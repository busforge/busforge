# Bus connections (IP, USB, and the bridge)

Busforge reaches the KNX bus through a transport abstraction, so the same
commissioning logic (read-back, parameter flash, group-table flash, the bus
monitor) runs unchanged whether the bus is reached over KNXnet/IP or a KNX USB
interface. A connection manager lets you save reusable connections and assign one
to each project.

There are **three** ways to the bus, and all three are supported:

| Way | Connection type | What it is |
|---|---|---|
| **KNX-IP interface** | `ip` | A real KNXnet/IP gateway on the LAN. |
| **Local USB** | `usb` | A KNX-USB stick plugged into the machine Busforge runs on. |
| **Remote USB (bridge)** | `ip` | A KNX-USB stick plugged into a *different* machine, put on the LAN by [`busforge-bridge`](#the-bridge-remote-usb). |

The third is not a fourth transport: the bridge **is** a KNXnet/IP server, so from
the client's side it is an ordinary gateway and the `ip` transport reaches it
unchanged. Nothing about the local-USB path changes because the bridge exists.

## Architecture

Everything above the transport speaks plain cEMI L_Data and never knows the
medium. One seam, `KnxTransport`, sits under `KnxDevice`, the flash load
procedures, and the bus monitor; three ways reach the bus through it:

![busforge's three ways to reach the KNX bus: local USB, a KNX-IP interface, and remote USB via the bridge](connections-transports.svg)

`KnxTransport` (`packages/knx/src/transport.ts`) is the seam. `KnxIpTunnel`
already provided this surface; `KnxUsbTransport` is the second implementation.
Incoming frames from either are decoded by the shared `parseCemiLData` helper, so
both transports surface identical `(src, dst, tpdu, isGroup)` callbacks.

The server picks the concrete transport from a project's selected connection with
`makeTransport(connection)` (`apps/server/src/transport.ts`).

## Connection liveness: the tunnel client keeps its own status honest

A KNXnet/IP tunnel can die under a client that never notices: the gateway reboots, the
network drops, or a spec-strict gateway (busforge's own bridge among them) reaps a channel
it has not heard from for 120 s. A read-only bus monitor is the worst case, because on a
quiet bus there is nothing to tunnel and therefore no failing send to reveal the dead
channel. The telegram log simply, silently, stops, while the status stays a green
`connected`.

`KnxIpTunnel` therefore does what the spec (3/8/2 §5.4) asks of a client:

- It sends a **CONNECTIONSTATE_REQUEST every 60 s** on its own channel and waits up to 10 s
  for the CONNECTIONSTATE_RESPONSE, retrying up to three times. Three unanswered requests
  mean the tunnel is dead.
- It **answers an inbound DISCONNECT_REQUEST** with a DISCONNECT_RESPONSE (so the gateway
  stops retransmitting) instead of throwing it away, as it used to.

Either event (a heartbeat gone unanswered or a DISCONNECT_REQUEST from the gateway) is
surfaced through an `onClosed(reason)` callback on `KnxTransport`. `Bus` wires it so the
moment the transport reports closure, `/bus/status` flips from `connected` to `disconnected`
with the reason, instead of reporting the stale value it was handed at connect time. The USB
transport reports closure the same way from its HID error event; a transport that genuinely
cannot detect closure leaves `onClosed` null rather than fake it. This is what makes the
bridge's promise (below: "the client is told rather than left to time out on its own") mean
something on the receiving end.

## KNX USB transport

A KNX USB interface is a vendor-defined HID device exchanging fixed 64-byte
reports. Each report carries:

1. **KNX HID Report Header** (3 bytes): report id `0x01`, packet info (sequence
   number + start/end/partial flags), data length.
2. **KNX USB Transfer Protocol Header** (8 bytes, start frame only): protocol
   version, header length, body length, protocol id, EMI id, manufacturer code.
3. **Body**: either a cEMI frame (Protocol ID `0x01`, EMI id `0x03` = cEMI) or a
   Bus Access Server feature service message (Protocol ID `0x0F`).

`connect()` opens the device, then sets the active EMI type to cEMI via the
feature service and reads it back. Management cEMI (T_Connect, 12-byte memory
chunks) always fits one report, so no fragmentation is needed on send; receive
reassembles defensively. `sendCemi` waits for the interface's `L_Data.con`, with
a timeout so a quiet or absent bus never hangs the caller.

`node-hid` is an `optionalDependency` of `@busforge/knx`, imported lazily inside
`connect()`/`listUsbInterfaces()`. The IP-only deployment (the production NAS
container) therefore never loads the native module. USB is meant for a locally
run server with the interface plugged in; to ship USB in production the device is
passed into the container.

## Discovery

- **KNXnet/IP**: `searchInterfaces()` multicasts a SEARCH_REQUEST to
  `224.0.23.12:3671` and collects SEARCH_RESPONSEs (name, ip, port, IA, MAC). It
  returns `[]` when nothing answers.
- **USB**: `listUsbInterfaces()` enumerates HID devices and keeps KNX-USB ones
  (product name match, or a known vendor id with the vendor-defined usage page).

## The bridge: remote USB

`KnxIpServer` (`packages/knx/src/ipserver.ts`) is the mirror image of `KnxIpTunnel`:
it speaks the *server* side of KNXnet/IP on top of any `KnxTransport`. The
`busforge-bridge` process (`apps/bridge`) binds a KNX-USB interface behind it, so a
stick plugged into one machine becomes an ordinary KNXnet/IP gateway on the LAN.

```bash
bun run apps/bridge/src/index.ts                      # the only attached interface, port 3671
bun run apps/bridge/src/index.ts --usb 147b:5120 \
    --name "Bench" --addresses 1.1.250,1.1.251        # explicit stick, two tunnel addresses
```

It exists for two reasons, and only one of them is convenience:

- **A USB interface can be opened by exactly one process on one machine.** That
  pinned every piece of bus work to the machine the stick is in, and it made the
  bus monitor and a download **mutually exclusive** — the loser failed in a way
  that looked like a bus fault. A KNXnet/IP server *multiplexes*: several tunnels
  share one physical interface, and that failure class disappears.
- ETS and any other KNXnet/IP client can use the same interface.

### Tunnel addresses (the one thing to get right)

Every tunnel needs its **own** individual address: a device's answers are addressed
to the IA that asked, so two tunnels sharing one address would both receive them and
both connection-oriented state machines would be corrupted.

The default pool is therefore exactly one address — the interface's own, read from
its Device Object (`PID_SUBNET_ADDR` 57 + `PID_DEVICE_ADDR` 58) at connect. **One
address means one tunnel**, and a second client is refused with `E_NO_MORE_CONNECTIONS`
rather than quietly corrupted. To get the multiplexing, hand the bridge more addresses
with `--addresses` — they must be **free on that line**, which nothing in the protocol
can verify for us, so it is an explicit operator decision and never inferred.

### What it deliberately refuses

| Request | Answer | Why |
|---|---|---|
| Device-management connection | `E_CONNECTION_TYPE` | Not implemented. A client that believed it was would wait forever. |
| Bus-monitor layer | `E_TUNNELLING_LAYER` | Not implemented. |
| A second tunnel with one address | `E_NO_MORE_CONNECTIONS` | See above. |
| A cEMI that is not `L_Data.req` | tunnel-ACKed, content refused and logged | The ACK is about the datagram; forwarding unknown content to a real bus is not. |
| Starting with an unknown interface address | `BRIDGE_NO_ADDRESS` | A tunnel on 0.0.0 is an address no device can answer to. |

### Protocol details it implements

SEARCH, DESCRIPTION, CONNECT, CONNECTIONSTATE, DISCONNECT, TUNNELLING_REQUEST/ACK.
Sequence numbers run in **both** directions: a client's retransmission (same sequence
number, because its ACK was lost) is acknowledged again but **not put on the bus twice**
— a duplicated memory write is exactly the damage this project exists to avoid. A frame
out of sequence is dropped and not acknowledged. Towards the client, a frame is retried
once after 1 s and the channel is then dropped. A channel that sends no
CONNECTIONSTATE_REQUEST for 120 s is reaped, and the client is told rather than left to
time out on its own.

A client's `L_Data.req` is answered with an `L_Data.con` **whether or not the bus took
it** — with the error bit set when it did not. Withholding the confirmation would leave
the client on a timeout it cannot interpret; sending a clean one would be a lie. What
one client sends is forwarded to the other tunnels as an `L_Data.ind`, exactly as they
would have seen it had a device sent it.

A malformed or truncated datagram is dropped with one log line, never thrown: the socket
is reachable by every host on the LAN, and a parser that overran a short buffer would take
the process down one crafted packet at a time.

### Threat model (it is a bench tool, not a hardened appliance)

The bridge binds UDP `3671` on all interfaces and answers unauthenticated discovery, which
is what KNXnet/IP is: there is no auth in the protocol, and ETS expects exactly this. Two
consequences are worth stating rather than hiding:

- **Discovery reflection.** `SEARCH_REQUEST`/`DESCRIPTION_REQUEST` are answered to the HPAI
  in the request, so a LAN host can aim a ~74-byte response at a third party (about 5x
  amplification). This is spec-conformant behaviour, not a bug, and it is bounded by the LAN.
- **Anyone on the LAN can drive the bus through it.** A tunnel is not authenticated. On a
  shared or hostile network this is a real exposure; the bridge is meant for a trusted bench
  or lab LAN, and the KNX bus behind it is the bench bus, not the house.

Neither is mitigated in code (a subnet restriction would break legitimate cross-subnet ETS
use, which is a normal KNXnet/IP deployment). If the bridge is ever pointed at the house bus
on an untrusted network, put it behind a firewall rule, not behind a hope.

## Connection manager

Connections live in a single global **`connections`** table (the library). A
project does not store connection details; it just **references** one saved
connection via `projects.connection_id` (`ON DELETE SET NULL`, so deleting a
connection clears it from any project using it). This is the single source of
truth: there is no inline copy to drift out of sync.

The earlier inline project columns (`connection_type`, `usb_*`, `interface_ip`,
`interface_port`) are now fully unused (no reader, no writer) and remain only as
migration history.

### One definition of "the project"

Everything that travels with a project is captured in two ways, the full
`.busforge` **export** and config **snapshots**, and both used to hand-pick the
project's columns, so a new project-level setting was easy to add to one and
forget in the other. The project's serializable, project-level **properties** now
have a single definition in `apps/server/src/db/projectProps.ts`:

```ts
export interface ProjectProperties { name: string; connectionId: string | null }
export function readProjectProperties(db, id): ProjectProperties | null
export function applyProjectProperties(db, id, p: ProjectProperties): void
```

Export and snapshots both **read** via `readProjectProperties` and **write** via
`applyProjectProperties`, embedding the whole typed object rather than cherry-
picking fields. Adding a project property is a one-place change in
`projectProps.ts` that flows into export, import, snapshot capture and snapshot
restore at once; neither path can silently omit it.

**Backup / restore semantics.** `connectionId` is a project property, so it is
carried in both the export and snapshots (a backup or restore point should
preserve which connection the project used). The connection's *details* are never
serialized (they live in the global library and are machine-specific). The
reference is only re-applied if that saved connection still exists on the target
system; otherwise it falls away (the foreign key would reject a dangling
reference anyway) and the user picks a connection again. `applyProjectProperties`
enforces this for both import and snapshot restore.

Server endpoints (`apps/server/src/app.ts`):

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/connections` | list saved connections |
| POST | `/api/connections` | create |
| PUT | `/api/connections/:id` | update |
| DELETE | `/api/connections/:id` | delete |
| GET | `/api/connections/discover-ip` | KNXnet/IP search |
| GET | `/api/connections/discover-usb` | scan KNX-USB interfaces |
| PUT | `/api/projects/:id/connection` | point a project at a saved connection (or `null` to clear) |

The UI is split by responsibility:

- **Bus popover** (`TaskIndicator` connection panel): a dropdown that *selects*
  which saved connection the project uses (each option shows an IP/USB icon),
  plus connect/disconnect. No connection editing here.
- **Connection manager dialog** (`apps/web/src/views/ConnectionManager.tsx`):
  *configures* connections (CRUD) with the type toggle, IP fields or USB picker,
  and network/USB discovery.

## Verification status (honest)

- **USB transport, HID/feature level: hardware-verified.** Against a real
  Weinzierl KNX-USB interface (VID `0x147B`, PID `0x5120`): enumerate, open, set
  active EMI to cEMI and read it back, multi-frame reassembly of feature
  responses, clean disconnect. Proven through the UI end-to-end (the picker scans
  and selects the real device).
- **USB transport, bus level: hardware-verified (2026-07-12).** Against a real bus
  through the same Weinzierl/ABB `147B:5120`: broadcast (`A_IndividualAddress_Read`),
  point-to-point `T_Connect` + device-descriptor read + property reads, and
  `L_Data.con` handling. What it took is worth knowing, because the framing was
  correct all along and the bus stayed silent anyway:

  **The interface must be put into Data Link Layer mode, or it transmits nothing.**
  The cEMI server object (interface object type 8) carries a communication mode
  property (PID 52). This interface comes up with it **unset** (reads `0xff`), and in
  that state it accepts every `L_Data.req` handed to it, confirms none of them, and
  puts none of them on the bus. No error, anywhere. Writing `0x00` (Data Link Layer)
  during `connect()` is what makes it transmit; the very first `L_Data.con` this
  transport ever saw arrived immediately after that write. This is standard, not a
  quirk of one stick: the reference stack does the same
  (calimero `KNXNetworkLinkUsb.linkLayerMode()`). `connect()` now establishes the mode
  and **verifies** it, and refuses the interface (`USB_LINK_LAYER_UNAVAILABLE`) if it
  cannot, rather than handing back a transport that silently swallows everything.
- **The interface's own address: hardware-verified (2026-07-14).** The bench
  Weinzierl/ABB `147B:5120` answers `1.1.100` on `PID_SUBNET_ADDR`/`PID_DEVICE_ADDR`.
  `assignedIa` used to be hardcoded to `0`, which is **fine for sending** (a cEMI with
  source 0.0.0 gets the interface's address substituted, which is why point-to-point
  management worked all along) but is not an address a KNXnet/IP server can hand to a
  tunnelling client.
- **A negative `L_Data.con` is a failure: hardware-verified (2026-07-14).** The confirm
  flag in the first control field says whether the frame reached the bus. This transport
  used to treat **any** `L_Data.con` as success, so a frame that never left the interface
  was indistinguishable from a frame no device answered — every read then reported
  "device not answering" and the diagnosis landed on the device instead of on the cable.
  It now fails with `BUS_SEND_FAILED`. This was found by running the bridge against the
  bench bus, and it immediately changed the diagnosis of a bug we had been blaming on a
  device.
- **The bridge: hardware-verified end to end (2026-07-14).** `busforge-bridge` on the bench
  laptop (Fedora, `198.51.100.231`) driving the `147B:5120`, with the busforge server running
  on a **Mac** and reaching it over the LAN. Proven: multicast discovery, tunnel open, address
  assignment (prog-mode and by serial number), and a **full first-time commissioning of a real
  commercial device** — a virgin GVS K-BUS AMMA-04/06.S taken to `verified: true`, byte-matched
  and persistent across a power cycle, entirely through the bridge. So the remote-USB path
  (server on one machine, USB interface on another) is proven for the hardest operation there is,
  not just for reads. Concurrent tunnels (the monitor + a download at once) were exercised with a
  two-address pool. One bug surfaced and was fixed here: the USB transport now **serializes** its
  sends, because the server ACKs a tunnel frame before the bus send completes and a client retry
  could otherwise collide with an in-flight send (it produced ~1787 spurious con-timeouts on one
  download; now zero).
- **KNXnet/IP discovery**: proven against the bridge; finding a third-party gateway is
  still unverified (no IP interface was online).
- **IP transport (client)** remains hardware-proven as before for connect, tunnelling and
  delivery, with one earlier fix (it now delivers only `L_Data.ind` to the upper layer; a
  gateway also tunnels back `L_Data.con` for our own frames, which were being reported as
  incoming telegrams).
- **Connection-state heartbeat + closure signalling: code-level only, not yet hardware-verified.**
  The 60 s CONNECTIONSTATE_REQUEST loop, the inbound-DISCONNECT_REQUEST handler, and the
  `onClosed` path that flips `/bus/status` to `disconnected` are covered by offline tests
  against a scripted socket (`packages/knx/test/ip-tunnel.test.ts`). They have **not** yet
  been proven against a real gateway that reaps a quiet channel, or against the bridge's own
  120 s reap. That is the next hardware check for this path.
