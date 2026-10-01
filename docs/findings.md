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

1. **Do not match the KNXnet/IP `L_Data.con` by sequence** (the decisive one). It carries the
   **server** sequence counter, not the client's, so naive matching never succeeds, every
   send stalls for its full timeout, and that starves response handling. Over UDP the
   `TunnelingAck` provides flow control and the confirmation is not awaited; over TCP Busforge waits
   for it, matched by destination and TPDU (§25).
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

**System 7 does the same, because ETS does.** Its L3 config byte carries a per-object `linked`
bit, and ETS partial downloads after a link change rewrite L3 with the group tables on both LSM
styles (MDT BE-02001.02 property-mapped: the whole table; ABB US/U 4.2 memory-mapped: only the
changed config bytes; 2026-09-26). Where the application names the L3 segment, the System 7 GA
flash reads the table the device holds, changes only each object's linked bit and writes
L3+L1+L2 in one bracket. On a device holding the table its last full download wrote, that is
ETS's bytes.

**And on System 7 such an object comes alive (MDT BE-02001.02, 2026-10-01).** Input A set to
"switch / toggle when closing" gives object 1, "Status for toggle": no read flag, transmit flag, and
with the device-wide "Status for toggle: request" the device sends a GroupValueRead on it after every
start. A full download with the object unlinked, then a restart: no group telegram from the device. A
GA flash that linked only that object to 0/0/250 (9 bytes differed: the linked bit and the group
tables), then a restart from a separate witness connection: `1.1.56 -> 0/0/250 GroupValueRead` 2.3 s
later. So an object linked purely by the System 7 GA flash transmits, which is what the linked bit
decides. Not shown on the memory-mapped ABB US/U 4.2.

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

## 10. `ParameterByteOrder="LittleEndian"` reverses multi-byte parameters

An application's `<Options>` may declare `ParameterByteOrder="LittleEndian"` (the ABB US/U 4.2
does). ETS then writes a multi-byte parameter least significant byte first: a 16-bit value of 450
lands as `c2 01`, not `01 c2` (2026-09-26 partial-download capture). Busforge applies it to
byte-aligned integer parameters whose width is a whole number of bytes. A float, or a
little-endian field that does not start on a byte boundary, is refused: no capture shows how ETS
places one, and reversing it by guess would write a plausible wrong value.

## 11. A choose on a union member nothing places takes its default branch

Unions overlay several parameters on the same bytes; only the member an active branch places is
meaningful. On the GVS AMMA a choose tests a union member that no active branch places. Evaluated
with that member's default, it took a branch that activated three com-objects (5, 6, 8); ETS
leaves them out (2026-09-26 partial-download capture). So a choose on a union member that is not
placed and has no stored value takes only its default branch. A stored value on such a member
still counts; the capture shows only the case without one, so that half is an assumption. The
rule is narrow on purpose: a broader variant (every unplaced ref) changed the image of another
bundled application at its defaults, with no capture to justify it.

## 12. A parameter owns bits, not the byte it shares

Several parameters, and union members, share one byte. The parameter flash used to own every
byte a written parameter touched and fill the byte's other bits from the application's `<Data>`
template. On the GVS AMMA (2026-09-26, bench) byte 64 holds "Output 3&4 function" in its top two
bits and that channel's unions in the rest. With the channel disabled the unions are idle; the
full download writes their `DefaultUnionParameter` (0), as ETS does, but a later parameter flash
wrote the template's 1s beside the two owned bits (`00` became `3f`). The read-back passed,
because the device held exactly what was written. The firmware did not ignore those bits: at the
next group-address flash it set the Communication, Read and Transmit flags of object 8 in the
com-object table by itself while the table was written, so the table read back `4f` where
Busforge wrote `00`.

So ownership is a bit mask per byte on both memory models: a written byte takes the owned bits
from Busforge's image and every other bit from the device, and the read-back compares only the
owned bits. The full download still writes whole bytes; its image is compared with ETS captures.

## 13. Write a device the way ETS does: confirmed, when it says it can take it

The classic `A_Memory_Write` is answered only by the transport layer's T_ACK, which a device
sends before its firmware has stored the bytes. On the GVS AMMA (2026-09-26, bench), writing the
1066-byte com-object table right after reallocating its segment left one byte wrong every time:
0x3786 held the value just written to 0x377a, twelve bytes (one chunk) earlier. Every frame on
the wire was correct and acknowledged (logged through a proxy); written slowly, the table landed
exactly. The device was being overtaken.

