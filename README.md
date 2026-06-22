# Busforge

**An open commissioning tool for KNX installations.** Cross-platform,
self-hostable alternative to KNX ETS. Import a project, browse the installation,
watch the bus with decoded values, edit a device's configuration, and
**program ("download") real KNX devices** over IP, all from a web UI.
Self-hostable as a single Docker container (think: deploy it on your NAS).
TypeScript on Bun, React frontend.

The hard, risky core is proven: with our own code we read a device, reconstruct
byte-for-byte what ETS flashed, and program real parameter and group-address
changes that take effect on the bus, **verified on live hardware, from the UI,
with backup and read-back verification.** See [`docs/ui.md`](docs/ui.md) for the
current architecture and features.

---

## Status

| Capability | Status |
|---|---|
| KNXnet/IP tunneling (own TS implementation, runs on Bun) | ✅ |
| Connection-oriented management: read device descriptor / memory / properties | ✅ |
| Decrypt `.knxproj` (ETS6 AES) + parse topology / devices / group addresses | ✅ |
| Read-back: reconstruct a device's loaded tables, **byte-match** vs. the project | ✅ |
| Flash a device (full load procedure, TS on Bun) | ✅ verified on the bus |
| Functional change proven on the bus (group address + a device setting) | ✅ |
| Parameter engine: full dynamic UI (conditions, unions, modules/channels, i18n) | ✅ |
| Web app: multi-project, persistence, devices, group addresses, bus monitor | ✅ |
| Bus monitor with DPT-decoded values + GA names | ✅ |
| Device configuration UI (edit + persist parameters) | ✅ |
| Program parameters and group addresses from the UI (backup + verify + revert) | ✅ verified on the bus |
| KNX Secure | ⬜ |

All ✅ items are **verified against a real KNX installation** (a live, multi
manufacturer house bus via an MDT KNXnet/IP interface).

---

## What was proven on the bus

**Group address change.** Changed a device's group table entry `2/1/7 → 2/1/8`,
flashed, and confirmed with a `GroupValueRead` that the device now answers on the
new address and not the old one, then reverted.

**Device setting change.** Changed a power supply's cyclic-voltage-send interval
from 600 s to 60 s by flashing its parameter segment, then watched the bus: the
device started broadcasting its voltage within 75 s (silent at 600 s), then we
reverted. The device autonomously changed its behaviour after we wrote the setting.

---

## Repository layout

```
packages/
  knx/          KNX transport (own MIT implementation)
    frame/connection/device.ts  KNXnet/IP, tunnel, connection-oriented device
    flash.ts                     the load procedures (parameter + group tables)
    dpt.ts                       browser-safe DPT value decoder
  project/      .knxproj loader: dependency-free ZIP + WinZip-AES + 0.xml parser
  product/      application-program engine
    appconfig/config.ts          the dynamic parameter UI (visibility, modules)
    image.ts / grouptables.ts    build the bytes to flash (params / GA tables)
apps/
  server/       Bun server: handleApi router, SQLite (db/), Bus, flash
  web/          React / Vite / shadcn frontend (the "Precision Instrument" theme)
docs/
  ui.md         current architecture and features (start here)
  findings.md   the protocol knowledge: formats, load procedure, gotchas
  deployment.md CI/CD pipeline and NAS deployment
  *-plan.md     per-iteration design notes
```

The genuinely hard part of this project was the protocol **discovery** (the subtle
KNXnet/IP and load-procedure gotchas), and that is captured in
[`docs/findings.md`](docs/findings.md). It is language-agnostic and is the most
valuable artifact here.

---

## Run it

Requirements: [Bun](https://bun.sh), and (for the bus features) a reachable
KNXnet/IP interface and your own `.knxproj`.

```bash
bun install
bun run dev:server     # Bun API on :3000
bun run dev:web        # Vite UI, proxies /api  (or: bun run build:web && bun run apps/server/src/index.ts)
bun run check          # typecheck + tests + web build
```

Open the web app, import a `.knxproj`, set the interface, and go. **Writing to a
device follows a real load procedure that unloads tables first; Busforge backs up
the segment, only writes on a confirmed change, and reads it back to verify, but
keep a recovery path.** See the safety notes in `docs/findings.md` and the flash
safety model in [`docs/ui.md`](docs/ui.md).

### Docker / deployment

```bash
docker build -t busforge .
docker run -p 3000:3000 -v busforge-data:/app/apps/server/data busforge
```

Pushing to `main` builds the image into the Forgejo container registry and
deploys it to the NAS (reachable at `busforge.internal` / `busforge.lan.example.org`).
See [`docs/deployment.md`](docs/deployment.md) for the pipeline and runtime model.

---

## Why this stack
- **Bun + TypeScript**: one language with the React frontend, native TS, built-in
  WebSocket, fast, clean single-container Docker deploy. `node:dgram` (UDP, which
  KNXnet/IP needs) is verified working on Bun; the KNX code is written runtime
  agnostic so it also runs on Node if needed.
- **Own KNX implementation (MIT)**: existing open KNX libraries do runtime group
  communication only, not device programming. We implement the management and load
  procedure ourselves, which we have to anyway, so there is no third-party library
  to depend on.

## Licensing / ethics
- We ship **tooling**, never manufacturer product data or any proprietary binary.
  The user brings their own `.knxproj` (which embeds the manufacturer data they
  legally obtained) or downloads `.knxprod` from the manufacturer.
- Parsing files you own and speaking the standardized KNX management protocol is
  legitimate. We do not use the KNX trademark or claim certification.

## Next steps
1. Full group-address link management (add/remove links, multiple GAs per
   com-object, create new GAs).
2. KNX Secure.
3. Config display completeness (DPT-9 float / text / binary value editors).
