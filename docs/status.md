# Status

The single place where Busforge states what it can do and how far each claim is proven. Every
other document links here instead of repeating a verification claim.
The per-Product, per-operation matrix computed from the kept evidence records is
[compatibility.md](compatibility.md) (generated); the app shows the same states in each device's
compatibility badge.

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
| Flash group addresses (surgical) | yes | hardware | System B rewrites the com-object table, and on the one manufacturer hardware-proven to need it also holds the application object in its own load bracket; System 7, in both LSM styles, sets each object's linked bit in the table the device holds, as ETS does, where the application names its segment (see known unproven). On the Gira M-0008 it re-declares the tables, writes the bytes of ETS's image and reads the declared stamps, as ETS does (on the house unit 1.1.x); on the Auro M-0081_A-FE01 it unloads and re-declares them, as ETS does (on the house unit 1.1.x; notes below); on the Theben TheLuxa P300 it re-declares them as on the Gira and writes the bytes of ETS's image (on the house unit 1.1.x), and so on the memory-mapped Theben Meteodata 140 S, over `0x0104` (on the house unit 1.1.x). |
| Full download / first-time commissioning without ETS | yes | hardware | Proven on System B (relative) and on both System 7 LSM styles: memory-mapped (MV-0701) and property-mapped (MV-0705). Authors the com-object table on System B and, where the application names its segment, on both System 7 LSM styles: the manufacturer's template with the active objects' config bytes and link bits. Not on every System 7 application: a procedure declaring `LdCtrlTaskCtrl1` is refused and not offered, except the Gira M-0008, the Auro M-0081_A-FE01, the Theben TheLuxa P300 and the Theben Meteodata 140 S, which run as ETS was captured running them, onto a unit already holding their application only, so not as first-time commissioning (device notes below; each run on one house unit, where every planned byte already equalled the unit, on the TheLuxa but for a download marker the unit clears itself: the sequence was accepted and the unit stayed loaded and answering, but no run shows changed configuration bytes transferred by a full download). |
| Individual-address assignment via programming mode | yes | hardware | Refuses unless exactly one device is in programming mode and the target address is free; the result is proven by talking to the device on its new address. |
| Individual-address assignment by serial number (no button press) | yes | hardware | The path used to commission a factory device that cannot be reached physically. |
| Structural change (a parameter that changes the set of com-objects) | yes (Jung 400021SE, MDT BE-02001.02) | hardware | Written as a structural flash: parameters, the com-object table authored for the new configuration and links, and the group tables, in one load bracket on System B (one per load-state machine on System 7), as ETS's partial download writes such a change ([load-procedures.md](load-procedures.md#structural-flash), [findings.md](findings.md) §28: every byte ETS wrote matches Busforge's image, 42 on the Jung, 222 on the MDT). Claimed only for the application programs proven on the bench (`STRUCTURAL_FLASH`: these two); every other device still gets the full download (`COM_OBJECT_TABLE_STALE_USE_DOWNLOAD`, or `COM_OBJECT_TABLE_STALE` without a full-download path); on the System 7 applications whose full download is refused (`LdCtrlTaskCtrl1`, notes below) such a change is refused with `COM_OBJECT_TABLE_STALE_USE_ETS` ([owned-products.md](owned-products.md)). Jung 400021SE (Data Secure, 2026-10-01, smoke spec `jung-400021se-secure`, api channel, run from the bench host next to the bridge): K2 switched to "Dimmen und Farbtemperatur" and back, each a structural flash verified after the restart, read back without drift; the same run passed every other capability, both behaviours and persistence. MDT BE-02001.02 (2026-10-01, smoke spec `mdt-be02001`, api channel, from the bench host): input B switched to the two-object short/long function and back (2→3→2 objects), each a structural flash verified after the restart, read back without drift; the same run passed every other capability, its behaviour and persistence. Both runs were on the build before the last review fixes, which narrowed the claim to these two programs and the restored bytes to verifiable parameters; the profile tests pass for both after them. On the committed build (`e17ccc3`) both specs then passed in the UI channel as well (2026-10-01, from the bench host): the structural change written through the flash dialog, which previewed it on the configuration and the group addresses and wrote it once, each direction verified, no drift; the full download through the dialog's full-download action; click-through, behaviours and persistence passed in the same runs. |
| Reach a segment above 64 KB (`A_MemoryExtended`) | yes | hardware | Reads auto-select it when a range exceeds `0xFFFF`. Writes use it, confirmed chunk by chunk, on every device that declares `PID_MAX_APDU_LENGTH`, as ETS does ([device-memory-model.md](device-memory-model.md)). An address past 24 bits is refused (`MEMORY_ADDRESS_TOO_HIGH`) rather than truncated. |
| KNX Data Secure: read (descriptor, property, serial, security mode) | yes | hardware | Own AES-128-CCM; tool keys come from the project file. The Jung 400021SE, secure-commissioned by ETS, reads back in full (parameters and links equal to the ETS project) and reports its security mode as on. Without a key on file `secure-identify` reads plainly (2026-09-30, bench): the GVS AMMA with Secure, never activated, states its security mode off; the ABB US/U 4.2 (silent) and the MDT BE-02001.02 (closes the connection) are reported as unreadable, not as off; that they lack the security object is likely, not shown. The Jung in secure mode refuses a plain read with access denied (0xFC, shown with a raw probe); that and the not-activated verdict on a device whose stored key gets no Sync answer (`SECURE_MODE_OFF`) are tested against a simulated device only. All 523 secured frames of ETS commissioning it decrypt with Busforge's CCM ([knx-secure.md](knx-secure.md#the-ets-reference-capture)). |
| KNX Data Secure: tool key deposited by hand | yes | hardware | Stored (source `manual`) only after the device answered a secure Sync under it ([knx-secure.md](knx-secure.md#the-key-store)). On the ETS-secured Jung 400021SE (2026-10-02, API, from the Mac over the bench bridge): a random key refused (`SECURE_SYNC_NO_RESPONSE`, the entry on file unchanged); with the entry removed, no serial refused before the bus (`TOOL_KEY_SERIAL_MISSING`), a wrong serial refused by the device's silence, the right key with its serial stored as `manual`, after which `secure-identify` opened a session under it; the key already on file kept its source. The same run repeated on the build after the review fixes, and through the device menu's dialog in the browser: a random key shown as refused, then the right key with the serial stored as `manual` and the device listed as secure. The refusal of a factory key (security mode off) and of a serial the device reports differently are tested against a stubbed identification only. |
| KNX Data Secure: flag a device whose security object no longer matches | yes | hardware (bytes only) | A fingerprint of the security object recorded by each verified GA flash, full download or structural flash (or a GA flash that finds the device already matching; not adopted at ETS import, so every imported secure device starts unknown) is compared on every project read; a key, sender or peer change made anywhere shows as "Security changed", no or an undecidable fingerprint as "Security unknown" ([knx-secure.md](knx-secure.md#security-object-baseline)). On the Jung 400021SE (2026-10-02, isolated server, the ETS export of 2026-10-01 imported): both secure devices started unknown; a dry and then a real GA flash of the Jung found its tables and security object matching (`unchanged`, nothing written, about 40 s each) and cleared its flag, the GVS stayed unknown; a sender added to 0/0/1 through the API flagged the Jung changed, removing it cleared it. A peer linking a transmitting object or changing its address: route tests only. |
| KNX Data Secure: keyring export (`.knxkeys`) for other tools | yes | real input files (the exported file read by ETS 6.4.1 and xknx 3.20.0; no device) | The project's tool keys, sequence numbers, certificates, group keys and senders as an ETS keyring ([knx-secure.md](knx-secure.md#keyring-export)). 2026-10-02: ETS 6.4.1 imported a file downloaded through the export dialog (certificate listed by serial), and one with an `Interface` element; xknx 3.20.0 loaded the same file with its signature, keys and sequence numbers and set up Data Secure from it. ETS takes only the certificates: a project holding the keyring's tool key read the activated Jung 400021SE plainly ([findings.md](findings.md#29-ets-imports-only-the-certificates-from-a-keyring)). No tool has talked to a device on the bus with an exported keyring. |
| KNX Data Secure: write (property write) | yes | hardware | Reversible property write on a real secure device. |
| KNX Data Secure: parameter flash over the secure channel | yes | hardware | On the ETS-secured Jung 400021SE (2026-09-28): one parameter changed and reverted by surgical flash through the session, 2 bytes each way, both verified. Smoke spec `jung-400021se-secure` passed in both channels on 2026-09-29, and again on 2026-10-01 against a fresh ETS commissioning after a master reset, with the GVS AMMA as a second sender on 0/0/1 (evidence records under tools/smoke/reports, local); two api runs broke off mid parameter flash on a stalled TCP stream, not the device (see Unproven). |
| KNX Data Secure: GA flash or full download | yes (System B) | hardware | The security object (group key table, per-object security flags) is loaded in the same bracket as the tables, the way ETS does it. On the ETS-secured Jung 400021SE (2026-09-28): the secured full download verified after its restart, its 158 security-object frames byte-identical to ETS's decrypted capture; a GA flash that linked a second object to the secured address set that object's flag on the device and verified, and its revert left the device equal to ETS's load again. Smoke spec `jung-400021se-secure` passed in both channels on 2026-09-29, and again on 2026-10-01 against a fresh ETS commissioning after a master reset, with the GVS AMMA as a second sender on 0/0/1 (evidence records under tools/smoke/reports, local); two api runs broke off mid parameter flash on a stalled TCP stream, not the device (see Unproven). Other memory models refuse (`SECURE_TABLES_UNSUPPORTED`). On the bus, the Jung's own secured telegram on 0/0/1 decrypts with the key the download left (2026-09-29). PID 54 (assigned senders) equal to ETS's load (dry run unchanged). Two secure devices on one secured address (2026-09-30): ETS secure-commissioned the GVS AMMA and linked it to 0/0/1 beside the Jung; imported into Busforge, the GA flash dry run of both is unchanged against what ETS loaded (the dry run compares PID 54 by address; the sequence bytes match ETS's decrypted capture in a unit test only), and a secured write from Busforge on 0/0/1 drew the GVS's secured status on it (not shown: that each device accepts the other's telegrams). Another device that only receives on a secured address is refused (`SECURE_SENDERS_UNPROVEN`), not shown. A GA flash that writes such a two-device table has not run. Each secured session records the sequence the device was seen to send, as ETS does (the Busforge-activated Jung, which had none: `0x011030` after an identify, 2026-09-30); PID 54 entries are built from it (dry run and unit test only, no such write has run). |
| KNX Data Secure: group address security mode, a key Busforge generates | yes (transfer, behaviour) | hardware | Each address carries ETS's mode ("Automatisch", "Erzwungen an", "Erzwungen aus"), imported from the `.knxproj` and editable ([knx-secure.md](knx-secure.md#group-address-security-mode)). On the GVS AMMA 1.1.203 (2026-10-02, API, isolated server): a new 0/0/2 linked to its switching object got a Busforge-generated key, the GA flash verified, and a secured GroupValueWrite on 0/0/2 from 1.1.100 switched output 1 on and off (its status came back secured on 0/0/1, `01` then `00`); restored by a second verified GA flash. **Reference: none**, no ETS capture of a Busforge-generated key. Not shown on hardware: a second secure device on the new address, a plain device turning an address plain (UI and API only). |
| KNX Data Secure: activation from the device certificate | yes | hardware | The Jung 400021SE after a physical master reset (2026-09-29): address assigned, activated from its certificate (security-mode read, switch-on and tool-key write byte-identical to ETS's capture), then a secured full download verified after its restart and read back with no drift. With a key Busforge generates, through the UI (2026-09-30, after a second master reset): a new empty project, the product placed, the address assigned by programming mode in the commission dialog, activated from the certificate in the activation dialog (key stored as provisioned before it was written, confirmed under it, security mode on), then a secured full download from the flash dialog, verified after the restart, and a new secured session read the device back with no drift. The project address of a device is changed from the device menu (the dialog checked in the browser on 2026-09-30; assigning a changed address to a device has not run). An activation interrupted between the key write and its confirmation, on hardware (2026-10-01, after a third master reset): the real activation ran with the new key stored as pending, the tunnel was cut right after the bridge confirmed the tool-key write on the bus, so the answer was lost (`DEVICE_NOT_ANSWERING`); the activation endpoint then opened a session under the pending key, reported `already-active`, marked the key provisioned, and the device identified with its security mode on. |
| Raw acquisition: read a device's identity, interface objects and planned memory without programming support | yes | hardware (read-only) | A `collect` task that sends read services only and records every answer, refusal and gap in a package ([raw-acquisition.md](raw-acquisition.md#implementation)); in the app, a cleaned diagnostic package the user consents to, reviews and saves ([raw-acquisition.md](raw-acquisition.md#diagnostic-package)). Bench: ABB US/U 4.2 and MDT BE-02001.02 plain, GVS AMMA and Jung 400021SE through their secure sessions, the GVS without its key refused after the descriptor, a cancel mid-scan kept its package (a cancel now drops it; that is shown by tests only); database unchanged apart from the task list and, after the secured runs, the devices' sequence counters. Same evening (`tools/collect.ts`): on the ABB, the MDT and the secured GVS every read without the free-key authorize ended as it did with it (outcome and length), except three GVS values that also change between two runs with it; a single read at `0xB800` (`tools/memread.ts`), outside every plan, was answered with count 0 by the ABB and the MDT. Not shown: that a package equals a Busforge read-back of the same device, a range of a plan refused by a real device, the memory of any device of a family Busforge cannot program: the house's MV-0012 interface (under its secure session) answered the descriptor, MV-0012, and the collector refused its memory step without sending it: the plan did not read the maximum APDU length, and without one Busforge allows only standard frames, which no secured memory read fits. The BCU1 plan now reads PID 56 of object 0 before its memory step; shown by tests only, the device has not been asked yet. |
| KNX IP Secure (secure tunnelling transport) | no | not implemented | Out of scope. |
| Transport: KNXnet/IP tunnelling (UDP and TCP), own implementation | yes | hardware | Connect, tunnel, management, heartbeat and closure. The connection-state heartbeat over TCP: a TCP tunnel idle for 190 s stayed up against the house's MDT KNX IP interface and against the bench bridge, which reaps a silent TCP channel after 120 s (shown with a raw client that sent nothing, dropped at 124 s). A client that vanished without a FIN (its port dropped on the bench host): the stream stayed established (nothing queued), a connect got `0x24` with the holder logged, the channel was dropped 124 s after its last frame and the next connect was served ([connections.md](connections.md)). |
| Transport: KNX USB (HID) | yes | hardware | Bus-level round trip proven on one interface model; sends are serialized because a second send clobbers the outstanding confirmation. |
| Expose a local USB interface on the network as a KNXnet/IP gateway | yes | hardware | Full downloads driven through it; a third-party tool (ETS) can also program a device through it. Management works only on the interface's own address on the USB stick tested. |
| Bus monitor: live telegrams, DPT-decoded values, group-address names | yes | hardware | Read-only: decoded live telegrams off a real installation bus. |
| Bus monitor: secured group telegrams (KNX Data Secure) | yes | hardware | Decrypted with the imported project's group keys; no key, failed authentication, a sequence already seen and undecodable frames are shown as such, never as a value. On the Jung 400021SE (2026-09-29): its K1 contact's secured telegrams on 0/0/1 decrypted to the toggle its parameters describe (On, Off, On), shown as "no key" without a value under a project without the key. Cipher also covered by xknx's known-answer vectors. Failed authentication and replay shown by tests only; not compared with the ETS group monitor. |
| KNX Data Secure: sending secured group telegrams, assigned senders | yes | hardware | Senders imported from the `.knxproj` (BusInterface connectors) or added in the group-address overlay, loaded into PID 54 by the GA flash. On the Jung 400021SE (2026-09-29): a secured GroupValueRead from the monitor's send panel (1.1.100) answered with a secured response, both decrypted; with the sender removed and flashed the Jung ignored it and Busforge refused to send. The smoke spec's `securedOutput` behaviour repeats the secured read every run (both channels, 2026-09-29). |
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
| GVS K-BUS AMMA-04/06.S multifunction actuator | MV-07B0 | relative | hardware | hardware | hardware | hardware, from virgin, survives a bus power cycle | hardware: the switch object drives the status object (again 2026-10-06 with the declared PID 67 write, api channel) |
| Jung 400021SE Tasterschnittstelle 2fach Secure | MV-07B0 | relative, module device, parameter segment above 64 KB | hardware | hardware | hardware | hardware, from factory; survives a restart since the memory-control-block fix (see below) | hardware: a surgically flashed link answers a read |
| OpenKNX RaumController (AB-SmartHouse AB-PRE) | MV-07B0 | relative | hardware | hardware, one parameter on the house unit, `verified` after the restart (see below) | hardware, one link added and removed on the house unit, each `verified` after the restart, the added link answered a group read (see below) | hardware, from factory **and onto a device running its application** (three downloads, each `verified`), application runs and survives a bus power cycle | hardware: in service in a real installation, driving light, fan and temperature |
| MEAN WELL KNX power supply (M-0162) | MV-07B0 | relative | hardware | hardware | not proven | not proven | hardware: the cyclic-send interval change took effect on the bus |
| Theben HMG 6T (M-0048) | MV-07B0 | relative, module device | hardware | hardware, module-instance parameter | not proven | not proven | not proven |
| Theben DALI gateway (M-0048) | MV-07B0 | relative | not proven (see below) | not proven | not proven | not proven | not proven |
| Auro presence detector (M-0081) | MV-0705 | absolute | hardware | hardware, on the house unit 1.1.x through the logging proxy, bracket and changed byte equal to ETS's partial download of `M-0081_A-FE01`, the unit's segment stamp equal to the one after ETS's download (see below) | hardware, add and remove on 1.1.x with the declared-order plan (tables unloaded and re-declared, as ETS's partial download), wire and stamps equal to ETS's (see below); unlinking and relinking the transmit-only object 9 clears and sets its linked bit as ETS's captured downloads do, written bytes and reads equal to ETS's | hardware, `M-0081_A-FE01` onto the house unit 1.1.x holding the application, declared order with `LdCtrlTaskCtrl1`; 151 bytes, all equal to the unit as ETS had left it, read after the restart equal to the reference: the sequence was accepted and the unit stayed loaded and answering, but no byte changed, so the transfer of changed bytes is shown by the two flashes, not by the full download (see below) | hardware: the unit answered a group read after the full download, after the parameter flash to LED = 0 and after the GA flash adding an address (on that address too); after the GA revert the removed address no longer answered and 5/3/9 did (all five writes repeated on 35ae113 with a group read after LED = 1 too); 5/3/9 answered after unlinking and relinking object 9 too, and object 9 (transmit only) sent on the address the flash had linked it to, from a unit that held no association of it before; that the bit alone decides it is not shown |
| Steinel presence detector (M-008E) | MV-0705 | absolute, data-less segment | hardware | hardware | not proven | refused (`LdCtrlTaskCtrl1`, see below) | not proven |
| Gira Tastsensor 3 (M-0008) | MV-0705 | absolute, dynamic tables | hardware | hardware, on the house unit 1.1.x through the logging proxy: ETS's bracket and the changed byte with ETS's value, the unit's segment stamp equal to the one after ETS's download (see below) | hardware, add and remove on 1.1.x: tables re-declared as ETS's partial download, exactly the bytes of ETS's image, wire equal to ETS's byte for byte, stamps equal to ETS's (see below) | hardware, onto the house unit holding the application; exactly the 822 bytes of ETS's image, shown on the wire (see below) | hardware: the unit answers a group read on object 64 after the download and after each flash; the new association of the GA flash not observed (object 4 has no read flag) |
| Theben TheLuxa P300 (M-0048, MV-0705 product) | MV-0705 | absolute, dynamic tables | hardware | hardware, on the house unit 1.1.x through the logging proxy: ETS's bracket, the changed byte and the download marker with ETS's values (see below) | hardware, add and remove on 1.1.x: tables re-declared as ETS's partial download, wire equal to ETS's byte for byte (see below) | hardware, `M-0048_A-107E-12-5B58` onto the house unit holding the application, declared order with `LdCtrlTaskCtrl1` (Address 17875, Count 1); exactly the 1090 bytes of ETS's image, wire equal to ETS's; every byte but the download marker already equal to the unit, so the transfer of changed bytes is shown by the two flashes (see below) | hardware: the unit answered a group read after each of the five writes; the address the GA flash added answered, and no longer after its removal |
| Theben Meteodata 140 S (M-0048, MV-0701 product) | MV-0701 | absolute, dynamic tables, memory-mapped load-state machines | hardware | hardware, on the house unit 1.1.x through the logging proxy: ETS's bracket over `0x0104`, the changed byte and the download marker, wire equal to ETS's (see below) | hardware, add and remove on 1.1.x: tables re-declared as ETS's partial download, every byte ETS wrote equal (see below) | hardware, `M-0048_A-140C-14-EB70` onto the house unit holding the application, declared order with `LdCtrlTaskCtrl1` (Address 18155, Count 1) over `0x0104`; exactly the 1893 bytes of ETS's image; every byte but the download marker already equal to the unit, so the transfer of changed bytes is shown by the two flashes (see below) | hardware: the unit answered group reads after each write; the address the GA flash added answered, and no longer after its removal |
| MDT IP Interface/Router (KNX Data Secure) | MV-07B0 in the product data, opaque on the bus (`0xFFFF` to plain reads) | relative (product data); none exposed plainly | hardware, secure identify only | not proven | not proven; planned with its security object where a tool key is on file | refused (`FULL_DOWNLOAD_TUNNELING_ENTRIES`: its tunnelling entries are not written, see below) | not proven |
| MDT IP Interface Secure (KNX Data Secure) | MV-0012 in the product data, opaque on the bus (`0xFFFF` to plain reads) | System 1, not implemented | hardware, secure identify and a collector package (descriptor only, memory not read) | refused (`DEVICE_FAMILY_UNSUPPORTED`) | refused (`DEVICE_FAMILY_UNSUPPORTED`) | refused (`FULL_DOWNLOAD_UNSUPPORTED`) | not proven |

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
  download is byte-equal to the ETS one (2026-09-25 capture, `captures/` of the [private corpus](testing.md#the-private-corpus)).
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
- **Gira M-0008**: ETS 6 was captured running its full, parameter and group-address download on the
  house unit 1.1.x. It does not send the declared procedure step by step: it re-declares
  the address and association tables at their built size, one behind the other, leaves the loaded
  application in place, sends no `LdCtrlTaskCtrl1`, and reads the PID 27 stamps for the declared
  `LdCtrlLoadImageProp` ([load-procedures.md](load-procedures.md#ets-captured-system-7-downloads)).
  Busforge's three writes send the same sequences; every byte ETS wrote in the captures matches
  Busforge's image (`tools/etsdiff.test.ts`; for the parameter bytes the configuration is decoded
  from ETS's own image, see [load-procedures.md](load-procedures.md#ets-captured-system-7-downloads)),
  object 64's config byte included, whose read flag the house project sets on the unit and Busforge
  imports ([owned-products.md](owned-products.md#the-named-leads)).
  **Full download, hardware (house unit 1.1.x, record):**
  Busforge writes the bytes of ETS's image and no others: the tables to their built length without
  the own address, the com-object table's 91 entries, and of the application's data segments the
  bytes a parameter covers, since ETS leaves the application loaded
  ([load-procedures.md](load-procedures.md#which-bytes-ets-writes)); `tools/etsdiff.test.ts` fails on
  any byte outside that image. Before the write every one of the 822 planned bytes equalled a read of
  the unit, which ETS had programmed (reference). The download went through the logging proxy: on the
  wire it wrote exactly those 822 bytes, value for value the image ETS's log dumps for its revert. It
  ended `flashed`, `verified` (transfer); the read after its restart equals the reference, 191 of 191
  records (persistence after the download's own restart, no bus power cycle); 1.1.x answered a group
  read on object 64's address afterwards (behaviour: the unit still acts; no byte changed). The first
  run (record), wrote whole
  segments, 90 bytes more (the 80 and 8 above and the own address); the planner no longer builds that image.
  **Parameter and group-address flash, hardware (house unit 1.1.x, record):**
  the parameter ETS changed in its capture (the status LED's on-time, 3 s → 4 s → 3 s) and the link
  it added (object 4 to 15/7/250, then removed), each through the logging proxy. The parameter flash
  sends ETS's bracket with the one changed byte (ETS also writes held bytes, above); the
  group-address flash writes the bytes of ETS's image of its group-address download and no others
  (405 adding, 401 removing; the own address and the com-object segment's 8 bytes behind its table
  left out, as ETS leaves them), and its wire equals ETS's group-address download and the table part
  of its revert byte for byte (reference). Each ended `flashed`, `verified` (transfer); after each
  write's restart the unit's PID 27 stamps equal those it reported after ETS's own download of the
  corresponding change (its parameter and group-address downloads, its revert for the two writes
  back), and the last read equals the reference, 191 of 191 records (persistence after the
  restart, no bus power cycle); 1.1.x answered a group read on object 64 after each (behaviour: the
  unit still acts; the association to 15/7/250 itself is not observable by a read, object 4 has no
  read flag). The full download
  is refused onto a unit that does not hold the application with load-state machines 1, 2 and 3
  loaded (`FULL_DOWNLOAD_APPLICATION_NOT_LOADED`): no capture shows that case. Not a smoke run, so the compatibility matrix does not count it.
- **Auro M-0081_A-FE01**: ETS 6 was captured running its full download, a parameter download, a
  group-address download (a second address on object 10) and the revert of both on the house unit
  1.1.x: the declared steps in their declared order, its `LdCtrlTaskCtrl1` (Address 0,
  Count 0) a PID 5 write of zeros
  ([load-procedures.md](load-procedures.md#declared-order-system-7-downloads)). Busforge's full
  download plans the same steps and writes exactly ETS's bytes; its parameter flash runs ETS's
  bracket and writes the changed byte with ETS's value (ETS writes every parameter byte); its
  group-address flash runs ETS's sequence: both tables unloaded, declared again as PID 5 writes,
  written without the own address, the com-object table whole. All three are pinned against the
  captures in `tools/etsdiff.test.ts` (the parameter values decoded from ETS's image, the house
  project is not in the corpus).
  **Hardware (house unit 1.1.x, record):** after ETS's captured downloads, Busforge
  ran a full download, a parameter flash ("led feedback" 1 to 0 and back) and a group-address flash
  (15/7/250 added to object 10 and removed again), each `verified`. Before the full download every
  one of its 151 planned bytes equalled the unit as ETS had left it, and the plan's image digest
  equals the server's dry run; so the full download shows its sequence (unload, the PID 5
  declarations, `LdCtrlTaskCtrl1`, `LoadCompleted`, the restart) accepted, with the unit loaded and
  answering afterwards, but no changed byte: the transfer of changed bytes is shown by the two
  flashes, not by the full download; the parameter and group-address flash went
  through the logging proxy, and their wire equals ETS's partial downloads (verify mode, and the
  unchanged bytes ETS writes too, aside); after the parameter change the unit's own PID 27 stamp of
  the parameter segment equals the one it showed after ETS's download of the same value, and after
  the added address the tables and the stamps of objects 1 and 2 equal those after ETS's
  group-address download. Behaviour: a group read on 5/3/9 (object 10) was answered after the full
  download, after the parameter flash to LED = 0 and after the added address, where one on 15/7/250
  was answered too; after the address was removed again, 15/7/250 no longer answered and 5/3/9 did.
  A second pass of all five writes on the committed build 35ae113, with the pre-flight and verify checks of that build, gave the same results and had a group read after LED = 1 too (record, "Second pass on 35ae113"). The final
  read equals the reference, stamps included. Persistence is the restart each write ends with; no
  bus power cycle, and no wire capture of the full download. The earlier group-address plan's run on
  1.1.x (no unload or declaration) is superseded. A table that shrinks leaves its old bytes behind
  it, in ETS's downloads and in Busforge's; on this unit `7F FA` and `03 0A`, left by ETS's revert,
  stay behind the tables, and the stamps cover them; Busforge, as ETS, writes nothing beyond a table
  ([load-procedures.md](load-procedures.md#tables-shrink-their-old-bytes-stay)). The full download is refused onto a unit that does not hold the
  application with load-state machines 1, 2 and 3 loaded (`FULL_DOWNLOAD_APPLICATION_NOT_LOADED`):
  no capture shows that case. Not a
  smoke run, so the compatibility matrix does not count it.
  **The linked bit (house unit 1.1.x, record):**
  ETS 6 was captured removing the only address of object 9 (`trigger`: transmit flag, no read flag)
  and adding it back, each a partial download: the config byte `0x47` → `0x43` → `0x47`, the rest of
  the com-object table unchanged. Busforge's group-address flash plans both exactly
  (`tools/etsdiff.test.ts`) and then ran both on the unit, `verified`: the same sequence and the same
  bytes written, in the same load-state sequence, as ETS's (ETS's verify-mode switch and Busforge's read-backs aside), and
  each read afterwards equal to the read after ETS's download of the same links, stamps included.
  The unit answered a group read on 5/3/9 after each.
  After the flash relinked it (the unit held no association of it before), object 9 sent its trigger on that address (`GroupValue_Write` 1 on 5/2/6, the first transmit a passive listener logged, record); silence while unlinked was not observed, so this shows the relinked object working, not that the bit alone decides it.
- **Theben TheLuxa P300 `M-0048_A-107E-12-5B58`**: ETS 6 was captured running its full download, a
  parameter download, a group-address download (the unlinked object 16 to 15/7/250) and the revert of
  both on the house unit 1.1.x: the declared full steps in their declared order, its
  `LdCtrlTaskCtrl1` the PID 5 write `03 04 45 D3 01` and zeros, and the two table segments re-declared
  as one region, as on the Gira ([load-procedures.md](load-procedures.md#the-theluxa-p300)). Busforge's
  three plans equal the captures (`tools/etsdiff.test.ts`). The com-object table writes object 116's
  update flag in config bit `0x80`, as ETS does; that bit is set for this application only
  ([roadmap.md](roadmap.md)).
  **Hardware (house unit 1.1.x, record):**
  Busforge's full download, its parameter flash (temperature calibration 0 → 1 → 0) and its
  group-address flash (object 16 to 15/7/250 and back), each through the logging proxy and `verified`
  (the full download and the group-address flash with the tables' references, PID 7, checked after
  the restart). On the wire each equals ETS's capture: the full download's 1090 bytes and its 18
  load-state writes, `TaskCtrl1` included; the group-address flash's 489 and 485 bytes; the parameter
  flash's bracket, where ETS also writes the unchanged parameter bytes. Of the full download's bytes
  only the download marker `0x4800` differed from the unit (`Access="None"`, written `AA`, cleared by
  the unit), so it shows the sequence accepted and the bytes equal, not changed configuration bytes
  transferred; the flashes show that. Behaviour: a group read on object 6's address was answered after
  each write, 15/7/250 answered after the link was added (object 16 has the read flag) and no longer
  after its removal. The final read equals the reference (the read after ETS's revert), 184 of 184,
  stamps included; the three bytes ETS's revert leaves behind the shrunk association table stay, as
  after ETS's. Persistence is the restart each write ends with; no bus power cycle. The full download
  is refused onto a unit that does not hold the application with load-state machines 1, 2 and 3 loaded,
  and for any other `TaskCtrl1` form. Not a smoke run, so the compatibility matrix does not count it.
- **Theben Meteodata 140 S `M-0048_A-140C-14-EB70`** (MV-0701, memory-mapped): ETS 6 was captured
  running its full download, a parameter download, a group-address download (the unlinked object 23 to
  15/7/250) and the revert of both on the house unit 1.1.x: the TheLuxa's procedure, every
  load control the memory write to `0x0104`, its `LdCtrlTaskCtrl1` `33 04 00 46 EB 01` and zeros, the
  tables re-declared as one region ([load-procedures.md](load-procedures.md#the-meteodata-140-s-memory-mapped)).
  ETS reads its image and writes only the bytes that differ; Busforge writes the whole image and reads
  it back. Busforge's full download and group-address flash equal ETS's logged images byte for byte, its
  parameter flash the two bytes ETS wrote (`tools/etsdiff.test.ts`).
  **Hardware (house unit 1.1.x, record):**
  Busforge's full download, its parameter flash (temperature calibration 0 → 1 → 0) and its
  group-address flash (object 23 to 15/7/250 and back), each through the logging proxy and `verified`.
  On the wire each runs ETS's load-control sequence exactly (19 `0x0104` writes and the restart for the
  full download, 2 for the parameter flash, 12 for each group-address flash), and every byte ETS wrote Busforge wrote with the
  same value; the parameter flash wrote the same two bytes as ETS. Of the full download's 1893 bytes only
  the download marker `0x4800` differed from the unit, so it shows the sequence accepted and the bytes
  equal; the flashes show changed bytes transferred. Behaviour: group reads were answered after each
  write, 15/7/250 answered after the link was added (`00403c93`, as after ETS's) and no longer after
  its removal. The final read equals the reference (the read after ETS's revert), 260 of 260 records,
  stamps and the table residue included; the manufacturer object's runtime values (date, time, counters)
  differ as after every restart. Persistence is the restart each write ends with; no bus power cycle.
  Its seven channel-level objects (0-4, 6, 15), linked in the project, reach Busforge's tables since the
  configuration view lists them (findings.md §33). Not a smoke run.
- **Full download on the System 7 applications declaring `LdCtrlTaskCtrl1`** (in the catalogue Steinel
  M-008E and the second Auro application `M-0081_A-FF31`; not the Gira M-0008, the Auro M-0081_A-FE01,
  the TheLuxa P300 nor the Meteodata 140 S, above) is refused before any write:
  their procedures declare `LdCtrlTaskCtrl1`, which the full download executes only in the form
  each captured application's own capture shows ([load-procedures.md](load-procedures.md#coverage-across-the-catalogue)).
  It is not offered either: the device page names the reason, the compatibility matrix shows it
  `refused`. A unit never verified since it was placed or replaced is refused on the surgical flashes
  too, naming ETS (`NEVER_PROGRAMMED_USE_ETS`): no application check precedes them on these
  applications ([owned-products.md](owned-products.md)).
- **MDT IP interfaces**: the IP Interface/Router application is System B and Data Secure, so the
  group-address flash plans it with its security object when the project holds its tool key, and
  plain without one; it has not run on it. Its tunnelling addresses (`AdditionalAddresses`,
  `MaxTunnelingUserEntries="4"`) are not written by any Busforge path, and what a download without
  them does to the interface's tunnels is not established, so the full download of any application
  declaring tunnelling entries is refused before any bus traffic (`FULL_DOWNLOAD_TUNNELING_ENTRIES`,
  unit- and route-tested offline) and not offered; the parameter and group-address flash stay
  ([owned-products.md](owned-products.md)).
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

**The done bar** ([/GLOSSARY.md](../GLOSSARY.md)): a device counts as fully supported only when
every capability its product claims, plus provisioning and the UI click-through, passes on real
hardware in **both** channels, together with every behaviour its spec declares. One green channel
is not done, and neither is a device that byte-verifies without ever acting on the bus, unless its
spec states why no behaviour is observable.

| Spec | Product | Mask | `api` | `ui` | Persistence (restart) | Done bar |
|---|---|---|---|---|---|---|
| `gvs-amma` | GVS K-BUS AMMA-04/06.S multifunction actuator, in KNX Data Secure mode since 2026-09-30 | MV-07B0 | hardware | hardware | hardware, both channels | **met** (2026-10-03, secured, imported from the ETS project; its behaviour plain, on Output 2); api channel passed again 2026-10-06 with the declared PID 67 write, ui channel not rerun |
| `mdt-be02001` | MDT BE-02001.02 universal interface 2-fold | MV-0705 | hardware | hardware | hardware, both channels | **met** |
| `abb-usu-4.2` | ABB US/U 4.2 universal interface | MV-0701 | hardware | hardware | hardware, both channels | **met**, to the byte only |
| `jung-400021se` | Jung 400021SE Tasterschnittstelle 2fach Secure | MV-07B0 | hardware | hardware | hardware, both channels | **met** (before the device went secure, 2026-09-27) |
| `jung-400021se-secure` | the same Jung, in KNX Data Secure mode | MV-07B0 | hardware | hardware | hardware, both channels | **met** (2026-09-29 and 2026-10-03, plus robustness refusals and restore) |
| `openknx-raumcontroller` | OpenKNX RaumController (AB-SmartHouse AB-PRE) | MV-07B0 | not proven | not proven | not proven | **not met** |

All four devices pass both channels, every capability, their behaviour and the persistence step
on build `50d6b80` (2026-09-27), which writes partial downloads the way ETS does (System B owned
bytes with the idle unions' defaults, memory-mapped System 7 differing table bytes only) on top of
the ETS-matched group-address flash, per-bit parameter ownership and the confirmed extended write.
Those runs, and the earlier ones they supersede (2026-09-25: MDT `c2cde85`, Jung `7c54b8d`, ABB and
GVS `c935d5f`; 2026-09-26: Jung `bf97acc`, all four on `1de6231`), are kept with their evidence records in evidence/runs/. Persistence there means an observed reboot
after A_Restart, every load object LOADED again, and a read-back equal to the project; it is not a
bus power cut ([evidence-contract.md](evidence-contract.md)).

On build `7933bb2` (2026-10-03, run from the bench host next to the bench bridge) all four bench devices
pass again in both channels: MDT, ABB, the Jung in secure mode and the GVS AMMA, now also secured,
with every capability, behaviour, persistence and, on the two secure devices, the robustness checks
and the restore (the GVS runs at 21:30 and 21:47 UTC, after the check below was added). These runs give the structural flash its first kept records (Jung and MDT, both
channels), so [compatibility.md](compatibility.md) shows it tested there. The first Jung runs of
that day failed only their plain behaviour, a runner fault (its fresh address was secured, the
witness read it plain); the passing runs supersede those records with that reason. On the GVS the
right tool key straight after a wrong one goes unanswered once and is answered on the next Sync
([findings.md](findings.md) §30); its spec declares that (`secondSyncAfterWrongKey`), and the check
records the silent first Sync and the answered second one as two results. The two GVS runs before
that failed this check only (their reports were not kept). Reports and records in `docs/evidence/runs/2026-10-03/`.

On the working tree on `8459f7a` with the closing PID 67 write (2026-10-06, the records name it
`8459f7a-dirty`), the GVS AMMA passed the api channel again, secured: every capability, behaviour,
persistence, the robustness checks and the restore, with each of its ten writes ending in object 4
PID 67 = `01`, echoed (trace next to the report in `docs/evidence/runs/2026-10-06/`). The ui channel
was not rerun.

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
  captures in the private corpus, records in [evidence/reference/](evidence/reference/)). The Jung
  400021SE (module device) as well. For the parameter flash one ETS partial download of the Jung
  exists: it writes the two MCB regions after the allocation, as Busforge's parameter flash does,
  and its parameter bytes match Busforge's image. For the group-address flash one ETS partial
  download per bench device exists (links plus, on the ABB, GVS and Jung, a parameter
  change): every byte ETS wrote, group tables and com-object table included, equals Busforge's
  image for that configuration (`tools/etsdiff.test.ts`, captures in the private corpus, records per
  flash operation `*-partial-links.json` in [evidence/reference/](evidence/reference/)). Everywhere else the read-back proves `device == our image` and can never prove
  `our image == ETS`. That blind spot has hidden a codec bug and the `LegacyPatchAlways` bug.
- **System 7 group-address flash of the com-object table.** It reads the table the device holds
  and changes only each object's linked bit; ETS rewrites that bit on a group-address download on
  both LSM styles (MDT and ABB partial-download captures). On a device holding a correct table
  that equals ETS's bytes; on one whose table another tool left wrong, the other bytes stay wrong.
  On the M-0081 (house unit 1.1.x) ETS's and Busforge's group-address downloads clear
  and set the bit of the transmit-only object 9 with the same bytes (notes above). A freshly linked read-capable object was proven to work on hardware, and so was
  a **transmit-only object** linked by a GA flash alone (MDT BE-02001, see
  [findings.md](findings.md) §7), and on the M-0081 a transmit-only object relinked by a GA flash sent on its address (house unit 1.1.x; its silence while unlinked not observed); on the memory-mapped ABB the latter is not shown. A property-mapped application that names no com-object table segment keeps the device's
  table; a memory-mapped one is refused.
- **KNX Data Secure is shown on two devices.** The smoke spec `jung-400021se-secure` (both channels,
 ) covers the secured full download, parameter and GA flash, read-back, persistence, a
  secured and a plain behaviour, the robustness refusals and a restore to the ETS project; all on the
  Jung 400021SE. Two api runs broke off in a parameter flash (same seed);
  the second was captured: the TCP stream between the bench bridge and the Mac stalled on the Wi-Fi
  path, not the device ([findings.md](findings.md) §25); the same seed then passed. An interrupted
  flash does not recover the device by itself: on the MDT BE-02001.02 (UI, the server's
  socket to the bridge killed in the write phase) the task failed `FLASH_INTERRUPTED_UNLOADED`, the
  flash dialog offered the full download, and that download through the dialog verified
  ([findings.md](findings.md) §31, one cut point). On a second Data Secure device, the GVS AMMA
  (both channels), the secured full download, parameter and GA flash, read-back,
  persistence, the robustness refusals and the restore pass; its behaviour is checked in plain only,
  a secured behaviour is shown on the Jung alone.
- **The GVS AMMA's closing PID 67 write.** Its application declares a write of `01` to object 4
  PID 67 for every download (`AppliesTo="all"`), which ETS sends after the last LoadCompleted;
  Busforge omitted it in every GVS run up to. The full download, parameter flash and
  group-address flash now end with it in ETS's place and refuse on a wrong echo
  ([load-procedures.md](load-procedures.md#closing-property-writes-run-because-ets-was-captured-sending-them));
  the order equals both ETS captures (`tools/etsdiff.test.ts`). On the bench device (smoke
  `gvs-amma` api, secured) all ten writes, in six full downloads, two parameter flashes and two
  group-address flashes, came back `01`, and the run passed behaviour, persistence and restore
  (evidence/runs/, with a trace of each write). Not shown:
  what the property does in the device (a read of it answers with no element, right before and right after the run, probe kept with the trace), the
  ui channel with the write, and the group-address flash's write against a links-only ETS capture
  (none exists; it is inferred from the declaration and ETS's partial download). Other applications
  that declare the same write without a capture of their own are refused every write.
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