ETS never writes that device classically. It reads `PID_MAX_APDU_LENGTH` (device object, PID 56)
after the descriptor, and on a device that answers it (GVS AMMA 55, Jung 400021SE 233) it uses
the confirmed `A_MemoryExtended_Write` at every address, waiting for each write response; on
the ABB US/U 4.2 and MDT BE-02001.02, which do not implement the property, it writes classic.
Its first chunk size on the GVS, 50 bytes, is the maximum APDU minus the 5 octets around the
data; the USB interface refused that frame and ETS continued with 35. Busforge now makes the
same choice from the same property, with its own transport limit as the second bound, and the
table lands exactly.

## 14. What ETS writes in a partial download, and what Busforge writes

The four partial-download captures of 2026-09-26 show one rule per device family, derived from
which bytes changed between the two configurations and which ETS wrote:

| Family (bench device) | ETS reads first | Parameter segment | Group and com-object tables |
|---|---|---|---|
| System B (GVS AMMA, Jung 400021SE) | nothing | unload, realloc **without** fill, then exactly the bytes its parameter model owns (GVS 229 of 2816, Jung 186 of 7701), idle unions' `DefaultUnionParameter` included | reallocated and written whole |
| System 7 memory-mapped (ABB US/U 4.2) | the tables and parameters | only the bytes that differ from the device | only the bytes that differ (2, 1 and 2) |
| System 7 property-mapped (MDT BE-02001.02) | one read | (no parameter change) | written whole, the own individual address excepted |

Busforge follows the same rules. The System B parameter flash owns the idle unions' defaults
too and writes only the bytes holding an owned bit, each read back as it is written. It relies on
the device keeping the rest across the reallocation, as ETS does, only while the segment stays at
its old address; if the allocation moves it, the whole image is written. Its final read-back
checks every byte of the segment against the image or against the read before the flash. The memory-mapped System 7 group-address
flash reads the tables at their new length and writes only the differing bytes; the
property-mapped one writes whole tables, the individual address included (ETS skips those two
bytes; they hold the same value). The parameter
flash on System 7 already wrote only owned bytes that differ. `tools/etsdiff.test.ts` holds the
System B parameter bytes against the captures, address and value. All four bench devices pass both
smoke channels with persistence on the build that introduced these rules (`50d6b80`, 2026-09-27,
evidence/runs/2026-09-27); the GVS parameter flash took about 77 s
instead of 96-116 s. The byte-level ETS comparison of the partial downloads lives in tests only; no
reference evidence record is emitted for it yet.

## 15. Tunnelling over TCP has no acknowledgement, and the bench bridge hid it

Against the house's MDT SCN-IP000.03, every operation over a TCP tunnel failed with
`TUNNEL_ACK_TIMEOUT`, and the `auto` transport (TCP first) never read a single device answer. Two
client faults, both invisible on the bench:

- **The client waited for a TUNNELLING_ACK over TCP.** KNXnet/IP Tunnelling v2 uses none on TCP (xknx's
  `TCPTunnel` neither waits for one nor sends one; ETS sends none to the bench bridge either). The
  bridge acknowledges every TCP request anyway, so against it the wait always ended. The client now
  writes each request once and acknowledges nothing over TCP.
- **The `auto` wrapper copied the receive callbacks only at connect time.** A device session installs
  its `onCemi` on the already connected transport, so the device's answers never reached it (the
  capture showed 1.1.x answering its descriptor read correctly, T_ACK and all, and Busforge timing
  out). The bench connection is pinned to `tcp`, which bypasses the wrapper.

With both fixed, a full read-back of the OpenKNX RaumController 1.1.x over the house interface
completed over `auto` (TCP) (operator observation, no evidence record).

What the TCP client gives up with the acknowledgement: a per-frame sign of a half-open link, since a
socket write does not fail on a dead peer. The connection-state heartbeat (which the client runs on
TCP too, see §23) notices a dead link within about 90 s. In between, the client now waits for the
interface's `L_Data.con` on every send, matched by destination and TPDU, not by sequence (§25).

## 16. OpenKNX reads its flash, not what was just written

