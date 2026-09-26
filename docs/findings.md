# Findings: KNX device programming from scratch

The technical log of reading and flashing real KNX devices without ETS: file formats, wire
layouts, and the non-obvious things that have to be right before any of it works. This log
*is* a large part of the open-source value of this project, so it records the facts and the
mistakes, not the chronology.

Where a fact is about the memory model or the load bracket it lives in
[device-memory-model.md](device-memory-model.md) or
[load-procedures.md](load-procedures.md); what is proven on hardware is in
[status.md](status.md).

---

## 1. The `.knxproj` is self-contained

A `.knxproj` is a ZIP. The **manufacturer application data** (the `.knxprod` equivalent:
`M-XXXX/…_A-….xml`, `knx_master.xml`) sits **in plaintext** in the outer ZIP. Only the
project instance data (`P-XXXX.zip`: topology, devices, parameter values, group addresses) is
encrypted. So the KNX online catalogue is not needed to program a device that is already in a
project.

**ETS6 project decryption** (matches `xknxproject`):

```
winzip_password = base64( PBKDF2-HMAC-SHA256(
    password.encode("utf-16-le"),
    salt = b"21.project.ets.knx.org",
    iterations = 65536, dklen = 32 ) )
```

`P-XXXX.zip` is then a standard WinZip-AES archive opened with that derived password. `0.xml`
inside holds installations, topology, devices, group addresses and com-object instances.

Key relations in `0.xml`:

- `GroupAddress Id="…_GA-n" Address="<16-bit>"`.
- `ComObjectInstanceRef RefId="O-x_R-y" Links="GA-a GA-b …"` links a device's com-object to
  group addresses.
- Device to application via `Hardware2ProgramRefId` to `M-XXXX_A-….xml`.

---

## 2. The device data model

A device's loaded state is a set of **interface objects** with **Load State Machines**
(LSMs), each backed by a memory **segment**:

| LSM / ObjIdx | Segment | Content |
|---|---|---|
| 1 | Address table | group addresses the device uses |
| 2 | Association table | (group index, com-object number) pairs |
| 3 | Com-object table | per-com-object flags and datapoint size |
| 4 | Application / parameter | the parameter image |
| 5 | Interface program | a second application program, if present |

Read a table's base address at runtime with `PropertyValueRead(obj, PID = 7)`, big-endian.
Read the LSM state with `PropertyValueRead(obj, PID = 5)`.

### Table layouts, System B (mask `MV-07B0`), all big-endian

- **Address table**: `[count:2][GA:2] x count`, group addresses sorted ascending.
- **Association table**: `[count:2][groupIdx:2][comObjNum:2] x count` (long form) or 1-byte
  fields (short form). Detect the form by validating that group indices are within the
  address-table count. Entries ordered by com-object number, then group index.
- **Com-object table**: `[count:2][flags:1][typeOrSize:1] x count`, entry i is com-object i
  (1-based).

### Table layouts, System 7 (mask `MV-0705`)

A different layout, reverse-engineered byte for byte off a real device. Counts are **one
byte** and entries are two bytes, so a System B reader misreads the header as a huge count
and every offset by one:

- **Address table**: `[count:1][own IA:2 BE][GA:2 BE x (count-1)]`. The **first entry is the
  device's own individual address**, so a 1-based group index `gi` resolves to the `gi`-th
  group address after it.
- **Association table**: `[count:1][groupIdx:1][comObjNum:1] x count`.

The one-byte counts mean a device with more than 254 group addresses or 255 associations
cannot be represented at all; that is far beyond any real TP device, but it is guarded rather
than silently wrapped.

For the com-object table layouts of both families, and their build rules, see
[device-memory-model.md](device-memory-model.md).

### Parameters

Each `<Parameter>` carries `<Memory CodeSegment="…" Offset="N" BitOffset="M"/>`, and its size
comes from the `ParameterType`'s `SizeInBit`. The value is stored at that offset in the
segment, big-endian for widths of 8 bits and up, as an MSB-first bit field below that.

