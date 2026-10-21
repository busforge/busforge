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
  fields (short form). The unit says which: the description of the association table object's
  table property (object 2, PID 23) carries `PDT_GENERIC_04` for the long form and `PDT_GENERIC_02`
  for the short one. ETS reads that description before every System B download and writes the form
  it names (MDT IP Interface/Router short; GVS AMMA, Jung 400021SE, Theben DALI-Gateway long). Busforge
  reads the same description before it reads the table back or writes it, and reads exactly the entries
  of that form. Only a unit that describes no table property there (it answers with PID 0) has its form
  told by validating that group indices are within the address-table count, and only for a read; a write
  to it is refused. Entries ordered by com-object number, then group index.
- **Table capacity**: how many group addresses and associations a unit takes is what its application
  declares (`<AddressTable MaxEntries>`, `<AssociationTable MaxEntries>`), the bound an ETS project
  holds a device to. The unit's description of the table property (PID 23) is not that bound: its
  maximum element count equals `MaxEntries` on the GVS AMMA, the Jung 400021SE and the MEAN WELL power
  supply, but the Theben DALI-Gateway describes 1343 of its application's 1744, the OpenKNX
  RaumController 4095 of 2047, and the MDT IP Interface/Router 1 of 255. That a unit takes more than
  it describes is not shown. Busforge refuses tables with more entries than the application declares
  before any write (`GA_TABLE_TOO_LARGE`), on System B as on System 7, and a System B application
  that declares none (`GA_TABLE_CAPACITY_UNDECLARED`).
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
- A device data frame with the sequence number of the one taken last is a **repetition**: the
  device sends it again when our `T_ACK` did not reach the bus (the interface answers the
  L_Data.con negative). Acknowledge it again and drop it. Taken as the answer to the request now in
  flight, it hands that request another request's bytes: a Theben DALI-Gateway repeated its answer
  for one memory block, and a read that took it would have stored that block one block further on.
  A memory read also refuses an answer for another address than the one asked.
- A device data frame of **another service** than the one the request is answered with (an
  `A_Memory_Response` while a device descriptor read waits) is not the answer either: acknowledge it,
  drop it, and keep its sequence number out of the repetition check, since it may come from an
  earlier connection whose numbering the new one repeats; keep the frame itself, so that its exact
  repetition within the device's repetition window (three repetitions, 3 s apart) is dropped too. The same holds between requests, where no answer is awaited, and at a
  confirmed restart, which awaits only the `A_Restart_Response`. A device that takes the request and
  answers it with nothing but other services, try after try, is refused as such
  (`ANSWER_SERVICE_MISMATCH`), not taken for silence (§31).
- A device that **repeats a frame of its own while a request waits** took that request while it was
  still waiting for our `T_ACK` of the frame (the transport layer's OPEN_WAIT): our `T_ACK` went out
  beside the request and the interface confirmed it negatively. The specification has the device keep
  the answer and send it once a `T_ACK` lets it go on; a Theben DALI-Gateway drops it instead. It
  acknowledges the request, never answers it, and acknowledges each repetition of it without passing it
  on, since a frame it acknowledged holds its number. Busforge therefore acknowledges the repetition and
  gives the request a full answer window from there, in which the keeping device answers once our
  `T_ACK` of the repetition reached it (an answer that lands between two tries is taken too). A
  **read** that is still unanswered is asked again **under the next number**, which the device takes as
  a new request; should it then answer both, the second answer, identical to the first, is acknowledged
  and dropped while no request or another read waits; the same read asked again takes it, being its
  answer, and so does a write answered alike (one writing the value just read). Any other request (a write, a function property
  command) is not asked twice, since the device would carry it out twice: it fails as unanswered. After
  a request the device acknowledged and did not answer, the next request takes the next number. A
  `T_ACK` is not sent again on a negative confirmation: the specification takes no action on that
  confirmation, and a `T_ACK` of a number the device has already moved past makes it disconnect when it
  is waiting for the `T_ACK` of its next frame. The ETS captures hold no `T_ACK` that was confirmed
  negatively, so they show no other way.

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

Three downloads on a System B actuator isolate it: a full download that already carries the links
gives a status object that transmits and answers reads; a baseline download without them followed
by a GA flash that adds them gives an object silent in both directions; the same GA flash rewriting
L3 brings it back. The switch relay clacks in every case, so neither the write path nor the device's
reaction is in doubt: only the object linked purely by a GA flash is dead, and it comes alive the
instant L3 is rewritten with its Communication flag set. Which devices hold this proof is in
[status.md](status.md).

**So the System B GA flash** rebuilds L3 from the current link set and writes **L3+L1+L2 in one
bracket**. It stays surgical, because those three are small tables, so it never touches the large
parameter image, which is why a mere link change is not promoted to a full download. The staleness
gate guarantees the only L3 change is link-driven, so a pure re-point of an already-linked object
writes L3 byte-identical (a no-op).

**The GA flash authors L3 from Busforge's model** of the com-object table, it does not write the
device's own L3 back. On a device Busforge itself programmed that is byte-identical apart from the
link-driven flags. But a device last programmed elsewhere (by ETS, or with drifted parameters) may
hold an L3 that differs in non-link bytes, and a GA flash rewrites those objects too, then verifies
green against Busforge's own table. So after a GA flash the device's L3 is Busforge's, not whatever
it held before, which is the standing verify-versus-ETS gap ([verification.md](verification.md))
reaching the GA path.

**System 7 does the same, because ETS does.** Its L3 config byte carries a per-object `linked`
bit, and ETS partial downloads after a link change rewrite L3 with the group tables on both LSM
styles (MDT BE-02001.02 property-mapped: the whole table; ABB US/U 4.2 memory-mapped: only the
changed config bytes). Where the application names the L3 segment, the System 7 GA flash reads the
table the device holds, changes only each object's linked bit and writes L3+L1+L2 in one bracket.
On a device holding the table its last full download wrote, that is ETS's bytes. The linked bit is
also the object's communication flag: ETS keeps the address and association of a linked object whose
communication flag the project sets off, and clears only the bit (MDT BE-02001.02, partial downloads
of communication off and back on).

**And on System 7 such an object comes alive (MDT BE-02001.02).** Input A set to "switch / toggle
when closing" gives object 1, "Status for toggle": no read flag, transmit flag, and with the
device-wide "Status for toggle: request" the device sends a GroupValueRead on it after every start.
After a full download with the object unlinked and a restart, the device sends no group telegram. After
a GA flash that links only that object (9 bytes differ: the linked bit and the group tables) and a
restart observed from a separate connection, the device sends its GroupValueRead on the new address
2.3 s later. So an object linked purely by the System 7 GA flash transmits, which is what the
linked bit decides. Not shown on the memory-mapped ABB US/U 4.2.

**On the Auro presence detector (M-0081_A-FE01, property-mapped MV-0705) a transmit-only object
relinked by the GA flash transmits too.** Its object 9 (`trigger`, transmit flag, no read flag) loses
its only address in a group-address download and gets it back, by ETS 6 and by the System 7 GA flash
alike: config byte `0x47` -> `0x43` -> `0x47`, the same bytes from both. After the GA flash relinks
it, the first transmit a passive listener logs is the object's trigger on that address. Silence
while unlinked is not shown on this product, so here the evidence is that the relinked object works,
not that the bit alone decides it.

**The general lesson:** flash exactly the segments that diverge from the device, at segment
granularity, and do not fall back to a full download for a change that only moves L1/L2/L3.
And a read-back verify is a **placement** proof, never a **behaviour** proof: a link can be
byte-perfect and still deaf, which is why the smoke framework observes the bus. It is the
behaviour check, not the read-back, that catches this.

## 8. `LegacyPatchAlways` means "always write the value", not "leave it to ETS"

The application-program attribute `LegacyPatchAlways="true"` marks a parameter ETS writes into the
image on every download, over the `<Data>` byte, even when the value is the default. It is not an
ETS-internal marker a tool may leave out. Two independent sources show what ETS does:

- **ETS captures.** Two ETS full downloads of the MDT BE-02001.02 write `0x1e` (30 ms, the
  parameter's value) at the debounce time `P-7`, whose `<Data>` byte is `0x32` (50 ms). `P-7` is a
  visible, editable parameter, so leaving it out would keep a user's debounce setting off the device.
- **Devices ETS commissioned.** Three Theben MIX actuators (application `M-0048_A-493B-21-B471`)
  hold the parameter values at all three of their `LegacyPatchAlways` parameters (3, 15 and the
  "Download erfolgt" bit), where an image without them holds `0`.

Leaving these parameters out of a comparison only hides them; it does not make an image match.
Busforge builds and owns `LegacyPatchAlways` parameters like any other; `tools/etsdiff.ts` matches
the MDT captures byte for byte.

## 9. Several ParameterRefs of one Parameter share one value

An application may reference one parameter through several ParameterRefs with different `Value`
attributes. The Jung 400021SE's seconds field (`P-505`) has `R-107` (no Value, so the parameter's
default 5), shown while the minutes field is 0, and `R-1` (`Value="0"`), shown while it is not.
Both are tested by chooses that pick one of two union members for the milliseconds field.

A ref's `Value` is the default of that ref when it is the one shown; it is not a separate value.
ETS shows it directly: switching the minutes to 1 sets the seconds to 0 once, and ETS's export then
stores a value only for the minutes; the seconds written (0) come from `R-1`'s default. With the
minutes at 0 it evaluates the choose on `R-1` as 5, the shared value, and writes the union member
for 5 seconds (0 ms). Evaluating `R-1` with its own default 0 instead activates the other member
too and writes 100 ms over it.

So a parameter has one value, and it is the placed ref's: one stored on a placed ref, else the
default of the placed ref. A value the project stores on a ref that no active branch places is a
leftover of an earlier configuration and is neither written nor read by a test. The Theben Meteodata
140 S (`M-0048_A-140C-14-EB70`) shows it: its project stores 5 on `UP-6673_R-6690` while the placed
`R-6677` has nothing stored, and ETS's full download writes `R-6677`'s default 1, as for the two
sibling unions (`0x496F-0x4971`, `0x499F-0x49A1`, `0x49CF`, `0x49D1`: 1 2 3). Two Auros
(`M-0081_A-FE01-11-75D9`) programmed by ETS show the same: the project stores a value on an unplaced
ref of `P-7` and `P-16`, and the devices hold the placed ref's default.

The same holds when a configuration switches which ref is shown: the newly placed ref's default
applies, not the value stored on the ref shown before, as ETS does on the Jung (above). A value the
user set through the old ref stays stored and returns when that ref is placed again.
Only a parameter none of whose refs is placed reads a value stored on its refs (for a choose).
A placed ref with nothing stored keeps its own default, because applications select an internal
parameter's value by which ref an active branch places; when several refs with different defaults
are placed, each keeps its own, since which one ETS would use is unknown. Which refs are placed is
determined once, by walking the tree until the placement no longer changes, and every pass (the
view and the image) reads the same placement. Against the stored configurations of an ETS
installation project and every catalogue fixture at its defaults, this rule changes the image only
for the Meteodata (8 bytes) and the two Auros (1 byte each), each to the byte the device holds.
Configurations edited after a ref switch change too, by design; no capture shows ETS after such an
edit beyond the Jung's.

## 10. `ParameterByteOrder="LittleEndian"` reverses multi-byte parameters

An application's `<Options>` may declare `ParameterByteOrder="LittleEndian"` (the ABB US/U 4.2
does). ETS then writes a multi-byte parameter least significant byte first: a 16-bit value of 450
lands as `c2 01`, not `01 c2` (partial-download capture). Busforge applies it to byte-aligned
integer parameters whose width is a whole number of bytes. A float, or a little-endian field that
does not start on a byte boundary, is refused: no capture shows how ETS places one, and reversing
it by guess would write a plausible wrong value.

