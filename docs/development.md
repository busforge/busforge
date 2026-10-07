# Development

## Prerequisites

- **Bun 1.3** or newer. It is the runtime, the package manager and the test runner; there is no
  Node build step.
- A KNX interface only for the parts that talk to a bus (the app itself, the `tools/` CLIs, the
  hardware smoke framework). Everything else, including the full `check` gate, runs offline.
- Optional: `node-hid` builds on install and is only needed for a directly attached KNX-USB
  interface. It is an optional dependency, so an install without it still works.
- Optional: Chromium for the smoke framework's `ui` channel (`bunx playwright install chromium`).

```bash
bun install
```

## Running it locally

```bash
bun run dev:server    # Bun API + static server on :3000
bun run dev:web       # Vite dev server on :5173, proxies /api and the bus-monitor WebSocket to :3000
```

Open the Vite URL for development. The server alone serves the built web app, which is what the
container does.

Server state (the SQLite database, the instance master key, and per-project flash backups) lives
in `apps/server/data/`. Uploaded `.knxproj` / `.knxprod` files are parsed into the database and not
kept as files. That directory is git-ignored in full and holds real project
data, so it never leaves the machine.

## The gate

```bash
bun run check         # typecheck + lint + tests + build, every workspace
```

Nothing is done until this is green. It is offline by construction: no bus, no network, no
hardware. What it proves and what it deliberately does not prove is in [testing.md](testing.md).

Individual steps exist (`bun run typecheck`, `lint`, `test`, `build`) but `check` is the one that
counts.

Some tests read manufacturer data from a private corpus outside the repository. Without
`BUSFORGE_CORPUS` they are skipped visibly and the check's last line names their files; a green run
without the corpus is the gate for a contribution, and the maintainers also run it with the corpus
([testing.md](testing.md#the-private-corpus)).

## Workspace layout

Bun workspaces, `packages/*` + `apps/*` + `plugins/*` + `tools`.

| Workspace | Contents |
|---|---|
| `packages/knx` | The KNX protocol library: KNXnet/IP tunnelling (UDP/TCP), USB HID transport, cEMI and APDU framing, device management, load-procedure execution, KNX Data Secure, a KNXnet/IP server |
| `packages/project` | `.knxproj` reading: container decryption, topology, devices, group addresses, per-device parameter values |
| `packages/product` | The product catalog side: application-program parsing, the unified config model, dynamic visibility, parameter image and table builders, load plans, the mask registry and device profiles |
| `apps/server` | The Bun HTTP API: projects, devices, catalog, flashing, read-back, snapshots, export, bus monitor, the task queue that serialises bus operations |
| `apps/web` | The React frontend (Vite, TanStack Router/Query, Tailwind) |
| `apps/bridge` | `busforge-bridge`: puts a KNX-USB interface on the network as a KNXnet/IP tunnelling server, so the stick does not have to sit on the machine running busforge |
| `plugins/*` | Native replacements for ETS DCA plugins (see [plugins.md](plugins.md)) |
| `tools` | Operator and development CLIs (below) plus the hardware smoke framework |

## The tools

Everything in `tools/` talks to a live bus or to data dumped from one. It is not part of the app
and not part of `check`. Read-only unless stated otherwise.

| Tool | Purpose |
|---|---|
| `readback.ts` | Dump a real device's commissioned memory and compare it against what busforge builds |
| `dump-param-memory.ts` | Dump every reachable device's parameter memory into a directory of dumps |
| `verify-images.ts` | Byte-verify the image build against those dumps, offline |
| `paramtest.ts` | Single-device parameter image comparison from files, one memory read |
| `etsdiff.ts` | Diff busforge's image against what ETS actually wrote, from a capture |
| `knxproxy.ts` | KNXnet/IP-over-TCP logging proxy: records the capture `etsdiff.ts` reads |
| `flashtest.ts` | **Writes.** Live group-address flash harness with revert |
| `udp-ssh-relay.ts` | Carry KNXnet/IP over an SSH TCP forward when the direct UDP route is broken |
| `smoke/runner.ts` | The hardware smoke framework, see [testing.md](testing.md) |

### readback.ts

Reads a device's memory over the bus and byte-compares it against the image busforge builds from
the project. This is the ground truth the flash paths are developed against. Read-only, it never
writes to a device.

```bash
bun run tools/readback.ts <project.knxproj> <password> <interface-ip> <out-dir> [--mode=all|params|tables] \
  [--configured-by=ets|busforge|unknown] [--prior-busforge-writes=none|some|unknown] [--via=busforge-bridge|direct]
```

- `params`: for every device with an LSM4 parameter image, build our image, read the device, and
  byte-compare. Writes `<ia>__<app>.built.bin`, `<ia>__<app>.device.bin` and `params.json`.
- `tables`: read every device's LSM1/2/3 group tables with a full, count-based read (no cap, not
  truncated). Writes `tables.json`.
- `all` (default): both.

Every parameter comparison is also written to `evidence.json` as an [evidence record](evidence-contract.md),
with the device's firmware revision where it reports one. What a match proves depends on who wrote
the device, which only you know: `--configured-by=ets --prior-busforge-writes=none` makes it
reference evidence, `--configured-by=busforge` transfer evidence, and the default (`unknown`) neither.

KNX Secure devices (descriptor `MV-FFFF`) are skipped, there is no plain access to them.

The output is **real device memory**, including your installation's group addresses. It is the same
class of personal data as a project's instance file. Write it to a git-ignored location; the tool
drops a `DO_NOT_COMMIT_device_memory.txt` marker in the output directory as a reminder.

### dump-param-memory.ts

Dumps every reachable device's parameter memory into a directory, for both memory models (LSM4
relative segments and absolute segments). Read-only. Unlike `readback.ts` it is **database-sourced**
and needs no `.knxproj` password: application programs and values come from the server's own
database.

