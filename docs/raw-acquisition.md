# Raw acquisition

How Busforge reads identity, interface-object properties and bounded memory ranges from a KNX
device it cannot program, without writing anything and without inventing a byte. This is the
design for the diagnostic collector; nothing on this page is implemented yet. The collector itself
is a separate piece of work, and nothing here is a verification claim ([status.md](status.md) holds
those).

The rule that shapes every section: **a range is either read, refused with a reason, or not
attempted with a reason**. A protected address answers with an empty or negative response, and
that answer is the result. Zero-filled gaps, guessed sizes and "probably the same as the sibling
product" are exactly what this design exists to avoid.

## Sources

| Source | What it gives | Where |
|---|---|---|
| KNX master data, `MaskVersion` resources | Per mask: where each system resource lives (memory address, pointer, interface-object property), its length and read access. | `knx_master.xml` inside every `.knxproj`. Checked against ETS 6 master data version 298 (`scratchpad/ets-captures/bench-2026-09-25.knxproj`, local) and the copy under `reference/vendor/Kaenx.Konnect` (local, gitignored): identical for every mask quoted here that the master data contains. MV-0311, MV-1311, MV-2311, MV-2010, MV-2110, MV-0810, MV-0811, MV-0AFD, MV-0AFE, MV-3012 and MV-4012 are in neither file; Busforge knows them from its own registry (`packages/product/src/masks.ts`). |
| ETS 6 captures of the four bench devices | What a real tool reads before it writes, and how the devices answer. | `tools/fixtures/*.log`, turned into checked vectors (see [Reference vectors](#reference-vectors)). |
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
monitor, see [Collector design](#collector-design)) and writes only its own package.

## The generic stage

Every device gets this, whatever its mask. It needs no product data.

```
T_Connect
  DeviceDescriptor type 0 ......... mask, or MV-FFFF: secured and no key -> stop here
  [mask declares AuthorizeLevels]
    Authorize FFFFFFFF ............ level (ETS gets 0 from all four bench devices)
  [mask has interface objects]
    PID 56 on object 0 ............ max APDU, or absent (count 0) -> classic chunks
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

**Stop conditions for the scan:** an object index past 63, a property index past 255, a device
that does not answer the first description request (recorded as "property descriptions
unsupported", and the scan ends), or the scan's share of the request budget.

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
| Owned | No device is known to be one. The one house instance whose product data declares MV-0012 is the MDT KNX IP interface SCN-IP000.03, which answers plain reads with descriptor `0xFFFF` and was read only through a secure identify ([status.md](status.md), device table; the inventory's `secure: false` for it is wrong). The mask that identify returned is not written down in the docs, and an IP interface that declares a BCU1 mask need not run one. Until it is identified, BCU1 has no owned target. |
| Discovery | Descriptor only. BCU1 has no interface objects and declares no `AuthorizeLevels`, so no authorize, no property reads, no scan: requests the device does not implement are answered by silence and cost a timeout each (Calimero notes the same for descriptor type 2). |
| Range derivation | The master data places everything in memory: manufacturer id `0x0104` (1 byte), application id `0x0104` (4 bytes), PEI type `0x0109`, hardware config `0x010C`, run error `0x010D`, association table pointer `0x0111`, group object table pointer `0x0112`, group address table `0x0116`, individual address `0x0117`, run status and programming mode `0x0060`. The pointers are one byte with the flavour `Ptr_StandardMemory100`; that the table then sits at `0x0100 + pointer` is read from the flavour's name (inferred). |
| Plan | `0x0060` (1 byte), then `0x0100` to `0x01FF`, the EEPROM segment every BCU1 mask declares (256 bytes, read access `Configuration`), which holds every resource above except `0x0060`; that it also holds the application's parameters is inferred. 256 bytes in 12-byte chunks. Then the tables at their pointers if a pointer leads outside that window. |
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
| `space` | `descriptor`, `property`, `property-description`, `memory`, `memory-extended` |
| `target` | object index or type and instance, PID, element range; or address and length |
| `source` | where the range came from: `master-data`, `device` (PID 7 / PID 27 / description), `product-xml` |
| `outcome` | `bytes` (with the bytes), `refused` (with the raw answer: count 0, return code such as `0xFC` access denied or `0xFD` address void), `timeout`, `connection-closed`, `not-attempted` (with the reason) |

A range that comes back in pieces is recorded as several records with exact sub-ranges. The
existing `memRead` throws `DEVICE_READ_REFUSED` when even one byte is refused; the collector needs
a variant that returns what it got and the refused sub-ranges, and keeps reading the rest of the
plan. A package with refusals is still a valid package.

## Collector design

What the collector has to be, in the terms of the code that exists.

- **A job, not a request.** A new task kind `collect`, `writes: false`, submitted to the
  `TaskQueue`, which already takes `Bus.withExclusiveOperation`. The bus monitor is closed for the
  duration; the package records when it closed and when the job released the bus, so the UI can
  say what the user missed. Cancellation is the job's `AbortSignal`; a cancelled job keeps what
  it read.
- **Plan, then execute.** The plan is computed from the mask (and, when the project holds it, the
  product XML) before the first request, stored in the package, and only then executed. A
  reviewer can see what was going to be read even when the device stopped answering.
- **Bounds, per phase.** The interface-object scan gets at most 1500 requests (descriptions and
  values together), so it cannot use up what the memory plan needs. The memory plan gets 64 KB,
  which on the classic 12-byte path is about 5500 requests, and is capped at 6000. The whole job
  stops after 15 minutes, and a device that fails three requests in a row is closed off as
  unresponsive. These are starting values, to be calibrated on the first bench runs. Each limit
  hit is recorded as such, never as "complete".
- **Secure devices.** With a tool key on file, the job opens the existing secure session and the
  same plan runs through it. The key, the serial-derived session material and any security-object
  content stay out of the package.
- **No baseline.** The job never calls the read-back adoption (`replaceParamBase`,
  `replaceLinkBase`); it writes only the package. The test for this compares the database before
  and after.
- **Provenance.** Busforge version and commit, transport kind and route, IA, the mask read, the
  authorize level obtained, timestamps per step.

## Reference vectors

[`tools/fixtures/raw-acquisition-vectors.json`](../tools/fixtures/raw-acquisition-vectors.json)
names 18 exchanges from the ETS captures by file and line; `tools/raw-acquisition-vectors.test.ts`
decodes each one from the captured frame and checks it against the fixture, including the
direction and the device address, so the vectors cannot drift from the captures. The same test
checks the association-table capacity of the two descriptions against the applications'
`MaxEntries`. The collector's codecs have to decode the same vectors.

| Vector | Shows |
|---|---|
| `dd0-*` | descriptor type 0 for MV-0705, MV-0701, MV-07B0 |
| `max-apdu-gvs`, `max-apdu-absent-*` | PID 56 present (55) and absent (count 0) |
| `serial-gvs` | a 6-byte serial (length only; the value stays in the capture) |
| `authorize-free-*` | free key `FFFFFFFF` answered with level 0 (the same exchange is in the captures of all four devices; one is enough as a vector) |
| `propdesc-*` | property description of object 2 PID 23: index 3, PDT `0x14`, 1600 and 1000 elements, read level 3, writable on the Jung and not on the GVS |
| `security-mode-off-gvs` | the security mode read on a device with Secure not activated |
| `table-reference-*` | PID 7 of object 3 on both System B devices |
| `load-status-*` | the application load status at `0xB6EC`, on the memory-mapped ABB and on the property-mapped MDT |

**What the vectors do not cover:** no negative memory response, no extended read, no description
scan past the first property, nothing from BCU1, BCU2, System 300, a coupler or an interface.
ETS never sent those to the bench devices. They are the first thing the collector's bench run has
to capture.

## Known unknowns

| Unknown | Why it matters | How it gets settled |
|---|---|---|
| What the house device declared MV-0012 (the MDT IP interface) reports and holds | it is the only owned device in an unsupported family on paper | a secure identify (read-only, key from the project) and then a collector run under that session |
| BCU1 behaviour at all | no owned real BCU1 is known | a capture from a contributed device, through the diagnostic intake |
| Whether M112 devices answer property descriptions | ETS never asked them | a description request to the MDT and the ABB on the bench |
| Whether a free-key authorize is needed for any read the bench devices allow without it | Busforge reads PID 7 today without authorizing | compare the same plan with and without it on the bench |
| `LcFilterMemory` access on couplers | the filter table is a coupler's configuration | a capture of a tool reading a coupler |
| Device-specific internal read boundaries | a refused straddling read must not fail the range | the boundary-aware read, recorded per sub-range |
