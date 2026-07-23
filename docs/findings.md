# Findings: KNX device programming from scratch

Running technical log of the spike. The honest record of what it takes to read and
flash real KNX devices without ETS. This log *is* the open-source value.

Target hardware: MDT SCN-IP000.03 IP interface (`203.0.113.41`), live house bus,
devices from GIRA / Theben / Basalte / MDT / Steinel / MEAN WELL.

---

## 1. Inputs: the `.knxproj` is self-contained

A `.knxproj` is a ZIP. The **manufacturer application data** (the `.knxprod`
equivalent: `M-XXXX/…_A-….xml`, `knx_master.xml`) sits **in plaintext** in the
outer ZIP. Only the project instance data (`P-XXXX.zip`: topology, devices,
parameter values, group addresses) is encrypted. So you do **not** need the KNX
online catalog to program a device already in a project.

**ETS6 project decryption** (matches `xknxproject`):

```
winzip_password = base64( PBKDF2-HMAC-SHA256(
    password.encode("utf-16-le"),
    salt = b"21.project.ets.knx.org",
    iterations = 65536, dklen = 32 ) )
```

Then `P-XXXX.zip` is a standard WinZip-AES archive opened with that derived
password (`7z x -p<derived>`). `0.xml` inside = installations / topology / devices /
group addresses / com-object instances.

Key relations in `0.xml`:
- `GroupAddress Id="…_GA-n" Address="<16-bit>"`.
- `ComObjectInstanceRef RefId="O-x_R-y" Links="GA-a GA-b …"` links a device's
  com-object to group addresses.
- Device → app via `Hardware2ProgramRefId` → `M-XXXX_A-….xml` (ApplicationProgram).

---

## 2. The device data model (what you must reconstruct)

A device's loaded state is a set of **interface objects** with **Load State
Machines** (LSMs), each backed by a memory **segment**:

| LSM / ObjIdx | Segment | Content |
|---|---|---|
| 1 | Address table | group addresses the device uses |
| 2 | Association table | (group-index → com-object-number) pairs |
| 3 | Com-object table | per-com-object flags + datapoint size |
| 4 | Application / parameter | the parameter image (settings) |
| 5 | Interface program | second app program (if present) |

Table layout (System B, mask `MV-07B0`), all big-endian:
- **Address table**: `[count:2][GA:2]×count`, GAs sorted ascending.
- **Association table**: `[count:2][groupIdx:2][comObjNum:2]×count` (long form) or
  1-byte fields (short form). Detect by validating group indices ≤ count.
- **Com-object table**: `[count:2][flags:1][typeOrSize:1]×count`.
- **Parameters**: each `<Parameter>` has `<Memory CodeSegment="…_RS-04-…"
  Offset="N" BitOffset="M"/>`; value stored at that offset in the LSM4 segment,
  big-endian, size from the `ParameterType` (`SizeInBit`).

Read the table base address at runtime with `PropertyValueRead(obj, PID=7)`
(big-endian). Read the LSM state with `PropertyValueRead(obj, PID=5)`.

---

## 3. The load procedure (how ETS "downloads")

Authoritative recipe lives in `knx_master.xml` per `MaskVersion`, with
`ProcedureType` (Load/Unload) × `ProcedureSubType` (`all` / `grp` / `par` /
`par,grp` / `cfg`). Manufacturer apps may use `MergedProcedure`. The master
procedure contains `LdCtrlMerge MergeId="k"` points that are replaced by the
product's own `LoadProcedure` fragments (`LdCtrlRelSegment`, `LdCtrlWriteRelMem`,
…) filtered by `AppliesTo` (`full` vs `par`).

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

A `grp` download rewrites **all three** tables (changing a GA can shift
association indices, so ETS always rewrites 1+2+3 together).

### LSM events (property-mapped, `PropertyMappedLsms=1`)

Write the load **event** as the value of `PID 5` (a 10-byte payload, `[0]`=event):

| Event written to PID 5 | Resulting STATE read back from PID 5 |
|---|---|
| `1` (Load / start loading) | `2` (Loading) |
| `2` (LoadCompleted) | `1` (Loaded) |
| `4` (Unload) | `0` (Unloaded) |
| `3` (AdditionalLoadControls / segment op) | n/a |

Note the asymmetry: the **event** value written ≠ the **state** value read.

### Segment allocation (`LdCtrlRelSegment`)

`PID 5` payload `[0x03, 0x0b, size:4 (BE), mode, fill, …]`. `Size=2` in the
procedure means "use the actual data length". After allocation, re-read the
segment address via `PropertyValueRead(obj, 7)` before writing.

### Parameter download (`par`): extra steps beyond tables

