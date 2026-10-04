# Deployment

Busforge ships as a **single Docker container**: the Bun server serves both the API and the built
web app. There is no separate frontend service, no database server, no message broker. State is one
SQLite file plus the uploaded project files, in one directory.

## Build

```bash
docker build -t busforge .
```

The build stage installs dependencies and runs `bun run build` (which builds the web app); the
runtime stage carries the result. Three optional build arguments bake the build identity into the
image, read back through `/api/version` and shown in the UI footer, and set as the OCI labels
`org.opencontainers.image.version`, `.revision` and `.created`:

| Build arg | Meaning |
|---|---|
| `BUSFORGE_VERSION` | Version string, e.g. `v0.4.0` |
| `BUSFORGE_COMMIT` | Commit hash |
| `BUSFORGE_BUILT_AT` | Build timestamp |

They default to `unknown`, which keeps a local `docker build` honest rather than claiming a version
it does not have. The build context excludes `.git`, so the server cannot read this from git at
runtime.

### What the image contains

The build context is an allowlist (`.dockerignore` starts with `*`): the license, the root and
workspace manifests, the lockfile, the source of the workspaces and the web build inputs. Tests,
fixtures, `docs/`, `tools/` (apart from its manifest), local scratch and runtime state are never
sent to the builder, so no layer of any build stage carries them. The runtime image then holds:

| Path in `/app` | What |
|---|---|
| `LICENSE` | The license, including its required notice |
| `package.json`, `bun.lock`, `tsconfig.base.json`, every workspace's `package.json` (`tools` and `apps/bridge` included) | Needed by the frozen-lockfile install |
| `apps/server/src`, `packages/*/src`, `plugins/*/src`, the `tsconfig.json` of `packages/*` and `plugins/*` | The server and the workspaces it imports, run from source by Bun |
| `node_modules` | Production dependencies of `@busforge/server` and the peer dependencies Bun adds for them (`react`, from the DALI plugin), about 9 MB |
| `apps/web/dist` | The built web app |
| `version.json` | The build identity above |
| `apps/server/data` | Declared `VOLUME`: all persistent state, see below |

The web source, the web app's own dependencies and the development toolchain (TypeScript, Vite,
oxlint, Playwright) stay in the build stage. A context that bypasses `.dockerignore` (a tar piped
into `docker build -`, which Docker sends as-is) is refused: the build stops if it finds tests,
fixtures, captures, project or key files, a database or a `master.key` in the context.

### Release build

Build a version from a clean checkout of its commit, never from a working tree, so the image holds
exactly what the commit holds and the stamped identity is true:

```bash
git worktree add --detach /tmp/busforge-release v0.4.0
cd /tmp/busforge-release
docker build -t busforge:v0.4.0 \
  --build-arg BUSFORGE_VERSION="$(git describe --tags --always)" \
  --build-arg BUSFORGE_COMMIT="$(git rev-parse --short=7 HEAD)" \
  --build-arg BUSFORGE_BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)" .
cd - && git worktree remove /tmp/busforge-release
```

Check the result with `docker inspect --format '{{json .Config.Labels}}' busforge:v0.4.0` and,
once it runs, `GET /api/version`.

## Run

```bash
docker run -d --name busforge \
  --stop-timeout 1800 \
  -p 3000:3000 \
  -v /srv/busforge/data:/app/apps/server/data \
  -e BUSFORGE_MASTER_KEY=<32 random bytes, hex or base64> \
  busforge
```

Or with the `docker-compose.yml` in the repository, which runs as-is and takes every
site-specific value from the environment:

```bash
BUSFORGE_IMAGE=busforge:latest \
BUSFORGE_DATA=/srv/busforge/data \
BUSFORGE_MASTER_KEY=<32 random bytes> \
  docker compose up -d
```

| Variable | Default | Meaning |
|---|---|---|
| `BUSFORGE_IMAGE` | `busforge:latest` | Image to run, including a registry prefix if it is not local |
| `BUSFORGE_DATA` | named volume `busforge-data` | Host path for the data directory, if you want it on a specific (backed-up) filesystem |
| `BUSFORGE_MASTER_KEY` | unset | Passed through only when set, so an empty value can never look like a configured key |

**No host port is published.** Compose can add published ports but never withdraw them, so a
port in the shared file would be forced on every deployment that fronts the container with a
proxy. Publish it, together with reverse-proxy labels, an external proxy network and any other
site-specific wiring, in a second file that stays out of the repository
(`docker-compose.deploy.yml` is gitignored for exactly this):

