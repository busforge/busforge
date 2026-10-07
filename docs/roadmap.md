# Roadmap

What is next, and why. How far every claim is proven today lives in [status.md](status.md); this
page only lists open work. Nothing here is scheduled, and nothing is started until the capability it
depends on is hardware-proven.

## Programming paths

- **Structural flash for more families.** Today only the Jung 400021SE and the MDT BE-02001.02 get a
  parameter change that alters the com-object table as a structural flash
  ([load-procedures.md](load-procedures.md#structural-flash)); every other device gets the full
  download. Each further application needs an ETS capture of such a partial download and a smoke run
  of its `structuralTrigger`: the GVS AMMA (persists at every `LoadCompleted`), the ABB US/U 4.2
  (memory-mapped System 7), and OpenKNX/thelsing, whose full download has to write the tables before
  the parameter image, which the structural bracket does not.
- **Deactivated parameters in the System 7 parameter flash.** ETS writes where its whole image
  changes, so a parameter a change deactivates goes back to its `<Data>` template value
  ([findings.md](findings.md) §28). The structural flash does that; the plain parameter flash still
  writes only active parameters' bytes, leaving old values in bytes nothing reads.
- **The Jung 400021SE clears the last byte of its parameter segment by itself** (offset `0x1E14`,
  [findings.md](findings.md) §27), so a parameter-flash dry run always reports one differing byte.
  Whether the byte is a one-shot marker to leave out of the comparison is not established.
- **Idle unions in module instances.** The full download and the System B parameter flash write an
  idle union's `DefaultUnionParameter` as ETS does, except in module instances, which no capture covers; there
  those bytes stay unowned.
- **Merged parameter load procedures.** Only a minimal single-segment subset of the declared
  procedures is executed; a procedure with image-property stamps the engine cannot compute is
  refused (`LOAD_STEP_UNSUPPORTED`).
- **Property-based loading** for devices that expose an object model instead of a memory image,
  and the fixed-EEPROM models of **System 1 / System 2**. Both are recognised and refused today; each
  is a generic, mask-keyed capability, not per-device code.
- **Time a large MV-0705 download against the stop grace period.** The 30-minute
  `stop_grace_period` ([deployment.md](deployment.md)) has been measured only against small MV-0705
  images.

## Verification

- **Turn the ETS-capture diff into a live read-back gate.** `our image == ETS` can only be checked
  where a captured ETS download exists. Diffing the built image against the device itself, with the
  segment base the device assigned, would catch that class of bug without a capture.
- **`tools/readback.ts` cannot read MV-0705 devices**; the server's read-back can. The tool should
  use the same absolute-segment path.
- **Verify large absolute segments by a device-provided checksum,** if these masks expose one, with
  the byte read-back as fallback. The read-back stays the evidence behind `verified`.
- **Traffic capture in the gateway process.** The tap points and decoders exist; the `--capture`
  flag that writes a decoded transaction log does not.
- **The unread-attribute audit.** [ets-coverage.md](ets-coverage.md) names a script that lists every
  product-XML attribute the parser never reads; it does not exist, the table is maintained by hand.

## Device coverage

- **Prove a non-TP device.** One read-back on real powerline, RF or IP hardware promotes that row
  from extrapolation to proof. Hardware verification help is welcome.
- **OpenKNX surgical flashes under an automated run.** Compare surgical flash, full download and ETS
  partial download (on a unit with a matching ETS project) on one RaumController, each followed by a
  read-back, a bus check and a power cut.
- **Devices that answer an opaque device descriptor** (IP interfaces) need a different read path or
  secure support; which one is not decided.
- **KNX IP interfaces as targets.** Capture an ETS download onto an IP interface, model what it
  writes for the tunnelling entries, then lift `FULL_DOWNLOAD_TUNNELING_ENTRIES` against that capture.
- **Should the group-address flash run the application's checks?** A declared `CompareProp` (the ABB
  US/U 4.2's application-id check, for example) runs in the parameter flash and the full download, not
  in the group-address flash ([load-procedures.md](load-procedures.md#coverage-across-the-catalogue)).
- **`LdCtrlTaskCtrl1` beyond the captured applications.** The Auro M-0081_A-FE01, the Theben TheLuxa
  P300 and the Theben Meteodata 140 S run it in the form each one's ETS capture shows
  ([load-procedures.md](load-procedures.md#declared-order-system-7-downloads)). The catalogue's other
  applications declaring it (Steinel M-008E, Auro `M-0081_A-FF31`) need an ETS full-download capture
  each before their full download is lifted.
- **What config bit `0x80` of the MV-0705 com-object table means.** ETS writes it as a configured
  object's update flag on the TheLuxa P300 and the Meteodata 140 S, and Busforge writes it so on those
  two applications only (`ETS_UPDATE_BIT_MV0705_APPS`,
  [device-memory-model.md](device-memory-model.md#mv-0705-layout-manufacturer-template-plus-overlay));
  every other application keeps the bit cleared on its configured objects, though some declare
  objects with the update flag. The Meteodata's objects of several sizes rule out size as the reason,
  but both applications are Theben's. An ETS capture of a configured object with the update flag on
  another manufacturer's application decides whether it becomes the rule.
- **Table-segment `<Data>` behind the tables.** ETS's full download of the Meteodata 140 S writes
  non-FF `<Data>` behind its tables; the Gira M-0008 and the TheLuxa P300 have such bytes too, and
  ETS writes neither. Busforge writes them for the Meteodata only
  (`ETS_TABLE_SEGMENT_DATA_SYSTEM7_APPS`). A capture of another application with such bytes decides
  the rule; what ETS does when the Meteodata's tables grow into those bytes is not shown either
  ([load-procedures.md](load-procedures.md#the-meteodata-140-s-memory-mapped)).
- **System 7 segment declarations as ETS sends them.** ETS writes `LdCtrlAbsSegment` and
  `LdCtrlTaskSegment` to PID 5 on every property-mapped MV-0705 application seen; Busforge does so on
  the Gira M-0008, the Auro M-0081_A-FE01 and the Theben TheLuxa P300 only, and writes memory `0x0104`
  elsewhere. Switching the
  MDT BE-02001.02 and the others needs a smoke run of its full download.

## Raw acquisition

What the collector ([raw-acquisition.md](raw-acquisition.md#implementation)) does not attempt yet:

- **The memory of a BCU1-mask device under a secure session.** The plan reads the maximum APDU
  length first; no device has been asked yet.
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
existing ETS project, secured group communication with keys Busforge generates, and decoding secured
telegrams in the monitor. How far each is shown is in [status.md](status.md). KNX IP Secure transport
is a separate capability and not an alpha prerequisite. Diagnostic access uses valid credentials
where they are required; raw acquisition is not a way around access control. What is still open:

- **The security object on System 7.** Only System B loads it; the others refuse a secure device's
  GA flash and full download.
- **Individual-address assignment of a secure device.** It is a broadcast and cannot use a session.
- **A smoke behaviour on a fresh address Busforge secures,** to show the device acting on a
  Busforge-generated key, not only holding it.
- **Sending:** read the interface's L_Data.con over UDP, extended frames for values longer than
  6 bits, and coordination with another tool sharing the sender address.
- **Peers that only answer reads on a secured address, or transmit with it as a further address**
  (`SECURE_SENDERS_UNPROVEN`), and **a group key table that shrinks below the address table** need
  an ETS capture each. In the latter case an old key can stay at an index that still exists, the
  verify then fails after the write, and nothing in Busforge clears it.
- **Monitor replay history across reconnects**, and refreshing a device's stored sequence number from
  the secured telegrams the monitor decrypts.
- **Unresolved `Links` tokens at import** can shift the sending address; the PID 54 sender rule
  trusts the stored order.
- **Project-level com-object flags outside the com-object table**: the PID 54 sender rule, the
  group-address view and the device page still use the application's flags.
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
- **Channel headings that stay a raw template** on one large application; reproduce before changing.
- **A hidden parameter's old baseline shows as a change nothing can clear;** the change count should
  leave out a ref the configuration does not show, or the full download should settle it.
- **Warn when the gateway is handed an address that is not the interface's own**, where a USB stick
  answers management only on its own address.
- **Two identical USB interfaces told apart on hardware** (unit-tested only).
- **DCA-replacement plugins, phase 2:** writing a device-specific configuration back.
- Remaining parity gaps in the configuration view are tracked in [ets-coverage.md](ets-coverage.md).