## 11. A choose on a union member nothing places takes its default branch

Unions overlay several parameters on the same bytes; only the member an active branch places is
meaningful. On the GVS AMMA a choose tests a union member that no active branch places. Evaluated
with that member's default, it takes a branch that activates three com-objects (5, 6, 8); ETS
leaves them out (partial-download capture). So a choose on a union member that is not placed and
has no stored value takes only its default branch. A stored value on such a member still counts;
the capture shows only the case without one, so that half is an assumption. The rule is narrow on
purpose: a broader variant (every unplaced ref) changes the image of another bundled application at
its defaults, with no capture to justify it.

## 12. A parameter owns bits, not the byte it shares

Several parameters, and union members, share one byte. Owning every byte a written parameter
touches, and filling the byte's other bits from the application's `<Data>` template, is wrong. On
the GVS AMMA byte 64 holds "Output 3&4 function" in its top two bits and that channel's unions in
the rest. With the channel disabled the unions are idle; the full download writes their
`DefaultUnionParameter` (0), as ETS does. A parameter flash that writes the template's 1s beside the
two owned bits (`00` becomes `3f`) passes its read-back, because the device holds exactly what was
written. The firmware does not ignore those bits: at the next group-address flash it sets the
Communication, Read and Transmit flags of object 8 in the com-object table by itself while the
table is written, so the table reads back `4f` where `00` was written.

So ownership is a bit mask per byte on both memory models: a written byte takes the owned bits
from Busforge's image and every other bit from the device, and the read-back compares only the
owned bits. The full download still writes whole bytes; its image is compared with ETS captures.

## 13. Write a device the way ETS does: confirmed, when it says it can take it

The classic `A_Memory_Write` is answered only by the transport layer's T_ACK, which a device
sends before its firmware has stored the bytes. On the GVS AMMA, writing the 1066-byte com-object
table classically right after reallocating its segment leaves one byte wrong every time: 0x3786
holds the value just written to 0x377a, twelve bytes (one chunk) earlier. Every frame on the wire
is correct and acknowledged (logged through a proxy); written slowly, the table lands exactly. The
device is being overtaken.

ETS never writes that device classically. Its application declares `<Options
SupportsExtendedMemoryServices="true">`, ETS reads `PID_MAX_APDU_LENGTH` (device object, PID 56) after
the descriptor, and it uses the confirmed `A_MemoryExtended_Write` at every address, waiting for each
write response. The option decides, not the property: the Theben DALI-Gateway answers the property
with 55 but declares no option, ETS writes it classic, and the gateway acknowledges an extended write
on the transport layer without ever answering it. The ABB US/U 4.2 and MDT BE-02001.02 (no option, no
property) are written classic too.
Its first chunk size on the GVS, 50 bytes, is the maximum APDU minus the 5 octets around the
data; the USB interface refused that frame and ETS continued with 35. ETS bounds the chunk by the
interface's own maximum APDU length too (the OpenKNX RaumController declares 254; behind an IP
interface announcing 210 ETS logs "NegotiateMaxApduLength -> 210, restricted by ByInterface"), so
Busforge's bridge announces the 40 octets a USB report has been shown to carry
([connections.md](connections.md)). Busforge makes the same
choice from the same option and property, with its own transport limit as the second bound, and the
table lands exactly.