```yaml
# docker-compose.deploy.yml
services:
  busforge:
    ports: ["127.0.0.1:3000:3000"]
```

```bash
docker compose -f docker-compose.yml -f docker-compose.deploy.yml up -d
```

The image declares a healthcheck that polls the SPA root, so `docker compose ps` and a deploy gate
can wait for readiness.

### Stopping and updating

A stop must not cut a device write short. A download interrupted mid-transfer can leave the device
reset, not merely half-configured. So on `SIGTERM`, `SIGINT` or `SIGHUP` the server:

1. refuses new bus operations (`503 SERVER_SHUTTING_DOWN`),
2. cancels every queued task without running it (`TASK_NOT_STARTED`), and aborts a running read or
   dry run (neither writes anything),
3. stops a running flash or download that is still reading the device, before its first write, and
   otherwise waits for the running write to finish, its read-back and baseline commit included,
4. closes the monitor tunnel, refusing any new monitor connection, and exits.

With no write running it exits at once. A second signal does not skip the wait; the log names the
write it is still finishing. The HTTP API stays up meanwhile, so an open client keeps seeing the
write's progress.

```mermaid
sequenceDiagram
  participant D as docker stop
  participant S as Busforge
  participant Dev as Device
  D->>S: SIGTERM
  S->>S: refuse new work, cancel queued tasks
  S->>Dev: running download continues
  Dev-->>S: read-back verified
  S->>S: commit baseline, close tunnel
  S-->>D: exit 0
  Note over D,S: grace period exceeded: SIGKILL,<br/>write reported interrupted on next start
```

Docker's default grace period is 10 seconds, far shorter than a download, after which it sends
`SIGKILL`. The shipped `docker-compose.yml` sets `stop_grace_period: 30m` (use
`--stop-timeout 1800` with `docker run`). A `SIGKILL`, whether from an exhausted grace period or
`docker kill`, still ends the process mid-write. The next start then reports that write as
`interrupted` with the device state unknown, and replays nothing.

**Why 30 minutes.** The `tasks` table of the development instance held 686 finished writes on
2026-09-30 (downloads, parameter and group-address flashes on the bench and on the installation bus,
TP through a KNXnet/IP interface or the bench bridge). The longest took 229 s (a parameter flash of a
Steinel True Presence), the longest full download 211 s (the ABB US/U 4.2); a group-address flash at
most 145 s. That is a margin of about eight. What is not measured is a large MV-0705 image: the only
MV-0705 device timed, the MDT BE-02001, downloads in 19 s. A device written with `A_Memory_Write`
takes 12 bytes per frame, each a confirmed round trip with a per-frame retry budget of a few seconds,
so a slow line and retries can stretch a download well past the measured ones; 30 minutes leaves
room for that. The grace period only costs time when
a write is actually running. Every write's start and end are recorded in the `tasks` table, so the
bound can be checked against real downloads. A deploy pipeline that replaces the container must wait
at least as long; the NAS deploy job allows 45 minutes.

