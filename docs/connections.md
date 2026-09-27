# Bus connections

Busforge reaches the KNX bus through a transport abstraction, so the same commissioning logic
(read-back, parameter flash, group-table flash, full download, the bus monitor) runs unchanged
whether the bus is reached over KNXnet/IP or a KNX-USB interface. A connection library lets you save
reusable connections and point each project at one.

What is proven on real hardware and what is not is in [status.md](status.md).

## Three ways to the bus

| Way | Connection type | What it is |
|---|---|---|
| **KNX-IP interface** | `ip` | A KNXnet/IP gateway on the network. |
| **Local USB** | `usb` | A KNX-USB interface plugged into the machine Busforge runs on. |
| **Remote USB** | `ip` | A KNX-USB interface plugged into a *different* machine, put on the network by `busforge-bridge`. |

The third is not a fourth transport. The bridge **is** a KNXnet/IP server, so from the client's side
it is an ordinary gateway and the `ip` transport reaches it unchanged. Nothing about the local-USB
path changes because the bridge exists.

## Architecture

Everything above the transport speaks plain cEMI `L_Data` and never knows the medium. One seam,
`KnxTransport`, sits under the device layer, the load procedures and the bus monitor:

![Busforge's three ways to reach the KNX bus: local USB, a KNX-IP interface, and remote USB via the bridge](connections-transports.svg)

```ts
export interface KnxTransport {
  readonly assignedIa: number;
  onCemi: ((src: number, dst: number, tpdu: Buffer, isGroup: boolean) => void) | null;
  onRawCemi?: ((cemi: Buffer) => void) | null;
  onClosed: ((reason: string) => void) | null;
  connect(): Promise<void>;
  sendCemi(cemi: Buffer): Promise<void>;
  disconnect(): Promise<void>;
}
```

`KnxIpTunnel` and `KnxUsbTransport` are the two implementations. Incoming frames from either are
decoded by the shared `parseCemiLData` helper, so both surface identical callbacks. The server picks
the concrete transport from the project's selected connection with `makeTransport(connection)`.

## The IP transport: auto, TCP or UDP

KNXnet/IP tunnelling runs over UDP (the classic transport) or TCP (KNXnet/IP Core v2). A saved IP
connection carries an `ipTransport` field:

| Value | Behaviour |
|---|---|
| `auto` (default) | Try TCP first; fall back to UDP **only** when the TCP connect is refused or unreachable. |
| `tcp` | Force TCP tunnelling. |
| `udp` | Force classic UDP tunnelling. |

TCP is preferred because it is what makes a gateway reachable through an SSH forward or on a
multi-homed host, where UDP source-address selection sends the datagrams out of the wrong interface
and the gateway never answers. UDP stays the fallback for gateways that speak only UDP.

The `auto` wrapper decides at connect time and falls back **only** on a `TUNNEL_CONNECT_FAILED`.
Any other error (a rejected channel, a protocol failure, a timeout after the socket was already up)
propagates unchanged, so a real bus fault is never masked as "the gateway must only speak UDP".
The wrapper forwards the receive callbacks to the tunnel it opened whenever they are set, also after
the connect: a device session installs its own on a connected transport.

**Over TCP there is no tunnelling acknowledgement** (KNXnet/IP Tunnelling v2). The client writes each
TUNNELLING_REQUEST once and neither waits for a TUNNELLING_ACK nor sends one for a request it
receives; a real KNX IP interface (MDT SCN-IP000.03) sends none, and waiting for one failed every
operation with `TUNNEL_ACK_TIMEOUT`. Busforge's own bridge still acknowledges a TCP client's
requests, which the client ignores. Over UDP the acknowledge-and-retransmit loop runs as before.

### Liveness: the client keeps its own status honest

A tunnel can die under a client that never notices: the gateway reboots, the network drops, or a
spec-strict gateway reaps a channel it has not heard from. A read-only bus monitor is the worst case,
because on a quiet bus there is nothing to tunnel and therefore no failing send to reveal the dead
channel. The telegram log would simply, silently, stop while the status stayed green.

- **On UDP**, the client sends a CONNECTIONSTATE_REQUEST every 60 s and waits up to 10 s for the
  response, retrying three times. Three unanswered requests mean the tunnel is dead.
- **On TCP**, no heartbeat is armed: the socket's own liveness stands in for it, and a closed or
  desynchronised stream is reported directly.
- Either way, an inbound DISCONNECT_REQUEST is **answered** with a DISCONNECT_RESPONSE (so the
  gateway stops retransmitting) and then treated as closure.

Closure is surfaced through `onClosed(reason)`. The bus wires it so that the moment the transport
reports closure, the status flips from connected to disconnected with the reason, instead of
reporting the stale value it was handed at connect time. The USB transport reports closure the same
way from its HID error event. **A transport that genuinely cannot detect closure leaves `onClosed`
null rather than fake it.**

Only `L_Data.ind` is delivered upward. A gateway also tunnels back the `L_Data.con` of our own
frames, and those are not incoming telegrams.

## The USB transport

A KNX-USB interface is a vendor-defined HID device exchanging fixed 64-byte reports. Each report
carries a KNX HID report header (report id, sequence number, start/end flags, data length), a
transfer-protocol header on the start frame (protocol version, body length, protocol id, EMI id,
manufacturer code), and a body that is either a cEMI frame or a Bus Access Server feature message.

`connect()` does four things:

1. Open the HID device.
2. Set the active EMI type to cEMI through the feature service and read it back. This is best
   effort: some interfaces do not implement it and work anyway.
3. **Enter Data Link Layer mode, and verify it.** This step is mandatory and is the reason the
   transport exists in this shape. The cEMI server object carries a communication-mode property that
   an interface may come up with *unset*. In that state it accepts every frame handed to it, confirms
   none of them, and puts none of them on the bus, with no error anywhere. Writing the Data Link
   Layer mode is what makes it transmit. If the mode cannot be established and confirmed, the
   interface is refused with `USB_LINK_LAYER_UNAVAILABLE` rather than handed back as a transport that
   silently swallows everything.
4. Read the interface's own individual address and serial number from its Device Object. The address
   matters because it is the only one a KNXnet/IP server can hand to a tunnelling client, and because
   of the point-to-point limit described below.

Sends are **serialised** through a chain. The queue is not politeness: a second send while a
confirmation is outstanding clobbers it. `sendCemi` waits for the interface's `L_Data.con` and
distinguishes two failures that used to look identical: no confirmation at all
(`USB_SEND_NOT_CONFIRMED`) and a confirmation with the error bit set, meaning the frame never left
the interface (`BUS_SEND_FAILED`). Conflating them sends every diagnosis to the wrong place: at the
device, when the real fault is the cable.

Management cEMI (a connect, a memory chunk) always fits one report, so nothing is fragmented on
send; receive reassembles defensively.

`node-hid` is an **optional dependency**, imported lazily inside `connect()` and the interface scan.
An IP-only deployment therefore never loads the native module. USB is meant for a server running on
the machine the interface is plugged into; in a container the device has to be passed through.

## Discovery

- **KNXnet/IP:** multicast a SEARCH_REQUEST and collect the responses (name, address, port,
  individual address, MAC). No answer returns an empty list; a socket failure **rejects**, and the
  API reports `DISCOVERY_FAILED`. The two are deliberately not the same thing.
- **USB:** enumerate HID devices and keep the KNX ones, by product-name match or by a known vendor
  id together with the vendor-defined usage page.

## The bridge: a local USB interface on the network

`KnxIpServer` is the mirror image of the tunnel client: it speaks the *server* side of KNXnet/IP on
top of any `KnxTransport`. The `busforge-bridge` process (`apps/bridge`) binds a KNX-USB interface
behind it, so an interface plugged into one machine becomes an ordinary KNXnet/IP gateway on the
network.

```bash
bun run apps/bridge/src/index.ts                        # the only attached interface, port 3671
bun run apps/bridge/src/index.ts --usb 1234:5678 \
    --name "Workshop" --addresses 1.1.250,1.1.251       # explicit interface, two tunnel addresses
```

Flags: `--port`, `--name`, `--usb vid:pid`, `--usb-path`, `--addresses`. The interface selection
refuses rather than guesses: nothing found, the given path or id not found, an ambiguous id, or
several interfaces attached without `--usb-path` all exit with a message.

It exists for two reasons, and only one of them is convenience:

- **A USB interface can be opened by exactly one process on one machine.** That pins every piece of
  bus work to the machine the interface is in, and it makes the bus monitor and a download mutually
  exclusive, with the loser failing in a way that looks like a bus fault. A KNXnet/IP server
  *multiplexes*: several tunnels share one physical interface, and that failure class disappears.
- Any other KNXnet/IP client, ETS included, can use the same interface.

### Tunnel addresses

Every tunnel needs its **own** individual address. A device's answers are addressed to the address
that asked, so two tunnels sharing one would both receive them and both connection-oriented state
machines would be corrupted.

The default pool is therefore exactly one address: the interface's own, read from its Device Object
at connect. **One address means one tunnel**, and a second client is refused with
`E_NO_MORE_CONNECTIONS` rather than quietly corrupted. To get the multiplexing, hand the bridge more
addresses with `--addresses`. They must be **free on that line**, which nothing in the protocol can
verify, so it is an explicit operator decision and is never inferred.

#### The USB limit: extra addresses carry group traffic only

A KNX-USB interface surfaces to the host only two kinds of incoming telegram: group and broadcast
(always), and connection-oriented point-to-point telegrams addressed to **its own individual
address** and no other. This is the interface behaving as one KNX device with one address. Neither
the bridge nor the USB transport filters anything, and no step in this stack reconfigures the
interface's address filter.

The consequence is sharp. With a pool that does not contain the interface's own address, broadcast
work still succeeds (a programming-mode scan, an address assignment) while **every** connection-
oriented operation fails with `DEVICE_NOT_ANSWERING`: the device answers on the bus, and its reply is
dropped by the USB interface before it reaches the host. It looks exactly like a dead device.

So where this applies, **device management works only on the interface's own address, i.e. exactly
one tunnel.** Extra addresses are usable for passive and group multiplexing (a second client
watching the bus) but never for a second programming client.

This is a property of the USB controller, not of the bridge, and a real KNXnet/IP router does not
have the limit at all. Which interfaces it has been observed on is in [status.md](status.md); it is
not claimed of any other. That is why the multiplexing is kept: it is correct where the hardware
supports it and harmless where it does not.

### Speaking enough KNXnet/IP for ETS

ETS is stricter than Busforge's own client. Six things were needed to make it use the bridge as an
interface, each of them a real interoperability constraint worth knowing:

- **Advertise Core service family v2.** Tunnelling over TCP is a Core-v2 feature. On Core v1, ETS
  does the description exchange over TCP and then gives up without ever sending a connect request.
- **Serve the local device-management connection.** ETS opens a device-management connection
  alongside its tunnel and reads the interface's own interface-object properties over it. Refusing it
  makes ETS abort the whole session. The bridge answers the two hard requirements (maximum APDU
  length and the device descriptor), plus the medium type and the list of additional individual
  addresses.
- **Do not run the UDP acknowledge-and-retransmit loop on a TCP channel.** Over TCP the transport is
  already reliable and ETS deliberately sends no tunnelling acknowledgements. Waiting for them drops
  the client the instant the first bus telegram reaches it.
- **Do not apply UDP duplicate detection to a TCP channel.** ETS over TCP leaves the tunnelling
  sequence counter at 0 on every frame, because TCP already guarantees order and non-duplication.
  UDP-style deduplication then reads every frame after the first as a retransmission and drops it
  (acknowledged, never put on the bus), stalling a download after its very first telegram. On TCP the
  bridge acknowledges and processes every frame; a duplicated memory write stays impossible, because
  TCP does not duplicate and the device's own transport-layer sequence rejects a repeat.
- **Hand out more than one tunnel address.** ETS keeps a persistent interface tunnel *and* opens a
  second one for the group monitor. With a single address the second gets `E_NO_MORE_CONNECTIONS`.
- **Route point-to-point management through the interface's own address.** Because of the USB limit
  above, the bridge sends a point-to-point frame sourced from the interface's own address, records
  which channel owns the conversation with that device, and routes the reply back to that channel with
  the destination rewritten to its tunnel address. The client never sees it. Group and broadcast
  frames are never touched.

### What the bridge implements, and what it refuses

Implemented: SEARCH, DESCRIPTION, CONNECT, CONNECTIONSTATE, DISCONNECT, TUNNELLING_REQUEST/ACK, and
DEVICE_CONFIGURATION_REQUEST/ACK for the local device-management connection. It listens on **both**
UDP and TCP on the same port.

| Request | Answer | Why |
|---|---|---|
| Bus-monitor layer | `E_TUNNELLING_LAYER` | Not implemented (a USB interface in data-link mode cannot passively monitor the whole line anyway). |
| A connection type that is neither tunnelling nor device management | `E_CONNECTION_TYPE` | Not implemented. |
| A second tunnel when the address pool is exhausted | `E_NO_MORE_CONNECTIONS` | One address per tunnel. |
| A property **write** over device management | property-error response | The bridge exposes its own properties read-only. |
| A cEMI that is not `L_Data.req` | tunnel-acknowledged, content refused and logged | The acknowledgement is about the datagram; forwarding unknown content to a real bus is not. |
| Starting with an unknown interface address | `BRIDGE_NO_ADDRESS` | A tunnel on 0.0.0 is an address no device can answer to. |
| Starting with no usable local IPv4 address | `BRIDGE_NO_LOCAL_ADDRESS` | It could not advertise a reachable endpoint. |

On UDP, sequence numbers run in **both** directions: a client's retransmission (same sequence number,
because its acknowledgement was lost) is acknowledged again but **not put on the bus twice**, because
a duplicated memory write is exactly the damage this project exists to avoid. A frame out of sequence
is dropped and not acknowledged. Towards the client a frame is retried once and the channel is then
dropped, and a channel silent for 120 s is reaped with the client told rather than left to time out.
TCP channels do neither: the socket carries both guarantees, and a TCP channel ends when its socket
does.

