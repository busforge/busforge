# Status

The single place where Busforge states what it can do and how far each claim is proven. Every
other document links here instead of repeating a verification claim.

The bar, and it is not negotiable: a claim says **what was shown on a real device**, on the axes of
the [evidence contract](evidence-contract.md): transfer, reference, behaviour, persistence. "The
tests are green" is none of them, and a read-back of our own bytes is transfer only. A capability
that only builds plausible bytes is listed as unproven, and an unimplemented path refuses with a
coded error rather than guessing.

## Proof levels

One vocabulary, used in every table on this page. A cell may add scope after the level
("hardware, from factory"), but the level itself is always one of these.

| Level | Meaning |
|---|---|
| **hardware** | Driven against a real KNX device on a live bus through the production endpoints, and verified by reading the device back byte-for-byte and/or by observing the device act on the bus. |
| **hardware (bytes only)** | As above, but the proof stops at the read-back: the device holds our bytes. No bus-observable behaviour was available to assert (e.g. a write-only output). |
| **offline byte-match** | Our bytes compared against an ETS capture of the same operation. No device involved. |
| **real input files** | Exercised against real ETS project and manufacturer catalog files. No device involved. |
| **tests only** | Unit, golden-master or route tests. Proves stability and codec math, nothing about a device. |
| **not proven** | Implemented, but never exercised on the device, medium or channel in question. |
| **unsafe** | The profile claims the path and the endpoint will attempt it, but driving it on this device is known to damage its state, so it is declared `unsafe` in the device's smoke spec and never exercised ([testing.md](testing.md)). Proven by nothing. |
| **refused by policy** | Implemented, but a guard now blocks the path, so it cannot be driven at all. Different from *not implemented* (there is nothing to drive) and from *not proven* (it could be driven, and never was). |
| **not implemented** | Refused with a coded error. |

The **Implemented** column of the capability table is a separate axis: `yes`, `partial`,
`wired` (every part exists and the route is reachable, but the composition has never been
driven), `code-shared` (the same code as a proven path, on an unexercised medium) or `no`.

All hardware verification to date is on **twisted pair**.

## Capabilities