The grace period covers `docker stop` and container replacement. A **host** shutdown or a restart of
the Docker daemon is also bounded by the daemon's and the init system's own timeouts (dockerd's
`shutdown-timeout`, the service manager's stop timeout for dockerd), which this file does not set
and which can end a running write earlier. Do not reboot the host while a device
is being programmed; the next start reports such a write as interrupted.

### Ports

| Port | Purpose |
|---|---|
| `3000` (`PORT`) | HTTP: the API, the web app, and the bus-monitor WebSocket on the same port |

Nothing else is exposed. Outbound, the container reaches a KNXnet/IP interface on the network
(UDP/TCP 3671 by default).

### Environment

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP listen port |
| `BUSFORGE_MASTER_KEY` | unset | The instance master key: **32 random bytes** as hex or base64. Not a passphrase, no key derivation is applied |
| `TZ` | container default | Timestamps in the UI and logs |

### State and the master key

Everything persistent lives under `/app/apps/server/data` inside the container: the SQLite
database (which is where an imported `.knxproj` or `.knxprod` ends up; the uploaded file itself is
not kept), the per-project flash backups, and `master.key` if no `BUSFORGE_MASTER_KEY` is set. Bind-mount that path to a backed-up host directory. The image declares
it a `VOLUME`, so a container started without a mount still writes to an anonymous volume rather
than into its own layer, but only a named volume or a bind mount is found again by the next
container. Nothing proprietary is baked into the image (see [What the image contains](#what-the-image-contains));
user data only ever lands in the data directory at runtime.

The master key seals KNX tool keys in the database. It is **unrecoverable**: restoring the database
onto a host without its key makes every sealed tool key permanently unopenable. Either pin
`BUSFORGE_MASTER_KEY` from your own secret store, or back up `master.key` **together with** the
database. The server refuses to start if sealed keys exist but no master key is available, rather
than silently generating a new one that cannot open them.

### Backup, restore and upgrade

Back up the data directory of a **stopped** container. A running server keeps recent writes in the
SQLite write-ahead log (`busforge.db-wal`); a clean stop folds it into `busforge.db`, so the copy is
consistent. Reach the data through the stopped container itself (`--volumes-from`), which works the
same for a named volume and a bind mount and does not depend on the name compose gave the volume
(compose prefixes it with the project name, by default the directory name, e.g.
`busforge_busforge-data`; `-v busforge-data:...` would silently create a new, empty volume):

```bash
docker compose stop busforge
docker run --rm --volumes-from busforge -v "$PWD":/backup --entrypoint tar busforge:latest \
  -czf /backup/busforge-data.tgz -C /app/apps/server/data .
docker compose start busforge
```

Check that the archive lists `busforge.db` (`tar -tzf busforge-data.tgz`) before relying on it.
Restore by unpacking the archive into the data directory of a container that is created but not
started, then starting it:

```bash
docker compose create busforge
docker run --rm --volumes-from busforge -v "$PWD":/backup --entrypoint tar busforge:latest \
  -xzf /backup/busforge-data.tgz -C /app/apps/server/data
docker compose start busforge
```

 The archive holds `master.key` too, unless the key comes from
`BUSFORGE_MASTER_KEY`, in which case the same value must be set again.

An upgrade is a new image on the same data directory: `docker compose pull && docker compose up -d`,
or `docker run` the new tag with the same `-v`. The old container is stopped first, with the grace
period above. On start the server applies its forward-only schema migrations (versioned on SQLite's
`user_version`), so there is no separate migration step to run. There is no downgrade: an older image
does not notice that a newer one has migrated the database and runs on it unchecked. To go back,
restore the backup taken before the upgrade. On 2026-10-04 this path was exercised locally with the shipped compose file
and exactly the commands above: a container from the image of `181c1fb` imported a project and
created a blank one on a fresh named volume, the image built from this layout replaced it and listed
both projects unchanged, the backup archive held `busforge.db` and `master.key`, and after
`docker compose down -v` deleted the volume, the restore gave the same project list. That covers a
fresh start, one upgrade and one restore, not every historical data layout.

### Bus access from a container

The container runs fine on bridge networking. A KNXnet/IP tunnel still reaches an interface on the
LAN because busforge advertises a `0.0.0.0` HPAI (NAT mode), so the gateway replies to the observed
packet source rather than to the container's internal address.

If a particular gateway ignores NAT mode (the bus monitor stays empty, a tunnel never connects),
switch the service to `network_mode: host`. That drops it off any user-defined Docker network, so it
is then reachable only on a host port.

A directly attached KNX-USB interface is not reachable from the container. Run
[`busforge-bridge`](development.md#busforge-bridge) on the machine holding the stick and connect to
it over KNXnet/IP.

### Behind a reverse proxy

Route a single upstream to port 3000. The bus monitor uses a standard HTTP upgrade, so any proxy
that passes WebSockets through needs no extra configuration beyond its usual upgrade handling.

Busforge has **no authentication of its own**. It can program devices in a real installation, so do
not expose it to the internet: keep it on a trusted network, or put authentication in front of it at
the proxy.

## Continuous integration

The pipeline in `.forgejo/workflows/ci.yml` runs `bun run check` (typecheck, lint, tests, web
build) on every push and pull request. That job is the gate; nothing downstream runs if it fails.

On `main`, CI then computes the next version from the commit subjects since the last `v*` tag
(`feat:` → minor, any `type!:` or a `BREAKING CHANGE` body → major, everything else → patch), builds
the image with that version baked in and pushes it to the project's container registry tagged by
commit. The pushed image is then started in a fresh container without a data volume, and must
report the commit it was built from on `/api/version`. That start is the release gate: only then is
`latest` moved to the image, and the release job tags the commit, re-tags the image with the version and creates a release with the
changelog. It skips when nothing changed since the last tag.

Deploying to the author's own NAS is a separate job after the build. It writes its site-specific
compose overlay and pulls `latest`; a release neither waits for it nor fails with it.

The hardware smoke framework is never part of CI. It needs a real bus and a real device; see
[testing.md](testing.md).