A client's `L_Data.req` is answered with an `L_Data.con` **whether or not the bus took it**, with the
error bit set when it did not. Withholding the confirmation would leave the client on a timeout it
cannot interpret; sending a clean one would be a lie. What one client sends is forwarded to the other
tunnels as an `L_Data.ind`, exactly as they would have seen it had a device sent it.

A malformed or truncated datagram is dropped with one log line, never thrown: the socket is reachable
by every host on the network, and a parser that overran a short buffer would take the process down
one crafted packet at a time.

### Threat model

The bridge binds UDP and TCP on the KNXnet/IP port on all interfaces and answers unauthenticated
discovery, which is what KNXnet/IP is: there is no authentication in the protocol, and ETS expects
exactly this. Two consequences are worth stating rather than hiding:

- **Discovery reflection.** Search and description requests are answered to the endpoint named *in
  the request*, so a host on the network can aim a small response at a third party (roughly five-fold
  amplification). Spec-conformant behaviour, not a bug, and bounded by the local network.
- **Anyone who can reach it can drive the bus through it.** A tunnel is not authenticated.

Neither is mitigated in code, because a subnet restriction would break legitimate cross-subnet ETS
use, which is a normal KNXnet/IP deployment. The bridge is a tool for a trusted network. Pointing it
at a bus that matters from an untrusted network needs a firewall rule, not a hope.