**Value precedence (verified by byte-match against a real device):** the device instance
value (from `0.xml`'s `ParameterInstanceRef`) if set, otherwise the `Parameter`'s own
`Value`. The `ParameterRef.Value` is a planning/UI-layer default and is **not** the image
source: a device held the parameter default `10`, not the ref value `1280`.

---

## 3. The load procedure (how ETS "downloads")

The authoritative recipe lives in `knx_master.xml` per `MaskVersion`, keyed by
`ProcedureType` (Load/Unload) and `ProcedureSubType` (`all` / `grp` / `par` / `par,grp` /
`cfg`). Manufacturer applications may use a `MergedProcedure`: the master procedure contains
`LdCtrlMerge MergeId="k"` points that are replaced by the product's own `LoadProcedure`
fragments, filtered by `AppliesTo` (`full` vs `par`).

### Group-address download (`MV-07B0`, subtype `grp`), verbatim from the master

```
LdCtrlConnect
LdCtrlUnload 3 / 2 / 1
LdCtrlLoad 3 ; LdCtrlRelSegment 3 Size=2 Mode=0 Fill=0
LdCtrlLoad 1 ; LdCtrlRelSegment 1 Size=2 Mode=0 Fill=0
LdCtrlLoad 2 ; LdCtrlRelSegment 2 Size=2 Mode=0 Fill=0
LdCtrlWriteRelMem 3 / 2 / 1   (Offset=0 Size=0x100000=whole, Verify=true)
LdCtrlLoadCompleted 3 / 2 / 1
LdCtrlMerge 7 ; LdCtrlRestart
```

A `grp` download rewrites **all three** tables: changing a group address can shift
association indices, so ETS always rewrites 1, 2 and 3 together.

### LSM events (property-mapped, `PropertyMappedLsms=1`)

The load **event** is written as the value of `PID 5` (a 10-byte payload whose first byte is
the event):

| Event written to PID 5 | State read back from PID 5 |
|---|---|
| `1` (Load) | `2` (Loading) |
| `2` (LoadCompleted) | `1` (Loaded) |
| `4` (Unload) | `0` (Unloaded) |
| `3` (AdditionalLoadControls / segment operation) | n/a |

Note the asymmetry: the event value written is not the state value read.

### Segment allocation (`LdCtrlRelSegment`)

`PID 5` payload `[0x03, 0x0b, size:4 BE, mode, fill, …]`. `Size=2` in the procedure means
"use the actual data length". After allocation, re-read the segment address via
`PropertyValueRead(obj, 7)` before writing: the device chooses it.

The device pre-fills a freshly allocated segment with `fill` when the fill flag is set
(thelsing/knx `TableObject::additionalLoadControls`: `doFill = data[6] == 1`,
`fillByte = data[7]`). A first-time download wants that, so no byte of a previous application
survives in a region the new one does not write. A parameter-only download must not, because
it rewrites an existing segment.

### Parameter download (`par`): the extra step

The `par` procedure also stamps the application id, so `LoadCompleted` validates the segment:
`LdCtrlWriteProp ObjIdx=4 PropId=13 InlineData=<manuf:2><appNum:2><ver:1>`. A minimal
LSM4-only sequence that works:

```
Unload 4 -> Load 4 -> RelSegment 4 (Mode=0) -> WriteRelMem 4 (+verify)
         -> WriteProp 4/13 (app id) -> LoadCompleted 4 -> Restart
```

### Memory-mapped LSMs (BIM M112, masks MV-0700/0701)

These older masks do not use PID 5 at all: the load control is an `A_Memory_Write` to
StandardMemory `0x0104` with the LSM index in the high nibble of byte 0, and the load status
is an `A_Memory_Read` from `46825 + LsmIdx`. Event and state values are identical to the
property-mapped variant. The control-payload layouts were cross-checked against Kaenx,
bcusdk, selfbus and KNX 03_05_02 and then confirmed empirically on a device:

```
LdCtrlAbsSegment   [(lsm<<4)|3, segType, 0, addr:2, size:2, access, memType, segFlags, 0]
LdCtrlTaskSegment  [(lsm<<4)|3, 2, 0, addr:2, peiType, manuf:2, appNo:2, version]
```

`0x0104` is a control register: it does not read back what was written, so that write must
not be read-back verified.

---

## 4. The connection-oriented transport layer

Connection-oriented KNX management on top of the tunnel. What matters on a busy live bus:

- `T_Connect` (connectionless control to the device).
- Numbered request, then wait for the device's **`T_ACK`** matching our 4-bit sequence, and
  **retransmit** on timeout (the bus drops the occasional ACK).
- On a device data response: **send our `T_ACK` first, then** release the waiter. If the next
  request goes out before our ACK, the device ignores it.
- Increment the 4-bit sequence per transaction.

Short per-operation timeouts (about 1.5 s) so a lost ACK fails fast and the **whole
procedure** is retried on a fresh connection (idempotent when writing identical content),
rather than burning past the device's ~6 s connection timeout and killing the session.

---

## 5. Transport gotchas you must get right

1. **Do not block on the KNXnet/IP `L_Data.con`** (the decisive one). It carries the
   **server** sequence counter, not the client's, so naive matching never succeeds, every
   send stalls for its full timeout, and that starves response handling. The `TunnelingAck`
   already provides flow control; treat the bus confirmation as fire-and-forget.
2. **Stamp the source address.** Outgoing `L_Data` may carry `0.0.0` expecting the interface
   to substitute the tunnel address. Some interfaces do not do this for connection-oriented
   frames, so device replies never route back. Set the source to the assigned tunnel address
   before sending.
3. **`A_Memory_Read` addresses are big-endian.** Sent little-endian, the device reads the
   wrong location (it echoed `A=0010` for a request to `0x1000`).
4. **Verify mode is a trade, not a default.** For a surgical write of a handful of chunks it
   is cleaner to write ack-only and read the owned bytes back. For a full download of a
   21 KB segment a full read-back is roughly 1800 extra telegrams, and there verify mode
   (object 0, `PID_DEVICE_CONTROL` bit 2) earns its keep: the device echoes every write with
   what actually landed, so a dropped write fails at the chunk instead of surfacing a
   thousand telegrams later, and the whole segment can then be confirmed with one
   `PID_MCB_TABLE` CRC read. ETS enables it with a read-modify-write on the device object
   (it reads `0x01` SAFE_STATE on a stopped virgin device and writes `0x05`). Busforge keeps
   read-back verification instead, which is the mechanism its proven paths rest on.
5. **Authorize.** Devices with an access level set need `A_Authorize_Request` (key
   `0xFFFFFFFF` for default/free access) before the load procedure. Devices with no key
   configured accept unauthenticated management.
6. **Handle the UDP socket's asynchronous error channel, and know it is platform-dependent.**
   A `CONNECT_REQUEST` sent to a gateway IP with nothing listening draws an ICMP
   port-unreachable. On **Linux** the kernel delivers that back as `ECONNREFUSED` on the
   datagram socket's `error` event, and with no listener the runtime rethrows it as an
   uncaught exception that crashes the process. On **macOS** the same error is never
   surfaced, so the connect merely times out. Result: a dead gateway "works" on a Mac dev
   machine and **crashes on a Linux CI runner** for identical code. The UDP `connect()` must
   attach an `error` handler and route it like the TCP path does (a coded
   `TUNNEL_CONNECT_FAILED` while connecting, an `onClosed` once the tunnel is up). The
   `send()` callback is not enough: the ICMP error arrives on a later receive, not in the
   send completion.
7. **A CRC-16 "mismatch" may be a convention difference.** Firmware reporting a segment CRC
   via `PID_MCB_TABLE` may use CCITT augmented with 16 zero bits (thelsing/knx) or plain
   CCITT-FALSE. Both are legitimate. Accept either, and only fall back to a full read-back
   when the reported value matches neither. A CRC that matches nothing is not by itself a
   failure verdict.
8. **Chunk sizes are a property of the transport, not of the service.** Over a KNX-USB HID
   interface a request is one report with no fragmentation, so a read (whose data comes back
   in the response) tolerates a much larger chunk than a write (whose data is in the
   request). Oversized writes are simply dropped. See
   [device-memory-model.md](device-memory-model.md), A_MemoryExtended.

---

## 6. Safety lessons (writing to live hardware)

- A real download **unloads segments first**. A crash between Unload and LoadCompleted leaves
  the device "unloaded": still addressable, recoverable by re-flash or ETS, but its function
  is off until reloaded. **The memory DATA survives an unload** (only the load-state flag
  changes).
- Always **back up the segments to disk** before writing. The backups plus an
  identical-content reload are the recovery path (with ETS as the last resort).
- Devices **reject a raw `A_Memory_Write` into a loaded segment**: the load state machine has
  to be driven. That is good news, because stray writes cannot corrupt a device.
- The parameter segment (LSM4) is more critical than the address tables; treat it with more
  care.
- Prefer testing write procedures against KNX Virtual or a quiet bus before live hardware.

---

## 7. A group-address flash must rewrite the com-object table, not just the group tables

A "group address" flash, the surgical download that changes which group addresses an object
talks on, writes the address table (L1) and the association table (L2). The obvious
implementation keeps the device's com-object table (L3) untouched: a link change adds or
removes no objects, so why rewrite L3?

Because **L3 carries a per-object Communication flag, and ETS clears it on every object
without a link** (byte-verified against an ETS-programmed device). So an object that was
**unlinked at the last full download holds `comm=0`** in the device's L3. Writing only L1+L2
to link it then points a group address at an object whose L3 still says "does not
communicate". The device happily **acknowledges telegrams** to that group address (the
address is in L1, so the data-link layer ACKs), and the read-back **verifies green** (the
group tables match our image), yet the object is **functionally deaf**: it neither answers a
`GroupValueRead` nor transmits on change. A textbook case of green not meaning
device-correct.