| Capability | Implemented | Proven | Note |
|---|---|---|---|
| Import a `.knxproj` (ETS 5/6, AES) and a manufacturer `.knxprod` catalog | yes | real input files | Own ZIP + WinZip-AES + XML implementation. Nothing that cannot be rendered is dropped silently; it is surfaced as a visible "not supported" marker. |
| Render and edit a device configuration (parameters, channels, modules, i18n) | yes | hardware | Click-through against the device's own read-back on four products (see the device table). |
| Read parameters back from a device | yes | hardware | Both memory models (relative/System B, absolute/System 7). |
| Read group-address links back from a device | yes | hardware | Both memory models. |
| Flash parameters (surgical, owned bytes only) | yes | hardware | Change applied and reverted, byte-checked each way, on both memory models and on module/channel devices. |
| Flash group addresses (surgical) | yes | hardware | System B rewrites the com-object table, and on the one manufacturer hardware-proven to need it also holds the application object in its own load bracket; System 7, in both LSM styles, sets each object's linked bit in the table the device holds, as ETS does, where the application names its segment (see known unproven). |
| Full download / first-time commissioning without ETS | yes | hardware | Proven on System B (relative) and on both System 7 LSM styles: memory-mapped (MV-0701) and property-mapped (MV-0705). Authors the com-object table on System B and, where the application names its segment, on both System 7 LSM styles: the manufacturer's template with the active objects' config bytes and link bits. |
| Individual-address assignment via programming mode | yes | hardware | Refuses unless exactly one device is in programming mode and the target address is free; the result is proven by talking to the device on its new address. |
| Individual-address assignment by serial number (no button press) | yes | hardware | The path used to commission a factory device that cannot be reached physically. |
| Structural change (a parameter that changes the set of com-objects) | partial | hardware | Refused surgically (`COM_OBJECT_TABLE_STALE_USE_DOWNLOAD`, or `COM_OBJECT_TABLE_STALE` where the family has no full-download path) and promoted to a full download, which rewrites the whole parameter image. A surgical structural flash is on the roadmap, not built. |
| Reach a segment above 64 KB (`A_MemoryExtended`) | yes | hardware | Reads auto-select it when a range exceeds `0xFFFF`. Writes use it, confirmed chunk by chunk, on every device that declares `PID_MAX_APDU_LENGTH`, as ETS does ([device-memory-model.md](device-memory-model.md)). An address past 24 bits is refused (`MEMORY_ADDRESS_TOO_HIGH`) rather than truncated. |
| KNX Data Secure: read (descriptor, property, serial, security mode) | yes | hardware | Own AES-128-CCM; tool keys come from the project file. The Jung 400021SE, secure-commissioned by ETS, reads back in full (parameters and links equal to the ETS project) and reports its security mode as on. All 523 secured frames of ETS commissioning it decrypt with Busforge's CCM ([knx-secure.md](knx-secure.md#the-ets-reference-capture)). |
| KNX Data Secure: write (property write) | yes | hardware | Reversible property write on a real secure device. |
| KNX Data Secure: parameter flash over the secure channel | yes | hardware | On the ETS-secured Jung 400021SE (2026-09-28): one parameter changed and reverted by surgical flash through the session, 2 bytes each way, both verified. Not a smoke run with evidence records yet. |
| KNX Data Secure: GA flash or full download | yes (System B) | hardware | The security object (group key table, per-object security flags) is loaded in the same bracket as the tables, the way ETS does it. On the ETS-secured Jung 400021SE (2026-09-28): the secured full download verified after its restart, its 158 security-object frames byte-identical to ETS's decrypted capture; a GA flash that linked a second object to the secured address set that object's flag on the device and verified, and its revert left the device equal to ETS's load again. Not smoke runs with evidence records yet. Other memory models refuse (`SECURE_TABLES_UNSUPPORTED`). That the secured address works on the bus is not shown: Busforge cannot yet send or decrypt a secured group telegram. |
| KNX Data Secure: FDSK provisioning | no | not implemented | ETS doing it on the Jung is captured and decrypted as the reference. |
| KNX IP Secure (secure tunnelling transport) | no | not implemented | Out of scope. |
| Transport: KNXnet/IP tunnelling (UDP and TCP), own implementation | yes | hardware | Connect, tunnel, management, heartbeat and closure. |
| Transport: KNX USB (HID) | yes | hardware | Bus-level round trip proven on one interface model; sends are serialized because a second send clobbers the outstanding confirmation. |
| Expose a local USB interface on the network as a KNXnet/IP gateway | yes | hardware | Full downloads driven through it; a third-party tool (ETS) can also program a device through it. Management works only on the interface's own address on the USB stick tested. |
| Bus monitor: live telegrams, DPT-decoded values, group-address names | yes | hardware | Read-only: decoded live telegrams off a real installation bus. |
| Snapshots: configuration restore points (capture, compare, restore) | yes | tests only | Database-level feature; no device write involved. |
| Export / import the `.busforge` archive (optionally encrypted) | yes | tests only | |
| Place a catalog device, replace a device and migrate its links | yes | hardware | Driven end to end into a real commission. One UI gap: links hidden by parameter visibility have no mapping row (`REPLACE_MAPPING_INCOMPLETE`). |
| DCA-replacement plugins (native views instead of a Windows ETS plugin) | partial | tests only | One read-only module (Theben DALI gateway) rendering fixtures, groups and scenes from the device's backup store. No write path. |
| Application code / firmware download (LSM 5) | no | not implemented | A System 7 full download writes the application's static code segments from the product data; there is no separate code-load capability. |
| Property-based loading (interface-object devices with no memory image) | no | not implemented | |
| System 1 / System 2 / System 300 devices | no | not implemented | Recognised by mask and refused, never routed into a path that guesses. |
| Non-TP media (powerline, RF, IP masks) | code-shared | not proven | Same codec and load procedure as the TP masks; never exercised on the wire. See [device-support.md](device-support.md). |

## Devices driven on real hardware

Read-back means our built image was compared byte-for-byte against the device's own memory.
Bus behaviour means the device was observed acting on the bus through an independent witness
connection, which is the only check that catches a byte-perfect flash of a semantically wrong
value.