The first surgical parameter flash on an OpenKNX device (the house's RaumController 1.1.x,
one byte: a channel's start delay 1 to 2 s) stopped with `FLASH_VERIFY_MISMATCH`: the
confirmed `A_MemoryExtended_Write` of the 73 owned bytes was answered with success for every chunk,
and the read straight after it still showed the old value in the last byte. About a minute later a
read showed the new one. The flash had stopped before LoadCompleted, so the parameter load-state
machine stayed Loading and the application did not run.

The firmware explains it (OpenKNX/knx and thelsing/knx `master`, same logic): `BauSystemB`
answers both memory write services right after `Memory::writeMemory`, which on a flash platform
copies the bytes into a RAM buffer of one erase block and returns. The buffer reaches the flash only
on a commit (from the restart request, "flush the EEPROM before resetting") or when a later write
moves to another erase block. Both memory read services read the flash itself through
`toAbsolute` (XIP on the RP2040). So any read-back before the restart can show old bytes. The
classic write's verify mode never caught it because its echo is a copy of the request data, not a
read.

What changed:

- **No read-back of a confirmed write before the restart**, as ETS does it: the per-chunk return
  code and the read-back after the restart are the proof. A full download on this device would have
  hit the same wall, since its echo requests had turned into read-backs on the confirmed path.
- **A flash never calls a device "unchanged" while a load-state machine it brackets is not LOADED.**
  The first recovery attempt reported `unchanged` with LSM 4 still Loading; a System B flash now
  runs its bracket to complete the load, a System 7 flash refuses (`DEVICE_LOAD_INCOMPLETE`).
- **Read-back relevance comes from the device's values** (see [verification.md](verification.md)).
  The Busforge project held defaults for this device while the device held its real sensors and
  channels; before the fix, reverting to the device and flashing would have reset 13 bytes.

Recovery that day: the device held its original value again after a second write had been
committed, so a LoadCompleted on LSM 4 and an A_Restart brought it back; all four load-state
machines LOADED, parameter drift zero, and its presence object answered a group read.

With the fixes, the same one-byte change went through: written, committed at the restart, all
four load-state machines LOADED, and a separate read-back after the restart showed the new value.
That flash itself reported an error, because the rebooted device went silent 9 KB into the 21.6 KB
read-back while its application started; the verify now reconnects and reads once more after such a
silence. The revert to the original value then completed as `flashed`, `verified: true`, and the
presence object answered a group read afterwards. Operator observation over the house interface,
no evidence record.


## 17. A module parameter resolves through its module definition, or the baseline never learns it

The bench regression failed on the Jung 400021SE with a seed that swept channel 1's
"Kanalfunktion" (`…_MD-1_M-100_MI-1_P-149_R-142`) from 1 to 8 and back. The value 8 (door/window
status) removes com-objects #253 and #254, so the mutation was correctly promoted to a full
download. The revert was not: it went out as a surgical parameter flash, reported `verified`, and
the device kept the table without #253 and #254. The persistence step caught it after the restart,
because the link the run had placed on #254 was gone from the device.

The cause was one regex. To decide which stored parameters a flash wrote, Busforge maps a
module-instance ref back to its definition, and stripped only `_MI-n`, so
`…_MD-1_M-100_P-149_R-142` never matched the definition `…_MD-1_P-149_R-142`. Every
module-instance parameter of every module device therefore counted as unwritten and kept its old
baseline after any verified download or flash. For "Kanalfunktion", which has no device memory,
the baseline still implied the default after the download that programmed 8, so the com-object
table guard compared 1 with 1 and let the surgical flash through.

The mapping now strips `_M-k_MI-n`, the exact inverse of how the module expansion builds instance
ids (checked over every module fixture: 4384 Jung and 4648 MDT refs, no mismatch). The same seed
on the Jung then promoted the revert to a full download and passed, persistence included. Baselines
written before the fix still lack these parameters; see [roadmap.md](roadmap.md).

## 18. A device in secure mode ignores a plain A_Restart

Busforge's first secured full download of the Jung 400021SE (2026-09-28) wrote every segment and the
security object, closed every load bracket, and then failed with `RESTART_IGNORED`. The decrypted
capture showed why: `sendRestart` built its frame beside the request machine and sent A_Restart in
clear. The device acknowledged it on the transport layer (T_ACK) and then did nothing with it, and
answered the secured descriptor read that followed. A device in secure mode accepts no plain
application service on a secured tool connection, and a T_ACK says only that the frame arrived.

Every numbered service now goes through one wire step (`KnxDevice.onWire`), the restart and the
master reset included. The rerun restarted and verified. The restart check caught it because it
proves the reboot by the device's silence, not by the acknowledgement; a check that trusted the
T_ACK would have called this download done.

Two sizes from the same capture: ETS never sends a secured request longer than 40 octets on the
bench path (after 151-byte frames went unanswered it wrote 22-byte memory chunks and 18-element
property writes, both exactly 40), and Busforge now holds secured writes to that.

## 19. What a factory-fresh secure device demands of the activation

Activating the Jung 400021SE after a physical master reset (2026-09-29) failed three times before it
worked, each time on something only the device could show (the second item below is a precaution
taken on the way, not one of them). None of it was visible against the
already-secured device, and none of it against the decrypted ETS capture read only for its content.

- **An unanswered Sync leaves a transport connection behind.** Trying the stored key first, then the
  factory key on a new link, got a T_ACK and no answer, until the failed attempt was closed with a
  T_Disconnect. This is shown: the same run with only the sequence change below still failed, and
  with the T_Disconnect added it worked, while a script that always disconnected opened the device
  under its factory key every time.
- **The tool's Sync sequence now starts at a clock.** Busforge started every session at 1; ETS starts
  at a millisecond clock (`0x004024085340`), and Busforge now at milliseconds since 2018-01-01, so the
  start grows across sessions as replay protection expects. That a factory device ignores a repeated
  start of 1 was the first suspicion here and was never shown on its own: the run that suggested it
  also lacked the T_Disconnect.
- **Switching security mode on takes three octets**, reserved, service 0 and mode 1, exactly as ETS
  sends them. Two octets (a misreading of the capture, pinned by a test that read it the same way)
  are refused with return code `0xF2`.

A master reset over the bus (A_Restart, erase codes 0x02 and 0x07, secured) is neither answered nor
carried out by this device; its only way back to the factory key is physical: bus voltage on with the
programming button held (slow blinking), release, hold again for 5 s (fast blinking).

## 20. A secure device answers no secured group read from a sender it does not list

On 2026-09-29 the bench tunnel (1.1.100) sent the ETS-secured Jung 400021SE two GroupValueReads on its
secured address 0/0/1, whose object has the read flag: one plain, one secured with the address's key
from the project (SCF 0x10, a fresh sequence). Neither got an answer. The plain one is expected, the
object's security flag demands authentication and confidentiality. For the secured one, ETS had
loaded the device's security individual address table (PID 54) empty, and a receiver keeps the last
sequence per sender there; a sender it does not list is dropped. That this is the reason is
consistent with the table's content, not shown by a second experiment (adding 1.1.100 to PID 54
would be a write to the security object).