Three runs on a System B actuator isolated it: a full download that already carried the links
produced a status object that transmitted and answered reads; a baseline download without them
followed by a GA flash that added them produced an object silent in both directions; the same GA
flash rewriting L3 brought it back. The switch relay clacked in every case, so neither the write
path nor the device's reaction was ever in doubt: only the object linked purely by a GA flash was
dead, and it came alive the instant L3 was rewritten with its Communication flag set. Which
devices hold this proof is in [status.md](status.md).

**The fix:** the System B GA flash rebuilds L3 from the current link set and writes
**L3+L1+L2 in one bracket**. It stays surgical, because those three are small tables, so it
never touches the large parameter image, which is why a mere link change is not promoted to a
full download. The staleness gate still guarantees the only L3 change is link-driven, so a
pure re-point of an already-linked object writes L3 byte-identical (a no-op).

**One behaviour change to keep in mind.** The GA flash used to write the device's own L3 back
verbatim; it now **re-authors L3 from Busforge's model** of the com-object table. On a device
Busforge itself programmed that is byte-identical apart from the link-driven flags. But a
device last programmed elsewhere (by ETS, or with drifted parameters) may hold an L3 that
differs in non-link bytes, and a GA flash now rewrites those objects too, then verifies green
against Busforge's own table. So after a GA flash the device's L3 is Busforge's, not whatever it
held before, which is the standing verify-versus-ETS gap ([verification.md](verification.md))
reaching the GA path.