## 14. What ETS writes in a partial download, and what Busforge writes

Four ETS partial-download captures show one rule per device family, derived from which bytes
changed between the two configurations and which ETS wrote:

| Family (captured device) | ETS reads first | Parameter segment | Group and com-object tables |
|---|---|---|---|
| System B (GVS AMMA, Jung 400021SE) | nothing | unload, realloc **without** fill, then exactly the bytes its parameter model owns (GVS 229 of 2816, Jung 186 of 7701), idle unions' `DefaultUnionParameter` included | reallocated and written whole |
| System 7 memory-mapped (ABB US/U 4.2) | the tables and parameters | only the bytes that differ from the device | only the bytes that differ (2, 1 and 2) |
| System 7 property-mapped (MDT BE-02001.02) | one read | (no parameter change) | written whole, the own individual address excepted |

Busforge follows the same rules. The System B parameter flash owns the idle unions' defaults
too and writes only the bytes holding an owned bit, each read back as it is written. It relies on
the device keeping the rest across the reallocation, as ETS does, only while the segment stays at
its old address; if the allocation moves it, the whole image is written. Its final read-back
checks every byte of the segment against the image or against the read before the flash. The
memory-mapped System 7 group-address flash reads the tables at their new length and writes only
the differing bytes; the property-mapped one writes whole tables, the individual address included
(ETS skips those two bytes; they hold the same value). The parameter flash on System 7 writes only
owned bytes that differ. `tools/etsdiff.test.ts` holds the System B parameter bytes against the
captures, address and value. Writing only the owned bytes brings the GVS parameter flash to about
77 s, against 96-116 s when every byte of the segment is written. The byte-level ETS comparison of the partial
downloads lives in tests only; no reference evidence record is emitted for it yet. Which devices
pass these flashes on hardware is in [status.md](status.md).

## 15. Tunnelling over TCP has no acknowledgement

KNXnet/IP Tunnelling v2 over TCP has no TUNNELLING_ACK: xknx's `TCPTunnel` neither waits for one
nor sends one, and ETS sends none. A client that waits for one fails every operation with
`TUNNEL_ACK_TIMEOUT` against the MDT SCN-IP000.03, which sends none, while Busforge's own bridge,
which acknowledges every TCP request anyway, hides the fault. Busforge's client writes each request
once and acknowledges nothing over TCP.

