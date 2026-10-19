# Status

What Busforge can do, and how far each claim is proven. Every other document links here instead
of repeating a verification claim. The per-Product, per-operation matrix computed from the kept
evidence records is [compatibility.md](compatibility.md) (generated); the app shows the same states
in each device's compatibility badge.

The bar: a claim says **what was shown on a real device**, on the axes of the
[evidence contract](evidence-contract.md): transfer, reference, behaviour, persistence. "The tests
are green" is none of them, and a read-back of our own bytes is transfer only. A capability that
only builds plausible bytes is listed as unproven, and an unimplemented path refuses with a coded
error rather than guessing.

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
| **refused by policy** | Implemented, but a guard blocks the path, so it cannot be driven at all. Different from *not implemented* (there is nothing to drive) and from *not proven* (it could be driven, and never was). |
| **not implemented** | Refused with a coded error. |

The **Implemented** column of the capability table is a separate axis: `yes`, `partial`,
`wired` (every part exists and the route is reachable, but the composition has never been
driven), `code-shared` (the same code as a proven path, on an unexercised medium) or `no`.

All hardware verification is on **twisted pair**.

## Capabilities

| Capability | Implemented | Proven | Note |
|---|---|---|---|
| Import a `.knxproj` (ETS 5/6, AES) and a manufacturer `.knxprod` catalog | yes | real input files | Own ZIP + WinZip-AES + XML implementation. Nothing that cannot be rendered is dropped silently; it is surfaced as a visible "not supported" marker. |
| Render and edit a device configuration (parameters, channels, modules, i18n) | yes | hardware | Click-through against the device's own read-back on four products (see the device table). Several group addresses per com-object, with the sending address chosen on the page: browser and route tests; the table order is ETS's two captures of such links (see [Known unproven](#known-unproven)). The flags shown are the application's with the project's own laid over them. Editing an object's flags and priority: browser and route tests; the group-address flash writes an edit with the bytes ETS's group-address download wrote for one on the MDT BE-02001.02 and the Jung 400021SE (capture comparison), not run by Busforge on a device (see [Known unproven](#known-unproven)). |
| Read parameters back from a device | yes | hardware | Both memory models (relative/System B, absolute/System 7). |
| Read group-address links back from a device | yes | hardware | Both memory models. |
| Flash parameters (surgical) | yes | hardware | Change applied and reverted, byte-checked each way, on both memory models and on module/channel devices. Writes the bytes ETS's parameter download writes: on a property-mapped System 7 mask every byte a parameter covers, on a memory-mapped one the bytes that differ from the unit ([load-procedures.md](load-procedures.md#the-rules-by-level)); on System B every owned byte. |
| Flash group addresses (surgical) | yes | hardware | System B rewrites the com-object table, and on the one manufacturer shown to need it also holds the application object in its own load bracket. System 7, in both LSM styles, sets each object's linked bit in the table the device holds, as ETS does, where the application names its segment (see [Known unproven](#known-unproven)). On System 7 both tables are unloaded and declared where ETS puts them, by rule ([load-procedures.md](load-procedures.md#the-rules-by-level)); shown on hardware on the Auro M-0081_A-FE01, the Gira M-0008, the Theben TheLuxa P300, the Theben Meteodata 140 S, the ABB US/U 4.2 and the MDT BE-02001.02 (device notes and smoke specs below). |
| Full download / first-time commissioning without ETS | yes | hardware | Proven on System B (relative) and on both System 7 LSM styles: memory-mapped (MV-0701) and property-mapped (MV-0705). Authors the com-object table on System B and, where the application names its segment, on both System 7 LSM styles: the manufacturer's template with the active objects' config bytes and link bits. The form follows the catalogue: the declared procedure in its order (`LdCtrlTaskCtrl1` encoded from its attributes), or ETS's partial form on a unit holding an application that declares `PreferPartialDownloadIfApplicationLoaded` ([load-procedures.md](load-procedures.md#the-rules-by-level)). On the Gira M-0008, the Auro M-0081_A-FE01, the Theben TheLuxa P300 and the Theben Meteodata 140 S it ran only onto a unit already holding the application, so not as first-time commissioning, and the hardware proof is the sequence and the bytes: every planned byte already equalled the unit (on the two Theben devices all but a download marker the unit clears itself), so no changed configuration byte was transferred by a full download; the parameter and group-address flash on the same units show that (device notes below). |
| Individual-address assignment via programming mode | yes | hardware | Refuses unless exactly one device is in programming mode and the target address is free; the result is proven by talking to the device on its new address. |
| Individual-address assignment by serial number (no button press) | yes | hardware | The path used to commission a factory device that cannot be reached physically. |
| Structural change (a parameter that changes the set of com-objects) | yes | hardware (Jung 400021SE, MDT BE-02001.02, Theben TheLuxa P300, Theben JMG 4 T, Theben DALI gateway, MDT BE-06001.02, see the note); reference only elsewhere | Written as a structural flash: parameters, the com-object table authored for the new configuration and links, and the group tables, in one bracket set and one restart, as ETS's partial download writes such a change ([load-procedures.md](load-procedures.md#structural-flash), [findings.md](findings.md) §28). Offered by the family's rule wherever the full download can be built, off on the GVS and thelsing/OpenKNX firmware; its plan is tested against ETS's captures of such a download on the Jung 400021SE and the MDT BE-02001.02 (a change that reshapes the com-object set), and the Auro M-0081_A-FE01, the Gira M-0008, the Theben TheLuxa P300, the Theben Meteodata 140 S, the Theben MIX 2, the Theben DALI-Gateway KNX plus and the MDT BE-06001.02 (the revert of a parameter and a link change), and the ABB US/U 4.2 (a parameter and a link change, read and compared as ETS writes it); on the MEAN WELL power supply it is offered by the rule without a capture. On the Jung and the MDT BE-02001.02 the smoke spec's structural change and its revert passed in both channels, verified after the restart and read back without drift: the Jung in Data Secure mode with ETS's closing steps and confirmed restart, the MDT with ETS's table unload and declarations. On the Theben TheLuxa P300, the Theben JMG 4 T (MIX 2), the Theben DALI gateway and the MDT BE-06001.02 a structural change (a parameter that adds an object, and a link of that object) and its revert ran on a unit, each verified, ETS's step sequence on the wire (device notes below). On the Auro, the Gira, the Meteodata, the ABB US/U 4.2, the other two MIX 2 products: capture-tested only, never run. Every other device gets the full download (`COM_OBJECT_TABLE_STALE_USE_DOWNLOAD`, or `COM_OBJECT_TABLE_STALE` without a full-download path), and the System 7 applications whose full download is refused get `COM_OBJECT_TABLE_STALE_USE_ETS` ([load-procedures.md](load-procedures.md#coverage-across-the-catalogue)). |
| Reach a segment above 64 KB (`A_MemoryExtended`) | yes | hardware | Reads auto-select it when a range exceeds `0xFFFF`. Writes use it, confirmed chunk by chunk, where the application declares `SupportsExtendedMemoryServices` and the device declares `PID_MAX_APDU_LENGTH`, as ETS does ([device-memory-model.md](device-memory-model.md)). An address past 24 bits is refused (`MEMORY_ADDRESS_TOO_HIGH`) rather than truncated. |
| KNX Data Secure: read (descriptor, property, serial, security mode) | yes | hardware | Own AES-128-CCM; tool keys come from the project file. The Jung 400021SE, secure-commissioned by ETS, reads back in full (parameters and links equal to the ETS project) and reports its security mode as on. Without a key on file `secure-identify` reads plainly: a device whose Secure was never activated states its security mode off (shown on the GVS AMMA before its activation); devices that stay silent or close the connection are reported as unreadable, not as off. The Jung in secure mode refuses a plain read with access denied (`0xFC`, shown with a raw probe); Busforge's handling of that refusal and the not-activated verdict on a device whose stored key gets no Sync answer (`SECURE_MODE_OFF`) are tested against a simulated device only. Every secured frame of ETS's captured commissioning of the Jung decrypts with Busforge's CCM ([knx-secure.md](knx-secure.md#the-ets-reference-capture)). |
| KNX Data Secure: tool key deposited by hand | yes | hardware | Stored (source `manual`) only after the device answered a secure Sync under it ([knx-secure.md](knx-secure.md#the-key-store)). On the Jung 400021SE through the API: a random key refused (`SECURE_SYNC_NO_RESPONSE`, the entry on file unchanged), a missing serial refused before the bus (`TOOL_KEY_SERIAL_MISSING`), a wrong serial refused by the device's silence, the right key stored and a session opened under it. Through the device menu's dialog: a random key shown as refused, then the right key stored. The refusal of a factory key (security mode off) and of a serial the device reports differently are tested against a stubbed identification only. |
| KNX Data Secure: flag a device whose security object no longer matches | yes | hardware (bytes only) | A fingerprint of the security object, recorded by each verified GA flash, full download or structural flash (not adopted at ETS import, so every imported secure device starts unknown), is compared on every project read; a key, sender or peer change shows as "Security changed", no or an undecidable fingerprint as "Security unknown" ([knx-secure.md](knx-secure.md#security-object-baseline)). On the Jung 400021SE: a GA flash that found tables and security object matching cleared the flag; a sender added and removed through the API set and cleared it. A peer linking a transmitting object or changing its address: route tests only. |
| KNX Data Secure: keyring export (`.knxkeys`) for other tools | yes | real input files (the exported file read by ETS 6 and xknx; no device) | The project's tool keys, sequence numbers, certificates, group keys and senders as an ETS keyring ([knx-secure.md](knx-secure.md#keyring-export)). ETS 6 imports the file but takes only the certificates ([findings.md](findings.md#29-ets-imports-only-the-certificates-from-a-keyring)); xknx loads its signature, keys and sequence numbers and sets up Data Secure from it. No tool has talked to a device on the bus with an exported keyring. |
| KNX Data Secure: write (property write) | yes | hardware | Reversible property write on a real secure device. |
| KNX Data Secure: parameter flash over the secure channel | yes | hardware | On the Jung 400021SE and the GVS AMMA, each secure-commissioned by ETS: change and revert verified; the secure smoke specs pass in both channels. |
| KNX Data Secure: GA flash or full download | yes (System B) | hardware | The security object (group key table, per-object security flags, assigned senders) is loaded in the same bracket as the tables, the way ETS does it. On the Jung 400021SE: the secured full download verified after its restart, its security-object frames byte-identical to ETS's decrypted capture; a GA flash that linked a second object to a secured address set that object's flag and verified, and its revert left the device equal to ETS's load. PID 54 (assigned senders) equal to ETS's load (dry run unchanged). With a second secure device (GVS AMMA) on the same secured address, as ETS commissioned both, the GA flash dry run of each is unchanged against ETS's load (the dry run compares PID 54 by address; the sequence bytes match ETS's decrypted capture in a unit test only), and a secured write from Busforge drew the GVS's secured status (not shown: that each device accepts the other's telegrams; a GA flash writing such a two-device table has not run). PID 54 entries built from the sequence a device was seen to send: dry run and unit test only. A further device that only receives on a secured address is refused (`SECURE_SENDERS_UNPROVEN`), not shown on hardware. Other memory models refuse (`SECURE_TABLES_UNSUPPORTED`). |
| KNX Data Secure: group address security mode, a key Busforge generates | yes (transfer, behaviour) | hardware | Each address carries ETS's mode ("Automatisch", "Erzwungen an", "Erzwungen aus"), imported from the `.knxproj` and editable ([knx-secure.md](knx-secure.md#group-address-security-mode)). On the GVS AMMA: a new address linked to its switching object got a Busforge-generated key, the GA flash verified, and a secured GroupValueWrite on it switched the output on and off (its status came back secured); restored by a second verified GA flash. **Reference: none**, no ETS capture of a Busforge-generated key. Not shown on hardware: a second secure device on the new address, a plain device turning an address plain (UI and API only). |
| KNX Data Secure: activation from the device certificate | yes | hardware | On the Jung 400021SE after a master reset: address assigned, activated from its certificate (security-mode read, switch-on and tool-key write byte-identical to ETS's capture), then a secured full download verified after its restart and read back with no drift. The same through the UI with a key Busforge generates, in a new empty project: address by programming mode, activation dialog (key stored as provisioned before it is written, confirmed under it), secured full download from the flash dialog. An activation cut off between the key write and its confirmation is completed on the next attempt under the pending key (`already-active`), shown on hardware at one cut point. Changing the project address of a device is checked in the browser; assigning a changed address to a device has not run. |
| Raw acquisition: read a device's identity, interface objects and planned memory without programming support | yes | hardware (read-only) | A `collect` task that sends read services only and records every answer, refusal and gap in a package ([raw-acquisition.md](raw-acquisition.md#implementation)); in the app, a cleaned diagnostic package the user consents to, reviews and saves ([raw-acquisition.md](raw-acquisition.md#diagnostic-package)). Run on the ABB US/U 4.2 and the MDT BE-02001.02 plainly, on the GVS AMMA and the Jung 400021SE through their secure sessions; the GVS without its key is refused after the descriptor; the database is unchanged apart from the task list and the devices' sequence counters. On an MDT IP Interface Secure (MV-0012) the BCU1 plan ran under its secure session: maximum APDU length, then its EEPROM segment. Not shown: that a package equals a Busforge read-back of the same device, a range of a plan refused by a real device, the memory of a System 2, System 300 or coupler device. A cancelled task drops its package: tests only. |
| KNX IP Secure (secure tunnelling transport) | no | not implemented | Out of scope. |
| Transport: KNXnet/IP tunnelling (UDP and TCP), own implementation | yes | hardware | Connect, tunnel, management, heartbeat and closure. The connection-state heartbeat keeps an idle TCP tunnel up against a third-party KNX IP interface and against Busforge's bridge, which reaps a silent TCP channel after 120 s; a client that vanished without a FIN is reaped the same way and the next connect is served ([connections.md](connections.md)). |
| Transport: KNX USB (HID) | yes | hardware | Bus-level round trip proven on one interface model; sends are serialized because a second send clobbers the outstanding confirmation. |
| Expose a local USB interface on the network as a KNXnet/IP gateway | yes | hardware | Full downloads driven through it; a third-party tool (ETS) can also program a device through it. Management works only on the interface's own address on the USB stick tested. |
| Bus monitor: live telegrams, DPT-decoded values, group-address names | yes | hardware | Read-only: decoded live telegrams off a live KNX bus. |
| Bus monitor: secured group telegrams (KNX Data Secure) | yes | hardware | Decrypted with the imported project's group keys; no key, failed authentication, a sequence already seen and undecodable frames are shown as such, never as a value. On the Jung 400021SE its contact's secured telegrams decrypted to the toggle its parameters describe, and show as "no key" under a project without the key. Cipher also covered by xknx's known-answer vectors. Failed authentication and replay shown by tests only; not compared with the ETS group monitor. |
| KNX Data Secure: sending secured group telegrams, assigned senders | yes | hardware | Senders imported from the `.knxproj` (BusInterface connectors) or added in the group-address overlay, loaded into PID 54 by the GA flash. On the Jung 400021SE: a secured GroupValueRead from the monitor's send panel answered with a secured response, both decrypted; with the sender removed and flashed the device ignored it and Busforge refused to send. The secure smoke spec's `securedOutput` behaviour repeats the secured read every run. |
| Snapshots: configuration restore points (capture, compare, restore) | yes | tests only | Database-level feature; no device write involved. |
| Export / import the `.busforge` archive (optionally encrypted) | yes | tests only | |
| Place a catalog device, replace a device and migrate its links | yes | hardware | Driven end to end into a real commission. One UI gap: links hidden by parameter visibility have no mapping row (`REPLACE_MAPPING_INCOMPLETE`). |
| DCA-replacement plugins (native views instead of a Windows ETS plugin) | partial | tests only | One read-only module (Theben DALI gateway) rendering fixtures, groups and scenes from the device's backup store. No write path. |
| Application code / firmware download (LSM 5) | no | not implemented | A System 7 full download writes the application's static code segments from the product data; there is no separate code-load capability. |
| Property-based loading (interface-object devices with no memory image) | no | not implemented | |
| System 1 devices | read; one write | hardware (one product) | Their EEPROM segment is read and decoded (parameters; group tables when empty), under a secure session where the device runs one. Written: the download of a Data Secure KNXnet/IP interface on MV-0012, as ETS runs it (the mask's procedure, the security object, the KNXnet/IP parameter object), on the parameter and the full-download route; shown on the MDT IP Interface Secure (below). Every other System 1 write is refused ([device-support.md](device-support.md#known-gaps)). |
| System 2 / System 300 devices | no | not implemented | Recognised by mask and refused, never routed into a path that guesses. |
| Non-TP media (powerline, RF, IP masks) | code-shared | not proven | Same codec and load procedure as the TP masks; never exercised on the wire. See [device-support.md](device-support.md). |

## Devices driven on real hardware

Read-back means our built image was compared byte-for-byte against the device's own memory. A
`verified` write proves that read-back for every owned byte, except the bytes a device written with
the confirmed extended write does not give back: those rest on its write confirmation alone, are named
in the result (`confirmedOnly`) and are accepted only under the conditions in
[load-procedures.md](load-procedures.md#the-rules-by-level): the device answered the chunk holding them
with return code `00`, which says it took the chunk, not what it stored. The MDT IP Interface/Router has
such a field (device notes below). A `verified` write whose closing restart the device did not confirm
carries `restartUnproven` ([load-procedures.md](load-procedures.md#a-negative-confirmation-of-the-restart-frame)):
the read-back after the restart shows the bytes, not that the device restarted and stored them for good.
Under that rule the MEAN WELL power supply's flashes end that way, shown by a test on its recorded restart, not by a run (device notes below).
Bus behaviour means the device was observed acting on the bus through an independent witness
connection, which is the only check that catches a byte-perfect flash of a semantically wrong
value.

| Manufacturer / product | Mask | Memory model | Read-back | Param flash | GA flash | Full download | Bus behaviour |
|---|---|---|---|---|---|---|---|
| ABB US/U 4.2 universal interface | MV-0701 | absolute, memory-mapped LSM | hardware | hardware | hardware (bytes only) | hardware | not applicable: write-only outputs |
| MDT BE-02001.02 universal interface 2-fold | MV-0705 | absolute, property-mapped LSM, module device | hardware | hardware | hardware | hardware, byte-equal to two ETS downloads | hardware: a flashed link answers a read |
| GVS K-BUS AMMA-04/06.S multifunction actuator | MV-07B0 | relative | hardware | hardware | hardware | hardware, from virgin, survives a bus power cycle | hardware: the switch object drives the status object |
| Jung 400021SE Tasterschnittstelle 2fach Secure | MV-07B0 | relative, module device, parameter segment above 64 KB | hardware | hardware | hardware | hardware, from factory, survives a restart | hardware: a surgically flashed link answers a read |
| OpenKNX RaumController (AB-SmartHouse AB-PRE) | MV-07B0 | relative | hardware | hardware, ETS's bracket, one parameter changed and reverted (see below) | hardware, add and remove, exactly the bytes of ETS's group-address download, ETS's bracket (see below) | hardware, from factory **and onto a device running its application**, application runs and survives a bus power cycle; ETS's bracket (see below) | hardware: in service in a real installation, driving light, fan and temperature |
| MEAN WELL KNX power supply (M-0162) | MV-07B0 | relative | hardware | hardware, ETS's bracket; with the record of a Busforge download only the changed byte (see below) | hardware, add and remove, ETS's bracket and table lengths (see below) | hardware, onto a unit running its application, ETS's bracket and image, bus voltage kept through every unload and restart; the unit does not confirm its restart, so under the current rule its flashes end `verified` with `restartUnproven`, shown on the recorded sequence by a test, not by a run (see below) | hardware: the cyclic-send interval change took effect on the bus; a flashed link answers a read |
| Theben HMG 6 T heating actuator (M-0048, MIX 2 application) | MV-07B0 | relative, module device | hardware | hardware, ETS's bracket and exactly the bytes of ETS's parameter download (see below) | hardware, add and remove, exactly the bytes of ETS's group-address download, ETS's bracket (see below) | hardware, ETS's bracket, the bytes of ETS's image; on a unit already holding the application, every byte but the download marker already equal (see below) | hardware: answers group reads after each write, an added address answers |
| Theben JMG 4 T blind actuator (M-0048, MIX 2 application) | MV-07B0 | relative, module device | hardware | hardware, ETS's bracket and exactly the bytes of ETS's parameter download (see below) | hardware, add and remove, exactly the bytes of ETS's group-address download, ETS's bracket (see below) | hardware, ETS's bracket, the bytes of ETS's image; on a unit already holding the application, every byte but the download marker already equal (see below) | hardware: answers group reads after each write, an added address answers |
| Theben RMG 8 T switch actuator (M-0048, MIX 2 application) | MV-07B0 | relative, module device | hardware | hardware, ETS's bracket and exactly the bytes of ETS's parameter download (see below) | hardware, add and remove, exactly the bytes of ETS's group-address download, ETS's bracket (see below) | hardware, ETS's bracket, the bytes of ETS's image; on a unit already holding the application, every byte but the download marker already equal (see below) | hardware: answers group reads after each write, an added address answers |
| Theben DALI gateway (M-0048) | MV-07B0 | relative | hardware | hardware, ETS's bracket, ETS's byte among the owned bytes written (see below) | hardware, add and remove, exactly the bytes of ETS's group-address download, ETS's bracket (see below) | hardware on a unit holding the application (ETS's partial form, the tables of ETS's capture); the full form not driven | hardware: status sent after each restart, an added address answered |
| MDT Universal Interface 6-fold BE-06001.02 (M-0083) | MV-0705 | absolute, module device | hardware | hardware, ETS's bracket, the changed bytes (see below) | hardware, add and remove, ETS's bracket and table bytes (see below) | hardware, ETS's bracket, the bytes of ETS's image | hardware: status sent after each restart, an added address answered |
| Auro presence detector (M-0081_A-FE01) | MV-0705 | absolute | hardware | hardware, bracket and changed byte equal to ETS's partial download, the segment stamp equal to the one after ETS's download | hardware, add and remove with the tables unloaded and re-declared, wire and stamps equal to ETS's; unlinking and relinking a transmit-only object clears and sets its linked bit, written bytes and reads equal to ETS's (see below) | hardware, sequence only: on a unit already holding the application, every planned byte already equal, no changed byte transferred (see below) | hardware: answers group reads after each write, a removed address stops answering; a transmit-only object relinked by a GA flash sends on its address (see below) |
| Steinel presence detector (M-008E) | MV-0705 | absolute, data-less segment | hardware | hardware | not proven | refused (parameter segment without `<Data>`, see below) | not proven |
| Gira Tastsensor 3 (M-0008) | MV-0705 | absolute, dynamic tables | hardware | hardware, ETS's bracket and the changed byte, the segment stamp equal to the one after ETS's download (see below) | hardware, add and remove with the tables re-declared, exactly the bytes of ETS's image, wire and stamps equal to ETS's (see below) | hardware, exactly the bytes of ETS's image, shown on the wire; on a unit already holding the application, every planned byte already equal (see below) | hardware: answers a group read after the download and after each flash; the GA flash's new association not observed (the object has no read flag) |
| Theben TheLuxa P300 (M-0048, MV-0705 product) | MV-0705 | absolute, dynamic tables | hardware | hardware, ETS's bracket, the changed byte and the download marker (see below) | hardware, add and remove with the tables re-declared as one region, wire equal to ETS's (see below) | hardware, declared order with `LdCtrlTaskCtrl1`, exactly the bytes of ETS's image, wire equal to ETS's; on a unit already holding the application, every byte but the download marker already equal (see below) | hardware: answers group reads after each write, an added address answers and stops after its removal |
| Theben Meteodata 140 S (M-0048, MV-0701 product) | MV-0701 | absolute, dynamic tables, memory-mapped LSM | hardware | hardware, ETS's bracket over `0x0104`, the changed byte and the download marker, wire equal to ETS's (see below) | hardware, add and remove with the tables re-declared as one region, every byte ETS wrote equal (see below) | hardware, declared order with `LdCtrlTaskCtrl1` over `0x0104`, the bytes of ETS's image; on a unit already holding the application, every byte but the download marker already equal (see below) | hardware: answers group reads after each write, an added address answers and stops after its removal |
| MDT IP Interface/Router (KNX Data Secure) | MV-07B0 in the product data, opaque on the bus (`0xFFFF` to plain reads) | relative (product data); none exposed plainly | hardware, secure identify only | hardware, under a secured session; the password field on the write confirmation (see below) | not proven; planned with its security object where a tool key is on file | refused (`FULL_DOWNLOAD_TUNNELING_ENTRIES`, see below) | not proven |
| MDT IP Interface Secure (KNX Data Secure) | MV-0012 in the product data, opaque on the bus (`0xFFFF` to plain reads) | System 1, EEPROM segment at `0x0100` | hardware, Busforge's read-back under the secure session, on a unit ETS programmed: no drift; its memory (collector) holds in every parameter byte Busforge's image of the project, the group tables empty (reference) | hardware, under the secured session through the unit's own tunnel: every write equal to ETS's download, in ETS's order, verified (segment and KNXnet/IP properties read back), the unit's memory afterwards equal to its memory after ETS's download (see below) | not applicable: the application has no group objects (`SYSTEM1_GROUP_TABLES_UNCAPTURED`) | the same procedure as the parameter download (no partial download); not run on its own route | the unit kept serving the tunnels it carries (the download's own and the other clients'), with the same individual addresses, through the restart |

What each row does not show:

- **Plans that differ from the ones run on hardware.** The plans follow the catalogue, family and
  KNX-wide rules ([load-procedures.md](load-procedures.md#the-rules-by-level)). Where a plan differs
  from the one the hardware cells above were shown with, it is capture-tested only (its steps and
  bytes equal ETS's capture, where one exists) and has not run on the device:
  - **Auro M-0081_A-FE01, Theben TheLuxa P300, Theben Meteodata 140 S**: the full download runs the
    declared form onto a unit that does not hold the application too; no capture or run shows that case.
  - **Auro, Gira, Meteodata, Theben HMG 6 T and RMG 8 T (MIX 2), ABB US/U 4.2, MEAN WELL power supply**: the structural flash is offered.
  - **Theben DALI gateway**: the full download onto a unit that does not hold the application (the
    declared form, allocation Mode 1) equals ETS's capture of it and has not run.
  - **Theben Meteodata 140 S, Steinel M-008E**: a configuration that activates one of their text
    parameters (the Meteodata's EIS 5 channels) is refused for every write, since no System 7 capture
    shows a text parameter; a read-back leaves those fields out.
- **Jung 400021SE** runs in Data Secure mode, secure-commissioned by ETS. Its plain claims were shown
  in plain mode; the plain smoke spec applies again only after a master reset. Its load procedure
  declares two memory-control-block regions that every allocation resets, so the full download and
  the parameter flash write them after the allocation ([load-procedures.md](load-procedures.md)).
  The Theben MIX 2 application declares the same regions and is written the same way (device notes
  below).
- **OpenKNX RaumController.** ETS 6 was captured running a full, a parameter and a group-address
  download and their revert on one unit. Busforge's full download, parameter flash (one parameter,
  changed and reverted) and group-address flash (one link added and removed) ran on that unit through
  a logging proxy, each `verified`: ETS's load controls on the wire, the group-address flash's bytes
  equal to ETS's, and the read after each restart equal to the reference (after the added link, equal
  to the unit after ETS's group-address download). Its full download writes exactly the bytes of ETS's
  full download (`tools/etsdiff.test.ts`); that write set has not run on the device ([Known
  unproven](#known-unproven)). Its parameter flash, with the stamp record ETS keeps, writes ETS's one
  byte (`tools/etsdiff.test.ts`). Where Busforge still differs from ETS: the
  device gets a settle and a reconnect before the restart, where ETS restarts at once. In this
  firmware (thelsing/knx with OpenKNX Common) a surgical flash and a full download take the same path,
  and the flash reads back only after the restart, because the firmware returns the old flash
  contents until then ([findings.md](findings.md) §16). It answers a group read on an object only once
  that object has had a value since the restart: a read before the object first sends goes
  unanswered. Persistence is the restart each write ends with. The from-factory smoke spec keeps both
  surgical capabilities out of automated runs, because recovering a failed run needs the device's
  serial console; the device-in-service spec drives them on a commissioned unit, each reverted, and
  has not run.
- **Theben DALI gateway.** ETS 6 was captured running a full download (after unloading the
  application), its partial form on a unit holding the application, a parameter, a group-address
  and a revert download. Busforge's plans equal them (`tools/etsdiff.test.ts`): ETS's bracket in each,
  every byte ETS wrote with ETS's value, the admin-password text parameter as ETS's image holds it;
  where the wire differs, the bytes only one side writes hold what the unit holds already
  ([load-procedures.md](load-procedures.md#the-rules-by-level)). On a unit holding the application,
  through a logging proxy, each `verified`: the full download (ETS's partial form, the tables of ETS's
  capture byte for byte), a parameter flash and its revert (ETS's bracket, the one byte ETS writes
  among the owned bytes Busforge writes), a group-address flash adding and removing a link (the bytes
  of ETS's capture; the added address answered a group read), and a structural flash adding an
  object and a link and its revert (ETS's steps). After each the unit's memory equals the reference
  or exactly the planned change. The gateway is written with `A_Memory_Write`: it declares a long
  APDU but no extended memory services, and does not answer an extended write. The gateway's DALI
  configuration (addresses, groups, scenes) lives in a vendor interface object written only by the
  manufacturer's DCA plugin; no ETS or Busforge download changed it. While the application is
  unloaded with the group tables still loaded (ETS's and Busforge's parameter and structural
  brackets), the gateway sends its failure object as set, and does not send it cleared after the
  restart: a read returns the cleared value. The DCA-replacement plugin renders committed fixtures and
  proves nothing about the device on a bus.
- **MEAN WELL KNX power supply `M-0162_A-0004-11-F245`** (System B, the line's power supply). ETS 6 was
  captured running a restart, a group-address, a parameter, a revert and a full download; Busforge's plans
  equal them (`tools/etsdiff.test.ts`). ETS reads the two parameters the application keeps in properties
  (object 0 PID 25 and PID 78) and writes neither; no Busforge plan writes them. On a unit running its
  application, through a logging proxy over a KNX-USB interface on the line, each `verified`: the full
  download (every byte ETS's full download writes, the same addresses and values), a parameter flash and
  its revert (with the record of the Busforge full download, the one changed byte), and a group-address
  flash adding and removing a link (ETS's bracket and table lengths; the com-object table whole, as ETS
  writes it when its record's download did not write that table; the differential form, after a record
  whose download wrote the table, is capture-tested only). The added address answered a group
  read, and the unit sends it after every restart. The bus voltage held through every unload and restart
  of ETS's and Busforge's downloads. The unit restarts before its L2 acknowledgement of `A_Restart`, so the
  interface confirms that frame negatively, for ETS and Busforge alike
  ([load-procedures.md](load-procedures.md#a-negative-confirmation-of-the-restart-frame)). The proof
  of such a restart needs the device's own `T_Disconnect`, and this unit gives none: after its reboot it
  acknowledges the probes on layer 2 and drops them without a transport answer, so its restart is
  unproven. A flash then goes on as ETS does after the same confirmation: it reconnects, reads back and
  ends `verified` with `restartUnproven`. That outcome is shown on the unit's recorded restart sequence
  by a test, not by a run of a flash on the unit; the runs on the unit stopped at the unproven restart,
  their bytes written as planned and a later read equal to the earlier final read. That the unit
  restarted and stored the bytes is not shown by a flash.
- **MDT IP Interface/Router `M-0083_A-0137-20-7EB2`** (System B, KNX Data Secure). Its parameter image
  equals ETS's image of its full download byte for byte, text fields and the defaults of inactive
  parameters included, and its parameter flash changes the same bytes as ETS's parameter downloads
  (`tools/etsdiff.test.ts`); with the stamp record it writes the bytes that differ from its read of the
  unit, ETS those that differ from its record, which here also differ where the unit reads a field back
  other than written (the web interface password). On a unit, under a
  secured session with the project's tool key, through a logging proxy: a parameter flash changing the
  device name was `verified`, its web interface password field (20 bytes, read back as `FF` after any
  write) accepted on the write confirmation alone and named in the result (`confirmedOnly`); a flash
  that changes nothing but that field ends unverified, as nothing readable shows it landed. The field
  always counts as a difference in the preview. Over a direct bus connection (a USB interface behind
  Busforge's bridge), the name changed and changed back to the project's value were each `verified`,
  the password field named on the write confirmation both times, and a read under a secured session
  afterwards found the unit at the project's configuration. Every restart of the unit makes an MDT IP
  interface beside it stop serving its tunnels for up to a minute and then drop them; Busforge opens
  its link again, and a secured session refuses a link that comes back under another individual
  address (`TUNNEL_ADDRESS_CHANGED`), so a flash through that interface is written and restarted but
  not verified by Busforge: shown once, the unit read back under a secured session afterwards held the
  planned image.
- **MDT Universal Interface 6-fold BE-06001.02 `M-0083_A-00B4-32-3919`** (MV-0705, module device).
  ETS 6 was captured running a full, a parameter, a group-address and a revert download; Busforge's
  plans equal them (`tools/etsdiff.test.ts`). On a unit, through a logging proxy, each `verified`: the
  full download (ETS's bracket, every byte of ETS's image), a parameter flash and its revert (ETS's
  bracket; on the unit it ran writing the changed bytes, its plan writes every byte a parameter covers,
  as ETS does, pinned by `tools/etsdiff.test.ts`),
  a group-address flash adding and removing a link (ETS's bracket and table bytes; the added address
  answered a group read) and a structural flash that activates a logic channel's output object and
  links it, and its revert (ETS's steps, every byte both write with ETS's value; the new object
  answered a group read). The final read equals the reference except two bytes behind the tables'
  ends, which neither tool clears. Written with `A_Memory_Write`; the unit declares no long APDU.
- **Auro M-0081_A-FE01.** ETS 6 was captured running its full, parameter and group-address download
  and their revert: the declared steps in their declared order, `LdCtrlTaskCtrl1` (Address 0,
  Count 0) as a PID 5 write of zeros
  ([load-procedures.md](load-procedures.md#declared-order-system-7-downloads)). Busforge's three
  writes are pinned against those captures (`tools/etsdiff.test.ts`; the parameter values are decoded
  from ETS's own image, the project behind the unit is not in the corpus). The parameter and
  group-address flash's wire equals ETS's partial downloads, apart from verify mode; the parameter flash
  ran writing the changed byte, its plan writes every byte a parameter covers, as ETS does. On the unit, every byte the
  full download planned already equalled the unit as ETS had left it: the sequence (unload, PID 5
  declarations, `LdCtrlTaskCtrl1`, `LoadCompleted`, restart) was accepted and the unit stayed loaded
  and answering, but the transfer of changed bytes is shown by the two flashes, not by the full
  download. Persistence is the restart each write ends with; no bus power cycle, and no wire capture
  of the full download. A table that shrinks leaves its old bytes behind it, in ETS's downloads and
  in Busforge's ([load-procedures.md](load-procedures.md#tables-shrink-their-old-bytes-stay)).
  ETS 6 was also captured removing the only address of a transmit-only object and adding it back,
  each a partial download that clears and sets the object's linked bit. Busforge's group-address
  flash plans both exactly (`tools/etsdiff.test.ts`) and ran both on the unit, `verified`: the same
  bytes written in the same load-state sequence (ETS's verify-mode switch and Busforge's read-backs
  aside), each read afterwards equal to the one after ETS's download of the same links. After the
  relink the object sent on that address. Its silence while unlinked was not observed, so this shows
  the relinked object working, not that the bit alone decides it.
- **Gira M-0008.** ETS 6 was captured running its full, parameter and group-address download: it
  re-declares the address and association tables at their built size, leaves the loaded application
  in place, sends no `LdCtrlTaskCtrl1`, and reads the PID 27 stamps for the declared
  `LdCtrlLoadImageProp` ([load-procedures.md](load-procedures.md#ets-captured-system-7-downloads)).
  Busforge's three writes send the same sequences and write the bytes of ETS's image and no others
  ([load-procedures.md](load-procedures.md#which-bytes-ets-writes); `tools/etsdiff.test.ts` fails on
  any byte outside it), including a com-object flag the project sets
  ([load-procedures.md](load-procedures.md#project-level-com-object-flags)); the parameter
  configuration is decoded from ETS's own image. All three ran on the unit through a logging proxy,
  each ending `verified`. Full download: every planned byte already equalled the unit, the wire shows
  exactly the bytes of ETS's image, and the read after its restart equals the reference, so it shows
  sequence and bytes, not changed bytes transferred. Parameter flash (one parameter changed and
  reverted): ETS's bracket with the changed byte. Without a record of its last download its plan writes
  ETS's whole parameter image (421 bytes, `tools/etsdiff.test.ts`), where ETS, holding its record, wrote 7. Group-address
  flash (one link added and removed): the bytes of ETS's group-address download, the wire equal to
  ETS's byte for byte. After each flash the unit's PID 27 stamps equal those after ETS's own download
  of the same change, the last read equals the reference, and the unit answered a group read; the
  added association itself is not observable by a read (the object has no read flag). Persistence is
  the restart each write ends with; no bus power cycle.
- **Theben TheLuxa P300 `M-0048_A-107E-12-5B58`.** ETS 6 was captured running its full, parameter and
  group-address download and their revert: the declared full steps in their declared order, its
  `LdCtrlTaskCtrl1` (Address 17875, Count 1) as the PID 5 write `03 04 45 D3 01` and zeros, and the two
  table segments re-declared as one region, as on the Gira
  ([load-procedures.md](load-procedures.md#the-theluxa-p300)). Busforge's three plans equal the
  captures (`tools/etsdiff.test.ts`), and all three ran on the unit through a logging proxy, each
  `verified`, the wire equal to ETS's (the parameter flash ran writing the changed bytes; its plan
  writes every byte a parameter covers, as ETS does, pinned by `tools/etsdiff.test.ts`). Of the full download's bytes only the download marker differed from the unit
  (written as ETS does, cleared by the unit), so the transfer of changed bytes is shown by the two
  flashes. A group read was answered after each write, and an added address answered until the link
  was removed. The final read equals the reference, the bytes ETS's revert leaves behind the shrunk
  association table included. The com-object table carries one object's update flag in config bit
  `0x80`, as ETS writes it
  ([device-memory-model.md](device-memory-model.md#mv-0705-layout-manufacturer-template-plus-overlay)). A structural
  flash (a parameter that adds an object, and a link of that object) and its revert ran on the unit
  through a logging proxy, each `verified`, ETS's revert step sequence on the wire, every byte both
  wrote with ETS's value; the added object answered on its new address, and the read after the revert
  equals the reference. Persistence is the restart each write ends with; no bus power cycle.
- **Theben Meteodata 140 S `M-0048_A-140C-14-EB70`** (MV-0701, memory-mapped). ETS 6 was captured
  running the same downloads: the TheLuxa's procedure, every load control a memory write to `0x0104`,
  its `LdCtrlTaskCtrl1` (Address 18155, Count 1) as `33 04 00 46 EB 01` and zeros, the tables
  re-declared as one region
  ([load-procedures.md](load-procedures.md#the-meteodata-140-s-memory-mapped)). ETS reads its image and
  writes only the bytes that differ; so does Busforge, its writes equal to ETS's in the three captured
  downloads (`tools/etsdiff.test.ts`; four bytes of the group-address download, which ETS wrote without
  reading, taken as the segment's `<Data>`). The parameter flash ran so on the unit: each planned write
  read first, the two differing bytes written, `verified`, the wire equal to the plan and to ETS's
  parameter download; the full download and group-address flash runs wrote the whole image. Its full
  download and group-address flash equal ETS's logged images byte for byte, its parameter flash the
  two bytes ETS wrote (`tools/etsdiff.test.ts`). All three ran on the unit through a logging proxy,
  each `verified`, ETS's load-control sequence exact on the wire and every byte ETS wrote written with
  the same value. Of the full download's bytes only the download marker differed from the unit, so
  the transfer of changed bytes is shown by the two flashes. Group reads were answered after each
  write, and an added address answered until the link was removed. The final read equals the
  reference, the table residue included (the manufacturer object's runtime values differ, as after
  every restart). It writes its table segment's `<Data>` past what the tables can hold and the update
  flag in config bit `0x80`, both as ETS does. Persistence is the restart each write ends with; no bus
  power cycle.
- **Theben MIX 2 `M-0048_A-493B-21-B471`** (System B, module slots, two memory-control-block
  regions), three products, each with its own captures and runs: HMG 6 T, JMG 4 T, RMG 8 T. ETS 6 was
  captured running a full, a parameter and a group-address download and their revert on one unit of
  each ([load-procedures.md](load-procedures.md#system-b-as-the-theben-mix-2s-captures-show-it)).
  Busforge's full download equals ETS's logged image byte for byte, the object-link tables (`BinaryValue`
  union members) and ETS's association order included, its parameter flash the bytes of ETS's
  parameter download, its group-address flash the tables of ETS's group-address download
  (`tools/etsdiff.test.ts`). All three ran on each unit through a logging proxy, each `verified`: ETS's
  load controls, the PID 27 reads and the confirmed restart on the wire, the parameter and table bytes
  ETS wrote written with the same values. The full download writes exactly ETS's bytes; that write set
  has not run on the units ([Known unproven](#known-unproven)).
  Of the full download's bytes only the download marker
  differed from the unit, so the transfer of changed bytes is shown by the two flashes (one parameter
  and one link each, changed and reverted). The reverts are Busforge's parameter and group-address
  flash, where ETS reverts both in one structural bracket; their bytes equal ETS's revert. Each unit
  answered a group read after each write, an added address answered, and the final read equals the
  reference, both memory-control-block regions included. The unit's download counter (device object
  PID 30) moves alike under both tools. Persistence is the restart each write ends with; no bus power
  cycle. The structural flash of the revert equals ETS's in steps and bytes. On the JMG 4 T a
  structural flash (a parameter of an unused channel that adds an object, and a link of that object)
  and its revert ran through a logging proxy, each `verified`, ETS's step sequence on the wire, every
  byte both wrote with ETS's value. The read after the revert equals the reference except one byte
  holding two parameters the change had activated: once inactive again, neither ETS nor Busforge
  writes them (`DownloadInvisibleParameters="None"`), so their defaults stay. Not run on the HMG 6 T
  and the RMG 8 T.
- **Gira M-0008 full download** is refused onto a unit that does not hold the application with
  load-state machines 1, 2 and 3 loaded (`FULL_DOWNLOAD_APPLICATION_NOT_LOADED`): its declared form
  sends a step after the restart that no capture shows. None of the Auro, Gira, TheLuxa and
  Meteodata runs is a smoke run, so the compatibility matrix does not count them.
- **Full download of the Steinel M-008E and the second Auro application `M-0081_A-FF31`** is refused
  before any write and not offered (`FULL_DOWNLOAD_SEGMENT_UNKNOWN`): a parameter segment without
  `<Data>`, and a `<Mask>` of a form no capture shows
  ([load-procedures.md](load-procedures.md#coverage-across-the-catalogue)).
  A unit never verified since it was placed or replaced is refused the surgical flashes too, naming
  ETS (`NEVER_PROGRAMMED_USE_ETS`).
- **MDT IP interfaces.** The IP Interface/Router application is System B and Data Secure, so the
  group-address flash plans it with its security object when the project holds its tool key, and
  plain without one; it has not run on one. No System B path writes its tunnelling addresses
  (`AdditionalAddresses`), and what a download without them does to the interface's tunnels is not
  established, so the full download of a System B or System 7 application declaring tunnelling
  entries is refused before any bus traffic (`FULL_DOWNLOAD_TUNNELING_ENTRIES`, unit- and route-tested)
  and not offered ([device-support.md](device-support.md#known-gaps)). The IP Interface Secure (System
  1) writes them as ETS does, in the KNXnet/IP parameter object. Its download, ETS's and Busforge's,
  ran through the unit's own tunnel; the unit took every write before its confirmed restart and kept
  its tunnels through the restart. A download that changes its IP or tunnelling addresses is refused
  (`SYSTEM1_IP_CHANGE_UNCAPTURED`): the capture writes the values the unit holds. Busforge writes the
  friendly name in the language the unit holds where it is the product's text in one of the
  catalogue's languages, else in the catalogue's default language; ETS writes it in its own. The full
  download route runs the same procedure and has not run on its own. Not shown: the procedure on a
  unit that did not hold the application, and a run over USB (refused).
- **A wider set carries the weaker proof of a read-back match** (build the image, read the device's
  memory, compare the bytes we own, `tools/verify-images.ts`): 28 of 32 reachable devices of an
  installation commissioned by ETS. Of the four residuals, two are secure interfaces and the rest are project-versus-device
  drift or a self-stamped marker, not modelling gaps. A Theben HMG 6 T unit holds old values in six bytes
  of inactive parameters, which ETS's full download writes as zero. A read-back match is not a flash
  round-trip.
- **Offered, never driven.** Some applications are offered writes because their declared procedure
  is covered, and those writes have no hardware evidence on the product: the MEAN WELL power supply (`M-0162_A-0004-11-F245`) for its structural flash.
- **Sibling products on a proven mask are individually unproven.** A mask proven on one product
  means the memory model and load procedure are right, not that another product on that mask has
  been driven.

## Hardware smoke specs, per channel

Which paths are held by an automated spec (`tools/smoke/specs/`, see [testing.md](testing.md)),
and in which channel it passes: `api` (the production endpoints directly) or `ui` (the real web app
in a browser). Persistence here means an observed reboot after A_Restart, every load object LOADED
again, and a read-back equal to the project; it is not a bus power cut
([evidence-contract.md](evidence-contract.md)). Kept runs and their records are in
the private corpus; the records that decide each cell ship with the server
([evidence-contract.md](evidence-contract.md#the-shipped-records)), and the states they decide are in
[compatibility.md](compatibility.md).

**The done bar** ([testing.md](testing.md#the-done-bar)): a device counts as fully supported only when
every capability its product claims, plus provisioning and the UI click-through, passes on real
hardware in **both** channels, together with every behaviour its spec declares. One green channel
is not done, and neither is a device that byte-verifies without ever acting on the bus, unless its
spec states why no behaviour is observable.

| Spec | Product | Mask | `api` | `ui` | Persistence (restart) | Done bar |
|---|---|---|---|---|---|---|
| `gvs-amma` | GVS K-BUS AMMA-04/06.S multifunction actuator, in Data Secure mode | MV-07B0 | hardware | hardware | hardware, both channels | **met**, secured; its behaviour checked plain |
| `mdt-be02001` | MDT BE-02001.02 universal interface 2-fold | MV-0705 | hardware | hardware | hardware, both channels | **met** |
| `abb-usu-4.2` | ABB US/U 4.2 universal interface | MV-0701 | hardware | hardware | hardware, both channels | **met**, to the byte only |
| `jung-400021se` | Jung 400021SE Tasterschnittstelle 2fach Secure, plain | MV-07B0 | hardware | hardware | hardware, both channels | **met** in plain mode; not rerun since the device went secure (the plain spec needs a master reset first) |
| `jung-400021se-secure` | the same Jung, in Data Secure mode | MV-07B0 | hardware | hardware | hardware, both channels | **met**, plus robustness refusals and restore |
| `openknx-raumcontroller` | OpenKNX RaumController (AB-SmartHouse AB-PRE) | MV-07B0 | not proven | not proven | not proven | **not met** |
| `openknx-raumcontroller-in-service` | the same product, a commissioned unit (parameter flash and GA flash, each reverted) | MV-07B0 | not proven | not proven | not proven | **not met** |
| `theben-theluxa-p300-in-service` | Theben TheLuxa P300, a commissioned unit (parameter, GA and structural flash, each reverted; full download on request) | MV-0705 | not proven | not proven | not proven | **not met** |
| `theben-meteodata-140s-in-service` | Theben Meteodata 140 S, a commissioned unit (parameter and GA flash, each reverted; full download on request; structural flash declared unsafe) | MV-0701 | not proven | not proven | not proven | **not met** |
| `mdt-be06001-in-service` | MDT BE-06001.02 universal interface 6-fold, a commissioned unit (parameter, GA and structural flash, each reverted; full download on request) | MV-0705 | not proven | not proven | not proven | **not met** |
| `auro-m0081-in-service` | Auro presence detector (M-0081_A-FE01), a commissioned unit (parameter flash, and a GA flash that adds the test address to a linked object, each reverted; full download on request; structural flash declared unsafe) | MV-0705 | not proven | not proven | not proven | **not met** |
| `theben-hmg6t-in-service` | Theben HMG 6 T heating actuator (MIX 2), a commissioned unit (parameter and GA flash, each reverted; full download on request; structural flash declared unsafe) | MV-07B0 | not proven | not proven | not proven | **not met** |
| `theben-jmg4t-in-service` | Theben JMG 4 T blind actuator (MIX 2), a commissioned unit (parameter, GA and structural flash, each reverted; full download on request) | MV-07B0 | not proven | not proven | not proven | **not met** |
| `theben-rmg8t-in-service` | Theben RMG 8 T switch actuator (MIX 2), a commissioned unit (parameter and GA flash, each reverted; full download on request; structural flash declared unsafe) | MV-07B0 | not proven | not proven | not proven | **not met** |
| `theben-dali-gateway-in-service` | Theben DALI-Gateway KNX plus, a commissioned unit (parameter, GA and structural flash, each reverted; full download declared unsafe) | MV-07B0 | not proven | not proven | not proven | **not met** |

- **ABB US/U 4.2**: its outputs are write-only, so its spec declares no behaviour. Every claimed
  capability plus the click-through is green in both channels, which clears the bar, but the proof
  stops at the bytes.
- **GVS AMMA**: its application declares a closing write of object 4 PID 67 for every download; the
  spec passes with it in both channels. On this device the
  right tool key straight after a wrong one goes unanswered once and is answered on the next Sync
  ([findings.md](findings.md) §30); the spec declares that (`secondSyncAfterWrongKey`).
- **OpenKNX RaumController**: the spec exists but has never run. The device's commissioning is
  hardware-proven, driven through the production endpoints. It runs in a live installation, so the
  spec stays unrun: driving it would program a device somebody depends on. Its two surgical
  capabilities are excluded from automated runs, so even a green run could not clear the bar for
  them. The device-in-service spec drives exactly those two on a commissioned unit, each reverted, with the
  full download declared unsafe there; it has not run.

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

- **A com-object flag or priority edited on the device page has not been written to hardware by
  Busforge.** ETS writes a flag change with its group-address download; on the MDT BE-02001.02 and the
  Jung 400021SE, Busforge's group-address flash builds the com-object table ETS wrote for a read flag
  off and back on (`tools/etsdiff-flags.test.ts`). Other flags, the priority, and the other products
  rest on the same table code, offline tests only. A read-back does not take flags into the baseline.
  On System B the communication flag of an object without a group address is written off whatever the
  project sets; whether ETS does the same for a project's flag is not captured. ETS offers
  communication and update on System 7, which Busforge does not (no capture of what ETS writes).
- **A device in service, taken over by read-back, has been run on emulated units only.** Every
  device-in-service spec runs against the real server and the real read and write paths on its unit
  emulated from a read-only collection (`tools/smoke/inservice-specs.test.ts`); none has run on
  hardware this way. There the Gira M-0008, the Auro M-0081_A-FE01, the MDT BE-06001.02, the Theben
  DALI-Gateway, the Theben TheLuxa P300 and Meteodata 140 S and the MIX 2's JMG 4 T and RMG 8 T are taken
  over and run their steps; the MIX 2's HMG 6 T stops before its first write, since the read-back does
  not read its com-object table ([roadmap.md](roadmap.md#verification)), and the OpenKNX
  RaumController's collection holds none of its memory.
- **Memory writes longer than 32 bytes extended or 12 classic have run on no device.** Busforge asks an
  IP interface for its maximum APDU before writing, as ETS does, and writes up to the shorter of the
  device's and the interface's (205 data bytes behind an interface announcing 210). The question and
  the answer (210) ran on an MDT IP Interface/Router ahead of a Meteodata 140 S parameter flash; that
  unit declares no maximum APDU, so its writes stayed classic and short. The Busforge bridge over a
  KNX-USB interface does not answer that question over TCP; ETS asks it the interface's PID 56 with a
  cEMI `M_PropRead` (`DEVICE_CONFIGURATION_REQUEST`) and gets 40, Busforge does not ask that way and
  writes 12 bytes there.
- **The stamp record has run on one device.** The System B parameter flash keeps ETS's record of the
  last download that wrote the parameters and with it writes ETS's differential bytes (pinned by
  `tools/etsdiff.test.ts` against every captured pair); on the MEAN WELL power supply, after a Busforge
  full download, it wrote the one changed byte. The record across a server restart has not run.
- **The System B full download's write set has run on one device.** It writes exactly the bytes ETS's
  full downloads write ([load-procedures.md](load-procedures.md#the-rules-by-level)); on the MEAN WELL
  power supply the bytes written equal ETS's. The earlier hardware runs of a System B full download
  (OpenKNX RaumController, Theben MIX 2, Theben DALI-Gateway, Jung 400021SE, GVS AMMA) wrote a wider set
  of the same values, which leaves the unit the same.
- **Our image equals what ETS would write** is checked only where an ETS capture of the same
  device exists (`tools/etsdiff.ts`, its records shipped with the others, [compatibility.md](compatibility.md)). Full
  download: the MDT BE-02001.02, the ABB US/U 4.2, the GVS AMMA and the Jung 400021SE, every segment
  byte for byte. Parameter flash: one ETS partial download of the Jung. Group-address flash: one ETS
  partial download each of the MDT, the ABB, the GVS and the Jung, every byte ETS wrote equal to Busforge's image. Plus the Auro
  M-0081_A-FE01, the Gira M-0008, the Theben TheLuxa P300, the Theben Meteodata 140 S, the three
  Theben MIX 2 products (device notes above), the MDT BE-06001.02 (full, parameter, group-address
  download), and the ABB's full download onto a unit holding the
  application (ETS's partial form). Structural flash: the Jung, the MDT BE-02001.02 and the reverts of
  the Auro, Gira, TheLuxa, Meteodata, MIX 2, Theben DALI gateway and MDT BE-06001.02. Everywhere else the read-back proves
  `device == our image` and can never prove `our image == ETS`.
- **An object whose sending address is not its lowest has been written to no device by
  Busforge.** On the MDT BE-02001.02 two ETS 6 captures show the order, with the sending address once
  above and once below the object's other address: ETS writes the sending address's association
  first, and the unit sent on that address and answered a read of either address on it
  ([findings.md](findings.md) §36). Busforge's tables for the same links equal every byte ETS wrote,
  and decoded as a read-back decodes them they name that address first (`tools/etsdiff.test.ts`); no
  test compares the MDT BE-02001.02's group-address flash sequence with a capture. On other products
  the order rests on the rule ([load-procedures.md](load-procedures.md#the-rules-by-level), R8).
- **System 7 group-address flash of the com-object table.** It reads the table the device holds
  and changes only each object's linked bit, as ETS does on both LSM styles. On a device whose table
  another tool left wrong, the other bytes stay wrong. A freshly linked read-capable object and a
  transmit-only object linked by a GA flash alone work on the MDT BE-02001.02
  ([findings.md](findings.md) §7). On the Auro M-0081_A-FE01 ETS's and Busforge's group-address
  downloads clear and set a transmit-only object's linked bit with the same bytes, and the relinked
  object sends; that the bit alone decides it is not shown there. On the memory-mapped ABB the
  transmit-only case is not shown. A property-mapped application that names no com-object table
  segment keeps the device's table; a memory-mapped one is refused.
- **KNX Data Secure is shown on two devices**, the Jung 400021SE and the GVS AMMA: secured full
  download, parameter and GA flash, read-back, persistence, the robustness refusals and a restore,
  both channels. A secured behaviour is shown on the Jung alone; the GVS's behaviour is checked
  plain. An interrupted flash does not recover the device by itself: a write cut off inside its
  load bracket fails `FLASH_INTERRUPTED_UNLOADED`, the flash dialog offers the full download, and
  that download verifies ([findings.md](findings.md) §31, shown at one cut point on the MDT
  BE-02001.02).
- **The GVS AMMA's closing PID 67 write.** Its application declares a write of `01` to object 4
  PID 67 for every download (`AppliesTo="all"`), which ETS sends after the last LoadCompleted; the
  full download, parameter flash and group-address flash end with it in ETS's place and refuse on a
  wrong echo ([load-procedures.md](load-procedures.md#the-closing-steps-run-as-declared)).
  Shown on hardware in both channels. Not shown: what the property does in the device, and the
  group-address flash's write against a links-only ETS capture (none exists). A closing write another application declares is run as declared; no other catalogue
  fixture declares one.
- **Config bit `0x80` of the System 7 com-object table as the update flag** is a family rule shown
  by the captures of the TheLuxa P300, the Meteodata 140 S and the MDT BE-06001.02; on hardware a set
  update bit is shown only on the two Theben units
  ([device-memory-model.md](device-memory-model.md#mv-0705-layout-manufacturer-template-plus-overlay)). The table
  segment's `<Data>` past what the tables can hold is written by rule; the Meteodata is the one
  capture showing ETS write such bytes ([load-procedures.md](load-procedures.md#the-rules-by-level), R6).
- **Non-TP media** (powerline, RF, IP masks) have never been exercised on the wire.
- **MV-0700, MV-2705, MV-5705, MV-17B0, MV-27B0, MV-57B0** share a proven code path but no device
  on those masks has been driven.
- **KNXnet/IP closure and heartbeat timing** are verified against Busforge's own server; against a
  third-party gateway only an idle TCP tunnel kept up by the heartbeat is shown.
- **The USB transport is proven on one interface model.** Its single-report HID limits (read and
  write chunk ceilings, management only on the interface's own address) are properties of that
  controller and may differ elsewhere. Two identical interfaces attached at once are told apart by
  their saved serial in unit tests only.
- **The DCA-replacement plugin is read-only** and covers one gateway; nothing is written back.
- **A secured full download of the Jung 400021SE has once been closed by the device.** It ended with
  `DEVICE_CLOSED_CONNECTION` (the device sent `T_Disconnect` mid-request, [findings.md](findings.md)
  §24); the writes after it verified, and the same step passes otherwise. The cause is not known.
- **A UDP tunnel to Busforge's bridge closes when the server stops acknowledging for two seconds**
  ([findings.md](findings.md) §35). A write parses the application before it opens the tunnel; what it
  still computes inside the session (images and tables from the parsed application) stayed inside that
  window for the Jung 400021SE's secured full download from a server limited to a quarter of a CPU
  core. That is not shown for every application on every host. A closed tunnel ends the write with
  `TUNNEL_CLOSED`; over TCP the bridge needs no acknowledgement.
