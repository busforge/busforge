# Install and first steps

From nothing to a project that talks to your bus: start the container, create or import a
project, bring in the product definitions, set up an interface. The runtime details behind each
step (image contents, shutdown, backup, upgrade) are in [deployment.md](deployment.md); what
Busforge does not do yet is in [limitations.md](limitations.md).

Busforge is an alpha for technically capable users. Before you write to a device, keep your ETS
project as a backup and a way to program the device without Busforge.

## What you need

- A host with **Docker** (Docker Engine with the compose plugin, or a desktop Docker runtime). See
  [Tested platforms](#tested-platforms) for what has actually run.
- A **KNXnet/IP interface or router** on the network that accepts a plain (not IP Secure) tunnel,
  or a **KNX USB interface** together with the [bridge](#a-knx-usb-interface-through-the-bridge).
- Your **ETS project** (`.knxproj`, ETS 5 or 6), or the manufacturers' **product databases**
  (`.knxprod`) for the devices you want to configure.

## 1. Start the container

Busforge needs a master key: 32 random bytes that encrypt the KNX Data Secure tool keys it
stores. Generate it once and keep it with your other secrets. It is not part of the data
directory, and without it a restored database cannot open those keys
([deployment.md](deployment.md#state-and-the-master-key)).

With the `docker-compose.yml` from the repository, put a small overlay that publishes the port and
an `.env` file next to it. Compose reads `.env` on every command, so the key and the overlay are
in place for each later update too:

```yaml
# docker-compose.deploy.yml
services:
  busforge:
    ports: ["127.0.0.1:3000:3000"]
```

```bash
[ -f .env ] || printf 'COMPOSE_FILE=docker-compose.yml:docker-compose.deploy.yml\nBUSFORGE_MASTER_KEY=%s\n' \
  "$(openssl rand -hex 32)" > .env
chmod 600 .env
docker compose up -d
```

Or with plain `docker run`, the key generated with `openssl rand -hex 32`:

```bash
docker run -d --name busforge --restart unless-stopped \
  --stop-timeout 1800 \
  -p 127.0.0.1:3000:3000 \
  -v busforge-data:/app/apps/server/data \
  -e BUSFORGE_MASTER_KEY=<the 64 hex characters> \
  ghcr.io/busforge/busforge:latest
```

Until the image package is public, pulling it needs a GitHub login that can read it; build the
image yourself as below instead. The published image is built for **linux/amd64** only. On an arm64 host (a Mac with Apple silicon,
an ARM single-board computer) build the image yourself from a checkout and run that tag instead:
`busforge` in place of the image name with `docker run`, or `BUSFORGE_IMAGE=busforge` in `.env`
with compose.

```bash
docker build -t busforge .
```

**Busforge has no login.** Whoever reaches the port can program every device on your bus. The
examples bind it to `127.0.0.1`; to reach it from another machine, publish it on a trusted network
only, or put a reverse proxy with authentication in front of it
([deployment.md](deployment.md#behind-a-reverse-proxy)). Never expose it to the internet.

The long `--stop-timeout` (`stop_grace_period: 30m` in the compose file) lets a running device
write finish before the container stops ([deployment.md](deployment.md#stopping-and-updating)).

Open `http://127.0.0.1:3000`. The Projects page offers **Blank project** and **Import project**.

## 2. Create or import a project

**Import an ETS project.** *Import project*, drop the `.knxproj`, enter its password if the
project is password-protected, *Analyze file*, check the preview, *Import*. Topology, building
structure, group addresses, every device's configuration and the KNX Data Secure keys in the
project come along, and the products it contains go into Busforge's catalog. The uploaded file
itself is not kept.

**Start empty.** *Blank project*, give it a name, *Create*. Add buildings and rooms, then place
devices with *Add device* from the catalog (next step).

## 3. Product definitions

Busforge builds every device's parameters and memory image from the manufacturer's product
definition. It never downloads or ships that data: you bring it.

- A device that is in your imported ETS project already has its definition. Nothing else to do.
- For a device that is not, open *Add device*, then *Import product database*, and choose the
  manufacturer's `.knxprod` (or an OpenKNX application XML). Busforge lists the manufacturer's
  download page under *Where do I get a product database?* where one is known; otherwise the
  manufacturer's website or the ETS Online Catalog is the source. The imported products then
  appear in the catalog, ready to *Add*.

## 4. Set up the interface

In a project, open the bus indicator in the header (it shows *disconnected*), then *Manage
connections* and *Add connection*. Saved connections belong to the installation, not to one
project.

- **KNXnet/IP**: enter the interface's IP address and port (`3671` by default), or let *Scan
  network* list the interfaces that answer a multicast search. Leave *Transport* on **Auto**: it tries TCP first and falls back to
  UDP. Busforge in a container reaches an interface on the LAN with the default bridge networking;
  if a particular interface stays silent, see [deployment.md](deployment.md#bus-access-from-a-container).
- **USB**: only for a server running directly on the machine the interface is plugged into. A
  container cannot reach it; use the bridge below.

Then pick the connection in the bus indicator and *Connect*. The bus monitor shows live telegrams.

### A KNX USB interface through the bridge

`busforge-bridge` runs on the machine that holds the USB interface and offers it on the network
as a KNXnet/IP tunnelling server. It runs from a source checkout with [Bun](https://bun.sh):

```bash
git clone https://github.com/busforge/busforge.git && cd busforge
bun install
bun run apps/bridge/src/index.ts --name "USB bridge"
```

On Linux the user running the bridge needs access to the interface's `hidraw` device. The tested
setup grants it with a udev rule for the interface's USB vendor and product id (`lsusb` shows
them) and a group the user is in:

```
# /etc/udev/rules.d/70-knx-usb.rules
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="<vid>", ATTRS{idProduct}=="<pid>", MODE="0660", GROUP="dialout"
```

Add it in Busforge as a KNXnet/IP connection with the bridge machine's address and port `3671`,
transport **Auto** or **TCP** ([limitations.md](limitations.md#known-issues) explains why not UDP
on a slow host). Device management works on the USB interface's own individual address only, so
one programming client at a time ([connections.md](connections.md#the-bridge-a-local-usb-interface-on-the-network)).

## 5. Before the first write

- **Read before you write.** Reading a device's parameters and links back changes nothing on it
  and shows whether Busforge and the device agree.
- **Check the product's state** in the device's compatibility badge or in
  [compatibility.md](compatibility.md). A product without evidence of its own is written only
  after you have acknowledged, once for the project, that it is untested.
- **KNX Data Secure** devices are programmed under the tool key from your project, a key entered by
  hand or one Busforge wrote when it activated the device ([knx-secure.md](knx-secure.md)).
  KNX IP Secure is not supported.
- Every surgical write is backed up and read back. A write that is cut off can leave a device
  unloaded; the flash dialog then offers the full download ([limitations.md](limitations.md#known-issues)).

## Update, backup, restore

| | |
|---|---|
| **Update** | A new image on the same data directory: `docker compose pull && docker compose up -d` in the directory with `.env`, or `docker stop busforge && docker rm busforge` and `docker run` the new tag with the same volume and key. Migrations run on start. There is no downgrade: take a backup first. |
| **Backup** | Stop the container and archive the **whole** data directory. Never copy `busforge.db` alone. Keep the master key separately; with `BUSFORGE_MASTER_KEY` set it is not in the directory. |
| **Restore** | Into the data directory of a stopped container; destructive, it replaces what is there. |

The exact commands, and why each step is the way it is, are in
[deployment.md](deployment.md#backup-restore-and-upgrade). Independent of these, a project can be
exported as a `.busforge` archive from the project's header ([export-format.md](export-format.md)).

## Tested platforms

What has run, and nothing more. Any other combination may work; it has not been tried.

| What | How | Host | Architecture |
|---|---|---|---|
| Server | Published image, Docker Engine with compose | Ubuntu 24.04 | x86_64 (`linux/amd64`) |
| Server | Image built locally, OrbStack | macOS on Apple silicon | arm64 (`linux/arm64`) |
| Server | From source with Bun | macOS on Apple silicon | arm64 |
| Bridge | From source with Bun, one KNX USB interface model | Fedora 44 | x86_64 |
| Check suite and a fresh-container start | GitHub Actions | Ubuntu 24.04, `oven/bun:1.3` | x86_64 |

The image is based on `oven/bun:1.3`. Not tried: Windows hosts, Docker Desktop, Podman, Kubernetes, ARM
single-board computers, a server with a USB interface passed into the container. All bus work was on
twisted pair, through KNXnet/IP interfaces and the bridge ([status.md](status.md)).

## Getting help and reporting a problem

Report a problem, a device that does not work, or a device that does, as an issue on
[GitHub](https://github.com/busforge/busforge/issues). The app opens a prefilled issue from a
device's menu (*Report on GitHub*) or from the start page (*Report a problem*).
[reporting.md](reporting.md) shows what the link carries, what stays out of a public issue (keys,
project files, addresses), and how to share a diagnostic package.

## License

Busforge is source-available under the [PolyForm Noncommercial License 1.0.0](../LICENSE):
free for private, hobby, research and other noncommercial use. Commercial use, such as
commissioning installations for paying clients, needs a separate license from the author
([README](../README.md#license)). KNX and ETS are trademarks of KNX Association cvba; Busforge is
not affiliated with or certified by it.
