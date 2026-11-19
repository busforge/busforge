# Roadmap

What is next, and why. How far every claim is proven today lives in [status.md](status.md); this
page only lists open work. Nothing here is scheduled, and nothing is started until the capability it
depends on is hardware-proven.

## Programming paths

- **Hardware runs of the operations the rules changed.** The plans follow the catalogue, family and
  KNX-wide rules ([load-procedures.md](load-procedures.md#the-rules-by-level)); where that changed a
  plan, the new one is capture-tested only ([status.md](status.md#devices-driven-on-real-hardware)):
  the System B partial form of the full download on the Jung 400021SE, the Theben DALI-Gateway's full
  download onto a unit without the application. Each needs its run on the device.
- **Hidden bytes in the System 7 full download.** The parameter and structural flash write a hidden
  parameter's bytes at the segment's `<Data>` only where the project is known to hold its parameters
  without memory, and refuse otherwise ([device-memory-model.md](device-memory-model.md#owned-bytes-and-left-alone-bytes)).
  The full download writes its whole image without that check, so on a project taken over by read-back
  that left such a parameter at its default it writes `<Data>` over a setting the unit runs with. Open
  decision: the same check there, or the full download kept for projects that hold those values.
- **The bytes of a hidden-byte refusal in the UI.** `PARAM_HIDDEN_BYTES_UNKNOWN` names the bytes and the
  remedy in the server's message; the localized text shows the remedy only, and not which parameters
  without memory are still to be assumed.
- **The interface's maximum APDU from the Busforge bridge.** Over TCP the bridge does not answer the
  `SEARCH_REQUEST_EXTENDED` Busforge asks the interface's maximum APDU with; ETS asks the interface
  object's PID 56 with a cEMI `M_PropRead` (`DEVICE_CONFIGURATION_REQUEST`) and gets the USB limit (40).
  Busforge writes 12 bytes there. Either the bridge answers the search over TCP, or Busforge asks as ETS
  does ([status.md](status.md#known-unproven)).
- **The tunnelling feature services as ETS uses them.** On an interface that advertises tunnelling
  version 2 (the MDT IP interface), ETS 6 asks the bus connection status (`TUNNELLING_FEATURE_GET`,
  feature 0x03) right after it connects over TCP, and switches the interface's feature info service on
  (`TUNNELLING_FEATURE_SET`, feature 0x08 = 1); the Busforge bridge advertises version 1 and ETS asks it
  nothing. Busforge asks neither, so an interface that is not on the bus shows as a device that does not
  answer. Needs: the same exchange, with a refusal where the interface reports no bus, tried against a
  tunnelling-v2 interface; no capture shows the exchange over UDP.
- **A device at the tunnel's own address.** A device tells management clients apart by source address
  only, so a device holding the address the interface gives the tunnel would share its connection.
  No ETS capture addresses the tunnel's own address, and none shows what ETS does on a collision;
  bussard reads the device descriptor of that address before each connection and refuses when
  something answers. Needs: how each interface (the Busforge bridge, a USB stick, an IP interface)
  passes a frame addressed to its own tunnel address, tried on hardware before such a check can be
  trusted.
- **A T_NAK from the device counts as its T_ACK.** `KnxDevice` takes any transport control frame with
  the request's sequence number as the acknowledgement, so a refused frame waits out the response
  timeout and is repeated instead of failing at once. `KnxDevice.restart()` notes a T_NAK on its probe
  separately and takes it as the device still being there (`RESTART_IGNORED`, or accepted where the
  firmware persists at `LoadCompleted` and the restart was confirmed).
- **The restart's proof over UDP.** Over a KNXnet/IP tunnel on UDP Busforge does not see the
  interface's `L_Data.con`, so a restart that never reached the bus takes the positive row of
  [the restart's proof](load-procedures.md#a-negative-confirmation-of-the-restart-frame), where an
  unanswered probe proves the reboot. Open decision: wait for the confirmation over UDP too, or prove
  every restart there as an unconfirmed one.
- **The stamp record on System 7.** With its record (PID 27 stamps) ETS's parameter download of the
  Gira M-0008 writes a changed byte alone (a byte in the middle of `AS-444E`), and the unstamped segment
  `AS-454E` whole; but a change of `0x435F` brings the three unchanged bytes before it along, every time.
  The rule behind those three is not shown (next capture: a change of `0x435D`/`0x435E` or of a bit in
  `0x435C`), so Busforge keeps no record on System 7 and writes the whole image there
  ([load-procedures.md](load-procedures.md#the-rules-by-level)). The unit ends the same.
- **The System B partial form of the full download under the stamp record.** It writes the owned bytes
  that differ from the unit's read, without a stamp check; every ETS capture of the partial form ran with
  matching stamps, so what ETS writes there without a record is not shown. The unit ends the same.
- **Text parameters beyond what ETS's images show.** Characters beyond ASCII that ETS's captures do not
  show (where the application declares no encoding, one above `FF` or one where ISO 8859-1,
  Windows-1252 and ISO 8859-15 differ, such as the euro sign; any under a declared encoding other than
  `utf-8`; next capture: ETS downloads of such texts, with and without `iso-8859-15` declared), a value that fills its field where the application declares
  `TextParameterZeroTerminate` (the GVS AMMA), and text on
  System 7 applications beyond what ETS's captures show (the Steinel M-008E; on the Meteodata 140 S a
  value that fills its field or meets a non-zero `<Data>` byte) are refused until a capture shows them. The editor does not check a text against its field when it is saved: the
  refusal comes at the flash
  ([device-memory-model.md](device-memory-model.md#which-parameter-types-reach-the-image-at-all)).
- **Raw-data parameters (`TypeRawData`).** No ETS download shows the layout of one, so the image writes
  none and an operation that would have to write one away from its default or from what the device
  holds is refused (`PARAM_RAW_DATA_UNSUPPORTED`); next capture: an ETS download of an application with a
  raw-data parameter changed in the editor
  ([device-memory-model.md](device-memory-model.md#which-parameter-types-reach-the-image-at-all)).
- **`InitialValue` forms ETS's captures do not show.** A device placed in Busforge, or given another
  product, starts a text parameter at its `Parameter`'s translated `InitialValue`; an untranslated one,
  one on a `ParameterRef`, beside a ref's own `Value`, on another type or in a module definition refuses the
  placement where it reaches the device (`PARAM_INITIAL_VALUE_UNSUPPORTED`); next capture: ETS adding
  such a product to a project and downloading it. Busforge has no project language: the client's
  language stands in for it.
- **Colour parameters beyond RGB on System B.** An RGB colour on a relative segment is written as
  ETS writes it; an HSV colour (the DALI-Gateway's and the MDT BE-06001.02's), any other space, and a
  colour on a System 7 device are refused (`PARAM_COLOR_UNSUPPORTED`) until an ETS download of one in
  use shows its bytes (e.g. the BE-06001.02's LED colour set in ETS)
  ([device-memory-model.md](device-memory-model.md#which-parameter-types-reach-the-image-at-all)).
- **One parameter, several references.** Where an application gives one parameter several
  `ParameterRef`s, the image builders encode each and the last one wins; no corpus application
  shows two of them disagreeing, but a builder should write only the parameter's effective reference.
- **Deactivated parameters in the System 7 parameter flash.** ETS writes where its whole image
  changes, so a parameter a change deactivates goes back to its `<Data>` template value
  ([findings.md](findings.md) §28). The structural flash does that; the plain parameter flash still
  writes only active parameters' bytes, leaving old values in bytes nothing reads.
- **Idle unions in module instances.** The full download and the System B parameter flash write an
  idle union's `DefaultUnionParameter` as ETS does, except in module instances, which no capture covers; there
  those bytes stay unowned.
- **Merged parameter load procedures.** Only a minimal single-segment subset of the declared
  procedures is executed; a procedure with image-property stamps the engine cannot compute is
  refused (`LOAD_STEP_UNSUPPORTED`).
- **Property-based loading** for devices that expose an object model instead of a memory image,
  and the fixed-EEPROM model of **System 2**. Both are recognised and refused today; each is a
  generic, mask-keyed capability, not per-device code.
- **System 1 beyond the MDT IP Interface Secure.** The download of a Data Secure KNXnet/IP interface on
  MV-0012 is written as ETS's capture shows it; every other System 1 application, and every KNXnet/IP
  setting that capture does not show (a device name, DHCP, tunnelling users, IP Secure, the
  installation's routing settings), is refused until a capture shows it. The group tables with entries
  are not decoded, and no System 1 group-address download is captured.
- **Read memory past `0xFFFF` without the extended services, and show `A_UserMemory` on a unit.**
  Busforge writes such memory with `A_UserMemory_Write` as ETS writes it into a device simulator, and
  reads nothing there (`USER_MEMORY_UNSUPPORTED`): no capture shows `A_UserMemory_Read`, so a backup,
  a comparison, a parameter or structural flash and a read-back are refused, and a full download whose
  segment the device's CRC does not prove is reported unverified. Needs an ETS capture that reads such
  memory, and a unit with such an application for transfer evidence
  ([device-memory-model.md](device-memory-model.md#a_usermemory-past-64-kb-without-the-extended-services)).
- **Request sizes through a coupler as ETS sizes them.** In a plain session, a device on another line
  than the interface gets standard frames only, which every coupler passes but which make a download
  slower ([connections.md](connections.md#devices-behind-a-coupler)). Needs an ETS download to a device behind
  a coupler that passes long frames, logged through the proxy with ETS's own log, to show whether ETS
  reads the coupler's maximum APDU and which sizes it then sends. Until then, a property read whose
  answer length the caller sets (an IP device's friendly name, the raw acquisition's property scan) is
  not held to a standard frame there, and a dropped answer shows as a device that does not answer.
- **Time a large MV-0705 download against the stop grace period.** The 30-minute
  `stop_grace_period` ([deployment.md](deployment.md)) has been measured only against small MV-0705
  images.

## Verification

- **No idle connection in the System 7, System 1 and secured writes, tested.** The session-idle test
  (`apps/server/test/session-idle.test.ts`) runs the System B writes through their restart and
  verification against an emulated unit that closes an idle connection; the other families' writes run
  in the same session envelope but no emulated unit takes their writes yet.
- **Reusing one KNXnet/IP tunnel object across reconnects.** The device sessions reopen their link
  through a fresh tunnel each time; a `KnxIpTunnel` used directly (tools) and reopened without a
  disconnect leaks its earlier UDP socket and, after a failed connect, sends its disconnect for the
  earlier channel. Close the old socket on every connect and disconnect only an established channel.
- **Echo checks on every management answer.** A memory read refuses an answer for another address, a
  property read one for another object, PID or start, a repeated data frame is dropped at the
  transport layer, and every request takes only its own answer service. A data frame the device
  addresses to another tool's address is still taken (and acknowledged) by the session as the answer.
- **The stale answer after a cut-off flash, on hardware.** That a session straight after a write cut
  inside its load bracket drops the device's repeated answer and reads the real mask is shown against
  a scripted device only ([findings.md](findings.md) §31). A cut on the bench with the transport
  traffic logged would show it on a device.
- **The persistence check on a unit that confirms no restart and closes no connection.** After a
  negatively confirmed A_Restart the check needs two silent probes in a row, and each silent probe
  takes about 4.9 s; the MEAN WELL power supply is silent for 1.5 s between the interface's negative
  confirmations and its start-up, so the check sees one and leaves the step not assessed
  (`tools/smoke/persistence.test.ts`). Proving such a reboot from what the unit shows on its own (its
  start-up telegrams) would need the evidence contract to admit it first.
- **Turn the ETS-capture diff into a live read-back gate.** `our image == ETS` can only be checked
  where a captured ETS download exists. Diffing the built image against the device itself, with the
  segment base the device assigned, would catch that class of bug without a capture.
- **`tools/readback.ts` cannot read MV-0705 devices**; the server's read-back can. The tool should
  use the same absolute-segment path.
- **Verify System 7 segments by the device's CRCs, as System B's full download does.** ETS reads the
  memory-control block (PID 27) on MV-0705 too (Gira M-0008: six regions on its application object);
  whether each region's CRC is the CRC over the bytes ETS wrote there is not yet compared against the
  captures. Until it is, the System 7 full download reads every write back.
- **Show that System B devices compute their segment CRC again after the restart.** The full
  download takes a region's CRC in place of its read-back. That the device computes it from its memory
  after the restart, and does not keep the one of the load, is shown on the Jung 400021SE (a capture)
  and thelsing/knx (its source); on the GVS AMMA, the Theben MIX 2, the Theben DALI-Gateway and the MEAN
  WELL power supply the CRC is shown at the close of the download only. A capture of a later session
  where a byte the device changes itself shows in its CRC, or a bench check, settles it per device.
- **Traffic capture in the gateway process.** The tap points and decoders exist; the `--capture`
  flag that writes a decoded transaction log does not.
- **A com-object flag a device holds otherwise than its project, read back off the bus.** The bench
  smoke runs read every flag on the bus and found the imported project's; units in service take theirs
  as the project's. A flag set by another tool is shown on emulated units only.
- **Interface object properties in the in-service restore.** The restore of a run on a device in service
  compares the unit's memory with the backup collected before the first write, byte for byte; the
  properties the writes set (load states, memory control blocks with their stamps, a KNXnet/IP object's
  parameters) are collected too but not compared. A memory-only collection would also take the
  interface-object scan out of each backup's bus time.
- **The unread-attribute audit.** [ets-coverage.md](ets-coverage.md) names a script that lists every
  product-XML attribute the parser never reads; it does not exist, the table is maintained by hand.

## Device coverage

- **Load-procedure steps refused until a capture shows them, or until Busforge follows one.** Steps on
  LSM 5 other than its task segment, the PEI program on System B, OEM task segments, segment sizes
  that disagree, `Delay`, `MapError`, `InvokeFunctionProp`, `MasterReset`, `TaskPtr`, `TaskCtrl2`,
  property writes inside the load, `DeclarePropDesc`, `CompareRelMem`, `<choose>` in a procedure: what is
  shown of each and what settles it is in [load-procedures.md](load-procedures.md#steps-refused-until-a-capture-shows-them).
- **The com-object table of an application with an ETS download plugin, or a product with a factory
  image.** The communication flag of an object without a group address is shown cleared only for
  applications without a download plugin on products without a factory image
  ([device-memory-model.md](device-memory-model.md#the-communication-flag-on-unlinked-objects)). An
  application that names a plugin is refused the writes of the table (`COM_OBJECT_TABLE_DOWNLOAD_PLUGIN`).
  A factory image is not yet detected: `Hardware2Program/@LoadedImage` has to be taken from the catalogue
  at import and reach the write path, as the PEI program does, so that a product whose factory image
  holds the com-object table is refused the same writes. An ETS capture of a download of either kind
  settles what the table holds; no product in the test corpus is of either kind.
- **Prove a non-TP device.** One read-back on real powerline, RF or IP hardware promotes that row
  from extrapolation to proof. Hardware verification help is welcome.
- **OpenKNX surgical flashes under an automated run.** The device-in-service spec
  (`openknx-raumcontroller-in-service`) drives the parameter flash and the GA flash on a commissioned
  unit, each reverted and read back, with a bus check and a restart; it passes on hardware in both
  channels, its full download of the configuration found included. A run of it is refused today before
  its first write: the unit reports no memory control block (PID 27), so a collection cannot size its
  tables, and the run's restore needs a complete backup of the unit's memory. Still open: sizing its
  tables for the collection, the comparison with an ETS partial download (on a unit with a matching ETS
  project), and a power cut.
- **Hidden bits after an in-service structural step.** The run's restore compares the bits the found
  configuration owns, so a structural step whose revert hides parameters could leave other bits than the
  segment's `<Data>` at them unnoticed. A spec that takes hidden values from the installation's project
  (`hiddenValuesFromProject`) compares every hidden bit with `<Data>` before its writes, after its
  structural step and its full download, and in the undo after a broken-off step (`hiddenDiffer`). Still
  open:
  - The check is opt-in: other System 7 specs with a structural step that shows hidden parameters do not
    run it, and the spec rules do not ask for the flag.
  - Bits the structural step writes that its revert does not set back (an `Access="None"` parameter with
    memory that only the step places, bits past the end of a segment's `<Data>`, a segment without
    `<Data>`) are not refused before the step; the check after the step reports them as a failure, with
    the unit left changed for a recovery by hand.
  - The step's com-object table entries are written in ETS's template form, and only their config byte
    is compared with the unit before.
- **Devices in service with KNX Data Secure.** The device-in-service mode takes a secured unit from
  the installation's project file and runs under its secure session, also through an interface whose
  tunnels the unit's restart drops, connecting again after each restart ([testing.md](testing.md#devices-in-service)).
  Its two specs, the MDT IP Interface/Router and the MDT IP Interface Secure, pass in both channels on
  units in service ([status.md](status.md)). Still open: the router's reboot was not seen; in both
  channels' runs the interface dropped the run's tunnel while the secured A_Restart went out (its
  persistence step not assessed; load states and configuration read back unchanged). The router's web interface password
  reads back as `FF` after any write; the parameter flash leaves it alone while the project has not
  changed it since the last programming, so the router's adoption finds nothing to write there (the
  flash's choice pinned against ETS's captures and a scripted unit; no run on the unit). Neither unit's run can be emulated from its
  collections (no collection reads a security object, and the IP Interface Secure's none of its
  KNXnet/IP parameter object); the router's read-back can, and is pinned on one taken after ETS's
  group-address download.
- **The short association table in the full download and the structural flash.** A System B unit
  that describes its association table with one-byte fields (`PDT_GENERIC_02`, the MDT IP
  Interface/Router) gets that form from the GA flash, as ETS writes it; the full download and the
  structural flash build the long form only and refuse such a unit (`ASSOC_TABLE_SHORT_UNSUPPORTED`).
  ETS's full download of the router writes the short form; the router's full download is refused for
  its tunnelling entries anyway, and no other product is known to use the short form.
- **Input-to-output behaviours on a device in service.** The mode places one test link, so only a
  behaviour of that one object (`output`, `heartbeat`) can be observed; an input driving an output
  needs two.
- **Devices that answer an opaque device descriptor** (IP interfaces) need a different read path or
  secure support; which one is not decided.
- **KNX IP interfaces as targets.** ETS's captured full download of the MDT IP Interface/Router writes
  no property of the KNXnet/IP parameter object, and its project instance holds no tunnelling addresses
  (the box's other application holds them, [device-support.md](device-support.md#known-gaps)).
  `FULL_DOWNLOAD_TUNNELING_ENTRIES` still refuses that application on its attribute alone. Open decision:
  let the gate look at the instance's own addresses, so that an application declaring entries whose instance
  has none is offered the full download once its other refusals are lifted; an instance with addresses keeps
  waiting for an ETS capture of its download.
- **Should the group-address flash run the application's checks?** A declared `CompareProp` (the ABB
  US/U 4.2's application-id check, for example) runs in the parameter flash and the full download, not
  in the group-address flash ([load-procedures.md](load-procedures.md#coverage-across-the-catalogue)).
- **A System B group-address download onto an unchanged com-object table.** With a record whose
  download wrote the table and equal stamps, ETS leaves out the table's identical bytes; whether it
  then still unloads, reallocates and completes the table with no byte written is not captured, so
  Busforge writes the table whole there (`relativeComObjWriteSet`). Next capture: a link moved from one
  group address to another on an already linked object, right after a full download.
- **The full download of the Steinel M-008E and the Auro `M-0081_A-FF31`.** Both are refused for
  their segments (a parameter segment without `<Data>`, a `<Mask>` of a form no capture shows); each
  needs an ETS full-download capture before it is lifted
  ([load-procedures.md](load-procedures.md#coverage-across-the-catalogue)).
- **System 2 (BCU2, MV-0020, MV-0021, MV-0025).** Recognised and refused, and no System 2 device is on the
  bench or planned. What is reported about its download (property-mapped 10-octet load controls, a second
  task control, task segments with the full application identity, the indexed association table, 3-octet
  com-object descriptors, a two-octet table reference, a task segment on LSM 5 that is tool metadata and
  never sent, three master-data procedure styles) is collected, unproven, in
  [raw-acquisition.md](raw-acquisition.md#system-2-bcu2-mv-0020-mv-0021-mv-0025). It becomes work only with
  a System 2 unit and an ETS capture of its downloads; nothing of it is implemented.
- **The association table of System 1 and System 2 with entries.** Reported as one reserved slot per group
  object (the sending link, or `FE`), further links in the unused slots first
  ([raw-acquisition.md](raw-acquisition.md#system-1-bcu1-mv-0010-to-mv-0013-mv-1011-to-mv-1013-mv-3012-mv-4012)).
  Needs a System 1 unit with links that ETS programmed, read back, to decode the read-back and close the
  "tables with entries are not read" gap; a write needs an ETS capture of such a download.
- **Coupler and router filter tables (MV-0900 to MV-091A, MV-1900, MV-2920).** Open: which memory or
  property holds the table per mask beyond what the master data gives, the bit order, how the use of the table is switched on, which router object
  of the media coupler MV-2920 carries it (reported: the secondary), the route-table control commands, and
  which group addresses ETS lets through. Reported, unproven, in
  [raw-acquisition.md](raw-acquisition.md#couplers-and-routers-mv-0900-mv-0910-mv-0911-mv-0912-mv-091a-mv-1900-mv-2920).
  Needs an ETS capture of a filter-table download on one memory-configured and one property-configured
  coupler, and a coupler.
- **Domain address of powerline and RF devices.** Busforge has no step for it. Reported, unproven: the
  domain address is a 2-octet property of the device object on System B powerline (PID 70), memory
  `0x0102` on powerline BCU1, a 6-octet property (PID 82) on RF System B and RF 7.5; it is set and read
  with `A_DomainAddressSerialNumber_Write` and `_Read`; an RF S-mode device has no fast
  acknowledgement, so a group write can be lost and management relies on the transport acknowledgement.
  Needs a powerline or RF device and an ETS capture; every device Busforge has met is twisted pair.
- **Reported device behaviours, none seen on our hardware.** Protocol shapes other tools report for
  products we do not hold, each a lead for those products only (the products and sources are in the
  private corpus), none of them a rule: a unit that merges its declared memory-control-block regions
  after `LoadCompleted`, so the read of the declared count gets fewer entries; a unit that answers
  `LOADED` right after the load event; a unit that refuses memory reads of its own loaded tables; a unit
  that answers a read starting in the middle of a table with nothing, so each table has to be read from
  its own table reference; a table base that differs from the application's declared address by a few octets, so
  a base always comes from the table reference or the product; a unit that takes fewer than the
  APDU allows per memory service (12 octets reported for one presence-detector family); a unit
  that sets or changes a bit or byte of an active parameter itself after every download (the
  download-marker rule covers only parameters with `Access="None"`); a master reset or restart that is not confirmed; a
  unit whose firmware ignores a serial-number address write; a unit that identifies as a newer mask
  than its product data names (`DownwardCompatibleMasks` in the master data); a unit behind a plug-in
  download whose standard procedure would overwrite the plug-in's configuration. Each is looked at when
  such a product is met, with its own capture.
- **Firmware behaviour of the OpenKNX stack** (the stack of the owned RaumController). Reported: an unload
  is volatile until a restart on older builds, because the stack writes its metadata to flash only on a
  restart; a firmware update that changes the stack's API version, manufacturer or hardware type discards
  everything including the address, one that changes only the device-object version keeps the address and
  leaves every table unloaded. A unit found unloaded after a firmware update is then the firmware's doing,
  not a failed flash. A com-object table loaded with no entries is an error on that stack, and a rejected load step
  leaves its reason in PID 28 of the table object, which Busforge does not read. Needs a bench check on
  the RaumController of which build behaves which way.
- **Specification notes.** Reported from a reading of the specification, unproven here: a device's verify
  mode is not meant for a tool's use; ETS enables it before a download, and so does Busforge on the System B
  full download ([commissioning.md](commissioning.md)). The restart's erase codes run from 1 to 8 as the
  specification is read; Busforge names the codes up to 7, and no capture of ours shows 8.

## Raw acquisition

What the collector ([raw-acquisition.md](raw-acquisition.md#implementation)) does not attempt yet:

- **Compare a package with a read-back** of the same System B and M112 device, as the control case.
- **System 300 variant plans**, **discovery by `PID_IO_LIST`** on MV-2920, and **coupler filter
  tables** (needs a capture of a tool reading one).
- **Bound a System B table by the product XML** when its memory control block is absent, and check
  a present one for plausibility.
- **A private route for diagnostic packages.** Only the receiving end exists
  (`tools/intake.ts`); the transfer service (expiring
  invitations, size limits, no anonymous endpoint) is still to choose and build.

## KNX Data Secure

Data Secure is in the alpha scope: device access and programming with known credentials,
activating a factory device from its certificate so that setting up a secure device needs no
existing ETS project, and, as far as their feasibility is shown, secured group communication with
keys Busforge generates and decoding secured telegrams in the monitor. How far each is shown is in
[status.md](status.md). KNX IP Secure transport is a separate capability and not an alpha prerequisite. Diagnostic access uses valid credentials
where they are required; raw acquisition is not a way around access control. What is still open:

- **The security object on System 7.** Only System B loads it; the others refuse a secure device's
  GA flash and full download.
- **Individual-address assignment of a secure device as ETS does it.** Busforge assigns it plain, and a
  unit in Data Secure mode ignores the plain `A_Restart` that ends programming mode, so it stays in it.
  ETS finds the unit by its serial (`A_SystemNetworkParameter_Read` of PID 11 while it is in programming
  mode, `A_IndividualAddressSerialNumber_Read` without), Syncs to `0/0/0` and sends the serial-number
  write as a secured broadcast, under the FDSK on a reset unit
  ([knx-secure.md](knx-secure.md#individual-address-assignment)) and under its tool key otherwise, with
  Data Secure on or off in the project (captured on the Jung 400021SE with it on and off, on the GVS AMMA
  with it on). On the secured
  connection that follows it switches the security mode on, writes the tool key and the sending sequence
  (PID 59) where the project has Data Secure on, reads the security mode where it is off, reads the serial
  number and ends with a secured confirmed restart ([commissioning.md](commissioning.md)).
- **Repeat a secured write that fails at the long size at 40 octets,** as ETS does ("switching to
  shorter frames"), and then size secured writes up to the interface's full length as ETS does. Until
  then a secured write uses the interface's announced length only on the interface's own line and
  within the 55 octets shown answered, and a path that carries less than its interface announces fails
  the write.
- **The sending sequence (PID 59) at an address assignment.** ETS writes it at every address assignment
  of a unit the project runs in Data Secure, also where nothing is re-activated (the Jung 400021SE and the
  GVS AMMA). Busforge writes it on a re-activation only; its address assignment is plain (above).
- **A master reset before downloading a secure-capable application over another one.** Reported for
  ETS (erase code 7 on such a device, none on a fresh one or one holding the same application); not
  captured, as the bench's secure units have one application each. ETS sends a secured confirmed restart
  with erase code 7 when the project switches a secured unit's Data Secure off, then switches the security
  mode off itself and writes the FDSK as the tool key; the Jung 400021SE answers that restart without error
  and restarts, and still opens under its tool key afterwards. Needs an ETS capture of such a download
  before anything is built.
- **Busforge's secured master reset is not answered where ETS's is.** On the Jung 400021SE Busforge's
  secured A_Restart with erase code 7 gets no answer and resets nothing, ETS's secured confirmed restart
  with erase code 7 is answered without error and restarts the unit ([findings.md](findings.md) §19). What
  differs between the two frames is not explained; Busforge's frame held against ETS's from its ETS6.log
  settles it.
- **A smoke behaviour on a fresh address Busforge secures,** to show the device acting on a
  Busforge-generated key, not only holding it.
- **Sending:** read the interface's L_Data.con over UDP, extended frames for values longer than
  6 bits, and coordination with another tool sharing the sender address.
- **Peers that only answer reads on a secured address, or transmit with it as a further address**
  (`SECURE_SENDERS_UNPROVEN`), and **an older group key at or below the last index a load writes**
  (`SECURE_KEY_TABLE_UNPROVEN`: a secured address made plain below a secured one that stays, or several removed with plain addresses between) need
  an ETS capture each, the latter also how the device looks a key up.
- **Monitor replay history across reconnects**, and refreshing a device's stored sequence number from
  the secured telegrams the monitor decrypts.
- **Unresolved `Links` tokens at import** can shift the sending address; the PID 54 sender rule
  trusts the stored order.
- **Project-level com-object flags in the PID 54 sender rule**: it still uses the application's
  flags; the device page and the group-address view show the project's.
- **Handing a Busforge-activated device to other tools.** ETS 6 takes only certificates from a
  keyring ([findings.md](findings.md#29-ets-imports-only-the-certificates-from-a-keyring)); whether
  xknx or Calimero talk to such a device on the bus is not shown; a keyring names a lone sender
  nowhere, which xknx needs.
- **Key changes on hardware:** two secure devices on a Busforge-secured address, a plain device on a
  turned-plain one, and an ETS capture of a Busforge-generated key.
- **Cache the security flag across project reads** for projects with many secure devices.
- **Flag a secure device whose memory model does not load the security object** when its keys or
  senders change; today Busforge refuses its group tables and ETS has to write them.
- **Apply the security mode in every link writer** (revert, snapshot restore, product replacement);
  today their mismatches are refused at flash time.

## Storage and catalog

- **Persist the parsed product model** in the catalog instead of the raw application-program XML.
- **An online product catalog** as a third ingest source, next to `.knxproj` and `.knxprod`.
- **Refuse a database migrated by a newer version** instead of running on it unchecked
  ([deployment.md](deployment.md#backup-restore-and-upgrade)).
- **A project value outside its parameter's type.** An edit and a revert refuse one, but an imported
  `.knxproj` or `.busforge`, a restored snapshot, and a project stored before that refusal can still
  hold one (no option of its enumeration, a number outside its bounds); the device page shows it as
  such, and a download writes it as any value that fits the field's bits. What ETS does with such a project value is not captured;
  until it is, whether the import should refuse it or the download should is open.

## Product and UI

- **Hidden preserved links in the replace-device flow.** The dialog offers rows only for visible
  links, so a device with a link hidden by parameter visibility is refused with no way forward.
- **Hidden linked com-objects of a module instance in the group-address device list.** A link on a
  com-object that parameter visibility hides is listed only for objects outside module instances;
  one inside a module instance is left out of the list without a word.
- **A hidden parameter's old baseline shows as a change nothing can clear;** the change count should
  leave out a ref the configuration does not show, or the full download should settle it.
- **Warn when the gateway is handed an address that is not the interface's own**, where a USB stick
  answers management only on its own address.
- **Two identical USB interfaces told apart on hardware** (unit-tested only).
- **The flash preview names the bytes read as `FF` that the parameter flash leaves alone** (`leftFF`):
  the result carries them, the preview shows no difference there and says nothing of them.
- **A change that sets only bytes the unit reads as `FF` to `FF` is reported unchanged.** System B's
  parameter flash, and its structural flash where nothing else differs, compare with the read, which
  shows no difference there; nothing is written. With any other change beside it the byte is written (the
  differential decides such a byte against the programmed baseline), but the preview's and the result's
  count of changed bytes and their list of bytes read as `FF` leave it out. Needs: count those bytes
  against the baseline's image, as the write set does.
- **The com-object table of a never-programmed device that keeps a surgical flash.** Such a device (an
  application that declares tunnelling entries, a System 7 application without group-table segments) is
  programmed by the parameter and the group-address flash. The parameter flash keeps the com-object table
  the unit holds, and whether that table fits the project's configuration is decided against the
  programmed baseline, which for such a device holds its defaults and start values, not what the unit
  holds; its verified result still ends the never-programmed state. On System 7 the group-address flash
  keeps the table's configuration bytes as well. Needs: the table read or written before that state ends.
- **The System B parameter flash counts the bytes that differ, not the bytes it writes.** Where it takes
  every owned byte (no stamp record, stamps other than the record, an application not `LOADED`, a device
  never programmed from this project) its preview and its result name the bytes that differ from its read
  ("0 bytes written" where the read shows none), though every owned byte goes out. Needs: the result to
  count the written set, and the preview to say that the write goes out whole.
- **DCA-replacement plugins, phase 2:** writing a device-specific configuration back.
- Remaining parity gaps in the configuration view are tracked in [ets-coverage.md](ets-coverage.md).
