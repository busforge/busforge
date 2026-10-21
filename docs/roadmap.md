# Roadmap

What is next, and why. How far every claim is proven today lives in [status.md](status.md); this
page only lists open work. Nothing here is scheduled, and nothing is started until the capability it
depends on is hardware-proven.

## Programming paths

- **Hardware runs of the operations the rules changed.** The plans follow the catalogue, family and
  KNX-wide rules ([load-procedures.md](load-procedures.md#the-rules-by-level)); where that changed a
  plan, the new one is capture-tested only ([status.md](status.md#devices-driven-on-real-hardware)):
  the ABB US/U 4.2 and MDT BE-02001.02 full download and group-address flash, the MDT's structural
  flash, every download of the Jung 400021SE and the GVS AMMA, the OpenKNX full download, the
  System B partial form of the full download on the Jung 400021SE, the Theben DALI-Gateway's full
  download onto a unit without the application, the structural flash newly offered on the Auro,
  Gira, Meteodata 140 S, Theben MIX 2, ABB US/U 4.2 and MEAN WELL power supply. Each needs its
  run on the device.
- **The interface's maximum APDU from the Busforge bridge.** Over TCP the bridge does not answer the
  `SEARCH_REQUEST_EXTENDED` Busforge asks the interface's maximum APDU with; ETS asks the interface
  object's PID 56 with a cEMI `M_PropRead` (`DEVICE_CONFIGURATION_REQUEST`) and gets the USB limit (40).
  Busforge writes 12 bytes there. Either the bridge answers the search over TCP, or Busforge asks as ETS
  does ([status.md](status.md#known-unproven)).
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
- **Text parameters beyond what ETS's images show.** Characters beyond ASCII, a value that fills its
  field where the application declares `TextParameterZeroTerminate` (the GVS AMMA), and text on
  System 7 applications (the Meteodata 140 S's EIS 5 channels, the Steinel M-008E) are refused until
  a capture shows them. The editor does not check a text against its field when it is saved: the
  refusal comes at the flash
  ([device-memory-model.md](device-memory-model.md#which-parameter-types-reach-the-image-at-all)).
- **Colour parameters.** No ETS download captured holds a colour in use, so a flash that would write
  one is refused (`PARAM_COLOR_UNSUPPORTED`); an ETS download of an RGB and an HSV colour in use
  (e.g. the DALI-Gateway's colour control type set to RGB) shows the encoding
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
- **A secured session across a tunnel that comes back under another address.** When an interface
  drops its tunnels after a restart (an MDT IP interface beside a restarting MDT IP router), the link
  can come back under another individual address; Busforge then refuses the read-back
  (`TUNNEL_ADDRESS_CHANGED`) rather than go on with a session bound to the old one, so the write is not
  verified. Rebinding the session (same tool key, sequence kept, Sync again) would verify it. No ETS
  capture shows the case: ETS reads nothing back after the restart.
- **Echo checks on every management answer.** A memory read refuses an answer for another address,
  a repeated data frame is dropped at the transport layer, and every request takes only its own
  answer service. `propRead` still takes a property answer for another object, PID or start: a late
  answer to an abandoned earlier property read would be taken as its own. Check the echo, as
  `propReadIfPresent` does. A data frame the device addresses to another tool's address is also still
  taken (and acknowledged) by the session.
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
- **Verify large absolute segments by a device-provided checksum,** if these masks expose one, with
  the byte read-back as fallback. The read-back stays the evidence behind `verified`.
- **Traffic capture in the gateway process.** The tap points and decoders exist; the `--capture`
  flag that writes a decoded transaction log does not.
- **A com-object flag a device holds otherwise than its project, read back off the bus.** The bench
  smoke runs read every flag on the bus and found the imported project's; units in service take theirs
  as the project's. A flag set by another tool is shown on emulated units only.
- **The unread-attribute audit.** [ets-coverage.md](ets-coverage.md) names a script that lists every
  product-XML attribute the parser never reads; it does not exist, the table is maintained by hand.

## Device coverage

- **Prove a non-TP device.** One read-back on real powerline, RF or IP hardware promotes that row
  from extrapolation to proof. Hardware verification help is welcome.
- **OpenKNX surgical flashes under an automated run.** The device-in-service spec
  (`openknx-raumcontroller-in-service`) drives the parameter flash and the GA flash on a commissioned
  unit, each reverted and read back, with a bus check and a restart; it passes on hardware in both
  channels, and its records enter the shipped evidence once the application program is in the
  catalogue the bundle reads. Its full download of the configuration found, offered on request, has not
  run. Still open: the
  comparison with the full download and an ETS partial download (on a unit with a matching ETS
  project), and a power cut.
- **Devices in service with KNX Data Secure.** The device-in-service mode takes a secured unit from
  the installation's project file and runs under its secure session, and it refuses an interface the
  unit's restart cuts ([testing.md](testing.md#devices-in-service)). Its two specs, the MDT IP
  Interface/Router and the MDT IP Interface Secure, have not run. The router's web interface password
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
- **KNX IP interfaces as targets.** Evaluate the captured ETS full download of the MDT IP
  Interface/Router for what it writes for the tunnelling entries, model it, then lift
  `FULL_DOWNLOAD_TUNNELING_ENTRIES` against that capture.
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
- **Individual-address assignment of a secure device.** It is a broadcast and cannot use a session.
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
- **DCA-replacement plugins, phase 2:** writing a device-specific configuration back.
- Remaining parity gaps in the configuration view are tracked in [ets-coverage.md](ets-coverage.md).
