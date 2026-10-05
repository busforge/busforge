# Raw acquisition

How Busforge reads identity, interface-object properties and bounded memory ranges from a KNX
device it cannot program, without writing anything and without inventing a byte. The collector is
built to this design; [Implementation](#implementation) says where, what it adds to the design and
what it leaves out, and [Diagnostic package](#diagnostic-package) how a user runs it from the app
and what the file they save holds. Nothing here is a verification claim beyond the bench runs listed there
([status.md](status.md) holds the claims).

The rule that shapes every section: **a range is either read, refused with a reason, or not
attempted with a reason**. A protected address answers with an empty or negative response, and
that answer is the result. Zero-filled gaps, guessed sizes and "probably the same as the sibling
product" are exactly what this design exists to avoid.

## Sources

| Source | What it gives | Where |
|---|---|---|
| KNX master data, `MaskVersion` resources | Per mask: where each system resource lives (memory address, pointer, interface-object property), its length and read access. | `knx_master.xml` inside every `.knxproj`. Checked against ETS 6 master data version 298 (`scratchpad/ets-captures/bench-2026-09-25.knxproj`, local) and the copy under `reference/vendor/Kaenx.Konnect` (local, gitignored): identical for every mask quoted here that the master data contains. MV-0311, MV-1311, MV-2311, MV-2010, MV-2110, MV-0810, MV-0811, MV-0AFD, MV-0AFE, MV-3012 and MV-4012 are in neither file; Busforge knows them from its own registry (`packages/product/src/masks.ts`). |
| ETS 6 captures of the four bench devices | What a real tool reads before it writes, and how the devices answer. | `captures/*-ets-*.log` of the [private corpus](testing.md#the-private-corpus), turned into checked vectors (see [Reference vectors](#reference-vectors)). |
| Captures of the collector on the bench | What the devices answer to the requests ETS never sends: the description scan, absent properties. | `captures/*-collect-scan.log` of the private corpus, checked vectors as well. |
| A capture of single memory reads on the bench | How a device refuses a memory read. | `captures/bench-memory-refused.log` of the private corpus (`tools/memread.ts`), checked vectors as well. |
| Calimero (`calimero-core`, `ManagementClientImpl`, `ManagementProceduresImpl`) | Service formats, chunking, how negative answers look. | github.com/calimero-project/calimero-core |
| xknx (`xknx/management/procedures`) | `DMP_InterfaceObjectScan_R`, memory-read and authorize procedures, return codes. | github.com/XKNX/xknx |
| thelsing/knx (OpenKNX stack) | Device-side behaviour: what a property description or an out-of-range read returns. | github.com/thelsing/knx |
| Busforge's own read path | What already exists (`packages/knx/src/device.ts`). | this repo |

The KNX specification itself (03.03.07 application layer, 03.05.01 resources, 03.05.02
management procedures) is paywalled and was not read. Facts that rest on one implementation's
reading of it are marked **(inferred)**.

## Boundaries

**Allowed services**, and nothing else. The collector issues no service outside this list; a
plan that needs one is a design change, not a configuration.

| Service | Use |
|---|---|
| `T_Connect` / `T_Disconnect` | the management connection |
| `A_DeviceDescriptor_Read` type 0 | the mask version |
| `A_Authorize_Request` with the free key `FFFFFFFF` only | the access level a tool without keys gets, as ETS does |
| `A_PropertyDescription_Read` | enumerate interface objects and their properties |
| `A_PropertyValue_Read`, `A_PropertyExtValue_Read` | property values |
| `A_FunctionPropertyExt_StateRead` on the security object, PID 51 | security mode, through the existing `securityMode()` |
| `A_Memory_Read`, `A_MemoryExtended_Read` | planned memory ranges only |

**Forbidden:** every write service, `A_Restart` in any form, `A_Key_Write`, any property write
(including the load-state and run-state controls, `PID_LOAD_STATE_CONTROL` written), function
property commands, `A_Authorize` with any key other than the free key, broadcast address
services (they belong to commissioning), and any read of a resource whose master-data
`AccessRights Read` is `None` (every `*LoadControl` and `*RunControl` resource carries it).

The `Read None` rule is about locations, not names. A control and its status often share one
location (object N, PID 5 is both `GroupAddressTableLoadControl` and the readable
`GroupAddressTableLoadStatus`), so a location is readable when a resource with `Read Runtime`
covers it. A memory range must not overlap a `Read None` location that no readable resource
covers: on MV-0700, MV-0701, MV-0705 and MV-5705 that is the 12-byte load control at `0x0104`, and on MV-0700 the run
controls at `0x0101` and `0x0102` (their run statuses at the same bytes are readable, so those
two bytes are read only as the status resource, one byte each).

**No sweep.** Memory is read only inside ranges derived as below. "Read 0x0000 to 0xFFFF and see
what answers" is not a plan: on the OpenKNX stack a memory read, classic or extended, is answered
from `nonVolatileStart + address` with no range check at all (thelsing `bau_systemB.cpp`,
`memory.cpp`), so an unbounded address can return arbitrary bytes or upset the device.

**No state.** The collector changes neither the device, nor the desired project values, nor the
programmed baseline. It runs as a bus job (so it takes the bus exclusively and closes the
monitor, see [Collector design](#collector-design)) and produces only its own package.

## The generic stage

Every device gets this, whatever its mask. It needs no product data.

```
T_Connect
  DeviceDescriptor type 0 ......... mask, or MV-FFFF: secured and no key -> stop here
  [mask declares AuthorizeLevels]
    Authorize FFFFFFFF ............ level (ETS gets 0 from all four bench devices)
  [mask has interface objects, or the BCU1 plan]
    PID 56 on object 0 ............ max APDU, or absent (count 0) -> classic chunks
  [mask has interface objects]
    identity properties ........... object 0: PID 11 serial, 12 manufacturer, 15 order info,
                                    25 version, 78 hardware type, 9 firmware revision;
                                    PID 13 (application id) on the application object
    load states ................... PID 5 on every load-controlled object, read only
    interface-object scan ......... see below
  [System B only, last request of the session]
    security mode ................. object type 17, PID 51
T_Disconnect
```

The descriptor decides which steps run. A mask Busforge does not know at all still gets the
descriptor and the scan; nothing else.

**The security-mode read comes last, and only on System B.** Asked without a key, the MDT
BE-02001.02 (MV-0705) closes the connection and the ABB US/U 4.2 (MV-0701) does not answer
([status.md](status.md), Data Secure read row); ETS never sends them the request. A request
that timed out also leaves the connection's sequence unadvanced (`device.ts`, `readSecurityMode`),
so anything after it on the same connection is unreliable. On M112 masks the security mode is
therefore not asked at all, and on System B it is the final request.

### The interface-object scan

Property descriptions make the device describe itself, so the scan works on products Busforge has
never seen. It follows `DMP_InterfaceObjectScan_R` as xknx implements it:

1. For object index 0, 1, 2, … up to 63: `A_PropertyDescription_Read(object, PID 0, property
   index 0)`. An answer whose PID is 0 (all zeros) means "no object at this index", and the scan
   **continues**: the OpenKNX stack (thelsing `Bau07B0::getInterfaceObject`) has no object at
   index 5 but has the security and cEMI server objects after it, so ending at the first gap
   would miss them. Masks that declare `InterfaceObjectDiscoveryByIoList` (MV-2920) list their
   objects in `PID_IO_LIST` (object 0, PID 71) instead.
2. For each object, read `PID_OBJECT_TYPE` (PID 1). Then property index 1, 2, …, until an answer
   with PID 0.
3. Each description gives: PID, write-enable bit, PDT (6 bits), maximum element count (12 bits)
   and the read and write access levels (high and low nibble; 0 is the highest level).

Then the values: for each property whose read level the session's level satisfies, read element
0 (the current element count) and then the elements, at most 15 per request (the 4-bit count
field), fewer when the elements would not fit the APDU (15 octets on a device without PID 56),
and within the byte budget per property. Skipped, and recorded as skipped with the reason:

- properties of the security object (type 17), except the security mode above; key tables are
  write-only and keys never enter a package anyway;
- function properties (PDT `0x3E` and the reserved range) (inferred: reading their value is not
  defined, they are invoked);
- properties whose read level the session does not reach.

**Why this also derives ranges.** On both System B bench devices ETS reads the description of
object 2, PID 23 (`PID_TABLE`) before writing, and the maximum element count equals the
application's `AssociationTable MaxEntries`: 1600 on the Jung 400021SE, 1000 on the GVS AMMA, PDT
`0x14` (4-byte elements). The same number is also each application's `AddressTable MaxEntries`.
So on these two devices the device states its own table capacity; that this holds generally, and
that no product XML is needed to bound the read, is inferred from two devices.

**Stop conditions for the scan:** an object index past 63, a property index past 255, or a device
that does not answer the first description request (recorded as "property descriptions
unsupported", and the scan ends). The scan has no request budget of its own; the job's duration
bounds it (see [Bounds](#bounds)).

## Per memory model

Where the system tables and the application memory live, and how the collector finds them. The
resource names are those of the master data. "Pointer" means: read the named pointer resource
first, then the table at the address it gives.

**Declared memory segments are the outer limit.** Each mask's master data also declares its
`MemorySegments` (start, length, optional flag, read access `Configuration`): BCU1 and the older
couplers `0x0100` + 256 bytes, BCU2 `0x0100` + 880, M112 and the System B masks `0x4000` + 8192
with optional `0x6000` + 22016 and `0xB800` + 2048. The collector never reads memory outside a
declared segment or a resource location, and a segment marked optional may not exist on the
device. The declaration is not a plan by itself: System B devices allocate their segments at
runtime, and the Jung 400021SE has its tables at `0xF000` to `0x16000` (vectors
`table-reference-*` and the PID 7 reads of the captures), outside every declared segment. On
System B only PID 7 and PID 27 bound a read.

### System B (MV-07B0, MV-17B0, MV-27B0, MV-57B0)

| | |
|---|---|
| Owned | Jung 400021SE, GVS AMMA, OpenKNX RaumController (bench); 10 house instances. Programming is supported, so this class is the control case: a collector package must agree with a Busforge read-back of the same device. |
| Discovery | Generic stage. Objects 1 to 5 are address table, association table, group object table, application, PEI program (master data); application-specific interface objects start at index 6 (`FirstAppObjectIdx`). |
| Range derivation | Per table object: `PID_TABLE_REFERENCE` (PID 7, 4 bytes) is the start, the size field of `PID_MCB_TABLE` (PID 27, 8 bytes: size u32, CRC control, access, CRC16) is the length. Both are only meaningful while the object's load state (PID 5) reads Loaded. |
| Runtime pointers | PID 7 of objects 1 to 5. A pointer of 0 means "not loaded", not address 0 (thelsing `table_object.cpp`). An answer with element count 0 means the property is absent, which is a different result: the existing `propRead` does not check the count, so `tableAddr` decodes an absent PID 7 as 0 and reports `DEVICE_NOT_PROGRAMMED`. The collector checks the count and records the two apart. |
| Chunks | Above `0xFFFF` the extended read, 48 bytes on the path (`EXT_READ_CHUNK`); below it the classic read, `clamp(maxApdu - 3, 12, 48)`. In a secure session 13 octets less. |
| Credentials | Free-key authorize. A secure-activated device answers a plain descriptor read with `0xFFFF` and, on the Jung 400021SE, a plain security-mode read with access denied (`0xFC`); that it refuses every other plain read is likely, not shown. It is read only with the tool key on file, through the existing secure session; without one the package records "secured, no key" after the descriptor. |
| Stop | Load state not Loaded: the table is recorded with its state and not read. No MCB answer: the length is unknown, the range is not read (the product XML may still bound it when present, and the package says which source bounded it). |

The relative segment (`RelativeSegment`, LSM 4) of the application is the same rule applied to
object 4, so parameters are covered without product data.

### BIM M112, property-mapped (MV-0705, MV-2705, MV-5705)

| | |
|---|---|
| Owned | MDT BE-02001.02 (bench); 22 house instances (GIRA, Basalte, Theben, MDT). Supported, second control case. |
| Discovery | Generic stage. Application id at object 3, PID 13; PEI program at object 4; application-specific objects from index 5 (`FirstAppObjectIdx`). |
| Range derivation | Group address table at the fixed address `0x4000` (master data `StandardMemory 16384`), its first byte the entry count. Association table through the pointer object 2, PID 7 (2 bytes), its first byte the count. **The group object table has no location** in the master data (`AddressSpace="None"`), and the application's absolute segments are known only from the product XML (`AbsoluteSegment Address Size`). |
| Runtime pointers | Object 2 PID 7. Stamps (PID 27, 8 bytes) on objects 1 to 4. |
| Chunks | No PID 56 on the MDT (count 0, vector `max-apdu-absent-mdt`): classic reads of at most 12 bytes. ETS reads 12-byte chunks on the ABB US/U 4.2 (MV-0701); on the MDT the captures hold only 1-byte reads. |
| Credentials | Free-key authorize (`AuthorizeLevels` 16). |
| Stop | Without the product XML, the com-object table and the parameter segments are **not attempted**, with that reason. Some M112 devices refuse a read that crosses an internal boundary; the existing `memRead` shrinks the request and places bytes by address ([device-memory-model.md](device-memory-model.md#chunking-and-internal-read-boundaries)), and the collector records a single refused byte as refused instead of failing the range. |

### Load status on the TP and IP M112 masks

On MV-0700, MV-0701, MV-0705 and MV-5705 the load states are memory bytes, `0xB6EA` to `0xB6ED`
for address table, association table, application and PEI program (master data `*LoadStatus`,
`StandardMemory 46826` to `46829`), MV-0705 included; what sets MV-0705 apart is that its load
*controls* are driven through PID 5 (`PropertyMappedLsms`), not where the status is read. MV-2705
(RF) declares status and control as PID 5 of objects 1 to 4 instead, and MV-1900 declares no load
resources at all. ETS reads `0xB6EC`, the
application's load status, on the ABB US/U 4.2 and gets `01` (vector `load-status-response-abb`),
and the MDT BE-02001.02 answers the same address with `01` too (`load-status-response-mdt`).

### BIM M112, MV-0701

As MV-0705 for the application id (object 3, PID 13) and the association table pointer (object 2,
PID 7), with memory-mapped load controls and no stamps (PID 27) in the master data. Owned: ABB US/U
4.2 (bench), one house instance. No PID 56.

### BIM M112, MV-0700

Not owned. Everything is memory, no interface object is declared: application id at `0xB6E5`
(5 bytes), PEI program id at `0xB6E0`, association table pointer at `0xB6F8` (2 bytes), order id
at `0xB607` (9 bytes), serial at `0xB61A` (6 bytes), run statuses at `0x0101` and `0x0102`, group
address table at `0x4000`. Plan: those resources as single reads, then the two tables; no property
reads, no scan unless the device answers a first property description.

### System 1, BCU1 (MV-0010 to MV-0013, MV-1011 to MV-1013, MV-3012, MV-4012)

| | |
|---|---|
| Owned | No device is known to be one. The one house instance whose product data declares MV-0012 is an MDT KNX IP interface SCN-IP000.03, which answers plain reads with descriptor `0xFFFF` ([status.md](status.md), device table; the inventory's `secure: false` for it is wrong). Its secure identify returned MV-0012 (commits `bd5332d` and `f2b4b20`, no evidence record); the collector run under its secure session read the same descriptor, `0x0012`, now with a package (see [House run](#house-run--the-mv-0012-ip-interface)). What it holds in memory is still not read: the plan's memory step was not attempted under that session. An IP interface that reports a BCU1 mask need not hold a BCU1 memory layout. |
| Discovery | Descriptor, then one property read: PID 56 of object 0 (maximum APDU length), before the memory step. BCU1 has no interface objects and declares no `AuthorizeLevels`, so no authorize, no other property read, no scan: requests the device does not implement are answered by silence and cost a timeout each (Calimero notes the same for descriptor type 2). PID 56 is the exception because the one owned device with this mask, an IP interface, answers secured property reads, and without a maximum APDU no secured memory read fits (see [House run](#house-run--the-mv-0012-ip-interface)); a real BCU1 is not expected to answer it (inferred), which costs one unanswered request with its retries (a few seconds) and a reopened link, and does not count towards closing the device off. Without a usable value (absent, unanswered, answered malformed or with a failed MAC) a plain session reads in 12-byte chunks and a secured one refuses its memory step, and the record says how the PID 56 read ended; a secured session also refuses it when the declared length is too short for a secured memory read. |
| Range derivation | The master data places everything in memory: manufacturer id `0x0104` (1 byte), application id `0x0104` (4 bytes), PEI type `0x0109`, hardware config `0x010C`, run error `0x010D`, association table pointer `0x0111`, group object table pointer `0x0112`, group address table `0x0116`, individual address `0x0117`, run status and programming mode `0x0060`. The pointers are one byte with the flavour `Ptr_StandardMemory100`; that the table then sits at `0x0100 + pointer` is read from the flavour's name (inferred). |
| Plan | PID 56 of object 0, then `0x0060` (1 byte), then `0x0100` to `0x01FF`, the EEPROM segment every BCU1 mask declares (256 bytes, read access `Configuration`), which holds every resource above except `0x0060`; that it also holds the application's parameters is inferred. 256 bytes in 12-byte chunks, or in chunks sized to the maximum APDU the device declares. Then the tables at their pointers if a pointer leads outside that window. |
| Credentials | None. |
| Stop | A pointer outside `0x0100` to `0x01FF` is recorded and not followed (inferred: on BCU1 it would be a corrupt table). |

The table layouts behind the flavours (`AddressTable_Bcu1`, `AssociationTable_Bcu1`,
`GroupObjectTable_Bcu11`) are named by the master data but not described in it; decoding them is
later work. The raw bytes are what the package carries. **No BCU1 vector exists yet**: every BCU1
statement here comes from the master data, none from a device.

### System 2, BCU2 (MV-0020, MV-0021, MV-0025)

Not owned. MV-0020 and MV-0021 give each table both ways: as memory (`0x0111`/`0x0112` pointers
with the `+0x100` flavour, address table pointer constant `0x0116`) and as properties (objects 1
to 3, PID 7, 2 bytes); MV-0025 only as properties. All three: application id object 3 PID 13,
load states PID 5, serial and order info on object 0, `AuthorizeLevels` 4, and a declared EEPROM
segment `0x0100` + 880 bytes (to `0x046F`). Plan: the generic stage, each table from its property
pointer, then the declared EEPROM segment.

### System 300 (MV-0300)

Not owned. Property-based. The base mask MV-0300 names only `ManagementDescriptor01` (object 0,
PID 72); the device reports which variant it is, and the variants (`MV-0300-0100…`) carry their
own resources: the tables as properties (PID 23 for the address and association tables, PID 51
for the group object table, PID 5 for their load states; which object carries each differs between
the two variants) and, on one variant, an EEPROM segment `0x0100` + 57344. Plan: the generic stage, the management descriptor, then the resources of the variant it
names; memory only inside a segment that variant declares.

### Couplers and routers (MV-0900, MV-0910, MV-0911, MV-0912, MV-091A, MV-1900, MV-2920)

Not owned as programmable devices. Four shapes, in the current (not the legacy) master data. "Object
6" below is an object *type* reference (the router object, found by type and occurrence), not an
object index.

- **Memory-configured** (MV-0900, MV-0910, MV-0911): configuration bytes in memory (`LcMode 0x0119`,
  `LcError 0x011A`, `LcConfig 0x011B`, `LcGrpConfig 0x011C`, run error `0x010D`), read as single
  bytes. The filter table is in the address space `LcFilterMemory` at `0x0200`, 3584 bytes.
- **Property-configured** (MV-0912, MV-091A): configuration as properties of object 6 (MV-0912:
  PIDs 52 to 55 and 57 to 59; MV-091A: 52 to 55, 57 and 58), plus PID 56 and the serial on
  object 0. The filter table is again `LcFilterMemory` at `0x0200`, 8192 bytes. Their legacy
  resource sets describe the older memory layout.
- **System B coupler** (MV-2920): the filter table is relative memory found through object 6,
  PID 7 (`RelativeMemoryByObjectType`), 8192 bytes, and the mask declares
  `InterfaceObjectDiscoveryByIoList`, so its objects come from `PID_IO_LIST` (object 0, PID 71).
- **M112 media coupler** (MV-1900, `ManagementModel` BimM112 in the master data, a media coupler in
  Busforge's registry): filter table in plain memory at `0x4003`, 4096 bytes, group configuration
  bytes `0x510D` and `0x510E`, EEPROM segment `0x4000` + 30208. Readable with ordinary memory
  reads, so its plan is those resources; no device or capture backs it.

Whether `A_Memory_Read` reaches `LcFilterMemory` is not shown anywhere, so on those masks the
filter table is **not attempted** until a capture shows how a tool reads it.

### Interfaces, RF-only and the rest (MV-0310, MV-0311, MV-1310, MV-1311, MV-2311, MV-2010, MV-2110, MV-0810, MV-0811, MV-0001, MV-0AFD, MV-0AFE, unknown)

MV-0310, MV-1310 (cEMI server) and MV-0001 are in the master data with no resources; the others
are not in it at all. Generic stage only: descriptor, then properties if the device
answers a property description. The interface Busforge is connected through is a different case:
its own properties are reachable by cEMI local device management (`M_PropRead`), not over the bus,
which is a separate design (inferred from the mask names; no source shows it).

## Results and refusals

Each attempted read is one record. The shape, for the collector to implement:

| Field | |
|---|---|
| `space` | `descriptor`, `authorize`, `property`, `property-description`, `function-property` (the security mode), `memory`, `memory-extended` |
| `target` | object index or type and instance, PID, element range; or address and length |
| `source` | where the range came from: `master-data`, `device` (PID 7 / PID 27 / description), `product-xml` |
| `outcome` | `bytes` (with the bytes), `refused` (with the raw answer: count 0, return code such as `0xFC` access denied or `0xFD` address void), `timeout`, `connection-closed`, `malformed` (an answer for another address or service, or of the wrong shape; never used as data), `not-attempted` (with the reason) |

A range that comes back in pieces is recorded as several records with exact sub-ranges. The
existing `memRead` throws `DEVICE_READ_REFUSED` when even one byte is refused; the collector needs
a variant that returns what it got and the refused sub-ranges, and keeps reading the rest of the
plan. A package with refusals is still a valid package.

## Collector design

What the collector has to be, in the terms of the code that exists.

- **A job, not a request.** A new task kind `collect`, `writes: false`, submitted to the
  `TaskQueue`, which already takes `Bus.withExclusiveOperation`. The bus monitor is closed for the
  duration; the package records when it closed and when the job released the bus, so the UI can
  say what the user missed. Cancellation is the job's `AbortSignal`; a cancelled job leaves no
  package, everything it read is dropped (`CollectCancelled`).
- **Plan, then execute.** The plan is computed from the mask (and, when the project holds it, the
  product XML) before the first request, stored in the package, and only then executed. A
  reviewer can see what was going to be read even when the device stopped answering.
- **Bounds.** Two bounds a user is told about: the whole job stops after 10 minutes, and a device
  that fails three requests in a row is closed off as unresponsive. A third bound guards memory
  only, see [Bounds](#bounds). Each bound hit is recorded as such, never as "complete".
- **Secure devices.** With a tool key on file, the job opens the existing secure session and the
  same plan runs through it. The key, the serial-derived session material and any security-object
  content stay out of the package.
- **No baseline.** The job never calls the read-back adoption (`replaceParamBase`,
  `replaceLinkBase`); it writes only the package. The test for this compares the database before
  and after.
- **Provenance.** Busforge version and commit, the connection's kind (not its host, port or USB
  serial), IA, the mask read, the authorize level obtained, timestamps per step.

### Bounds

| Bound | Value | Why |
|---|---|---|
| Duration | 10 minutes, from when the job takes the bus | The bus is the job's alone while it runs, and the monitor is closed. At the bench's rate of about 4 requests a second, the bench devices took between 0.1 s and 157 s ([Bench runs](#bench-runs-2026-10-04)). |
| Failures in a row | 3 | A device that leaves three requests unanswered (or answers them malformed) is closed off as unresponsive; each failure reopens the link first. |
| Memory | 1 MiB, internal | Only a guard against a device that states a wrong table size (a wrong PID 27 on System B leads the read straight to the address its own PID 7 names). Ten minutes at 4 requests a second read about 115 KB on the 48-byte extended path, so the duration ends a job long before this bound, also on future devices with extended memory. The dialog does not name it. |

The interface-object scan and the memory plan have no request counts of their own. Per property,
values are read within 1024 bytes past element 0 (see [Implementation](#implementation)).

## Reference vectors

[`tools/fixtures/raw-acquisition-vectors.json`](../tools/fixtures/raw-acquisition-vectors.json)
names 29 exchanges by file and line: 18 from the ETS captures and 11 from captures of the collector
and of single memory reads on the bench, taken through the same logging proxy (the collector captures
are excerpts that end with the interface-object scan; the memory phase of those runs is left out).
`tools/raw-acquisition-vectors.test.ts`
decodes each one from the captured frame and checks it against the fixture, including the
direction and the device address, so the vectors cannot drift from the captures. The same test
checks the association-table capacity of the two descriptions against the applications'
`MaxEntries`. The collector's codecs have to decode the same vectors.

| Vector | Shows |
|---|---|
| `dd0-*` | descriptor type 0 for MV-0705, MV-0701, MV-07B0 |
| `max-apdu-gvs`, `max-apdu-absent-*` | PID 56 present (55) and absent (count 0) |
| `serial-gvs` | a 6-byte serial (length only; the value stays in the capture) |
| `authorize-free-*-jung` | free key `FFFFFFFF` answered with level 0 (the same exchange is in the ETS captures of all four devices; one is enough as a vector) |
| `propdesc-request-jung`, `propdesc-response-*` | property description of object 2 PID 23: index 3, PDT `0x14`, 1600 and 1000 elements, read level 3, writable on the Jung and not on the GVS |
| `security-mode-off-gvs` | the security mode read on a device with Secure not activated |
| `table-reference-*` | PID 7 of object 3 on both System B devices |
| `load-status-*` | the application load status at `0xB6EC`, on the memory-mapped ABB and on the property-mapped MDT |
| `authorize-free-response-abb` | the free key answered with level 0 on an M112 device |
| `property-absent-abb` | object 0 PID 15 (order info) answered with element count 0: absent, not empty |
| `propdesc-scan-*` | the scan's first request (object 0, PID 0, property index 0) and its answer: PID 1, PDT `0x04`, one element; read level 5 on the ABB, 15 on the MDT |
| `propdesc-end-abb` | an object's last property: index 6 of object 0 answered with PID 0 |
| `propdesc-no-object-*` | no object at the index (5 on the ABB, 6 on the MDT): PID 0, PDT 0 and no elements, with the access octet `0x00` on the ABB and `0xFF` on the MDT, so the access octet tells nothing about the end |
| `memory-read-b800-mdt`, `memory-refused-*` | a 1-byte `A_Memory_Read` at `0xB800` (the start of the optional M112 segment) answered with count 0 and the address, no data, by both M112 devices |

**What the vectors do not cover:** no extended read in plain (the bench devices reach it only in
their secure sessions, whose frames a vector cannot decode without the tool key), nothing from BCU1,
BCU2, System 300, a coupler or an interface.

## Implementation

| Part | Where |
|---|---|
| Codecs (descriptor, authorize, property description and value, memory, function-property state) | `packages/knx/src/rawcodec.ts`, checked against every reference vector |
| Read services that keep refusals: `authorizeFreeKey`, `propertyDescription`, `propReadCounted`, `memReadPartial` | `packages/knx/src/device.ts` |
| Plan per mask | `packages/product/src/collectplan.ts` |
| Execution, bounds, records | `packages/product/src/collect.ts` |
| Session, provenance, the package's lifetime in memory | `apps/server/src/collect.ts` |
| Cleaning into a diagnostic package | `packages/product/src/diagnostic.ts` |
| Consent, progress, review and saving | `apps/web/src/views/DiagnosticDialog.tsx` |
| The same collector from the command line, over a TCP tunnel, optionally without the free-key authorize. It writes the uncleaned package with the tool's own provenance (commit, target), writes nothing when interrupted, and stores no device sequence after a secured session: it prints it. | `tools/collect.ts` |
| One memory read outside any plan, plain, and the device's answer | `tools/memread.ts` |

**API.** `POST /api/projects/:id/devices/:deviceId/collect` queues a task of kind `collect`
(`writes: false`) and answers 202 with it; while it runs, the task's `done` counts the requests sent.
The task's result is the verdict (`complete`, `limited`, or `stopped:<reason>` for what the device
did: unresponsive, secured without a key, the duration bound). A collection that breaks off at the
interface or in Busforge itself ends the task as an error, `COLLECT_FAILED`; its package is kept. A
cancelled task has no package. `GET /api/projects/:id/diagnostics/:taskId` returns the cleaned
[diagnostic package](#diagnostic-package), or `DIAGNOSTIC_NOT_FOUND` once it is gone. Neither the
database nor the data directory holds a package: it lives in the server's memory, on its job.

**What it adds to the design.**

- `memReadPartial` joins adjacent pieces of the same kind, so a range is a handful of records: the
  bytes read, and each refused run with the device's answer.
- A request that gets no answer, a connection the device closes, or an answer that does not fit
  the request (`malformed`: one late answer would shift every answer after it) is followed by a
  fresh connection (`T_Disconnect`, `T_Connect`, the free-key authorize again, since the access
  level is the connection's). Three failed requests in a row stop the job as unresponsive; the
  authorize on the new connection answering does not reset that count.
- The request counts in the package count requests as the collector issues them. The transport's
  own repetitions of one request (`KNX_TRIES`, three by default), `T_Connect`, `T_Disconnect` and
  the Data Secure Sync of each new connection are not counted. The 10 minutes are checked before
  each request, so the job can overrun them by the request in flight and one reconnect, some seconds.
- **On System B, PID 27 alone bounds a table read**, as designed, held only by the 1 MiB memory
  guard and the 10 minutes. A device reporting a wrong memory control block size therefore gets read
  from the address its own PID 7 names until one of them ends the job. A plausibility bound (PID 23's
  capacity, the application's declared sizes) is in the backlog.
- Property values are read within a budget of **1024 bytes per property** past element 0. A batch
  of elements the device refuses is asked again one element at a time, and a single refused
  element ends that property: the GVS AMMA answers element 1 of two properties (object 0 PID 223,
  object 7 PID 220) and refuses every element after it, which without this rule spent a thousand
  requests on refusals.
- A memory range planned from the product XML or from the device must be covered by declared
  segments; adjacent segments join (the ABB's application segment `0x4600` + 7790 runs from
  `0x4000` + 8192 into `0x6000` + 22016). A master-data resource is a location in its own right.
- Monitor and bus: the package names the monitor connection the job closed and when
  (`provenance.monitorClosed`), when the job took the bus and when it released it. The job does
  not reopen the monitor.
- **One write to the database, on secure devices only:** after a secured session the device's
  sending sequence, as seen in that session, is stored with its tool key (`device_security.seq_group`),
  as every secured session in Busforge does. It is the device's counter, not project state.

**What it leaves out**, each as a `not-attempted` record in the package and a backlog entry in
[roadmap.md](roadmap.md#raw-acquisition): the System 300 variant plans, discovery by `PID_IO_LIST`
(MV-2920, scanned by index instead), every coupler filter table, and the product XML as the bound of a
System B table without a memory control block.

### Bench runs, 2026-10-04

Read-only, from the Mac over the bench bridge, against a copy of the data directory; every table
of that copy hashed before and after. Each run below was repeated on the final build, with the
same results; the cancel was run once, on the build before the review fixes.

| Device | Session | Result | Requests | Bytes from memory | Time |
|---|---|---|---|---|---|
| ABB US/U 4.2 (MV-0701) | plain | complete: identity, scan of objects 0 to 4, load statuses, both group tables, every application segment of the product XML | 911 | 9199 | 96 s |
| MDT BE-02001.02 (MV-0705) | plain | complete; the two product-XML segments at `0x0700` lie outside the declared segments and are not attempted | 284 | 1304 | 28 s |
| GVS AMMA (MV-07B0) | plain, no key on file | stopped after the descriptor (`0xFFFF`): secured, no key | 1 | 0 | 0.1 s |
| GVS AMMA (MV-07B0) | secured | limited only by the property budget (object 3 PID 23); tables of objects 1 to 4 read through PID 7 and PID 27; security mode read last. It answers the description of object 6, property index 23, with the description of PID 1 at index 0, in every run: recorded as malformed, the link reopened, the rest of object 6 not described | 459 | 3896 | 94 s |
| Jung 400021SE (MV-07B0) | secured | as the GVS; tables at `0xF000` to `0x16000`, the three above `0xFFFF` through the extended read | 636 | 10366 | 157 s |
| ABB US/U 4.2 | plain, cancelled after 12 s | task `cancelled`, package kept with 129 records from the scan (that build kept a cancelled job's package; a cancel now drops it, see [Diagnostic package](#diagnostic-package)) | 123 | 0 | 12 s |

Database: on the plain runs only the task list changed. On the two secured runs `device_security`
changed in `seq_group` of those two devices and nothing else. No device memory was refused on any
run.

### Bench runs, 2026-10-04 evening: authorize and a refused read

`tools/collect.ts` through a logging proxy on the Mac, read-only, the same plans as above (product
XML of the ABB and the MDT for their segments). Each device once with the free-key authorize and once
without (the GVS a second time with it), and the first two packages compared record by record (step,
service, target, outcome, bytes):

| Device | Session | With authorize | Without | Records that differ |
|---|---|---|---|---|
| ABB US/U 4.2 (MV-0701) | plain | complete, 911 requests, 9199 bytes | complete, 910, 9199 | the authorize record only |
| MDT BE-02001.02 (MV-0705) | plain | complete, 284, 1304 | complete, 283, 1304 | the authorize record only |
| GVS AMMA (MV-07B0) | secured | limited (property budget), 459, 3896 | limited (property budget), 457, 3896 | the two authorize records (the second on the connection reopened after the malformed object-6 answer), and the values of object 0 PID 30 and of PID 220 on objects 7 and 11 |

Those GVS values change between two runs *with* the authorize as well, and so does one more. Over the
three runs (with, without, with): object 0 PID 30 `000a`, `000b`, `000c`; object 0 PID 198 `000e62`,
`000e62`, `000e63`; PID 220 of objects 7 and 11 a different 8-byte value each run. So on the three
devices every read without the free key ended as it did with it (the same bytes, or the same refusal,
failure or malformed answer, of the same length), except the three GVS values of the table, which also
differ between two runs with the key; whether the authorize affects them these runs cannot show.

No planned range was refused on any run. A single 1-byte read with `tools/memread.ts` at `0xB800`, the start of the
optional M112 segment `0xB800` + 2048, outside every planned range, was answered with count 0 by both
the ABB and the MDT (vectors `memory-refused-*`); that the segment is absent on them, rather than
protected, is inferred. The collector records such an answer as `refused` with the raw answer
(`memReadPartial`, spy tests in `packages/product/test/collect.test.ts`).

Not compared yet: a collector package with a Busforge read-back of the same device (the control
case of System B and M112).

### House run: the MV-0012 IP interface

`tools/collect.ts` against the house device (MV-0012) through the house's own KNXnet/IP gateway, run
by hand, secured with the tool key from the house project (the key never enters the package),
read-only: one Sync, then the plan for the reported mask. The checkout was the commit before this
section's, with uncommitted flash-path changes, none on the collector's path for this run (no
application program was given; hence `-dirty` in the package's provenance). Whether the tunnel's
server was this interface itself or the other house interface is not recorded.

| Step | Outcome |
|---|---|
| Descriptor (type 0), secured | `0x0012`: MV-0012, family `system-1`, the same as the identify |
| Plan | the BCU1 plan: no authorize, no interface objects, no identity reads, memory `0x0060` (1 byte) and `0x0100` to `0x01FF` (256 bytes) |
| Memory | **not attempted**, one record for the whole step: "the device declares no maximum APDU length, so it takes standard frames only, and a secured memory request does not fit one" |
| Totals | 1 request (the Sync, sent before the plan, not counted), 0 memory requests, 0 bytes, no stop, no limit, 0.06 s |

The refusal is the collector's own, before anything was sent: a secured request carries 13 octets of
framing (SCF, sequence, MAC, the secure APCI), and a classic memory read, with its count and address,
then exceeds the 15 octets of a standard frame. The device was not asked for its maximum APDU length:
the BCU1 plan reads no properties, so the record's "declares no" means "Busforge does not know one",
not a device answer. The standard-frame bound is Busforge's assumption, and this device already
exceeds it: the secured descriptor response of this run is 16 octets, and the secured property read
of its serial (PID 11 of object 0) in the identify of 2026-06-30, with the same tool key, was 18
octets and was answered. So the device has an object 0 and takes secured requests longer than a
standard frame; whether it answers PID 56 (the same request shape as the serial read), and whether
its memory then reads, is the next run.

Since this run the BCU1 plan reads PID 56 of object 0 before its memory step, and a refused memory
step names its cause: "the device declares no maximum APDU length" only when the device answered
PID 56 with element count 0; "no maximum APDU length is known" with the read's outcome (timeout,
connection closed, malformed, which includes an answer whose MAC fails) when the read gave no value;
"this plan does not read PID 56 of object 0" for a plan that does not ask it (the probing plan of an
unknown mask, the memory-only coupler plans); and the declared length when it is too short for a
secured memory read. Shown by tests against a simulated device only; the house device has not been
asked yet.

The package and the run's sequence counter stay out of the repository; the package is in the
[private corpus](testing.md#the-private-corpus), `collections/`.

## Diagnostic package

How a user runs the collector from the app, and what leaves Busforge when they save the result. The
UI says "diagnostic package" (German "Diagnosepaket"), never "export": export is the project
archive ([export-format.md](export-format.md)).

```
device page: "Create diagnostic package"
  └─ consent .................................. one fixed scope, one click
       └─ progress ............................ steps, requests sent, time of at most 10:00
            ├─ cancel ......................... no package, nothing read is kept
            ├─ plan ran to its end ............ review: complete
            └─ bound, silent device, link ..... review: incomplete, and why
                 review (contents | file) ──► "Save file" into the browser's downloads folder
```

**Entry.** An icon button in the device page's action bar, next to "Read from device", for every
device: also one Busforge cannot program or has no application program for. A collect task in the
bus queue opens the same dialog at its progress or its review.

**Consent, once, for one fixed scope.** The dialog says what is read (identity, every readable
interface-object property but never the security object, only the memory ranges planned for the
device's mask, decided after the first reads), the two bounds (at most 10 minutes, stop after 3
failures in a row; no byte or request figures), that an open monitor is closed and not reopened, and
that the result stays on this computer. A device with a tool key on file gets one more line: it is
read through the stored tool key, and the key does not enter the package. One click starts the job;
there are no levels to choose.

**Progress and cancel.** The steps of the plan, the requests sent and the time against the 10
minutes. The dialog cannot be dismissed while the job runs. **Cancel drops everything**: the job
ends `cancelled`, no package is made, nothing read survives. A job that ends at the duration bound,
at an unresponsive device, at a secured device without a key or at a failed link does produce a
package, and the review names it incomplete and why (a device that never answered at all is told
apart from one that stopped answering midway). The review names no byte or request figures.

**Review before saving.** Two tabs: what the package holds (interface objects, properties, memory
bytes, refused or unattempted reads, the connection kind, the times, the Busforge version), what
Busforge removed, and a warning box on what is not anonymized; and the file itself, in full, exactly
as it is saved. "Save file" hands that text to the browser's downloads folder as
`busforge-diagnostic-<ia>-<yyyy-mm-dd-hh-mm>.json` (UTC, the same name in every language). Busforge
sends it nowhere; the dialog says the user can attach it to a GitHub issue themselves, and promises
nothing about what happens to it after that.

**Lifetime.** The package lives in the server's memory, on its job (`DiagnosticStore`,
`apps/server/src/collect.ts`): review and save work any number of times for 24 hours after the job,
not across a server restart. No uncleaned original is kept anywhere, and there is no list of
packages.

### What the file holds

Format `busforge-diagnostic/1` (`packages/product/src/diagnostic.ts`), plain JSON, unencrypted.

| | |
|---|---|
| Kept | IA, mask, family, `secured`, authorize level, maximum APDU, the plan, every record (step, service, target, source, outcome, reason, timestamp), the bounds hit, the stop reason, the counts, start and end, when the job took the bus, closed the monitor and released the bus, Busforge version and commit, the connection's kind: `ip` with its transport, or `usb` with the interface's vendor and product id |
| Removed | project, device and task id; the connection's host and port; the USB interface's serial number; the device's serial number wherever the plan reads it (PID 11 of any interface object, in the identity read and in the scan, and the M112 `serial number` memory resource), recorded as `"removed": "serial number, 6 bytes"` in place of the bytes |
| Unchanged, labelled not anonymized | every memory byte and property value. They can hold installation data (group addresses, parameter texts, coordinates, the IP and MAC address of an IP interface that is itself the device read), and Busforge cannot tell which. A device that also keeps its serial inside a larger memory range keeps it there; the review says so |

Text the link put into the package (a stop reason, an error, a record's reason, a reason in the plan)
is searched for the host, the ids, the USB serial and the device serial, and for any IPv4 or IPv6
address literal (IPv6 in every written form: compressed, with a zone, bracketed with a port) (a host saved by name reaches error texts as its address); each is replaced by
`<removed>`.

**Cancel after the end.** A cancel that reaches the server after the read has already finished
cannot cancel the task, but it still drops the package: `POST .../tasks/:taskId/cancel` answers
`{ "cancelled": "discarded" }` for a finished collect task, and the dialog shows the read as
cancelled. A cancel during a failed request opens no new link.

## Known unknowns

| Unknown | Why it matters | How it gets settled |
|---|---|---|
| What the house device declared MV-0012 (the MDT IP interface) holds | it is the only owned device in an unsupported family on paper | **mask settled with a package**: the secure identify and the collector run under the same session both read MV-0012. **Memory still open**: the run's BCU1 plan read no maximum APDU length, so Busforge held the secured session to standard frames, and no secured memory read fits one (the device itself answered longer secured requests); the collector refused the step without sending it ([House run](#house-run--the-mv-0012-ip-interface)). The plan now reads PID 56 of object 0 first (tests only). Settled by running the collector again under the session: if the device declares a maximum APDU long enough for a secured memory read, the memory is read within it; if not, the record says why |
| BCU1 behaviour at all | no owned real BCU1 is known | a capture from a contributed device, through the diagnostic intake |
| Whether M112 devices answer property descriptions | ETS never asked them | **settled for the bench devices** (2026-10-04): the ABB US/U 4.2 (MV-0701) describes objects 0 to 4, 21 properties, and the MDT BE-02001.02 (MV-0705) answers the scan as well. Other M112 products: not shown. |
| Whether a free-key authorize is needed for any read the bench devices allow without it | Busforge reads PID 7 today without authorizing | **settled for the ABB US/U 4.2, the MDT BE-02001.02 and the secured GVS AMMA** (2026-10-04 evening): every read without it ended as it did with it, outcome and length, except three GVS values (object 0 PID 30, PID 220 of objects 7 and 11) that also change between two runs with it. Other devices: not shown. |
| `LcFilterMemory` access on couplers | the filter table is a coupler's configuration | a capture of a tool reading a coupler |
| Device-specific internal read boundaries | a refused straddling read must not fail the range | the boundary-aware read, recorded per sub-range |