The `par` procedure also stamps the application id so `LoadCompleted` validates the
segment: `LdCtrlWriteProp ObjIdx=4 PropId=13 InlineData=<manuf:2><appNum:2><ver:1>`
(for MEAN WELL: `01 62 00 04 11`). A minimal LSM4-only sequence that worked here:

```
Unload 4 → Load 4 → RelSegment 4 (Mode=0) → WriteRelMem 4 (+verify)
        → WriteProp 4/13 (app-id) → LoadCompleted 4 → Restart
```

(The full master `par` also touches LSM5, `LdCtrlLoadImageProp`, `LdCtrlCompareProp`
and merge fragments; not needed for a param-only change on this device.)

---

## 4. The connection-oriented transport layer

Connection-oriented KNX management on top of the tunnel. The pieces that matter on
a **busy live bus**:

- `T_Connect` (connectionless control to the device).
- Numbered request → wait for the device **`T_ACK`** (matching our 4-bit sequence),
  **retransmit** on timeout (the bus drops the occasional ACK).
- On a device data response: **send our `T_ACK` first, then** release the waiter,
  if the next request goes out before our ACK, the device ignores it.
- Increment the 4-bit sequence per transaction.

Short per-op timeouts (≈1.5 s) so a lost ACK fails fast and the **whole procedure**
is retried on a fresh connection (idempotent when writing identical content) rather
than burning past the device's ~6 s CO-connection timeout and killing the session.

---

## 5. Transport gotchas you must get right

The non-obvious things that have to be correct before connection-oriented
management works at all on a busy live bus:

1. **Do not block on the KNXnet/IP `L_Data.con`** (the decisive one). It carries the
   **server** sequence counter, not the client's, so naive matching never succeeds
   and every send stalls for its full timeout, which starves response handling. The
   `TunnelingAck` already provides flow control; treat the bus confirmation as
   fire-and-forget.
2. **Stamp the source address.** Outgoing `L_Data` may carry `0.0.0` expecting the
   interface to substitute the tunnel address. Some interfaces (e.g. MDT) do not do
   this for connection-oriented frames, so device replies never route back. Set the
   source to the assigned tunnel address before sending.
3. **`A_Memory_Read` address is big-endian.** Sending it little-endian makes the
   device read the wrong location (it echoed `A=0010` for a request to `0x1000`).
4. **Verify mode: unnecessary for a small surgical write, essential for a big one.**
   For the surgical par flash (a handful of chunks) it is cleaner to write ack-only
   and read the owned bytes back yourself. But a full download writes a 21601-byte
   segment, where a full read-back is ~1800 extra telegrams; there, verify mode
   (object 0, PID 14, bit 2) earns its keep: the device echoes every write with
   what actually landed, so a dropped write fails AT the chunk instead of surfacing
   a thousand telegrams later, and the whole segment is then confirmed with one
   `PID_MCB_TABLE` CRC read rather than reading it all back. The application's own
   load procedure declares `LdCtrlWriteRelMem Verify="true"`, i.e. it asks for this.
   See [openknx.md](openknx.md).
5. **Authorize.** Devices with an access level set need `A_Authorize_Request` (key
   `0xFFFFFFFF` for default/free access) before the load procedure. Devices with no
   key configured accept unauthenticated management.
6. **Handle the UDP socket's asynchronous error channel, and know it is
   platform-dependent.** A `CONNECT_REQUEST` sent to a gateway IP with nothing
   listening draws an ICMP port-unreachable. On **Linux** the kernel delivers that
   back as an `ECONNREFUSED` on the datagram socket's `error` event; with no listener
   Node/Bun rethrows it as an uncaught exception that crashes the process. On
   **macOS** the same error is never surfaced, so the connect merely times out.
   Result: a dead gateway "works" (times out cleanly) on a Mac dev machine and
   **crashes on a Linux CI runner** for the identical code. The UDP `connect()` must
   attach an `error` handler and route it like the TCP path does (a coded
   `TUNNEL_CONNECT_FAILED` while connecting, an `onClosed` once the tunnel is up).
   The `send()` callback is not enough: that ICMP error arrives on a later receive,
   not in the send completion.

---

## 6. Results (verified on real hardware)

- **Read-back byte-match**: group address table built from the decrypted project ==
  the bytes loaded on the real device (55 GAs, 112 bytes, identical). Association
  count and com-object table structure matched too.
- **Flash**: full `grp` load procedure executed first-try; all LSMs `Loaded`, table
  byte-intact.
- **Functional GA change**: `2/1/7 → 2/1/8`, proven on the bus via `GroupValueRead`,
  reverted.
- **Functional setting change**: cyclic-voltage interval `600 s → 60 s`; observed an
  autonomous `1.1.x → 2/1/2` broadcast within 75 s (silent at 600 s), reverted.

---

## 7. Safety lessons (writing to live hardware)

