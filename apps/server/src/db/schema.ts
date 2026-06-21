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
];

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