```bash
bun run tools/dump-param-memory.ts <interface-ip> [out-dir]
```

Writes one `<ia>__<seg>.device.bin` per segment plus `manifest.json`. The default output directory
is `apps/server/data/readback/parammem` (git-ignored).

### verify-images.ts

Byte-verifies the image build against those dumps. **Offline**, no bus: it reads the dumped `.bin`
files and compares them against what busforge builds now. This is the honest correctness check,
against real devices rather than against our own frozen golden snapshot.

```bash
bun run tools/verify-images.ts [dump-dir]
```

The match is **owned-scoped**: a segment passes when the bytes busforge derives from active
parameters (the ones it would actually flash) equal the device. Unowned bytes (manufacturer
defaults, erased gaps, inactive-branch parameters) are reported for context and never fail a device,
because busforge does not write them. See [verification.md](verification.md).

### paramtest.ts

The narrow version of `readback.ts`: build one device's parameter image from files and compare it
against the image on the device, with a single memory read. Read-only, no defaults, every argument
required so a bare invocation opens no tunnel.

```bash
bun run tools/paramtest.ts <interface-ip> <device-ia> <app.xml> <decrypted-0.xml> <device-id>
```

### etsdiff.ts

Holds busforge's built parameter image against what **ETS** actually wrote to a real device, byte
for byte.

```bash
bun run tools/etsdiff.ts <ets-capture.log> --project=<file.knxproj> [--password=<pw>] [--device=<i> | --ia=<a.l.d>] [--partial] [--evidence=<out.json>]
```

`--evidence` writes the result as a reference [evidence record](evidence-contract.md) that points at
the capture by path and SHA-256. Keep the capture: a comparison nobody can repeat does not count.
`--partial` takes an ETS partial download instead of a full one and writes one record per Busforge
flash operation it touched: `flashParams` for the parameter segments, `flashLinks` for the group
tables. The full invocation reference is in [verification.md](verification.md).

This closes a gap nothing else can: busforge's own flash verifies that the device holds what we
sent, which can never prove that what we sent is what ETS would have sent. For a union-heavy
application the visibility resolver could pick a different active set, and every test plus the
verify would stay green while the device ran on a wrong image.

One trap is baked into the tool: a relative segment is
written at the address the **device** assigns during allocation, so ETS's `A_MemoryExtended_Write`
addresses are segment base + offset, not the 0-based offsets our image is indexed by. The tool
infers that base from the capture; `--base` pins it. Diffing without it reports every write as
divergent on an image that is in fact byte-identical.

Input is a logging-proxy capture, as described under [Capturing reference traffic](#capturing-reference-traffic).

### flashtest.ts

**This writes to a real device.** It changes one group address on the named device, flashes it,
proves on the bus that the device answers on the new address, then reverts.

```bash
bun run tools/flashtest.ts <interface-ip> <device-ia>
```

There is no default target: both arguments are required, so a bare invocation does nothing. Never
point it at a device in a live installation you are not prepared to reprogram. It only reverts if
every step succeeds.

### udp-ssh-relay.ts

A workaround, not a feature: SSH forwards TCP, not UDP, so this carries each KNXnet/IP datagram as
a length-prefixed frame over a TCP stream. Use it when the development machine cannot reach a
KNXnet/IP interface directly (for example a dual-homed host whose UDP source-address selection
fails).

```bash
# on the host that can reach the interface
bun run tools/udp-ssh-relay.ts remote <tcpPort> <interfaceUdpPort>
# forward the TCP port, then locally
bun run tools/udp-ssh-relay.ts local <udpPort> <tcpPort>
```

Then point a busforge connection at `127.0.0.1:<udpPort>`. This works only because busforge's
tunnel uses a single socket with a NAT-mode HPAI (`0.0.0.0:0`), so the gateway replies to the
observed packet source.

### busforge-bridge

A KNX-USB interface can be opened by exactly one process on one machine. The bridge puts it on the
network as an ordinary KNXnet/IP tunnelling server, so busforge (and ETS) can reach it from
anywhere:

```bash
bun run apps/bridge/src/index.ts [--usb <vid:pid> | --usb-path <p>] [--port 3671] [--name "<label>"] [--addresses 1.1.250,1.1.251]
```

`--addresses` hands out extra tunnel addresses. Note that many USB interfaces only pass
point-to-point frames addressed to their **own** individual address, so device management works on
that one address only; see [connections.md](connections.md).

## Capturing reference traffic

Some device behaviour cannot be derived from the `.knxproj`: the exact load procedure a device
runs, its memory-write bracket, the `A_Restart` timing, KNX Data Secure commissioning, the
management dialogue of module and DCA devices. The way to learn it is to capture a **real ETS
programming transaction** against the real device and read it back frame by frame. The result is
also the input for `etsdiff.ts`.

**The traffic that matters is connection-oriented point-to-point management**, not group traffic:
`T_Connect`, numbered `T_Data_Connected` carrying `A_Memory_Write` / `A_Memory_Response`, the load
state machine's control properties, and the closing `A_Restart`. Any group-only capture (the ETS
*Group* Monitor, a group-monitor-only interface) misses the entire transaction. That single
distinction is what makes most naive capture attempts useless.