## The connection library

Connections live in a single global `connections` table. A project does **not** store connection
details; it references one saved connection, and deleting a connection clears it from any project
using it. There is no inline copy to drift out of sync.

A connection carries a type (`ip` or `usb`), and for IP a host, a port and the transport preference;
for USB the vendor and product id.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/connections` | list saved connections |
| POST | `/api/connections` | create |
| PUT | `/api/connections/:id` | update |
| DELETE | `/api/connections/:id` | delete |
| GET | `/api/connections/discover-ip` | KNXnet/IP search |
| GET | `/api/connections/discover-usb` | scan for KNX-USB interfaces |
| PUT | `/api/projects/:id/connection` | point a project at a saved connection, or `null` to clear |

The UI is split by responsibility:

- **The bus popover** in the header *selects* which saved connection the project uses and connects
  or disconnects. No editing there, and the selection is locked while a connection is open.
- **The connection manager dialog** *configures* connections: the type toggle, IP fields with the
  transport preference, the USB picker, and both discovery scans. A stored interface that is not
  currently attached stays selectable rather than disappearing.

## Configuring one

1. Open the bus popover in the project header and choose **Manage connections**.
2. Pick the type. For **IP**, run the network scan or type the gateway address and port, and leave
   the transport on `auto` unless a gateway is known to need otherwise. For **USB**, run the USB scan
   and pick the interface.
3. Save it, then select it in the popover and connect. The indicator shows the live status and the
   reason if the connection closes.

For a remote USB interface, run `busforge-bridge` on the machine the interface is plugged into and
add it as an ordinary **IP** connection pointing at that machine.
