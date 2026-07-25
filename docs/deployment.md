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
image, read back through `/api/version` and shown in the UI footer:

| Build arg | Meaning |
|---|---|
| `BUSFORGE_VERSION` | Version string, e.g. `v0.4.0` |
| `BUSFORGE_COMMIT` | Commit hash |
| `BUSFORGE_BUILT_AT` | Build timestamp |

They default to `unknown`, which keeps a local `docker build` honest rather than claiming a version
it does not have. The build context excludes `.git`, so the server cannot read this from git at
runtime.

## Run

```bash
docker run -d --name busforge \
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
not kept), the per-project flash backups, and `master.key` if no `BUSFORGE_MASTER_KEY` is set. Bind-mount that path to a backed-up host directory. Nothing
proprietary is baked into the image (see `.dockerignore`); user data only ever lands on the host at
runtime.

The master key seals KNX tool keys in the database. It is **unrecoverable**: restoring the database
onto a host without its key makes every sealed tool key permanently unopenable. Either pin
`BUSFORGE_MASTER_KEY` from your own secret store, or back up `master.key` **together with** the
database. The server refuses to start if sealed keys exist but no master key is available, rather
than silently generating a new one that cannot open them.

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
the image with that version baked in, publishes it to the project's container registry tagged by
version and by commit, and creates a release with the changelog. It skips when nothing changed since
the last tag.

The hardware smoke framework is never part of CI. It needs a real bus and a real device; see
[testing.md](testing.md).