- A real download **unloads segments first**. A crash between Unload and
  LoadCompleted leaves the device "unloaded": still addressable, recoverable by
  re-flash or ETS, but its function is off until reloaded. **The memory DATA
  survives unload** (only the load-state flag changes).
- Always **back up the segments to disk** before writing; the backups + an
  identical-content reload are the recovery path (plus ETS as the last resort).
- Devices **reject raw `A_Memory_Write` to a loaded segment**, you must drive the
  load state machine. (Good: you can't corrupt a device with stray writes.)
- The application/parameter segment (LSM4) is more critical than the address tables;
  treat it with more care.
- Prefer testing write procedures against **KNX Virtual** or a quiet bus before
  live hardware.

## 8. The parameter image

Parameters live in the LSM4 segment (a `RelativeSegment` with `LoadStateMachine=4`)
which ships a base64 default `Data`. Each `<Parameter>` has
`<Memory CodeSegment Offset BitOffset>`; its size comes from the `ParameterType`
`SizeInBit`. Build the image from the segment default, then write each parameter's
effective value at its offset (big-endian for >= 8 bit, a bit field at `BitOffset`
for sub-byte).

**Value precedence (verified by byte-match against a real device):** the device
instance value (from the project `0.xml` `ParameterInstanceRef`) if set, otherwise
the `Parameter`'s own `Value`. The `ParameterRef.Value` is a planning/UI-layer
default and is NOT the image source (a device showed the parameter default `10`,
not the ref value `1280`).

**Verified:** built the full 212-byte parameter image for a real device from
project + product data; byte-identical to the segment loaded on the device.
Unions / conditional visibility (choosing the active parameter per offset) were not
needed for this device; that is the remaining dynamic-engine work for devices that
use them.

## 9. A group-address flash must rewrite the com-object table, not just the group tables

A "group address" (GA) flash — the surgical download that changes which group
addresses an object talks on — writes the address table (L1) and the association
table (L2). The obvious implementation keeps the device's com-object table (L3)
untouched: a link change does not add or remove objects, so why rewrite L3?

Because **L3 carries a per-object Communication flag, and ETS clears it on every
object without a link** (`comobjbuild.ts` `buildComObjectTable`: an object with no
association has `comm=0`, byte-verified against an ETS-programmed device). So an
object that was **unlinked at the last full download holds `comm=0`** in the
device's L3. Writing only L1+L2 to link it then points a group address at an object
whose L3 still says "does not communicate". The device happily **acknowledges
telegrams to that group address** (the address is in L1, so the data-link layer
ACKs), and the read-back **verifies green** (the group tables match our image), yet
the object is **functionally deaf**: it neither answers a `GroupValueRead` nor
transmits on change. A textbook "green ≠ device-correct".

**Hardware-proven on the GVS AMMA (System B, MV-07B0, `1.1.203`), three runs:**

| Setup | Status object answers? |
| --- | --- |
| Full download WITH the switch + status linked | ✓ transmits + answers reads |
| Baseline full download (no links) **then a GA flash** to add the links | ✗ dead (transmit + read both silent) |
| Same GA flash, **after the fix** (GA flash rewrites L3) | ✓ transmits + answers reads |

The switch relay clacked in every case (the write path and the device's reaction
were never in doubt); only the status object, linked purely by a GA flash, was
dead. It came alive the instant L3 was rewritten with its Communication flag set.

**The fix:** the GA flash rebuilds L3 from the current link set
(`buildComObjectTable`) and writes **L3+L1+L2 in one bracket**. It stays surgical:
those three are small tables, so it never touches the large parameter image (L4) —
the reason a mere link change is NOT promoted to a full download. The staleness gate
(`assertComObjectTableStable`) still guarantees the only L3 change is link-driven,
so a pure re-point of an already-linked object writes L3 byte-identical (a no-op).

**One behaviour change to keep in mind:** the GA flash used to write the device's own
L3 back verbatim; it now **re-authors L3 from busforge's model** of the com-object
table. On a device busforge itself programmed this is byte-identical apart from the
link-driven comm flags. But a device last programmed elsewhere (ETS, or with drifted
parameters) may hold an L3 that differs from busforge's authoring in non-link bytes,
and a GA flash now rewrites those objects too — then verifies green against busforge's
own table. This is the project's standing caveat (device == our image is proven, our
image == ETS is not), now reaching the GA path: after a GA flash the device's L3 is
busforge's, not whatever it held before.

**Lesson (the general one):** flash exactly the segments that diverge from the
device, at the segment granularity — do not fall back to a full download for a
change that only moves L1/L2/L3. And the read-back verify is a **placement** proof,
never a **behaviour** proof: a link can be byte-perfect and still deaf, which is why
the smoke framework observes the bus (it was the behaviour check, not the read-back,
that caught this).