| Manufacturer / product | Mask | Memory model | Read-back | Param flash | GA flash | Full download | Bus behaviour |
|---|---|---|---|---|---|---|---|
| ABB US/U 4.2 universal interface | MV-0701 | absolute, memory-mapped LSM | hardware | hardware | hardware (bytes only) | hardware | not applicable: write-only outputs |
| MDT BE-02001.02 universal interface 2-fold | MV-0705 | absolute, property-mapped LSM, module device | hardware | hardware | hardware | hardware, byte-equal to two ETS downloads | hardware: a flashed link answers a read |
| GVS K-BUS AMMA-04/06.S multifunction actuator | MV-07B0 | relative | hardware | hardware | hardware | hardware, from virgin, survives a bus power cycle | hardware: the switch object drives the status object |
| Jung 400021SE Tasterschnittstelle 2fach Secure | MV-07B0 | relative, module device, parameter segment above 64 KB | hardware | hardware | hardware | hardware, from factory; survives a restart since the memory-control-block fix (see below) | hardware: a surgically flashed link answers a read |
| OpenKNX RaumController (AB-SmartHouse AB-PRE) | MV-07B0 | relative | hardware | hardware, one parameter on the house unit, `verified` after the restart (see below) | hardware, one link added and removed on the house unit, each `verified` after the restart, the added link answered a group read (see below) | hardware, from factory **and onto a device running its application** (three downloads, each `verified`), application runs and survives a bus power cycle | hardware: in service in a real installation, driving light, fan and temperature |
| MEAN WELL KNX power supply (M-0162) | MV-07B0 | relative | hardware | hardware | not proven | not proven | hardware: the cyclic-send interval change took effect on the bus |
| Theben HMG 6T (M-0048) | MV-07B0 | relative, module device | hardware | hardware, module-instance parameter | not proven | not proven | not proven |
| Theben DALI gateway (M-0048) | MV-07B0 | relative | not proven (see below) | not proven | not proven | not proven | not proven |
| Auro presence detector (M-0081) | MV-0705 | absolute | hardware | hardware | hardware, re-point and revert | not proven | hardware: an independent bus read confirmed the device on the newly linked group address |
| Steinel presence detector (M-008E) | MV-0705 | absolute, data-less segment | hardware | hardware | not proven | not proven | not proven |
| Sensor (M-0008) | MV-0705 | absolute | hardware | refused by policy (see below) | not proven | not proven | not proven |
| Theben sensor (M-0048, MV-0705 product) | MV-0705 | absolute | hardware | hardware | not proven | not proven | not proven |
| MDT IP interfaces (KNX Data Secure) | opaque (`0xFFFF` to plain reads) | none exposed | hardware, secure identify only | not proven | refused (`SECURE_TABLES_UNSUPPORTED`) | refused (`SECURE_TABLES_UNSUPPORTED`) | not proven |

Notes attached to that table:

