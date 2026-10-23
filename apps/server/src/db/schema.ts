import { Database } from "bun:sqlite";

// Forward-only SQL migrations, versioned on SQLite's user_version pragma.
// Append a new string to extend the schema; never edit an existing entry.
const MIGRATIONS: string[] = [
  `
  CREATE TABLE projects (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    imported_at    INTEGER NOT NULL,
    source_file    TEXT NOT NULL,
    interface_ip   TEXT NOT NULL DEFAULT '',
    interface_port INTEGER NOT NULL DEFAULT 3671
  );

  CREATE TABLE devices (
    id           INTEGER PRIMARY KEY,
    project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    ia           TEXT NOT NULL,
    name         TEXT NOT NULL,
    product_ref  TEXT NOT NULL,
    app_ref      TEXT NOT NULL,
    manufacturer INTEGER NOT NULL
  );
  CREATE INDEX idx_devices_project ON devices(project_id);

  CREATE TABLE group_ranges (
    id          INTEGER PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    parent_id   INTEGER REFERENCES group_ranges(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    range_start INTEGER NOT NULL,
    range_end   INTEGER NOT NULL
  );
  CREATE INDEX idx_ranges_project ON group_ranges(project_id);

  CREATE TABLE group_addresses (
    id         INTEGER PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    range_id   INTEGER REFERENCES group_ranges(id) ON DELETE CASCADE,
    raw        INTEGER NOT NULL,
    address    TEXT NOT NULL,
    name       TEXT NOT NULL,
    dpt        TEXT NOT NULL
  );
  CREATE INDEX idx_gas_project_raw ON group_addresses(project_id, raw);

  CREATE TABLE telegrams (
    id         INTEGER PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    ts         INTEGER NOT NULL,
    src        TEXT NOT NULL,
    dst_raw    INTEGER NOT NULL,
    kind       TEXT NOT NULL,
    data       TEXT NOT NULL
  );
  CREATE INDEX idx_telegrams_project_ts ON telegrams(project_id, ts);
  `,
  // Iteration 3: the device's 0.xml DeviceInstance Id (added as an ALTER so
  // databases from earlier iterations migrate in place), plus per-device
  // parameter values (seeded from the project, edited in the configuration UI).
  `
  ALTER TABLE devices ADD COLUMN instance_id TEXT NOT NULL DEFAULT '';

  CREATE TABLE device_parameters (
    project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    device_id    TEXT NOT NULL,
    param_ref_id TEXT NOT NULL,
    value        TEXT NOT NULL,
    PRIMARY KEY (project_id, device_id, param_ref_id)
  );
  `,
  // Iteration 3 phase 2: a device's module instances (resolved arg values),
  // stored as JSON since they are read whole to expand the configuration.
  `
  CREATE TABLE device_modules (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    device_id  TEXT NOT NULL,
    instances  TEXT NOT NULL,
    PRIMARY KEY (project_id, device_id)
  );
  `,
  // Group-address links: a device's com-object -> GA assignments, seeded from
  // 0.xml and edited in the UI, used to rebuild the address/association tables.
  `
  CREATE TABLE device_links (
    project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    device_id      TEXT NOT NULL,
    com_obj_ref_id TEXT NOT NULL,
    slot           INTEGER NOT NULL,
    ga_raw         INTEGER NOT NULL,
    PRIMARY KEY (project_id, device_id, com_obj_ref_id, slot)
  );
  CREATE INDEX idx_links_device ON device_links(project_id, device_id);
  `,
  // Baselines of the "programmed" state, to surface per-device unprogrammed
  // changes. Seeded at import as a copy of the live params/links, refreshed
  // after a successful flash. A device has changes when its live params/links
  // differ from these. Existing data is backfilled as a clean baseline.
  `
  CREATE TABLE device_param_base (
    project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    device_id    TEXT NOT NULL,
    param_ref_id TEXT NOT NULL,
    value        TEXT NOT NULL,
    PRIMARY KEY (project_id, device_id, param_ref_id)
  );
  CREATE TABLE device_link_base (
    project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    device_id      TEXT NOT NULL,
    com_obj_ref_id TEXT NOT NULL,
    slot           INTEGER NOT NULL,
    ga_raw         INTEGER NOT NULL,
    PRIMARY KEY (project_id, device_id, com_obj_ref_id, slot)
  );
  INSERT INTO device_param_base SELECT * FROM device_parameters;
  INSERT INTO device_link_base SELECT * FROM device_links;
  `,
  // The device's ETS "Beschreibung" (Comment/Description), to make it
  // searchable in the device list. Populated on (re-)import.
  `
  ALTER TABLE devices ADD COLUMN comment TEXT NOT NULL DEFAULT '';
  `,
  // ETS-style restore points: one JSON snapshot of the project's config layer
  // (parameter values, links, name, interface) per row. Manual (user title) or
  // automatic (before a risky operation). Restoring rewrites the config but
  // leaves the programmed baselines untouched, so drift stays truthful.
  `
  CREATE TABLE snapshots (
    id             TEXT PRIMARY KEY,
    project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    label          TEXT NOT NULL DEFAULT '',
    kind           TEXT NOT NULL,
    reason         TEXT NOT NULL DEFAULT '',
    created_at     INTEGER NOT NULL,
    schema_version INTEGER NOT NULL,
    payload        TEXT NOT NULL
  );
  CREATE INDEX idx_snapshots_project ON snapshots(project_id, created_at);
  `,
  // Catalog layer: manufacturer application programs, keyed by application-program
  // id (appProgramId), stored as the decrypted XML extracted at import. Global and
  // shared (not project-scoped): many devices and projects reuse one entry. This
  // moves the only runtime dependency on the raw .knxproj into the DB; the parser
  // stays the source of truth (we parse the stored XML at runtime, RAM-cached).
  `
  CREATE TABLE app_programs (
    id  TEXT PRIMARY KEY,
    xml TEXT NOT NULL
  );
  `,
  // DCA baggage (BinaryData/UserFiles from the inner archive, e.g. a DALI
  // gateway's backup-store) moved off disk into the DB, so the project dir is no
  // longer an import-time store. Per project, keyed by the (slash-flattened)
  // baggage name; a device's blobs are those whose name starts with its id.
  `
  CREATE TABLE device_baggage (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    data       BLOB NOT NULL,
    PRIMARY KEY (project_id, name)
  );
  `,
  // Catalog product metadata: the browsable layer for placing devices into a
  // blank project. One row per (product, application program) the device can be,
  // carrying the catalogue name / order number / hardware version. Global and
  // shared like app_programs; app_program_id links to the stored program XML, so
  // every catalog product is placeable. Populated at import from Hardware.xml and
  // (for legacy imports) backfilled from existing device rows.
  `
  CREATE TABLE catalog_products (
    app_ref        TEXT NOT NULL,
    product_ref    TEXT NOT NULL,
    app_program_id TEXT NOT NULL,
    manufacturer   INTEGER NOT NULL,
    name           TEXT NOT NULL DEFAULT '',
    order_number   TEXT NOT NULL DEFAULT '',
    hw_version     TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (app_ref, product_ref)
  );
  `,
  // Catalog persistence flag. A pinned product was ingested from an official source
  // (a .knxprod product database), so it stays in the catalog independent of any
  // project: its application program is a GC root, and project-delete GC never drops
  // it. Products that only came in via a project import stay pinned=0 (GC-eligible
  // with that project, the milestone-3 behavior). Existing rows default to 0.
  `
  ALTER TABLE catalog_products ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
  `,
  // Bus connection becomes transport-aware. A project's active connection stays
  // inline on the project row (minimal ripple to flash/bus/export/import): the
  // existing interface_ip/interface_port serve the IP transport, the new columns
  // serve USB. connection_type selects which. The `connections` table is a
  // reusable library of saved/discovered connections the user can apply to any
  // project; it is environment-specific (your IP gateway, your USB stick), not
  // part of a portable project export.
  `
  ALTER TABLE projects ADD COLUMN connection_type TEXT NOT NULL DEFAULT 'ip';
  ALTER TABLE projects ADD COLUMN usb_vendor_id INTEGER;
  ALTER TABLE projects ADD COLUMN usb_product_id INTEGER;
  ALTER TABLE projects ADD COLUMN usb_serial TEXT;

  CREATE TABLE connections (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    type           TEXT NOT NULL,            -- 'ip' | 'usb'
    host           TEXT NOT NULL DEFAULT '', -- ip transport
    port           INTEGER NOT NULL DEFAULT 3671,
    usb_vendor_id  INTEGER,                  -- usb transport
    usb_product_id INTEGER,
    usb_serial     TEXT,
    created_at     INTEGER NOT NULL
  );
  `,
  // A project's active bus connection is now a REFERENCE to a saved connection in
  // the global `connections` library (single source of truth), not an inline copy.
  // The earlier inline columns (connection_type, usb_*, interface_ip/port) became
  // unused once the model switched to a reference; they are dropped in the next
  // migration. The project's serializable properties live in projectProps.ts, the
  // one definition shared by export and snapshots.
  `
  ALTER TABLE projects ADD COLUMN connection_id TEXT REFERENCES connections(id) ON DELETE SET NULL;
  `,
  // Drop the now-unused inline connection columns on `projects` (no reader, no
  // writer remains; the active connection is projects.connection_id). The USB
  // columns on the `connections` table are unaffected, those are live. Migrations
  // run before `PRAGMA foreign_keys = ON`, so the connection_id foreign key does
  // not interfere with the column drops.
  `
  ALTER TABLE projects DROP COLUMN interface_ip;
  ALTER TABLE projects DROP COLUMN interface_port;
  ALTER TABLE projects DROP COLUMN connection_type;
  ALTER TABLE projects DROP COLUMN usb_vendor_id;
  ALTER TABLE projects DROP COLUMN usb_product_id;
  ALTER TABLE projects DROP COLUMN usb_serial;
  `,
  // Building structure from 0.xml <Locations>: a tree of spaces (Building > Floor
  // > Room > ...) with each space's directly-placed devices. Read whole to render
  // the device overview grouped by location. ext_id keeps the source Space Id;
  // ord preserves import order so floors/rooms list as ETS shows them. Existing
  // projects have no rows until re-imported (locations are import-time metadata).
  `
  CREATE TABLE spaces (
    id         INTEGER PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    parent_id  INTEGER REFERENCES spaces(id) ON DELETE CASCADE,
    ext_id     TEXT NOT NULL,
    type       TEXT NOT NULL,
    name       TEXT NOT NULL,
    ord        INTEGER NOT NULL
  );
  CREATE INDEX idx_spaces_project ON spaces(project_id);

  CREATE TABLE space_devices (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    space_id   INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    device_id  TEXT NOT NULL,
    PRIMARY KEY (project_id, space_id, device_id)
  );
  CREATE INDEX idx_space_devices_project ON space_devices(project_id);
  `,
  // KNX Data Secure key store: per-device tool keys for secure-commissioned devices.
  // tool_key is SEALED at rest (AES-256-GCM under the instance master key, see
  // secrets.ts); the DB file alone never reveals a key. serial_number is the 6-byte
  // device serial (for the Sync request); seq_group is the project's group/data
  // sequence counter (tool-access programming syncs its own). source records how the
  // entry was populated (import | manual | provisioned). See docs/knx-secure.md.
  `
  CREATE TABLE device_security (
    project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    device_id     TEXT NOT NULL,
    tool_key      BLOB NOT NULL,
    serial_number BLOB NOT NULL,
    seq_group     TEXT NOT NULL DEFAULT '',
    source        TEXT NOT NULL,
    PRIMARY KEY (project_id, device_id)
  );
  `,
  // A device's instance_id must be unique within its project: it is the key the
  // per-device tables (device_parameters/_links/_modules/_security, all device_id) join
  // on, so two device rows sharing one would silently merge their config last-wins. The
  // index is PARTIAL (WHERE instance_id != '') so legacy rows from before instance_id was
  // populated (added with DEFAULT '') do not block the migration; every real id is unique.
  //
  // A DB imported before this guard could already hold such duplicate rows (a malformed
  // 0.xml merged silently). Creating the index over them would throw and brick startup
  // (migrate() runs outside any request handler), so first collapse each duplicate group to
  // its lowest-rowid row. That is a safe repair: the per-device config keyed on the shared
  // instance_id already pointed at one merged device, so dropping the extra row loses no
  // config that was not already ambiguous. On a clean DB (the normal case) this deletes
  // nothing.
  `
  DELETE FROM devices
   WHERE instance_id != ''
     AND id NOT IN (SELECT MIN(id) FROM devices WHERE instance_id != '' GROUP BY project_id, instance_id);
  CREATE UNIQUE INDEX idx_devices_project_instance ON devices(project_id, instance_id) WHERE instance_id != '';
  `,
  // The project's group-address style as a level count (2 or 3), from GroupAddressStyle.
  // Persisted so the GA formatter and the edit endpoints use the project's real style
  // instead of guessing from already-formatted address strings. Existing projects default
  // to 3 (ETS's default and the historical behaviour) until re-imported.
  `
  ALTER TABLE projects ADD COLUMN ga_levels INTEGER NOT NULL DEFAULT 3;
  `,
  // A saved IP connection's KNXnet/IP transport: 'auto' (prefer TCP, fall back to UDP), 'tcp' or
  // 'udp'. TCP tunnelling is what reaches a bridge through an `ssh -L` forward or a multi-homed
  // host where UDP source selection fails, so 'auto' prefers it. Existing rows default to 'auto'.
  // Meaningful only for type = 'ip'; stored uniformly and ignored for USB.
  `
  ALTER TABLE connections ADD COLUMN ip_transport TEXT NOT NULL DEFAULT 'auto';
  `,
  // Identity changes invalidate queued programming even for a same-product replacement or
  // delete/recreate with the same instance id. Tokens stay local and are not imported.
  `
  ALTER TABLE devices ADD COLUMN programming_token TEXT NOT NULL DEFAULT '';
  UPDATE devices SET programming_token = lower(hex(randomblob(16)));
  CREATE TRIGGER device_programming_insert AFTER INSERT ON devices BEGIN
    UPDATE devices SET programming_token = lower(hex(randomblob(16)))
    WHERE project_id = NEW.project_id AND instance_id = NEW.instance_id;
  END;
  CREATE TRIGGER device_programming_target AFTER UPDATE OF ia, app_ref, product_ref ON devices BEGIN
    UPDATE devices SET programming_token = lower(hex(randomblob(16)))
    WHERE project_id = NEW.project_id AND instance_id = NEW.instance_id;
  END;
  `,
  // Bus-operation tasks, so a submitted job's outcome outlives the request that submitted it and
  // the process that ran it. Deliberately no foreign keys: the record of what was written to a
  // device outlives the device's (or the project's) deletion, for the task retention period.
  `
  CREATE TABLE tasks (
    id                 TEXT PRIMARY KEY,
    project_id         TEXT NOT NULL,
    device_id          TEXT NOT NULL,
    device_name        TEXT NOT NULL,
    ia                 TEXT NOT NULL,
    kind               TEXT NOT NULL,
    writes             INTEGER NOT NULL,
    snapshot_id        TEXT,
    state              TEXT NOT NULL,
    phase              TEXT,
    done               INTEGER NOT NULL,
    total              INTEGER NOT NULL,
    error              TEXT,
    error_code         TEXT,
    result             TEXT,
    baseline_committed INTEGER NOT NULL,
    queued_at          INTEGER NOT NULL,
    started_at         INTEGER,
    finished_at        INTEGER
  );
  CREATE INDEX idx_tasks_project ON tasks(project_id, finished_at);
  `,
  // Device associations the last read-back could not show. While any remain, a group-address
  // flash would overwrite links nobody has seen. A device already holding a link baseline has not
  // had its links counted, so its count is unknown (-1) until it is read back.
  `
  ALTER TABLE devices ADD COLUMN link_base_gaps INTEGER NOT NULL DEFAULT 0;
  UPDATE devices SET link_base_gaps = -1 WHERE EXISTS (
    SELECT 1 FROM device_link_base b WHERE b.project_id = devices.project_id AND b.device_id = devices.instance_id
  );
  `,
  // KNX Data Secure group keys, one per secured group address, SEALED at rest like the tool keys.
  // Keyed by the address itself (a group address is identified by its raw value in this schema),
  // and kept apart from group_addresses: keys are commissioning state, not configuration, so neither
  // a snapshot restore nor deleting the address touches one (an address that comes back must not
  // come back plain).
  `
  CREATE TABLE group_keys (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    raw        INTEGER NOT NULL,
    key        BLOB NOT NULL,
    source     TEXT NOT NULL,
    PRIMARY KEY (project_id, raw)
  );
  `,
  // KNX Data Secure device certificates: the factory default setup key (FDSK) and serial from the
  // label printed on a secure device, SEALED at rest like the tool keys. Kept after activation: a
  // master reset returns the device to this key, and it is the only way back in.
  `
  CREATE TABLE device_certificates (
    project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    device_id     TEXT NOT NULL,
    fdsk          BLOB NOT NULL,
    serial_number BLOB NOT NULL,
    PRIMARY KEY (project_id, device_id)
  );
  `,
  // How a secured group telegram was received (telegram.ts TelegramSecurity); NULL for a plain one.
  `
  ALTER TABLE telegrams ADD COLUMN security TEXT;
  `,
  // Senders of a group address besides its linked objects (groupSenders.ts): the bus interfaces a
  // project assigns to it, which a secure receiver lists in PID 54. And the last secured group
  // sequence each sender used from this project, so the next telegram is always fresh.
  `
  CREATE TABLE group_senders (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    ga_raw     INTEGER NOT NULL,
    ia         TEXT NOT NULL,
    source     TEXT NOT NULL,
    PRIMARY KEY (project_id, ga_raw, ia)
  );
  CREATE TABLE send_sequences (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    ia         TEXT NOT NULL,
    last       TEXT NOT NULL,
    PRIMARY KEY (project_id, ia)
  );
  `,
  // Where a project came from: the imported file's name, SHA-256 and size, and whether it was a
  // .knxproj or a .busforge artifact. Empty for projects created in busforge or imported before.
  `
  ALTER TABLE projects ADD COLUMN source_kind TEXT NOT NULL DEFAULT '';
  ALTER TABLE projects ADD COLUMN source_name TEXT NOT NULL DEFAULT '';
  ALTER TABLE projects ADD COLUMN source_sha256 TEXT NOT NULL DEFAULT '';
  ALTER TABLE projects ADD COLUMN source_bytes INTEGER NOT NULL DEFAULT 0;
  `,
  // A device placed from the catalog, or whose product was replaced, on which no configuration of the
  // project has been verified yet. Its empty baseline would otherwise read as "no changes". Rows from
  // before are left at 0.
  `
  ALTER TABLE devices ADD COLUMN never_programmed INTEGER NOT NULL DEFAULT 0;
  `,
  // A group address's Data Secure mode as ETS sets it (gaSecurity.ts): 'auto', 'on' or 'off'.
  `
  ALTER TABLE group_addresses ADD COLUMN security TEXT NOT NULL DEFAULT 'auto';
  `,
  // The fingerprint of the security object last verified on a Data Secure device
  // (deviceservice.ts securityFingerprint). NULL: not known.
  `
  ALTER TABLE devices ADD COLUMN security_base TEXT;
  `,
  // The user's acknowledgement that a Product running an application program is programmed
  // although its operation is not tested on hardware (compatibility.ts). Once per project.
  `
  CREATE TABLE untested_acks (
    project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    product_ref     TEXT NOT NULL,
    app_program_id  TEXT NOT NULL,
    acknowledged_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, product_ref, app_program_id)
  );
  `,
  // The com-object flags and priority the project sets on a device over its application's (0.xml
  // ComObjectInstanceRef; @busforge/project DeviceComObjOverrides). attrs: the attributes as ETS stores
  // them, JSON. Written at import and by the device page; seq keeps two entries of one RefId apart.
  `
  CREATE TABLE device_comobj_overrides (
    project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    device_id      TEXT NOT NULL,
    seq            INTEGER NOT NULL,
    com_obj_ref_id TEXT NOT NULL,
    attrs          TEXT NOT NULL,
    PRIMARY KEY (project_id, device_id, seq)
  );
  `,
  // The image stamps (PID 27 memory-control-block elements) a device reported at the end of the last
  // verified download that wrote its parameters, JSON [{obj, element, hex}], the record ETS keeps of
  // that download (@busforge/product ImageStamp). NULL: no record.
  `
  ALTER TABLE devices ADD COLUMN image_stamps TEXT;
  `,
  // A KNXnet/IP device's settings the project keeps on its DeviceInstance outside the parameters (0.xml
  // IPConfig, AdditionalAddresses, the security element's attribute names, the Installation's attributes;
  // @busforge/project DeviceKnxIp, without deviceId), JSON. Read-only project data, written at import.
  `
  CREATE TABLE device_knxip (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    device_id  TEXT NOT NULL,
    settings   TEXT NOT NULL,
    PRIMARY KEY (project_id, device_id)
  );
  `,
  // The com-object flags and priority the device was last written with (device_comobj_overrides as
  // it stood then), the flags' programmed baseline. Seeded from the import, which is what ETS wrote.
  `
  CREATE TABLE device_comobj_override_base (
    project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    device_id      TEXT NOT NULL,
    seq            INTEGER NOT NULL,
    com_obj_ref_id TEXT NOT NULL,
    attrs          TEXT NOT NULL,
    PRIMARY KEY (project_id, device_id, seq)
  );
  INSERT INTO device_comobj_override_base SELECT * FROM device_comobj_overrides;
  `,
  // Parameter values a read-back took as assumed (its `assume`) although the device cannot tell them
  // from another value of their parameter: the baseline holds them, the device never showed them.
  // value: the baseline value the mark is about, NULL for the parameter's default (no baseline row).
  // A mark follows the baseline value: a read-back that records another value ends it, a verified write
  // moves it (replaceParamBase).
  `
  CREATE TABLE device_param_assumed (
    project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    device_id    TEXT NOT NULL,
    param_ref_id TEXT NOT NULL,
    value        TEXT,
    PRIMARY KEY (project_id, device_id, param_ref_id)
  );
  `,
  // The structured facts behind a task's coded refusal (Task.errorDetails), JSON; NULL when it has none.
  `
  ALTER TABLE tasks ADD COLUMN error_details TEXT;
  `,
  // The images an application program's TypePicture parameters show, from its manufacturer's product
  // baggage, keyed by program and baggage id; they go with their program.
  `
  CREATE TABLE catalog_baggage (
    app_program_id TEXT NOT NULL REFERENCES app_programs(id) ON DELETE CASCADE,
    baggage_id     TEXT NOT NULL,
    name           TEXT NOT NULL,
    data           BLOB NOT NULL,
    PRIMARY KEY (app_program_id, baggage_id)
  );
  `,
];