A second trap of the same kind: a transport wrapper that picks TCP or UDP at connect time
(Busforge's `auto`, which tries TCP first) must forward the receive callbacks a device session
installs **after** the connect. Copying them only at connect time drops every device answer (the
device answers correctly, T_ACK and all, and the client times out). A connection pinned to `tcp`
bypasses the wrapper, so it does not show this. With both rules in place, a full read-back of the
OpenKNX RaumController over `auto` (TCP) through the MDT interface completes (operator observation,
no evidence record).

What the TCP client gives up with the acknowledgement: a per-frame sign of a half-open link, since a
socket write does not fail on a dead peer. The connection-state heartbeat (which the client runs on
TCP too, see §23) notices a dead link within about 90 s. In between, the client waits for the
interface's `L_Data.con` on every send, matched by destination and TPDU, not by sequence (§25).

## 16. OpenKNX reads its flash, not what was just written

On an OpenKNX device a confirmed `A_MemoryExtended_Write` is answered with success for every
chunk, and a read straight after it can still show the old bytes (in one case a read about a
minute later showed the new byte; after the restart the read shows it). A flash that read-back-verifies before LoadCompleted therefore
stops with `FLASH_VERIFY_MISMATCH` and leaves the parameter load-state machine Loading, with the
application not running.

The firmware explains it (OpenKNX/knx and thelsing/knx `master`, same logic): `BauSystemB`
answers both memory write services right after `Memory::writeMemory`, which on a flash platform
copies the bytes into a RAM buffer of one erase block and returns. The buffer reaches the flash only
on a commit (from the restart request, "flush the EEPROM before resetting") or when a later write
moves to another erase block. Both memory read services read the flash itself through
`toAbsolute` (XIP on the RP2040). So any read-back before the restart can show old bytes. The
classic write's verify mode does not catch it because its echo is a copy of the request data, not a
read.

What Busforge does about it:

- **No read-back of a confirmed write before the restart**, as ETS does it: the per-chunk return
  code and the read-back after the restart are the proof. A full download meets the same wall if
  it reads back on the confirmed path.
- **A flash never calls a device "unchanged" while a load-state machine it brackets is not LOADED.**
  A System B flash runs its bracket to complete the load, a System 7 flash refuses
  (`DEVICE_LOAD_INCOMPLETE`).
- **Read-back relevance comes from the device's values** (see [verification.md](verification.md)),
  so a project holding defaults for a device that holds its real configuration does not reset it.
- **The verify reconnects and reads once more after a silence:** the rebooted device can go silent
  partway into a long read-back while its application starts.

A one-byte surgical parameter flash with these rules on the OpenKNX RaumController is written,
committed at the restart, all four load-state machines LOADED, and a separate read-back after the
restart shows the new value; the flash's own read-back is cut off when the rebooted device goes
silent about 9 KB into the 21.6 KB segment, which is why the verify reconnects. The revert to the
original value completes as `flashed`, `verified: true`, and the presence object answers a group
read afterwards (operator observation, no evidence record). In the one case shown, a device left
with LSM 4 Loading came back after a LoadCompleted on LSM 4 and an `A_Restart`, once the right bytes
had been committed; that is not established as a general recovery.

## 17. A module parameter resolves through its module definition

To decide which stored parameters a flash wrote, Busforge maps a module-instance ref back to its
definition. Module expansion builds instance ids by inserting `_M-k_MI-n`, so the inverse strips
exactly that: `…_MD-1_M-100_MI-1_P-149_R-142` maps to `…_MD-1_P-149_R-142`. Stripping only `_MI-n`
leaves `_M-k` in place, no module-instance parameter matches its definition, and every one of them
counts as unwritten and keeps its old baseline after any verified download or flash. For a
parameter with no device memory that changes the set of com-objects (the Jung 400021SE's channel
function, "Kanalfunktion", whose value 8 removes objects #253 and #254), the stale baseline makes
the com-object table guard compare equal values and let a surgical flash through where a full
download is needed; the device then keeps the table without those objects. The smoke spec's
persistence step catches that, because a link placed on #254 is gone after the restart.

The mapping is checked over every module fixture (4384 Jung and 4648 MDT refs, no mismatch). On the
Jung, the same mutation and revert then promotes the revert to a full download and passes,
persistence included.

## 18. A device in secure mode ignores a plain A_Restart

A device in secure mode accepts no plain application service on a secured tool connection. A plain
`A_Restart` after a secured full download of the Jung 400021SE is acknowledged on the transport
layer (T_ACK) and then ignored; the device answers the secured descriptor read that follows. A T_ACK
says only that the frame arrived.

Every numbered service in Busforge goes through one wire step (`KnxDevice.onWire`), the restart and
the master reset included, so on a secured connection each is secured. The restart check proves the
reboot by the device's silence, not by the acknowledgement; a check that trusted the T_ACK would
call such a download done (`RESTART_IGNORED` is the refusal).

On the path it was captured on (a KNXnet/IP tunnel through Busforge's bridge to TP), ETS never
sends the Jung a secured request longer than 40 octets:
after 151-byte frames go unanswered it writes 22-byte memory chunks and 18-element property writes,
both exactly 40. Busforge holds secured writes to that.

## 19. What a factory-fresh secure device demands of the activation

Activating the Jung 400021SE after a physical master reset fails until two things are right, both
shown only by the factory-fresh device (the sequence start below is a precaution, not one of them).
None of it shows against an already-secured device, and none in the decrypted ETS capture read only
for its content.

- **An unanswered Sync leaves a transport connection behind.** Trying the stored key first, then the
  factory key on a new link, gets a T_ACK and no answer until the failed attempt is closed with a
  T_Disconnect. Shown: without the T_Disconnect the activation fails, with it the device opens under
  its factory key every time.
- **The tool's Sync sequence starts at a clock.** ETS starts at a millisecond clock, Busforge at
  milliseconds since a fixed epoch (`TOOL_SEQUENCE_EPOCH`), so the start grows across sessions as
  replay protection expects. That a factory device ignores a repeated start of 1 is suspected, not shown on its own.
- **Switching security mode on takes three octets**, reserved, service 0 and mode 1, exactly as ETS
  sends them. Two octets are refused with return code `0xF2`.

A master reset over the bus (A_Restart, erase codes 0x02 and 0x07, secured) is neither answered nor
carried out by this device; its only way back to the factory key is physical: bus voltage on with the
programming button held (slow blinking), release, hold again for 5 s (fast blinking).

## 20. A secure device answers no secured group read from a sender it does not list

A secured GroupValueRead (SCF 0x10, the address's group key, a fresh sequence) from a tunnel the Jung
400021SE does not list in its security individual address table (PID 54) gets no answer, even though
the object has the read flag; a plain one gets none either, as the object's security flag demands
authentication and confidentiality. A receiver keeps the last sequence per sender in PID 54 and
drops a sender it does not list. That this is the reason is consistent with the table's content
(ETS had loaded it empty) and with §22, where the same read is answered once
ETS lists the tunnel.

What follows for Busforge: it cannot stimulate a secured object from the bus without being entered
in the device's PID 54. Observing needs no table, a monitor only needs the group key, so the monitor's
decryption can be shown on the bus by a telegram the device sends by itself (a contact input, say).

## 21. The Jung ignores a Sync request that comes less than a second after the previous one

The Jung 400021SE drops an `S-A_Sync_Req` that arrives within about a second of the previous one.
A script replaying ETS's frames (same connectionless secured services, same control bytes, the same
plain reads in between, direct to the bridge and through a logging proxy) is answered every time
until it also matches ETS's pace. Measured with the second Sync.req sent a fixed time after the
first (each gap run at least twice): 800 and 900 ms no answer, 1000, 1200, 1500 ms and longer answered.
ETS 6 sends its second Sync about 0.8 s after the first, just inside the window, so an ETS
re-download of the secured Jung fails every time (partial and full application downloads, with and
without an added secured sender): one Sync answered, a secured descriptor and serial read
answered, the second Sync unanswered, then ETS gives up without writing (its later attempts use
another key and its own sequence, which the device also ignores). A first commissioning needs only one
Sync and is not affected. The bridge, a proxy, the tool key, the device's sequence state and the
secured-sender assignment are not the cause. Whether ETS with a slower interface stays outside the
window is not known; a capture proxy that holds back a Sync.req until 1.2 s after the last one lets
ETS download the device.

Busforge runs one Sync per session, and its activation's second Sync (under the new key) follows
several writes. `KnxDevice` still keeps 1.2 s between two Syncs to the same device (`SYNC_GAP_MS`),
across transports: two previews of the flash dialog back to back, each on its own tunnel, otherwise
meet the window (`SECURE_SYNC_NO_RESPONSE`).

## 22. How ETS loads a secured sender into a receiver's PID 54, and what it buys

With the Sync spacing in place (§21), ETS 6.4.1 downloads the Jung 400021SE after an MDT IP Router
Secure's tunnelling channel is made a sender of a secured group address (drag the address onto the
channel in Topology). Its security object bracket in that partial download, in order
(A_PropertyExtValue_WriteCon to object type 17, instance 1, decrypted with the project's tool key):

| Write | Bytes after the object/PID header | Meaning |
|---|---|---|
| PID 54, start 0, 1 element | `0000` | clear the table (element 0 is the count) |
| PID 54, start 1, 1 element | `<IA:2> 000000000000` | entry 1: the tunnel's individual address, last sequence 0 |
| PID 53, start 1, 1 element | `0001` + 16-byte key | key of address-table index 1 |
| PID 61, start 1 | one flag per object, 18 elements per write | as in the first commissioning |

So a PID 54 entry is 8 bytes, the sender's individual address then its last accepted sequence (6
bytes), and ETS starts a newly listed interface sender at sequence 0 (any first telegram is fresh).
The device confirms each write with a count of 1. A device is never listed in its own table (shown on two devices).

Effect: a secured GroupValueRead on that address from the listed tunnel (group key, SCF 0x10) draws a
secured GroupValueResponse from the Jung, where before the download the same frame is ignored (§20).

**Two secure devices on one secured address.** With the GVS AMMA secure-commissioned by ETS from its
certificate, its switching object (receives) and its status object (transmits) linked to the same
secured address as the Jung (whose object 253 transmits on it), and both downloaded partially, ETS
clears each PID 54 and writes two elements in one request:

| Receiver | Entry 1 | Entry 2 |
|---|---|---|
| GVS AMMA | the tunnel, sequence 0 | the Jung, at a sequence ETS saw it send |
| Jung 400021SE | the tunnel, sequence 0 | the GVS AMMA, at a sequence ETS saw it send |

So ETS lists the other secured device that transmits on the address, ascending by address, never the
device itself (one pair of devices shown; thelsing/knx looks entries up by binary search, so
ascending is also the safe order for more). It starts such a device not at 0 but at the
`SequenceNumber` the project holds for it. An interface sender still starts at 0. ETS downloads a
receiver whose sender list changed even though it shows it as needing nothing: it does not flag such
a receiver.

**Where ETS's value comes from.** It is the last sequence ETS saw that device send: the GVS's answer
to the last request of its own download carries the value ETS writes into the Jung's table; the
Jung's Sync response declares its next sequence, its first answer uses it, and that is the value in
the GVS's table. So ETS takes a device's tool-access answers to come from the counter it sends group
telegrams from. On the Jung that holds: its sending counter, PID 59 of the security object, and the
sequences of its next session's answers continue from the same counter. For the GVS it is not
compared. Busforge records the same value after each session (`SecureSession.peerSequence`, the key
store's `seq_group`).

**A device that only receives, a plain device, a new address.** Further ETS 6.4.1 partial downloads
of the GVS only:

- *Only receives.* With the Jung's transmitting object 253 unlinked from the address and its
  receive-only object 254 ("Schalten - Status": communication and write flags, no read or transmit
  flag) linked instead, the GVS's PID 54 holds the tunnel alone: ETS does not list another secured
  device whose objects on the address only receive.
- *A plain device.* Linking the MDT BE-02001's transmitting object to the secured address: with the
  address's security on "Automatisch" (the default) ETS warns that the address will then communicate
  unencrypted, for every device on it; with "Erzwungen an" it refuses the link ("Eine sichere
  Gruppenadresse kann nicht zu einem Gerät gelinkt werden, welches keine Sicherheit unterstützt").
  ETS never programs a plain device onto an address that stays secured.
- *A new address.* The GVS's switching object linked to a second, new address as well: the address is
  secured automatically, and the download writes a second PID 53 element, `0002` and a 16-byte key ETS
  makes for it. PID 54 keeps the tunnel alone: a new address gets no interface sender of its own.
- *A key table that shrinks.* Deleting that address again, the next download writes PID 53 element 1
  only, start 1, and never touches element 0: the GVS keeps two entries, the second for address-table
  index 2, which the one-entry address table no longer has. ETS leaves such an entry; it refers to
  nothing.
- *A plain address on an old key.* Linking a plain address ("Erzwungen aus") so that it takes index 2
  again, the next download still writes PID 53 element 1 only: the deleted address's key stays the
  entry for index 2, now the plain address's index. ETS never reads PID 53 back. The GVS works such an
  address plain in both directions: a plain GroupValueRead on it draws a plain answer, its status object
  sends plain on it, and a plain GroupValueWrite on it switches the output, while the secured address
  beside it stays secured. The object's flag in PID 61 (`0x00`) decides, not the key table.

**How the project file carries the mode.** ETS 6.4.1 exports with the address set in turn to each
mode: "Automatisch" writes no `Security` attribute on the `<GroupAddress>`, "Erzwungen an" writes
`Security="On"` beside the `Key`, "Erzwungen aus" writes `Security="Off"` and drops the `Key`.
Switching to "Erzwungen aus" first shows a warning that the address will communicate unencrypted.
ETS's undo brings the address back to "Automatisch" with the same key.

## 23. A refused TCP connect from Bun proves nothing, and TCP tunnels need the heartbeat too

**Bun's `ECONNREFUSED` is not a refusal.** Bun 1.3.8 reports every TCP connect that fails at once as
`ECONNREFUSED` (errno -61). Reproduced on macOS: with `ulimit -n 64` an exhausted descriptor table
gives `ECONNREFUSED`, and a connect to an address in the reserved "this network" block, where Node
reports `EHOSTUNREACH`, gives `ECONNREFUSED` in Bun too. A refused connect in Bun does not stick: refused-then-listening recovers on
the next attempt, and 40 tunnel connect/disconnect cycles leak no descriptors. A long-lived Bun
process on macOS that gets every connect "refused" while `nc` reaches the same listening port, and
that recovers on restart, most likely lost LAN access to macOS Local Network privacy (`EHOSTUNREACH`
in Node terms). That is a documented pattern on macOS 15 and later (Apple developer forums 776552,
765285): new processes and Apple's own binaries (`nc`) are unaffected, and restarting the process
ends it. Not proven here. The client's connect error says that Bun cannot tell these causes apart,
instead of passing `ECONNREFUSED` on as the cause.

**The connection-state heartbeat runs on TCP.** KNXnet/IP v2 does not drop the procedure on TCP:
ETS 6 sends a CONNECTIONSTATE_REQUEST over its TCP tunnel
(`06 10 02 07 00 10 01 00 08 02 00 00 00 00 00 00`), and Calimero's `ClientConnection` starts the
60 s heartbeat regardless of transport. Without it, a TCP client whose FIN never arrives keeps its
channel on the server indefinitely (ESTABLISHED connections with no process behind them, every new
tunnel refused with status `0x24`), and a monitor over TCP keeps showing "connected" over a dead link.
Busforge's client and bridge both run the procedure on TCP exactly as on UDP.

Shown on hardware: a raw TCP client that opens a channel and sends nothing is dropped by Busforge's
bridge at about 124 s (DISCONNECT_REQUEST, then FIN). A Busforge TCP tunnel idle for 190 s stays up
against the bridge and reads a device afterwards, and stays up for 190 s against an MDT KNX IP
interface, which therefore answers the heartbeat over TCP (three unanswered requests would close it
after about 90 s). ETS is not affected by the reaper: in every capture it closes its
device-management channel within milliseconds of reading two properties, and it is never silent for
more than 8 s on an open tunnel.

## 24. A device may close the connection instead of answering

A plain `A_FunctionPropertyExtState_Read` of PID 51 (security mode, object type 17) gets four
different answers from four devices. The GVS AMMA with Secure, never activated, answers return code
0, mode 0. The Jung 400021SE in secure mode answers return code `0xFC` (access denied), and a plain
serial read with no element. The ABB US/U 4.2 does not acknowledge the request at all. The MDT
BE-02001.02 acknowledges each of three tries on the transport layer, never answers, and about six
seconds after the first sends a `T_Disconnect` (`0x81`). Why the MDT closes is not shown: six seconds
is also the transport layer's connection timeout, so it may close an idle connection rather than
refuse the service.

A request machine that recognises only the numbered control frames (`T_ACK`/`T_NAK`, `0xC0` and
above) parses `0x81` as a data frame with service `0x100`, acknowledges it and reports an answer.
In Busforge a device's `T_Connect`/`T_Disconnect` is never acknowledged or delivered, and a
`T_Disconnect` ends the request in flight as `DEVICE_CLOSED_CONNECTION`, and it is not asked again on
that connection: a closed connection takes no further numbered frame (a new connection asks it once
more only where the device closed before the request reached it, §25). It is deliberately not `DEVICE_NOT_ANSWERING`,
which callers read as silence: a device that closes is present. The address check before an
individual-address write counts it as taken (a device in another tool's connection answers a
stranger's frame this way), and the read after a restart reconnects and reads once more, as it does
after silence.

## 25. A device that "stops answering" may be a stalled TCP stream

A long run of secured management requests over a TCP tunnel can look like `DEVICE_NOT_ANSWERING`,
to a client that does not wait for the interface's confirmation, with the device not at fault. Traced through a logging proxy: every secured read is answered within about
300 ms up to one request the interface still confirms (`L_Data.con`); after it nothing more arrives
on that TCP stream, while the server side holds it with unsent bytes queued towards the client
(`FIN-WAIT-1`), which is where the device's answer is. Polling the server's TCP state shows lost
segments on a Wi-Fi path that TCP resends after about 200 ms; a few losses in a row put TCP into
retransmission back-off (0.2, 0.4, 0.8, 1.6, 3.2 s), longer than a device request's three tries of
about 2 s each. Neither the device nor Data Secure is the cause: a stream that stalls for a few
seconds cuts off a long run of management requests.

Busforge tells the two apart by waiting, over TCP, for the interface's confirmation of every send
(§15), matched by destination and TPDU, and by not giving up on it while the stream is stalled.

- **The confirmation wait.** A cEMI client waits for a confirmation before its next request, 3 s
  being the recommended time (KNX 3/6/3 §4.1.5.1, a recommendation, not a rule to end the
  operation; Calimero and xknx use 3 s and close nothing when it passes). ETS goes on as well: its log
  of a partial download through a TCP link that stalled for several seconds shows `ConfTimeout after
  1026 ms` and the next frame sent, and the answers arriving with the stream. So a confirmation
  missing after 3 s is not yet a failure. Busforge writes a `CONNECTIONSTATE_REQUEST` behind the
  frame; the interface reads the stream in order, so its answer shows the interface has read the
  frame (an answer to a request written before the frame shows nothing about it). From that answer
  the confirmation gets 3 s more, and missing then it is `TUNNEL_CON_TIMEOUT`: the interface answers
  on the link and did not take the frame, is stuck, or the link stalled again; whether the device
  answered is unknown. While the requests go unanswered the stream is stalled and the send waits, until
  the heartbeat declares the tunnel dead (three requests 10 s apart, KNX 3/8/2 §5.4), which fails it as
  `TUNNEL_CLOSED`. However the answers go, a send waits no longer than that round can last, 3 s on
  each side of it.
  Neither is retried at this layer, and the load runner and the reconnect after a restart pass both
  on rather than report the device as silent.
- **The device's connection timers keep running.** A device closes a connection that carried no
  frame for 6 s, and one whose frame of its own we do not acknowledge after three repetitions 3 s
  apart (thelsing/OpenKNX `transport_layer.cpp`, Calimero `TransportLayerImpl`). A stall that long
  ends the connection under the request. A closed connection answers a numbered frame with
  `T_Disconnect` and passes nothing on (thelsing A10), and a stalled stream delivers the device's
  `T_Disconnect`, our frame's confirmation and what follows in order, in one burst: Busforge hands
  each frame behind a confirmation in that burst on one event-loop turn later, so the request the
  confirmation settles sees what came before it, not what came after. Over USB each frame arrives as
  its own event; over UDP the send ends at the interface's acknowledgement, before the bus, so there a
  `T_Disconnect` counts as ahead of the frame only when it came before that acknowledgement.
- **Asked again on a new connection.** A request whose connection the device closed before the
  request's first frame reached it (its `T_Disconnect` came while the request waited for the frame's
  confirmation, or between two requests after the device had taken a frame of the connection), and of
  which the device acknowledged or refused no try, never reached the device. A `T_Disconnect` that
  lands on a new connection before the device took anything on it may still belong to the connection
  before, and does not count.
  As ETS does after `Connection closed by remote device` (it logs `Waiting 2289.6548 ms before
  reconnect`, opens a new connection and sends the request again, a read as well as a property
  write), Busforge waits 2.3 s, so the device's `T_Disconnect` to the frame that met the closed
  connection lands in the old connection, connects again and asks the request once more. Not after an
  A_Restart on that connection, where a closed connection is the reboot the restart's proof reads (its
  probes included), not for a request sent only once (the tool key write), and not for the first frame of
  a connection, where a `T_Disconnect` is the refusal of a device that holds another connection (§37). A
  device that took the request and then closed (the MDT BE-02001.02 of §24) is not asked again.
- **The restart.** An A_Restart that met a closed connection was dropped by the device, and the
  silence after it would pass for the reboot. So a connection the device closed is opened again
  before A_Restart (and before the master reset), and a restart whose confirmation came after the
  device's `T_Disconnect` is sent once more on a new connection; a restart sent twice reboots the
  device twice, which changes nothing it stores. The proof of a restart sent again counts from the one
  that went out on the open connection, and the device's connection timer from that connection's
  `T_Connect`. Met by a `T_Disconnect` ahead of it again, it is `RESTART_NOT_DELIVERED`: the restart
  most likely never reached the device, so whether it restarted, and stored its configuration, is not
  proven.
- **The restart's proof.** A device that ignored A_Restart closes the idle connection 6 s after it, and
  a link stalled that long delivers that `T_Disconnect` ahead of the probe, where it looks like the
  device going away. So a `T_Disconnect` ahead of the probe proves the reboot only from a device that
  closes as it takes A_Restart: within the proof window (4 s) of the restart's send, which keeps clear of
  the 6 s idle timeout, the restart confirmed in time (a stall around it hides the order), and not after
  a restart sent again (the first
  one's closed connection may still answer); after a restart sent again only a `T_Disconnect` in
  answer to a probe counts. Otherwise the restart is `RESTART_UNPROVEN`, which a flash takes as an
  unproven restart and settles by its read-back ([load-procedures.md](load-procedures.md), "An unproven
  restart in a flash").

Shown on hardware: the confirmation matches against Busforge's bridge and an MDT KNX IP interface
(reads and a secured smoke run). Shown against a scripted interface and unit (`link-stall.test.ts`):
stalls of 2, 5, 8 and 15 s in both directions, at a read, a write, the load bracket's `LoadCompleted`
and the restart, end in the device's bytes, each write and event carried out once and one proven
reboot; a stall longer than the heartbeat's three requests ends the tunnel as `TUNNEL_CLOSED`; a device
that ignores A_Restart is not taken as rebooted, with the probe held by a stall in both directions or
towards the interface only and the restart's confirmation late or not, and a device that closes as it takes
A_Restart behind a late confirmation is reported unproven. The smoke runner's persistence check takes such
a close behind A_Restart as no silence. Not
shown: any of it on a real stall. Over UDP the confirmation is not awaited and a stall costs the tunnel
after two seconds (§35).

What it does not change: a server with one tunnel address that still holds the dead channel refuses
every new tunnel with `0x24` until it reaps that channel, 120 to 130 s after the channel's last frame
on Busforge's bridge ([connections.md](connections.md)). A flash interrupted that way leaves the
device where the bracket stood; recovering it is a full download, started by the user.

## 26. An OpenKNX object with no group address transmits to 0/0/0

An OpenKNX device sends an object that has the communication and transmit flags set but no
association to group address 0/0/0. The cause is in the KNX stack OpenKNX runs (thelsing/knx,
unchanged in the OpenKNX fork):

- `BauSystemBDevice::sendNextGroupTelegram` skips an object whose communication flag is off. One with
  the communication and transmit flags set goes on to `ApplicationLayer::groupValueWriteRequest`.
- `groupValueSend` takes `_assocTable->translateAsap(asap)` without checking it. For an object with no
  association that is `-1`, cast to `0xFFFF` (the read path checks for `< 0`, the write path does not).
- `AddressTableObject::getGroupAddress(0xFFFF)` is out of range and returns `0`: group address 0/0/0.

The unchecked lookup is an upstream bug; a device configured by any tool that leaves the flag on for
an unlinked object shows it. Busforge clears the Communication flag on com-objects that carry no group
address, as ETS does (§7), so the stack skips them. The 0/0/0 sends are seen on an OpenKNX AB-PRE
commissioned with the flag on for unlinked objects. That clearing the flag stops them is shown by the
source only: a listen on a live line with an OpenKNX device programmed that way sees nothing sent to
0/0/0, but that device sent nothing at all in the window.

## 27. The Jung 400021SE clears the last byte of its parameter segment

A full ETS 6.4.1 download of the Jung after a master reset (ETS activates it from its certificate,
then downloads everything; capture decrypted with the exported project's keys) shows the whole load
of the parameter segment:

- LSM 4 is allocated with `0x1E15` bytes, then PID 27 of object 4 gets the two elements the application
  declares (`LdCtrlWriteProp`): `00001E14 0033 0000` and `00000001 0133 0000`, a region of `0x1E14`
  bytes and one of a single byte, the segment's last. Busforge writes the same.
- The memory writes put `01` at offset `0x1E14`: parameter P-1, default 1. Busforge's full-download
  image and its parameter-flash target both have `01` there.
- `LdCtrlLoadImageProp` is no write: at the end ETS only reads PID 27 of objects 1 to 4 back, each entry
  now carrying the device's CRC.

Read back through Busforge afterwards, the segment equals what ETS wrote in every byte but `0x1E14`,
which holds `00`. The device clears that byte itself. P-1 is the application's `_Allg_Download`
(`Access="None"`, value 1), a download marker by its name, and it sits alone in a region whose
CRC-control byte is 1, so ETS sends it in every download, its partial form included, although its own
record of the last download already holds `01` ([load-procedures.md](load-procedures.md#the-rules-by-level),
R16). ETS's download with nothing changed sends that byte alone and restarts the unit; so does a
Busforge full download. A Busforge parameter flash counts the cleared byte alone as no change, since
P-1 holds the same value in every configuration of the application (R17), and writes it with any
other change.

## 28. What ETS writes when a parameter change alters the com-object table

ETS 6.4.1, "Programmieren > Partiell", four captures: the Jung 400021SE with K2 switched from
"Schalten" to "Dimmen und Farbtemperatur" and back (decrypted with the exported project's keys), and
the MDT BE-02001.02 with input B switched from "Kontaktzustand senden" to the two-object short/long
function, downloaded once in full by ETS, then switched back. Trimmed fixtures of these captures are
in the [private corpus](testing.md#the-private-corpus).

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
senden", ETS writes `01` at `0x44B2`, a byte of input B's short/long settings that the new function no
longer uses; `01` is the segment's `<Data>` template there, the short/long function had `00`. So ETS
writes the bytes where its whole image changes, not only those of active parameters.

**Every byte ETS writes matches Busforge's image for the same configuration**: 42 on the Jung (through
a conversion of the decrypted capture that leaves out the security object's writes) and 222 on the MDT,
none divergent (`tools/etsdiff.ts --partial`, `tools/etsdiff.test.ts`). The structural flash is built
on these brackets (see [load-procedures.md](load-procedures.md#structural-flash)). Where it differs
from ETS: on System B it writes every byte its parameter model owns, as the parameter flash does; on
System 7 of the parameter segments only the bytes that differ from the device, and it brackets the
group tables as ETS does, unload and segment declaration included. Against the MDT capture the writes are exact: Busforge's are the bytes
ETS changed, with ETS's values, given the configuration ETS had downloaded before as the baseline.

## 29. ETS imports only the certificates from a keyring

ETS 6.4.1, a new project with the Jung 400021SE (activated by ETS, its tool key held by another
project) inserted from the catalog. *Projekt > Sicherheit > Schlüsselbund importieren* asks for a
project password first, then for the keyring's.

- A Busforge keyring with the Jung's `ToolKey`, `SequenceNumber` and `SerialNumber` and no `FDSK`:
  "Import fehlgeschlagen. Die Datei enthält keine Gerätezertifikate." Password and signature pass.
- The same with the Jung's `FDSK`: "1 Gerätezertifikat(e) importiert", listed by serial, not
  assigned. So does a file from the export endpoint, and one with an `Interface` element.
- *Info > Geräteinfo* of the device in that project: mask `FFFF` and the address, nothing else (a plain
  read of a secured device). The same after the serial is set on the device and the certificate shows
  as assigned to it. In the project holding the tool key, over the same interface: mask `07B0`,
  serial, firmware, application loaded and running.

ETS therefore uses a keyring's certificates for a device it commissions itself, and ignores the tool
key of a device that is already activated. A device Busforge activated reaches ETS only through a
master reset and the certificate.

## 30. The GVS AMMA ignores a Sync shortly after one it could not authenticate

On the GVS AMMA in Data Secure (one tunnel, over Busforge's bridge): a Sync with a wrong tool key goes unanswered, as it
should. A Sync with the right key that follows it about 3.1 s later (the wrong one's 3 s timeout, a
T_Disconnect and a new T_Connect in between) also goes unanswered; the next one, 0.4 s after that, is
answered. With 2, 5, 10 or 20 s more between them the right key is answered at once. The Jung 400021SE
answers the right key straight after the wrong one. So the AMMA does not lock out after a failed
authentication; it drops a Sync within a few seconds of an unauthentic one. Where exactly the window
ends (between about 3 and 5 s) is not measured. The smoke spec of a device that does this declares it
(`secondSyncAfterWrongKey`, today only the GVS); the robustness check then records the silent first
Sync and requires the second to open the session.

## 31. A flash cut off inside its load bracket

A parameter flash started from the flash dialog, with the server's TCP socket to the interface killed
as soon as the task reports its write phase (shown on the MDT BE-02001.02), fails as
`FLASH_INTERRUPTED_UNLOADED` ("the write broke off inside its load bracket and may have left the
device unloaded; TUNNEL_CLOSED") within seconds. The dialog shows that message and offers the full
download, which verifies; a later parameter flash of the same device verifies too. Shown at that one
cut point only; other cut points (after LoadCompleted, inside the table writes) are not tried.
After such a failure the dialog offers the full download alone where that download loads the
application: Flash stays disabled, and no target is previewed again, by itself or through Retry.
Flash also waits until every target has previewed, so no write queues behind a preview.

A session opened straight after the cut can meet the device still repeating an answer the closed
tunnel never acknowledged. The MDT BE-02001.02 in verify mode answers each memory write with an
`A_Memory_Response` (the ETS downloads of the device in the private corpus show it), so after a cut parameter write that
repetition is a memory response, for example one byte at `0x44A5` in its parameter memory. Taken as the
answer to a device descriptor read, its three octets read as the mask `MV-44A508` and the session
stops with `MASK_MISMATCH`, as a group-address preview right after the failure did. The descriptor
read takes only a descriptor response, and a frame of another service is acknowledged and dropped
(§4). That the octets were such a repetition is inferred from them, the frame was not logged; that a
session after such a cut then reads the device's own mask is shown against a scripted device, not on
hardware.

## 32. ETS does not run the Gira M-0008's declared procedure

ETS 6 downloads of the Gira Tastsensor 3 Komfort (`M-0008_A-10D7-11-2783-O000A`, MV-0705,
`DynamicTableManagement="true"`), a full, a parameter, a group-address and a reverting partial
download, each captured with ETS's own log of the steps it executes:

- The address and association table segments are taken as one region. ETS declares LSM 1 exactly as
  long as the address table and LSM 2 directly behind it (`16384+17`, `16401+467` for the declared
  `16384+243`, `16627+241`); one more group address moves the association table by two bytes
  (`16384+19`, `16403+465`). Each is unloaded first, LSM 3 never.
- The application (LSM 3) is loaded, written and completed, without `LdCtrlAbsSegment`,
  `LdCtrlTaskSegment` or the declared `LdCtrlTaskCtrl1`, in every one of the five downloads.
- `LdCtrlLoadImageProp` is a read: PID 27 of objects 1, 2 and 3 (six elements, one per segment
  declared with `SegFlags="128"`), after the last `LoadCompleted`. Before the next download ETS reads
  object 3's stamps again and skips every byte it takes the device to hold; the 3-byte segment
  declared with `SegFlags="0"` has no stamp and is written every time.
- On this mask the segment declarations are PID 5 writes (`03 00 …`, `03 02 …`), as on the MDT
  BE-02001.02, where Busforge sends them to memory `0x0104` (the control register of the
  memory-mapped masks) and the device accepts that (hardware-proven full download).
- The association table lists each object's first address (the one it sends on) first, by object
  number, then the others by object and group index.

What Busforge sends for it, and where it departs from ETS: [load-procedures.md](load-procedures.md#ets-captured-system-7-downloads).

## 33. Objects outside a shown ParameterBlock are linked too

Links are resolved against the configuration view: an object the view does not list keeps its link in
the project, but the group tables built from the view leave it out. Two placements are linked by ETS
and must be listed:

- A `ComObjectRefRef` directly under a `<Channel>` (or a `ChannelIndependentBlock`), outside every
  `ParameterBlock`. The Theben Meteodata 140 S (`M-0048_A-140C-14-EB70`) places its measured-value
  objects 0-4, 6 and 15 there; ETS lists them and its address table holds their 7 links (count `0x14`
  = own address + 19 in its full download, against 13 without them). The TheLuxa P300
  (`M-0048_A-107E-12-5B58`, 8 objects) and MIX 2 `M-0048_A-9071` (18) do the same.
- A `ComObjectRefRef` inside a `ParameterBlock Access="None"`. The MIX 2 `M-0048_A-493B-21-B471`
  keeps its central objects 241-252 in such a block ("Gemeinsame Objekte"); devices ETS programmed
  hold associations for those of them the project links.

The view lists them: an object directly under a container goes into the container's own section
(a text-less container gets one, named by its `Name`), an object of a hidden block into the section
that encloses the block. Every active object the image pass reaches must appear in the view, or the
configuration is refused (`CONFIG_VIEW_INCOMPLETE`), and so is anything placed outside every
channel and block. A test over every catalogue fixture checks the view against the image pass
and against the catalogue itself (every `ComObjectRefRef` with no `<when>` above it). Over an ETS
installation project, listing these objects changes only views, no parameter image, and every
project link resolves.

## 34. The Theben MIX 2 counts a download only after its counter was read

The MIX 2 units (`M-0048_A-493B-21-B471`, all three products) keep a download counter in the device
object, PID 30 (`PID_DOWNLOAD_COUNTER`, read-only, unsigned). It does not count every download. It adds
2 at the first download after PID 30 was read, application or tables alike, and stays put for every
further download until it is read again. A restart alone does not count, and reading another property
does not re-arm it. So two downloads with no read of PID 30 between them add 2, the same two with a
read between add 4, whichever tool runs them. No download writes PID 30, and Busforge's
download paths never read it; the collector does (`tools/collect.ts` reads the device object's
properties), so a package taken between two downloads changes what the second one does to the counter.

## 35. A UDP tunnel dies when its client stops to think

Over KNXnet/IP UDP every TUNNELLING_REQUEST needs a TUNNELLING_ACK within 1 s; a server repeats an
unacknowledged one once and then disconnects (3/8/4). That includes the `L_Data.con` of the client's own
frame, which arrives a few tens of milliseconds after the client sent it. A client that starts a long
computation right after a frame therefore loses its channel two seconds into it, without having sent
anything wrong. Busforge's bridge enforces this exactly. Over TCP nothing is acknowledged, and the same
pause costs nothing. Whether a given KNX IP interface enforces it is not known.

Parsing an application program is such a computation: about a second on a fast machine for a large one
(the OpenKNX RaumController's is 76 MB of XML), several on a slow host. A server limited to a quarter of
a CPU core that parses the Jung 400021SE's application (26 MB) inside the device session loses its UDP
channel to the bridge about 2.5 s after the tunnel opens, in every full download. Busforge parses the
application before it opens the session and takes the load procedures from that parse; from the same
server the same downloads verify.

A send into the closed socket is no help in finding this. The tunnel closes its socket on the server's
DISCONNECT_REQUEST, and Bun's `node:dgram` answers a later send with a bare `TypeError` (`null is not an
object (evaluating 'kStateSymbol')`, the same on a second `close()`), where Node throws
`ERR_SOCKET_DGRAM_NOT_RUNNING`. Neither names the closure. A send on a closed tunnel fails as
`TUNNEL_CLOSED` without touching the socket, a send waiting for its acknowledgement when the channel
closes included, and a disconnect of a closed tunnel does nothing.

## 36. ETS lists the sending address first, and the device sends on it

ETS 6 writes the association of an object's sending address (the address its association view marks
as sending; "Sendend setzen" moves the mark) before the object's other addresses, whatever its group
index and whenever it was linked. Captured twice on the MDT BE-02001.02, object 0 with two addresses,
the address table ascending both times:

| Sending address | Linked | Association table |
| --- | --- | --- |
| the higher | first | `02 \| 02 00 \| 01 00`, the higher address's index first |
| the lower | last, then set as sending | `02 \| 01 00 \| 02 00`, the lower address's index first |

The unit sent on the address listed first both times: after each download's restart object 0 sent its
state there, and a GroupValueRead of either address was answered there. In both runs the address object
0 sent on, and answered reads on, was its first association; not its lowest or highest group index,
and not the order its links were made in. A read-back that sorts an object's addresses loses it;
Busforge keeps the first association first.

An Auro presence detector (application FE01) answered the same way: with an address added behind the
light level object's one own address, a GroupValueRead of the added address was answered within 50 ms
with the object's value on its own address, and nothing answered on the added one. With one own
address, below the added one, this does not tell its first association from its lowest.

## 37. A device closes a connection that carries no request for six seconds

A transport-layer connection has a connection timeout of 6 s: a device that has taken no frame on it for
that long sends `T_Disconnect` (`0x81`) and takes no further numbered frame, so the next request meets a
closed connection: it is asked once more on a new connection 2.3 s later (§25), or 12 s later where the
device had taken nothing on the connection yet (below), and on a connection that carried an A_Restart it
ends as `DEVICE_CLOSED_CONNECTION` (§24). The OpenKNX RaumController does exactly this, its `T_Disconnect` 6.0 s
after the client's last frame. A client that works between two requests (parsing a large application,
building an image or a configuration from it, decoding what it read) loses the connection once that work
takes six seconds, and on a host under load it takes a multiple of its idle time. Over UDP the same pause
costs the tunnel after two (§35).

So Busforge does no such work while a device session is open. A session opens at the operation's first
request to the device, and the mask check runs then: what an operation builds from the application (its
images, tables, configurations, coverage, refusals) is built before the tunnel opens; a refusal of a build
the operation uses only after a device check is raised where it uses it, after that check. A read-back
reads everything it takes off the device (parameter segments, group tables, com-object table, and where it
checks whether the device holds the configuration, its application id and load states) and decodes it after
its session has closed; that check's two dry runs then run in sessions of their own. Between two requests a
System B or System 7 operation compares bytes. The System 1 download builds its plan after it has read the
unit's friendly name, which the plan keeps; its application is the size of a BCU 1 EEPROM. The System B
writes (parameter, group-address and structural flash, both forms of the full download) are tested to keep
to the same rule up to their restart and through the read-back that verifies them, against an emulated
unit; the System 7, System 1 and secured writes are not.

A wait the device itself needs is spent without a connection. The thelsing/OpenKNX full download leaves the
device alone for 8 s before its restart, for the save the firmware makes 5 s after its memory was last
written ([load-procedures.md](load-procedures.md), the deferred save): the connection is closed before that
pause and a new one carries the restart. The wait for a device that commits its flash after the last
`LoadCompleted` closes the connection before each try to reach it.

A new connection to a device needs the old one closed first. The OpenKNX RaumController takes a `T_Connect`
from the partner it is connected to as nothing: it keeps that connection's sequence numbers, and a request
of the new one, numbered from 0, gets `T_NAK` each time it is sent. After `T_Disconnect` and `T_Connect`
the same request is answered.

A connection whose link to the interface failed may still be open in the device: the `T_Disconnect`
that ends it went into the stalled link and never reached the bus, and the device still waits for the
`T_ACK` of its last answer, repeating it. A device holding a connection takes a `T_Connect` from the
same address as nothing (it keeps the old numbering), answers one from another address with a
`T_Disconnect` at once, and ignores a `T_Disconnect` from another address (the transport layer's A0,
A10 and E3): the OpenKNX RaumController closed a new connection that way when the new tunnel had
another tunnel address than the failed one. Only the device ends that connection, after 6 s without a
frame, or 3 s after the third repetition of a frame never acknowledged, 12 s after the frame.
Busforge therefore:

- notes a connection when a frame of it fails on the link, and the next connection to that device
  under the same tunnel address, within 12 s, closes it first with a `T_Disconnect`;
- takes a `T_Disconnect` to the first frame of a new connection, before the device acknowledged or sent
  anything on it, for a refusal: it waits 12 s, connects again and asks once more, and a second refusal
  is reported as the device holding a connection with another partner. A secured session, whose
  first frame is its Sync, takes a `T_Disconnect` before or at the Sync for the same refusal and is
  opened and synced again the same way.

The ETS captures show no failed link.