**The System 7 twin is deliberately not fixed the same way.** The MV-0705 GA flash still
writes only the address and association tables and keeps the device's L3, whose config byte
carries a per-object `linked` bit, because the System B deadness has not been reproduced there:
the case that would actually depend on that bit is a **transmit-only object with no read flag**,
and extending the L3 rewrite without that evidence would be guessing. Proof state in
[status.md](status.md), the open item in [roadmap.md](roadmap.md).

**The general lesson:** flash exactly the segments that diverge from the device, at segment
granularity, and do not fall back to a full download for a change that only moves L1/L2/L3.
And a read-back verify is a **placement** proof, never a **behaviour** proof: a link can be
byte-perfect and still deaf, which is why the smoke framework observes the bus. It was the
behaviour check, not the read-back, that caught this.

## 8. `LegacyPatchAlways` means "always write the value", not "leave it to ETS"

The application-program attribute `LegacyPatchAlways="true"` marks a parameter ETS writes into the
image on every download, over the `<Data>` byte, even when the value is the default. Busforge read
it the other way round, as an ETS-internal marker it must not author, and left such parameters out
of the image model. Two independent sources show what ETS does:

- **ETS captures.** Two ETS full downloads of the MDT BE-02001.02 write `0x1e` (30 ms, the
  parameter's value) at the debounce time `P-7`, whose `<Data>` byte is `0x32` (50 ms). `P-7` is a
  visible, editable parameter, so a user's debounce setting never reached the device either.
- **House devices ETS commissioned.** Three Theben MIX actuators (application
  `M-0048_A-493B-21-B471`) hold the parameter values at all three of their `LegacyPatchAlways`
  parameters (3, 15 and the "Download erfolgt" bit), where Busforge's image had `0`.

The earlier exclusion had raised the owned-byte match on a Theben device only because it removed
those bytes from the comparison. `LegacyPatchAlways` parameters are now built and owned like any
other; `tools/etsdiff.ts` matches the MDT captures byte for byte.

## 9. Several ParameterRefs of one Parameter share one value

An application may reference one parameter through several ParameterRefs with different `Value`
attributes. The Jung 400021SE's seconds field (`P-505`) has `R-107` (no Value, so the parameter's
default 5), shown while the minutes field is 0, and `R-1` (`Value="0"`), shown while it is not.
Both are tested by chooses that pick one of two union members for the milliseconds field.

A ref's `Value` is the default of that ref when it is the one shown; it is not a separate value.
ETS showed it directly: switching the minutes to 1 set the seconds to 0 once, and ETS's export then
stored a value only for the minutes; the seconds written (0) came from `R-1`'s default. With the
minutes at 0 it evaluated the choose on `R-1` as 5, the shared value, and wrote the union member
for 5 seconds (0 ms). Busforge evaluated `R-1` with its own default 0, activated the other member
too, and wrote 100 ms over it.

So a parameter has one value: one stored on a placed ref, else one stored on any of its refs, else
the default of the placed ref. A placed ref with nothing stored keeps its own default, because
applications select an internal parameter's value by which ref an active branch places; when
several refs with different defaults are placed, each keeps its own, since which one ETS would use
is unknown. Which refs are placed is determined once, by walking the tree until the placement no
longer changes, and every pass (the view and the image) reads the same placement. Among the
bundled applications only the Jung changes.