What follows for Busforge: it cannot stimulate a secured object from the bus without being entered
in the device's PID 54. Observing needs no table, a monitor only needs the group key, so the monitor's
decryption can be shown on the bus only by a telegram the device sends by itself (here, its contact
input).


## 21. The Jung ignores a Sync request that comes less than a second after the previous one

A re-download of the ETS-secured Jung 400021SE from ETS 6.4.1 failed every time on the bench
(2026-09-29, four attempts: two partial, two full application downloads, with and without an added
secured sender). The decrypted capture was the same each time: a Sync answered, a secured descriptor
read and a secured serial read answered, then a second S-A_Sync_Req that the device never answered,
after which ETS gave up (its later attempts use another key and its own sequence, which the device
also ignores). No write left ETS; the device stayed as it was. The first commissioning (ticket 28)
worked because it needs only one Sync.

A replica of ETS's frames from a script (same connectionless secured services, same control bytes,
the same plain reads in between, direct to the bridge and through the logging proxy) was answered
every time, until it also matched ETS's **pace**. Measured with the second Sync.req sent a fixed time
after the first (each gap run at least twice): 800 and 900 ms no answer, 1000, 1200, 1500 ms and
longer answered. ETS 6 sends its second Sync about 0.8 s after the first, just inside the window.

So the Jung drops a Sync.req that arrives within about a second of the previous one; the bridge, the
proxy, the tool key, the device's sequence state and the secured-sender assignment are not the cause
(an earlier note here blamed the re-download path and the bench bridge; both were wrong). Whether
ETS with a slower interface stays outside the window is not known. On the bench, the capture proxy
now holds back a Sync.req until 1.2 s after the last one, and ETS can download the device again.

Busforge runs one Sync per session, and its activation's second Sync (under the new key) follows
several writes, so it had not met this. `KnxDevice` keeps 1.2 s between two Syncs to the same
device (`SYNC_GAP_MS`), across transports: two previews of the flash dialog back to back, each on
its own tunnel, met the window on 2026-09-30 (the second got `SECURE_SYNC_NO_RESPONSE`).

## 22. How ETS loads a secured sender into a receiver's PID 54, and what it buys