// The schema version stamped into a snapshot at capture, so a future migration
// that changes the config layer can detect and handle older payloads on restore.
export const SCHEMA_VERSION = MIGRATIONS.length;

function migrate(db: Database): void {
  const current = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`); // v+1 is our own integer, safe to inline
    })();
  }
}

// Open (or create) the database with sane pragmas and run pending migrations.
export function openDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

// Bun's close() defers the close while any statement from db.prepare() is unfinalized, and a
// deferred close never checkpoints: every committed write would stay in busforge.db-wal alone.
// The checkpoint moves them into busforge.db and empties the log first. Another connection reading
// or writing the same file blocks it; the checkpoint waits for that up to the busy timeout and
// then reports it in its result row, not as an error.
export function closeDb(db: Database): void {
  db.exec("PRAGMA busy_timeout = 5000");
  const r = db.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number; log: number; checkpointed: number };
  // log -1 with busy set: another connection held the checkpoint lock, nothing was copied.
  if (r.busy !== 0 && r.log < 0) {
    throw new Error("the database checkpoint could not start: busforge.db alone may not hold every committed write");
  }
  if (r.checkpointed !== r.log) {
    throw new Error(`the database checkpoint did not complete (${r.checkpointed} of ${r.log} log frames copied): busforge.db alone does not hold every committed write`);
  }
  if (r.busy !== 0) {
    throw new Error("the database checkpoint copied every log frame but could not empty the log: busforge.db holds every committed write, busforge.db-wal is not empty");
  }
  db.close();
}
