# Deployment & CI/CD

Busforge ships as a **single Docker container** and deploys to the home **NAS**
on every push to `main`, driven by a Forgejo Actions pipeline. The container
image is published as a **package** in the Forgejo container registry.

## Pipeline overview

```
push / PR to main
      │
      ▼
┌──────────────┐   PR + push     runner: hetzner
│    check     │  typecheck + bun test + web build  (bun run check)
└──────┬───────┘
       │ push to main only
       ▼
┌──────────────┐   build the image, push to the Forgejo registry
│    build     │  ghcr.io/busforge/busforge:main-<sha> + :latest
└──────┬───────┘  link the package to the repo
       │
       ▼
┌──────────────┐   runner: nas (runs docker locally on the NAS)
│   deploy     │  ship docker-compose.yml → /srv/busforge
└──────┬───────┘  docker compose pull && up -d, wait for healthy, prune
       │
       ▼
┌──────────────┐   semver bump from commit messages
│   version    │  git tag v<x.y.z>, re-tag image :v<x.y.z>, Forgejo Release
└──────────────┘  runner: hetzner
```

The workflow lives in [`.forgejo/workflows/ci.yml`](../.forgejo/workflows/ci.yml).

### Jobs

| Job | Runner | When | Does |
|-----|--------|------|------|
| `check` | `hetzner` | every PR and push | `bun install --frozen-lockfile` then `bun run check` (typecheck, tests, web build). This is the gate. |
| `build` | `hetzner` | push to `main` | Builds the image from the root `Dockerfile`, pushes `:main-<sha>` and `:latest`, links the package to the repo. |
| `deploy` | `nas` | push to `main`, after `build` | Copies `docker-compose.yml` to `/srv/busforge`, pulls `:latest`, restarts, waits for the healthcheck, prunes old images. The NAS runner executes Docker locally, so there is no SSH hop. |
| `version` | `hetzner` | push to `main`, after a successful deploy | Computes the next semver from commit messages, tags `v<x.y.z>`, re-tags the image `:v<x.y.z>`, and creates a Forgejo Release with the changelog. Skips if nothing changed since the last tag. |

### Versioning

The bump is derived from commit subjects since the last `v*` tag:

- `feat: ...` → **minor**
- `feat!: ...`, `fix!: ...` (any `type!:`) or a body containing `BREAKING CHANGE` → **major**
- anything else (`fix`, `chore`, `docs`, ...) → **patch**

The first release is `v0.1.0`.

## Runtime model on the NAS

Busforge runs as a **self-contained compose stack** (project name `busforge`),
separate from the Ansible-managed `nas-apps` stack. Its
[`docker-compose.yml`](../docker-compose.yml) attaches to the existing external
`traefik` network, so the shared Traefik reverse proxy routes to it:

- **HTTP**: `http://busforge.internal`
- **HTTPS**: `https://busforge.lan.example.org` (shared `*.lan.example.org`
  wildcard cert; plain HTTP on that name redirects to HTTPS)

Both hostnames resolve to the NAS through the OPNsense split-horizon
`*.lan.example.org` wildcard, so no DNS change is needed.

### State

The SQLite database and uploaded `.knxproj` / `.knxkeys` files live under
`/app/apps/server/data` inside the container, bind-mounted to
`/srv/busforge/data` on the NAS. That keeps the data on the
backed-up data array alongside the other apps (rather than in Docker's internal
volume store), and it survives image updates and restarts. **Nothing proprietary
is baked into the image** (see `.dockerignore`); user data only ever lands on the
host at runtime.

### Bus access (KNXnet/IP)

The container runs on Docker **bridge** networking. The KNX tunnel still reaches
the KNXnet/IP interface on the LAN because the connection advertises a `0.0.0.0`
HPAI (NAT mode), so the gateway replies to the packet source rather than to the
container's internal address. If a particular gateway ignores NAT mode and the
bus monitor stays empty, switch the service to `network_mode: host` in
`docker-compose.yml` (this drops it off the Traefik network, so it would then be
reachable only on a host port).

## Required secrets

Org-level Forgejo secrets reused from the sibling repos:

| Secret | Used for |
|--------|----------|
| `REGISTRY_USER` / `REGISTRY_TOKEN` | Push to and pull from the container registry; link the package. |
| `CI_RUNNER_TOKEN` | Create the Forgejo Release via the API. |

Pushing the version tag uses the automatic Actions token from `actions/checkout`.

## Manual operations

```bash
# Trigger the whole pipeline by hand (Forgejo UI → Actions → Run workflow),
# or locally inspect the running container on the NAS:
cd /srv/busforge
docker compose ps
docker compose logs -f busforge

# Roll back to a specific version:
docker pull ghcr.io/busforge/busforge:v0.1.0
# then pin that tag in docker-compose.yml and `docker compose up -d`.
```