With the Sync spacing in place (§21), ETS 6.4.1 downloaded the Jung 400021SE after an MDT IP Router
Secure's tunnelling channel (set to 1.1.100) had been made a sender of the secured 0/0/1 (drag the
address onto the channel in Topology). The partial download completed (2026-09-29, capture
`ets-pid54-sender-reference.log` on the bench, decrypted with the project's tool key). Its security
object bracket, in order (A_PropertyExtValue_WriteCon to object type 17, instance 1):

| Write | Bytes after the object/PID header | Meaning |
|---|---|---|
| PID 54, start 0, 1 element | `0000` | clear the table (element 0 is the count) |
| PID 54, start 1, 1 element | `1164 000000000000` | entry 1: sender 1.1.100, last sequence 0 |
| PID 53, start 1, 1 element | `0001` + 16-byte key | key of address-table index 1 |
| PID 61, start 1 | one flag per object, 18 elements per write | as in the first commissioning |

So a PID 54 entry is 8 bytes, the sender's individual address then its last accepted sequence, and
ETS starts a newly listed sender at sequence 0 (any first telegram is fresh). The device confirmed each
write with a count of 1. The Jung itself, the only other device on 0/0/1 and its sender, is not listed
in its own table.

Effect, shown right after: a secured GroupValueRead on 0/0/1 from 1.1.100 (group key, SCF 0x10) now
draws a secured GroupValueResponse from the Jung (value 0, contact open), where before the download
the same frame was ignored (§20). With several senders the order is not shown here (one entry);
thelsing/knx looks entries up by binary search, so ascending by address is the safe order.

**Two secure devices on one secured address (2026-09-30).** ETS 6.4.1 secure-commissioned the bench's
GVS AMMA (1.1.203) from its certificate and linked its switching object (receives) and its status
object (transmits) to 0/0/1, beside the Jung (object 253 transmits on it), then downloaded both
partially (capture `ets-gvs-secure-2026-09-30.log`, decrypted with the exported project's keys). Each
PID 54 was cleared and then written with two elements in one request:

| Receiver | Entry 1 | Entry 2 |
|---|---|---|
| GVS 1.1.203 | `1164 000000000000` (1.1.100, sequence 0) | `11cc 000000010bcd` (the Jung) |
| Jung 1.1.204 | `1164 000000000000` | `11cb 0000000ab9ae` (the GVS) |

So ETS listed the other secured device that transmits on the address (one pair of devices shown),
ascending by address, never the device itself, and started it not at 0 but at the `SequenceNumber`
the project holds for that device: `0x0AB9AE` is the GVS's value in the exported project. An interface sender still starts at 0.
The Jung was downloaded although ETS showed it as needing nothing: ETS does not flag a receiver whose
sender list changed. A device whose objects on the address only receive is not listed (below).

**Where ETS's value comes from.** It is the last sequence ETS saw that device send. The GVS answered
the last request of its own download (13:37:12) with sequence `0x0AB9AE`, the value ETS wrote into the
Jung's table 47 s later. The Jung's Sync response declared `0x010BCD` as its next sequence and its first
answer used it; that is the value in the GVS's table. So ETS takes a device's tool-access answers to
come from the counter it sends group telegrams from. On the Jung that holds: its sending counter, PID 59
of the security object, read `0x011028` on 2026-09-30 evening, and the last answer of its next session
carried `0x011030`. For the GVS it is not compared. Busforge records
the same value after each session (`SecureSession.peerSequence`, the key store's `seq_group`).

**A device that only receives, a plain device, a new address (2026-10-01).** Three more ETS 6.4.1 runs
on the same bench, partial downloads of the GVS only, captured and decrypted
(`scratchpad/cap-1001`, local):

- *Only receives.* The Jung's transmitting object 253 unlinked from 0/0/1 and its receive-only object
  254 ("Schalten - Status": communication and write flags, no read or transmit flag) linked instead. The GVS's PID 54 came back as
  `1164 000000000000` alone: ETS does not list another secured device whose objects on the address
  only receive.
- *A plain device.* Linking the MDT BE-02001's transmitting object to 0/0/1: with the address's
  security on "Automatisch" (the default) ETS warns that 0/0/1 will then communicate unencrypted, for
  every device on it; with "Erzwungen an" it refuses the link ("Eine sichere Gruppenadresse kann
  nicht zu einem Gerät gelinkt werden, welches keine Sicherheit unterstützt"). ETS never programs a
  plain device onto an address that stays secured. (Both dialogs cancelled; nothing was downloaded.)
- *A new address.* The GVS's switching object linked to a new 0/0/2 as well: the address is secured
  automatically, and the download wrote a second PID 53 element, `0002` and a 16-byte key ETS made for
  it. PID 54 stayed `1164` alone: a new address gets no interface sender of its own.
- *A key table that shrinks.* Deleting 0/0/2 again, the next download wrote PID 53 element 1 only,
  start 1, and never touched element 0: the GVS kept two entries, the second for address-table index 2,
  which the one-entry address table no longer has. ETS leaves such an entry; it refers to nothing.

## 23. A refused TCP connect from Bun proves nothing, and TCP tunnels need the heartbeat too

On 2026-09-29 the dev server failed every bus operation for minutes with `TCP connect to
198.51.100.231:3671 failed: connect ECONNREFUSED`, while `nc` from the same Mac connected to the same
port and the bridge was listening. Restarting the server fixed it at once. Two things were learned:

**Bun's `ECONNREFUSED` is not a refusal.** Bun 1.3.8 reports every TCP connect that fails at once as
`ECONNREFUSED` (errno -61). Reproduced on the Mac: with `ulimit -n 64` an exhausted descriptor table
gives `ECONNREFUSED`, and a connect to `0.0.0.1`, where Node reports `EHOSTUNREACH`, gives
`ECONNREFUSED` in Bun too. A refused connect in Bun does not stick either: refused-then-listening
recovers on the next attempt, locally and against the bench host, and 40 tunnel connect/disconnect cycles
leak no descriptors. The most likely cause of the stuck server is macOS Local Network privacy denying
the long-lived process LAN access (`EHOSTUNREACH` in Node terms). That is a documented pattern on
macOS 15 and later (Apple developer forums 776552, 765285): new processes and Apple's own binaries
(`nc`) are unaffected, and restarting the process ends it. **Not proven here**: the unified log was
not readable, and the failure has not recurred under a probe yet. ETS runs on the bench host, so "after an
ETS download" in the first report was most likely coincidence. The client's connect error now says
that Bun cannot tell these causes apart, instead of passing `ECONNREFUSED` on as the cause.

**The connection-state heartbeat runs on TCP.** Busforge's client armed no heartbeat on TCP and its
bridge never reaped a quiet TCP channel, on the belief that KNXnet/IP v2 drops the procedure there.
Both references contradict that: ETS 6 sent a CONNECTIONSTATE_REQUEST over its TCP tunnel to the
bridge (`06 10 02 07 00 10 01 00 08 02 00 00 00 00 00 00`, capture `ets-plain-redownload.log`), and
Calimero's `ClientConnection` starts the 60 s heartbeat regardless of transport. Without it, a TCP
client whose FIN never arrived kept its channel on the bridge indefinitely (three ESTABLISHED
connections from the Mac with no process behind them, every new tunnel refused with status `0x24`),
and a Busforge monitor over TCP would have kept showing "connected" over a dead link. Both sides now
run the procedure on TCP exactly as on UDP.

Shown on hardware the same evening: a raw TCP client that opened a channel and sent nothing kept it
for 150 s on the old bridge and was dropped at 124 s by the new one (DISCONNECT_REQUEST, then FIN).
A Busforge TCP tunnel idle for 190 s stayed up against the new bridge and read a device afterwards,
and stayed up for 190 s against the house's MDT KNX IP interface, which therefore answers the
heartbeat over TCP (three unanswered requests would have closed it after about 90 s). ETS is not
affected by the reaper: in every capture it closes its device-management channel within
milliseconds of reading two properties, and it was never silent for more than 8 s on an open tunnel.

## 24. A device may close the connection instead of answering

A plain `A_FunctionPropertyExtState_Read` of PID 51 (security mode, object type 17) on the four bench
devices (2026-09-30) got four different answers. The GVS AMMA with Secure, never activated, answered
return code 0, mode 0. The Jung 400021SE in secure mode answered return code `0xFC` (access denied),
and a plain serial read with no element. The ABB US/U 4.2 did not acknowledge the request at all.
The MDT BE-02001.02 acknowledged each of the three tries on the transport layer, never answered, and
about six seconds after the first sent a `T_Disconnect` (`0x81`).

Busforge had taken that `T_Disconnect` for an answer: its request machine only recognised the
numbered control frames (`T_ACK`/`T_NAK`, `0xC0` and above), so `0x81` was parsed as a data frame
with service `0x100`, acknowledged with a `T_ACK`, and reported as "answered with service 0x100".
Why the MDT closed is not shown: six seconds is also the transport layer's connection timeout, so
it may have closed an idle connection rather than refused the service.

A device's `T_Connect`/`T_Disconnect` is now never acknowledged or delivered, and a `T_Disconnect`
ends the request in flight as `DEVICE_CLOSED_CONNECTION` without asking again: a closed connection
takes no further numbered frame. It is deliberately not `DEVICE_NOT_ANSWERING`, which callers read as
silence: a device that closes is present. The address check before an individual-address write
counts it as taken (a device in another tool's connection answers a stranger's frame this way), and
the read after a restart reconnects and reads once more, as it does after silence.

## 25. A secured parameter flash that "stopped answering" was a stalled TCP stream

The secure smoke spec on the Jung 400021SE broke off twice in a parameter flash with
`DEVICE_NOT_ANSWERING`: on 2026-09-29 (seed 3986290679, after the parameter object was unloaded, so
the device kept no application until a full download) and on 2026-09-30 with the same seed, this time
in the read-back after the restart. The 2026-09-30 run went through a logging proxy on the Mac:

- Every secured read of the verify loop was answered within about 300 ms, up to one request that the
  bridge still confirmed (`L_Data.con`) at 12:30:28.637. After it nothing came back on that TCP
  stream: no T_ACK, no answer, and no confirmation for the two repetitions.
- The bridge on the bench host held that stream afterwards with 349 unsent bytes queued towards the Mac
  (`FIN-WAIT-1`), which is where the Jung's answer was.
- Busforge disconnected and reconnected at once. The bridge still held the dead channel and has one
  tunnel address, so every reconnect was refused with `0x24` until it reaped the channel at
  12:32:32, 120 s after its last heartbeat. Every later step of the run failed on that refusal.
- The same seed then passed in full. Polling the bridge's TCP state every 250 ms during that run
  showed a lost segment on the Wi-Fi path between the bench host and the Mac that TCP resent after about
  200 ms. A few losses in a row put TCP into retransmission back-off (0.2, 0.4, 0.8, 1.6, 3.2 s),
  longer than the device request's three tries of about 2 s each.

So the device was not the cause, and neither was Data Secure: a stream that stalls for a few seconds
cut off a long run of management requests. Not shown: that the 2026-09-29 abort had the same cause
(no transport data was recorded then; the symptom is the same).

Busforge had no way to tell the two apart, because over TCP it did not wait for the interface's
confirmation (§15). It now does, matched by destination and TPDU, and a missing confirmation within
3 s is `TUNNEL_CON_TIMEOUT` ("the link to the interface stalled, or the interface is stuck; whether
the device answered is unknown") instead of `DEVICE_NOT_ANSWERING`. It is not retried (a repetition
would queue behind the stuck frame), and the load runner and the reconnect after a restart pass it on
rather than report the device as silent. What does not change: a new tunnel opened before the bridge
has reaped the dead channel is still refused (`0x24`) for up to 120 s, because the bench bridge has one
tunnel address. Shown on hardware: the confirmation matched on the bench bridge and on the house's MDT
KNX IP interface (reads and a secured smoke run). Not shown: `TUNNEL_CON_TIMEOUT` on a real stall,
which needs the stall to recur. An interrupted flash still leaves the device where the bracket stood;
recovering it is a full download, started by the user.


## 26. An OpenKNX object with no group address transmits to 0/0/0

On the OpenKNX AB-PRE at 1.1.x, freshly commissioned by Busforge, sent its measurements to
group address 0/0/0. The cause is in the KNX stack OpenKNX runs (thelsing/knx, unchanged in the
OpenKNX fork; source read at thelsing `980c047` and OpenKNX `57b5b05`):

- `BauSystemBDevice::sendNextGroupTelegram` skips an object whose communication flag is off. One with
  the communication and transmit flags set goes on to `ApplicationLayer::groupValueWriteRequest`.
- `groupValueSend` takes `_assocTable->translateAsap(asap)` without checking it. For an object with no
  association that is `-1`, cast to `0xFFFF` (the read path checks for `< 0`, the write path does not).
- `AddressTableObject::getGroupAddress(0xFFFF)` is out of range and returns `0`: group address 0/0/0.

So an unlinked object with its communication flag on transmits to 0/0/0. Busforge left that flag on
for unlinked objects until (`dddf900`, "Clear the Communication flag on com-objects that
carry no group address", as ETS does), which matches the date of the observation. With the flag
cleared the stack skips the object. A 5.5-minute listen on the house line (97 group
telegrams, 19 senders) saw nothing to 0/0/0; 1.1.x itself sent nothing in that window. The unchecked
lookup is an upstream bug; a device configured by any tool that leaves the flag on would show it.

## 27. The Jung 400021SE clears the last byte of its parameter segment

A full ETS 6.4.1 download of the Jung after a master reset (2026-10-01; ETS activated it from its
certificate, then downloaded everything; capture decrypted with the exported project's keys) shows the
whole load of the parameter segment:

- LSM 4 is allocated with `0x1E15` bytes, then PID 27 of object 4 gets the two elements the application
  declares (`LdCtrlWriteProp`): `00001E14 0033 0000` and `00000001 0133 0000`, a region of `0x1E14`
  bytes and one of a single byte, the segment's last. Busforge writes the same (`3c54107`).
- The memory writes put `01` at offset `0x1E14`: parameter P-1, default 1. Busforge's full-download
  image and its parameter-flash target both have `01` there.
- `LdCtrlLoadImageProp` is no write: at the end ETS only reads PID 27 of objects 1 to 4 back, each entry
  now carrying the device's CRC.

Read back through Busforge a few minutes later, the segment equals what ETS wrote in every byte but
`0x1E14`, which holds `00`. The device clears that byte itself. This is why a Busforge parameter-flash
dry run reported one differing byte after a verified full download: not a builder fault, the device's
own state. What the byte means to the firmware is not known.

## 28. What ETS writes when a parameter change alters the com-object table

ETS 6.4.1, "Programmieren > Partiell", four captures on 2026-10-01 (`scratchpad/cap-1001`, local; trimmed
fixtures in `tools/fixtures/*-ets-partial-structure.log` and `mdt-be02001-ets-fulldownload-b7.log`):
the Jung 400021SE with K2 switched from "Schalten" to "Dimmen und Farbtemperatur" and back (decrypted
with the exported project's keys), and the MDT BE-02001.02 with input B switched from "Kontaktzustand
senden" to the two-object short/long function, downloaded once in full by ETS, then switched back.

**System B (Jung): one bracket over all four objects and the security object.** Both directions:

1. Reads only: serial, the application's state and program id, the MCBs of objects 3 and 4, the
   table references.
2. Unload of the application (4), the com-object table (3), association (2) and address table (1),
   then the security object.
3. Load and reallocation of each **without fill**, in the order 4, 3, 1, 2; the application's two
   MCB elements right after its allocation (the parameter flash writes the same two). The sizes are
   unchanged (7701, 2656, 4, 6), and each segment stays where it was.
4. Memory writes: the parameter segment's changed region (25 bytes in five runs adding the dimmer
   objects, 25 in three runs going back), the com-object table only where it changed (7 bytes in two
   runs), the association and address tables whole.
5. The security object's load (PID 54, 53, 61), the program-id stamp, `LoadCompleted` of 4, 3, 2, 1,
   a read of every MCB, `A_Restart`.

That is the full download's bracket (`planSystemBFullDownload`) without fill and with partial writes,
relying on the device keeping the bytes of a segment that is reallocated at the same address.

**System 7 (MDT, property-mapped): one load bracket per state machine, no common bracket.** The
address table (LSM 1) and the association table (LSM 2) are each unloaded, loaded, declared and
completed with their changed bytes (one count byte each here). The application's machine (LSM 3) is
loaded without an unload and gets the parameter bytes and the com-object table, which on this device
share it: 220 bytes in 30 runs, many of them unchanged. One `A_Restart` closes it.

**ETS restores the template value of a parameter that goes inactive.** Going back to "Kontaktzustand
senden", ETS wrote `01` at `0x44B2`, a byte of input B's short/long settings that the new function no
longer uses; `01` is the segment's `<Data>` template there, the short/long function had `00`. So ETS
writes the bytes where its whole image changes, not only those of active parameters.

**Every byte ETS wrote matches Busforge's image for the same configuration**: 42 on the Jung (through
a local conversion of the decrypted capture that leaves out the security object's writes) and 222 on the MDT,
none divergent (`tools/etsdiff.ts --partial`, `tools/etsdiff.test.ts`). The structural flash is built
on these brackets (see [load-procedures.md](load-procedures.md#structural-flash)). Where it differs
from ETS: on System B it writes every byte its parameter model owns, as the parameter flash does; on
System 7 only the bytes that differ from the device, and it brackets the group tables without ETS's
unload and segment declaration. Against the MDT capture the writes are exact: Busforge's are the bytes
ETS changed, with ETS's values, given the configuration ETS had downloaded before as the baseline.
