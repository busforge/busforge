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
| Flash group addresses (surgical) | yes | hardware | System B rewrites the com-object table, and on the one manufacturer hardware-proven to need it also holds the application object in its own load bracket; System 7 keeps the device's com-object table, in both LSM styles (see known unproven). |
| Full download / first-time commissioning without ETS | yes | hardware | Proven on System B (relative) and on both System 7 LSM styles: memory-mapped (MV-0701) and property-mapped (MV-0705). Authors the com-object table, which a virgin device does not have, on System B and on the property-mapped System 7 masks; the memory-mapped ones write the manufacturer's static table from the product data. |
| Individual-address assignment via programming mode | yes | hardware | Refuses unless exactly one device is in programming mode and the target address is free; the result is proven by talking to the device on its new address. |
| Individual-address assignment by serial number (no button press) | yes | hardware | The path used to commission a factory device that cannot be reached physically. |
| Structural change (a parameter that changes the set of com-objects) | partial | hardware | Refused surgically (`COM_OBJECT_TABLE_STALE_USE_DOWNLOAD`, or `COM_OBJECT_TABLE_STALE` where the family has no full-download path) and promoted to a full download, which rewrites the whole parameter image. A surgical structural flash is on the roadmap, not built. |
| Reach a segment above 64 KB (`A_MemoryExtended`) | yes | hardware | Auto-selected when a range exceeds `0xFFFF`; the classic path is byte-identical below. Previously such devices were refused (`MEMORY_ADDRESS_TOO_HIGH`) rather than truncated. |
| KNX Data Secure: read (descriptor, property, serial) | yes | hardware | Own AES-128-CCM; tool keys come from the project file. |
| KNX Data Secure: write (property write) | yes | hardware | Reversible property write on a real secure device. |
| KNX Data Secure: parameter flash, GA flash or full download over the secure channel | wired | not proven | All three routes pass the device's secure credentials into the session, so the paths are reachable, but the composition (secure session + load procedure) has never been driven; the only secure devices available are gateways with no parameter image. |
| KNX Data Secure: FDSK provisioning | no | not implemented | |
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
| OpenKNX RaumController (AB-SmartHouse AB-PRE) | MV-07B0 | relative | hardware | not proven (see below) | not proven (see below) | hardware, from factory **and onto a device running its application** (three downloads, each `verified`), application runs and survives a bus power cycle | hardware: in service in a real installation, driving light, fan and temperature |
| MEAN WELL KNX power supply (M-0162) | MV-07B0 | relative | hardware | hardware | not proven | not proven | hardware: the cyclic-send interval change took effect on the bus |
| Theben HMG 6T (M-0048) | MV-07B0 | relative, module device | hardware | hardware, module-instance parameter | not proven | not proven | not proven |
| Theben DALI gateway (M-0048) | MV-07B0 | relative | not proven (see below) | not proven | not proven | not proven | not proven |
| Auro presence detector (M-0081) | MV-0705 | absolute | hardware | hardware | hardware, re-point and revert | not proven | hardware: an independent bus read confirmed the device on the newly linked group address |
| Steinel presence detector (M-008E) | MV-0705 | absolute, data-less segment | hardware | hardware | not proven | not proven | not proven |
| Sensor (M-0008) | MV-0705 | absolute | hardware | refused by policy (see below) | not proven | not proven | not proven |
| Theben sensor (M-0048, MV-0705 product) | MV-0705 | absolute | hardware | hardware | not proven | not proven | not proven |
| MDT IP interfaces (KNX Data Secure) | opaque (`0xFFFF` to plain reads) | none exposed | hardware, secure identify only | not proven | not proven | not proven | not proven |

Notes attached to that table:

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
- **ABB US/U 4.2 com-object table.** ETS clears the Communication flag of every object without a
  group address in this memory-mapped table; Busforge used to write the manufacturer's template
  unchanged. The full download now clears it (byte-equal to an ETS download at application
  defaults, 2026-09-25 capture). The group-address flash sets the flag on linked objects and
  clears it on the rest in the table the device holds, touching no other byte, so a newly linked
  object is not left silent. That GA-flash path has not been compared with an ETS capture or
  driven on hardware yet, and what ETS writes for a linked object is not known.