- **Jung 400021SE runs in secure mode since 2026-09-28** (ETS secure-commissioned it as the reference
  for the secure work, [knx-secure.md](knx-secure.md#the-gap)). Its plain claims in this table were
  shown before that and stand; the plain smoke spec does not apply to it until a master reset. Busforge
  full-downloaded it in secure mode on 2026-09-28 (verified after the restart).
- **Jung 400021SE lost its application at the next restart, until the memory-control-block fix.** After a Busforge full download the
  device answers with every load object LOADED and every byte read back equal. After an A_Restart
  (2026-09-25, reproduced twice) the tables are still LOADED, but the application object (object
  4) comes back in ERROR and the device answers no group read. Cause, from an ETS capture: its load
  procedure declares two memory-control-block regions (object 4, PID 27) that ETS writes after the
  allocation and Busforge skipped, and every allocation (full download or parameter flash) resets
  them. Both paths now write them ([load-procedures.md](load-procedures.md)); on hardware the
  device then keeps both regions through a GA flash and a parameter flash and its application
  survives a restart. The Theben MIX application (`M-0048_A-493B-21`) declares the same regions:
  parameter flashes Busforge did on such a device before this change may have left one region,
  which shows only at the device's next restart. Its parameter flash now writes the two regions
  as well; that bracket has not been driven on a Theben device yet.
- **ABB US/U 4.2 com-object table.** ETS authors this memory-mapped table as it does the
  property-mapped MDT one: each active object's config byte from the application, with the link
  bit set only on objects that have a group address. Busforge used to write the manufacturer's
  template unchanged. Its full download now authors it that way (byte-equal to ETS at defaults,
  2026-09-25). On a group-address download ETS writes only the config bytes that change (a
  partial download after enabling a channel and linking object 1, 2026-09-26); Busforge's
  group-address flash changes only the linked bit in the table the device holds, touching no
  other byte.
- **ABB US/U 4.2 parameter byte order.** The application declares
  `ParameterByteOrder="LittleEndian"`; ETS writes multi-byte parameters least significant byte
  first (450 as `c2 01`). Busforge wrote them big-endian. Byte-aligned integers are now written
  as ETS does; a little-endian parameter that is a float or not byte-aligned is refused
  (`PARAM_BYTE_ORDER_UNSUPPORTED`), because no capture shows how ETS places one.
- **GVS AMMA with every output disabled.** ETS downloads a configuration that activates no
  com-object, writing the declared table of silent entries; Busforge used to refuse it
  (`COM_OBJECT_TABLE_EMPTY`) and now writes the same table. In the disabled channels' regions
  every union has no active member, and ETS writes the member marked `DefaultUnionParameter`;
  Busforge's full download now does the same (module-instance unions excepted, no capture covers
  them); the parameter flash writes them as well, as ETS's partial download does. The whole
  download is byte-equal to the ETS one (2026-09-25 capture, `tools/fixtures/`).
- **GVS AMMA: a parameter flash wrote idle union bits.** The parameter flash owned whole bytes, so
  beside a 2-bit parameter it wrote the `<Data>` template's 1s into the disabled channel's idle
  unions, where the device held (and ETS writes) 0s. The firmware read them as configuration and,
  at the next group-address flash, set flags in the com-object table itself, which then failed
  its read-back. Ownership is now per bit on both memory models ([findings.md](findings.md) §12).
- **GVS AMMA: objects a union member without a placement switched on.** After enabling a channel,
  Busforge activated three com-objects (5, 6, 8) that ETS leaves out: a choose tested a union
  member no active branch places, read its default and took the branch. ETS treats such a member
  as unset and takes the default branch; Busforge now does the same (2026-09-26 partial-download
  capture). No other bundled application changes at its defaults.
- **Jung 400021SE: one parameter byte differed from ETS.** At offset 176 ("delay after bus voltage
  return") Busforge wrote 100 ms where ETS writes 0 ms. Two ParameterRefs of one parameter carry
  different defaults: the one shown uses the parameter's default, the other, only tested by a
  choose, has its own. ETS shares one value per parameter (a targeted capture and ETS's own export,
  2026-09-26), Busforge evaluated the tested ref with its own default and activated a second union
  member. A ref that is not placed now reads the shared value ([findings.md](findings.md) §9); the
  Jung full download is byte-equal to ETS, and no other bundled application changes.
- **MDT BE-02001.02 debounce time.** Until 2026-09-25 the debounce time (`P-7`, marked
  `LegacyPatchAlways`) was left out of the image, so the device got the `<Data>` default of 50 ms
  instead of 30 ms, and an edit never reached it ([findings.md](findings.md) §8). The earlier
  hardware proofs of this device did not cover that byte.

- **OpenKNX surgical parameter and group-address flash: proven on the house unit.** The first
  attempt (1.1.x, one byte) stopped before LoadCompleted because Busforge read the
  bytes back before the restart, when this firmware still returns the old flash contents
  ([findings.md](findings.md) §16); the device was recovered the same day. With the read-back moved
  after the restart the change and its revert both landed, persisted across the restart (read back
  separately) and the revert reported `verified: true`; the application answered a group read
  afterwards. Operator observation, no evidence record, one parameter. The group-address flash
  first needed the device's links in the project: the read-back had left 11 of them
  out of the baseline and shown a project-only link as "no change" (fixed in `e9709f8`, see
  [verification.md](verification.md)). After a read-back with 0 gaps and "revert to the device", a
  dry run reported `unchanged` over all 2788 table bytes. Linking object 23 to a new group address
  wrote 75 bytes, `verified: true` after the restart, and the object answered a group read on it;
  removing the link again wrote 75 bytes, `verified: true`, a fresh read-back showed no drift and no
  gaps, the dry run `unchanged`, and the test address stopped answering while an existing house
  link (5/2/9) still did. Operator observation, no evidence record, one link. Earlier versions of
  this page called them unsafe; the label came from
  two failures of the *full download*, both explained since: a module-state region poisoned by
  earlier bench experiments (recovered by `erase openknx`) and a com-object table sized to the
  active instead of the declared objects (fixed in `a7b179c`; the group-address flash now builds
  the table the same way). In the firmware (thelsing/knx with OpenKNX Common) a surgical flash and
  a full download take the same path: unloading any table makes the stack report unconfigured
  until the restart, module state is saved before the unload and restored after the restart. The
  profile claims both capabilities and the endpoints perform them. The smoke spec keeps them out of
  automated runs because recovering a failed run needs the device's serial console; a controlled
  comparison is on the [roadmap](roadmap.md).
- **Theben DALI gateway**: earlier documents claimed a hardware read-back of its group and
  association tables, others did not, and the evidence could not be reconstructed. The claim is
  therefore withdrawn rather than carried forward on a memory of it. The DCA-replacement plugin for
  this gateway renders committed fixtures and proves nothing about the device on a bus.
- **M-0008 parameter flash**: it was hardware-proven, then a later coverage gate started refusing
  it (`LOAD_STEP_UNSUPPORTED`), because this device's load procedure declares three image-property
  stamps the engine cannot compute and it declines a partial recipe rather than guess.
- **The table lists the devices driven through a write path.** A wider set carries the weaker
  hardware proof: an owned-byte read-back match (build the image, read the device's memory,
  compare the bytes we own, `tools/verify-images.ts`) covered **28 of 32 reachable devices** of the
  reference installation. Of the four residuals, two are the secure interfaces (read and written
  over the secure channel instead) and the rest are project-versus-device drift or a device
  self-stamped marker, not modelling gaps. A read-back match is not a flash round-trip.
- **Sibling products on a proven mask are individually unproven.** A mask being hardware-proven on
  one product means the memory model and load procedure are right, not that another manufacturer's
  product on that mask has been driven.
- Two units of the Theben HMG 6T show a small residual byte difference attributed to
  project-versus-device drift (the same parameters build correctly on their clean siblings), not
  to a modelling gap.

### Hardware smoke specs, per channel

The rows above say which paths a device has been through. This table says which of them are held
by an automated spec (`tools/smoke/specs/`, see [testing.md](testing.md)) and **in which channel**
that spec has actually been run: `api` (the production endpoints directly) or `ui` (the real web
app in a browser).

**The done bar** ([/CONTEXT.md](../CONTEXT.md)): a device counts as fully supported only when
every capability its product claims, plus provisioning and the UI click-through, passes on real
hardware in **both** channels, together with every behaviour its spec declares. One green channel
is not done, and neither is a device that byte-verifies without ever acting on the bus, unless its
spec states why no behaviour is observable.

| Spec | Product | Mask | `api` | `ui` | Persistence (restart) | Done bar |
|---|---|---|---|---|---|---|
| `gvs-amma` | GVS K-BUS AMMA-04/06.S multifunction actuator | MV-07B0 | hardware | hardware | hardware, both channels | **met** |
| `mdt-be02001` | MDT BE-02001.02 universal interface 2-fold | MV-0705 | hardware | hardware | hardware, both channels | **met** |
| `abb-usu-4.2` | ABB US/U 4.2 universal interface | MV-0701 | hardware | hardware | hardware, both channels | **met**, to the byte only |
| `jung-400021se` | Jung 400021SE Tasterschnittstelle 2fach Secure | MV-07B0 | hardware | hardware | hardware, both channels | **met** |
| `openknx-raumcontroller` | OpenKNX RaumController (AB-SmartHouse AB-PRE) | MV-07B0 | not proven | not proven | not proven | **not met** |

All four devices pass both channels, every capability, their behaviour and the persistence step
on build `50d6b80` (2026-09-27), which writes partial downloads the way ETS does (System B owned
bytes with the idle unions' defaults, memory-mapped System 7 differing table bytes only) on top of
the ETS-matched group-address flash, per-bit parameter ownership and the confirmed extended write.
Those runs, and the earlier ones they supersede (2026-09-25: MDT `c2cde85`, Jung `7c54b8d`, ABB and
GVS `c935d5f`; 2026-09-26: Jung `bf97acc`, all four on `1de6231`), are kept with their evidence records in evidence/runs/. Persistence there means an observed reboot
after A_Restart, every load object LOADED again, and a read-back equal to the project; it is not a
bus power cut ([evidence-contract.md](evidence-contract.md)).

- **ABB US/U 4.2**: its outputs are write-only, so its spec declares no behaviour. Every claimed
  capability plus the click-through is green in both channels, which clears the bar, but the proof
  stops at the bytes and the table says so rather than implying a bus-observable one.
- **Jung 400021SE**: every capability it claims, its `output` behaviour, the click-through and the
  persistence step are green in both channels, first on build `7c54b8d` (2026-09-25) after the
  memory-control-block fix (device table notes), now on `1de6231`. The earlier runs of 2026-09-25
  record the failure.
- **OpenKNX RaumController**: the spec exists but has never been run in either channel. The
  device's commissioning is hardware-proven (see the device table), driven through the production
  endpoints before the framework existed. The device now runs in a live installation rather than on
  the bench, so the spec stays unrun: driving it would program a device somebody depends on. Its two
  surgical capabilities are excluded from automated runs (see the device table notes), so even a
  green run could not clear the bar for them.

## What green tests prove, and what they do not

`bun run check` proves exactly two things:

- **Stability.** The golden-master build of every bundled application program still produces the
  bytes it produced before. That is a regression guard against **our own previous output**, not a
  comparison with a device or with ETS.
- **Codec math.** The encoding primitives match KNX reference vectors, independent of any device.

They prove **nothing** about whether a device is programmed correctly. A device faithfully holds
wrong bytes, and both the flash verify and the read-back will report success on them. Do not
report a device family as working on the strength of a passing test suite.

## Known unproven

- **Our image equals what ETS would write** is only checked where an ETS capture of the same
  device exists, all for the full download: the MDT BE-02001.02 (defaults and one link), the ABB
  US/U 4.2, the GVS AMMA and the Jung 400021SE (project configurations), every segment byte for byte (`tools/etsdiff.ts`,
  captures in `tools/fixtures/`, records in [evidence/reference/](evidence/reference/)). The Jung
  400021SE (module device) as well. For the parameter flash one ETS partial download of the Jung
  exists: it writes the two MCB regions after the allocation, as Busforge's parameter flash does,
  and its parameter bytes match Busforge's image. For the group-address flash one ETS partial
  download per bench device exists (links plus, on the ABB, GVS and Jung, a parameter
  change): every byte ETS wrote, group tables and com-object table included, equals Busforge's
  image for that configuration (`tools/etsdiff.test.ts`, captures in `tools/fixtures/`, records per
  flash operation `*-partial-links.json` in [evidence/reference/](evidence/reference/)). Everywhere else the read-back proves `device == our image` and can never prove
  `our image == ETS`. That blind spot has hidden a codec bug and the `LegacyPatchAlways` bug.
- **System 7 group-address flash of the com-object table.** It reads the table the device holds
  and changes only each object's linked bit; ETS rewrites that bit on a group-address download on
  both LSM styles (MDT and ABB partial-download captures). On a device holding a correct table
  that equals ETS's bytes; on one whose table another tool left wrong, the other bytes stay wrong.
  The M-0081 (house device 1.1.x) now gets that bit rewritten too, which no capture of that
  product covers. A freshly linked read-capable object was proven to work on hardware; a
  **transmit-only object**, the case that depends on the linked bit, has not been observed on the
  bus. A property-mapped application that names no com-object table segment keeps the device's
  table; a memory-mapped one is refused.
- **KNX Data Secure writes are operator runs, not smoke runs.** The secured full download, a
  surgical parameter flash and a GA flash that changed the security object were each driven once on
  the Jung and verified; no smoke spec drives them yet, so there are no evidence records.
- **Non-TP media** (powerline, RF, IP masks) have never been exercised on the wire.
- **MV-0700, MV-2705, MV-5705, MV-17B0, MV-27B0, MV-57B0** share a proven code path but no device
  on those masks has been driven.
- **The OpenKNX RaumController's surgical flashes are operator observations on one house unit**
  (one parameter, one link), not smoke runs with evidence records; no ETS reference of a partial
  download exists for this product (no ETS project matches the unit).
- **KNXnet/IP connection-state heartbeat and closure** are verified against Busforge's own server,
  not against a third-party gateway's real timing.
- **The USB transport is proven on one interface model.** Its single-report HID limits (read and
  write chunk ceilings, management only on the interface's own address) are properties of that
  controller and may differ elsewhere.
- **The DCA-replacement plugin is read-only** and covers one gateway; nothing is written back.