**The capture the tools read is the log of the logging proxy** `tools/knxproxy.ts`, which ETS uses
as its KNXnet/IP TCP interface ([testing.md](testing.md#taking-a-capture)). An external packet
capture (Wireshark on the network segment between ETS and the interface) is the route for reading a
transaction by eye. Capturing inside the bridge process is **not implemented**.

### Wireshark

Needs no code from busforge. Use Wireshark 3.0 or newer for its built-in KNX/IP dissector (the
old third-party plugin does not decode the cEMI payload and is useless here). Have ETS commission
the device through `busforge-bridge` or a KNXnet/IP gateway, capture the segment between the two
and filter on `knxip`. Because ETS programs using its assigned tunnel address as source, its
memory writes, load control, restart and the device's connection-oriented replies all traverse
that tunnel.

Two constraints shape the setup, for the logging proxy and for Wireshark alike:

- A USB interface only surfaces point-to-point frames addressed to its **own** individual address,
  so ETS must tunnel on that address for the programming dialogue to cross the bridge at all. If
  the commissioning works, the capture is complete.
- A USB interface can only be held by one process, so ETS and the bridge cannot both own the
  stick. Run ETS in a VM on the host that owns the interface, or on a second machine on the same
  network, and point it at the bridge's KNXnet/IP port.

A tunnel tap records **our own** session. Passively sniffing someone else's session over a tunnel
we merely opened is not possible; that is a property of tunnelling, not a tooling limit.

**Honest limit.** A USB interface in data-link-layer mode hands over fully formed `L_Data.ind`, so
the transcript carries APDU content and ordering (everything needed for load-procedure, memory,
restart and secure work) but **not** L2 acknowledgements, repeat flags or sub-frame timing. Those
need a true busmonitor (a TP-UART based interface), which nothing described here needs.

### What each tap can see

| Tap | Our own p2p programming | Third-party p2p | L2 acks / timing | Secure plaintext |
|---|---|---|---|---|
| Logging proxy (`tools/knxproxy.ts`) | yes | no (the tunnel filters by address) | no | ciphertext; decrypt with `tools/secure-capture-decode.ts` |
| Wireshark on the tunnel | yes | no (the tunnel filters by address) | no | yes, via keyring import |
| Wireshark on routing multicast | if it crosses the router | if it crosses the router | no | yes, via keyring |
| ETS Bus Monitor (busmonitor-capable interface) | yes | yes | yes | yes, with keys loaded |
| ETS Group Monitor | **no, group only** | no | no | n/a |
| Bridge transport logger (**not implemented**, see below) | would be both directions | no | no (link-layer mode) | would be, with busforge's own tool key |

### In the bridge process: not implemented

The bridge sees every cEMI frame in both directions, and the decoders a transcript would need
(`parseCemiLData`, `parseApdu`, the `APCI` constants) already exist, so a logging decorator over
the transport is a small piece of work. It has not been written: there is **no** capture flag on
the bridge and no transaction log comes out of it. Until there is, use the logging proxy
([testing.md](testing.md#taking-a-capture)) or Wireshark above
([roadmap.md](roadmap.md#verification)).

### Secure devices

If ETS commissions a Data Secure device, the management APDUs are wrapped in `SecureService` (APCI
`0x3F1`) and appear as ciphertext in the capture. The framing (source, destination, TPCI,
APCI, connection-oriented versus broadcast, sequence progression, the number and size of secured
writes, the restart) stays in clear, so the *shape* of the transaction is readable from ciphertext
alone. For plaintext, either import an ETS keyring into Wireshark (Preferences → Protocols →
KNXnet/IP → key file), or decrypt a logging-proxy capture with `tools/secure-capture-decode.ts`,
busforge's own AES-128-CCM implementation, and the keys that ride in with the project (see
[knx-secure.md](knx-secure.md)).

### Before you touch the bus

State what is about to be programmed, at which address, and what the recovery path is. This is a
physical system; a download that dies mid-bracket leaves a device unloaded, not half-configured.