- **GVS AMMA with every output disabled.** ETS downloads a configuration that activates no
  com-object, writing the declared table of silent entries; Busforge used to refuse it
  (`COM_OBJECT_TABLE_EMPTY`) and now writes the same table. In the disabled channels' regions
  every union has no active member, and ETS writes the member marked `DefaultUnionParameter`;
  Busforge's full download now does the same (module-instance unions excepted, no capture covers
  them); the surgical parameter flash leaves those bytes as the device holds them. The whole
  download is byte-equal to the ETS one (2026-09-25 capture, `tools/fixtures/`).
- **Jung 400021SE: one parameter byte differs from ETS.** At offset 176 of the parameter segment
  ("delay after bus voltage return") Busforge writes 100 ms where ETS writes 0 ms. Two
  ParameterRefs of the same parameter (`P-505`) carry different defaults and gate one union; ETS
  evidently shares one value per parameter, Busforge evaluates each ref's own default and activates
  both union members. Such differing ref defaults are common (161 in this application alone), so
  the rule is not changed on one byte of evidence; a targeted ETS capture decides it.
- **MDT BE-02001.02 debounce time.** Until 2026-09-25 the debounce time (`P-7`, marked
  `LegacyPatchAlways`) was left out of the image, so the device got the `<Data>` default of 50 ms
  instead of 30 ms, and an edit never reached it ([findings.md](findings.md) §8). The earlier
  hardware proofs of this device did not cover that byte.

- **OpenKNX surgical flashes: never driven, no failure observed.** Earlier versions of this page
  called them unsafe. No surgical write was ever attempted on this device; the label came from
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

The 2026-09-25 runs (MDT on build `c2cde85`, the Jung on `7c54b8d`, ABB and GVS again on
`c935d5f` after their com-object table and union fixes; both channels, every capability,
behaviour and the persistence step) and their evidence records are kept in
[evidence/runs/2026-09-25/](evidence/runs/2026-09-25/). Persistence there means an observed reboot
after A_Restart, every load object LOADED again, and a read-back equal to the project; it is not a
bus power cut ([evidence-contract.md](evidence-contract.md)).

- **ABB US/U 4.2**: its outputs are write-only, so its spec declares no behaviour. Every claimed
  capability plus the click-through is green in both channels, which clears the bar, but the proof
  stops at the bytes and the table says so rather than implying a bus-observable one.
- **Jung 400021SE**: every capability it claims, its `output` behaviour, the click-through and the
  persistence step are green in both channels on build `7c54b8d` (2026-09-25), after the
  memory-control-block fix (device table notes). The earlier runs of that day record the failure.
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
  US/U 4.2 and the GVS AMMA (defaults), every segment byte for byte (`tools/etsdiff.ts`,
  captures in `tools/fixtures/`, records in [evidence/reference/](evidence/reference/)). The Jung
  400021SE matches except one parameter byte (below). The parameter flash and the group-address
  flash have no ETS capture yet. Everywhere else the read-back proves `device == our image` and can never prove
  `our image == ETS`. That blind spot has hidden a codec bug and the `LegacyPatchAlways` bug.
- **MV-0705 group-address flash keeps the device's own com-object table.** A freshly linked
  read-capable object was proven to work on hardware; a **transmit-only object**, the case that
  would actually depend on the table's per-object link bit, is unproven, which is why the
  table-rewriting fix applied to System B was deliberately not extended here.
- **Full parameter or group-address flash over KNX Data Secure** has never been driven. Both
  directions of the secure channel are hardware-proven on their own; the composition is not.
- **Non-TP media** (powerline, RF, IP masks) have never been exercised on the wire.
- **MV-0700, MV-2705, MV-5705, MV-17B0, MV-27B0, MV-57B0** share a proven code path but no device
  on those masks has been driven.
- **The OpenKNX RaumController has never been driven through the bracketed System B group-address
  flash.** The device itself was re-driven on 2026-08-30 (three full downloads, each `verified`, one
  of them onto the device in service), but no surgical group-address flash has been driven on it,
  so that path stays unproven here until the controlled comparison on the roadmap runs.
- **KNXnet/IP connection-state heartbeat and closure** are verified against Busforge's own server,
  not against a third-party gateway's real timing.
- **The USB transport is proven on one interface model.** Its single-report HID limits (read and
  write chunk ceilings, management only on the interface's own address) are properties of that
  controller and may differ elsewhere.
- **The DCA-replacement plugin is read-only** and covers one gateway; nothing is written back.
