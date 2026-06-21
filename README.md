# Busforge

**An open commissioning tool for KNX installations.** Cross-platform,
self-hostable alternative to KNX ETS. The goal: import a project, render device configuration from manufacturer data,
and **program ("download") real KNX devices** over IP. Self-hostable as a single
Docker container (think: deploy it on your NAS). TypeScript on Bun, React frontend.

This repo validates the hard, risky core: with our own code, can we read a device,
reconstruct byte-for-byte what ETS flashed, and program real changes that take
effect on the bus? **Yes, verified on live hardware.**

---

## Status

| Capability | Status |
|---|---|
| KNXnet/IP tunneling (own TS implementation, runs on Bun) | ✅ |
| Connection-oriented management: read device descriptor / memory / properties | ✅ |
| Decrypt `.knxproj` (ETS6 AES) + parse topology / devices / group addresses | ✅ |
| Read-back: reconstruct a device's loaded tables, **byte-match** vs. the project | ✅ |
| Flash a device (full load procedure) | ✅ proven, port to TS in progress |
| Functional change proven on the bus (group address + a device setting) | ✅ |
| Dynamic parameter engine (build the parameter image from changed values) | ⬜ next |
| Web app (Bun server + REST/WebSocket + React UI) | ⬜ next |
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
  knx/          the KNX engine (own MIT implementation)
    src/frame.ts        KNXnet/IP + cEMI + TPCI/APCI byte handling
    src/connection.ts   KnxIpTunnel: tunnelling + acks + retransmission
    src/device.ts       KnxDevice: connection-oriented read/write/flash
    src/cli.ts          read a device descriptor + group table
apps/
  server/       Bun server (REST + WebSocket), serves the web app   (planned)
  web/          React / Vite frontend                                (planned)
docs/
  plan.md       scope, v1 cut, build sequence, deferred items
  findings.md   the protocol knowledge: formats, load procedure, gotchas
```

The genuinely hard part of this project was the protocol **discovery** (the subtle
KNXnet/IP and load-procedure gotchas), and that is captured in
[`docs/findings.md`](docs/findings.md). It is language-agnostic and is the most
valuable artifact here.

---

## Run it

Requirements: [Bun](https://bun.sh), a reachable KNXnet/IP interface, and a device
whose `.knxprod` data you legally have (it ships inside your `.knxproj`).

```bash
bun run packages/knx/src/cli.ts <interface-ip> <device-ia>
# e.g. bun run packages/knx/src/cli.ts 198.51.100.10 1.1.x
```

**Writing to a device follows a real load procedure that unloads tables first;
always back up first and keep a recovery path.** See the safety notes in
`docs/findings.md`.

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
1. Port the proven flash / load procedure into `packages/knx`.
2. Dynamic parameter engine: build the parameter image from changed values
   (conditions, unions, channels).
3. Bun server (REST + WebSocket) + React frontend; single Docker container.
4. KNX Secure.
