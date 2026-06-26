# Bus connections (IP and USB)

Busforge reaches the KNX bus through a transport abstraction, so the same
commissioning logic (read-back, parameter flash, group-table flash, the bus
monitor) runs unchanged whether the bus is reached over KNXnet/IP or a KNX USB
interface. A connection manager lets you save reusable connections and assign one
to each project.

## Architecture

Everything above the transport speaks plain cEMI L_Data and never knows the
medium:

```
KnxDevice (T_Connect, numbered requests, memory/property read+write)
flash load procedures (LSM brackets, surgical owned-byte writes)
Bus (group-telegram monitor)
        |
        v  cEMI L_Data in/out
+-----------------------------+
|        KnxTransport         |   interface: connect / sendCemi / onCemi / disconnect / assignedIa
+--------------+--------------+
               |
       +-------+--------+
       |                |
  KnxIpTunnel      KnxUsbTransport
  (KNXnet/IP        (KNX USB Transfer
   tunnelling,       Protocol over HID,
   UDP 3671)         node-hid)
```

`KnxTransport` (`packages/knx/src/transport.ts`) is the seam. `KnxIpTunnel`
already provided this surface; `KnxUsbTransport` is the second implementation.
Incoming frames from either are decoded by the shared `parseCemiLData` helper, so
both transports surface identical `(src, dst, tpdu, isGroup)` callbacks.

The server picks the concrete transport from a project's selected connection with
`makeTransport(connection)` (`apps/server/src/transport.ts`).

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

## Connection manager

Connections live in a single global **`connections`** table (the library). A
project does not store connection details; it just **references** one saved
connection via `projects.connection_id` (`ON DELETE SET NULL`, so deleting a
connection clears it from any project using it). This is the single source of
truth: there is no inline copy to drift out of sync.

The earlier inline project columns (`connection_type`, `usb_*`, `interface_ip`,
`interface_port`) are kept only so the `.busforge` export format and snapshots
stay byte-stable; they no longer drive the active connection.

**Export/backup.** A project's `connection_id` is a project property, so it is
carried in the `.busforge` export (a backup should preserve which connection the
project used). The connection's *details* are never exported (they live in the
global library and are machine-specific). On import the reference is re-applied
only if that saved connection still exists on the target system; otherwise it
falls away (the FK would reject a dangling reference anyway) and the user simply
picks a connection again.

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
- **USB transport, bus level: NOT yet verified.** No bus was attached during
  development, so an actual `L_Data` round-trip (T_Connect to a device, memory
  read/write, `L_Data.con`/`.ind`) over USB is unproven. The framing is correct
  by construction and mirrors the IP path, but per the project's honest bar this
  is not "supported" until byte-verified against a device on a real bus.
- **KNXnet/IP discovery**: returns cleanly with no gateway present; finding a real
  gateway is unverified (no IP interface was online).
- **IP transport** is unchanged and remains hardware-proven as before.
