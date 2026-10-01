# Roadmap

What is next, and why. The current honest state of every claim lives in
[status.md](status.md); this page only lists open work. Nothing here is scheduled, and nothing is
started until the capability it depends on is hardware-proven.

## Programming paths

- **Surgical structural flash.** A parameter change that alters the set of com-objects is refused
  surgically and promoted to a full download, which rewrites the whole parameter image even when
  one channel changed. The plan is to author the new com-object table, diff it and the new
  parameter image against the device, and write only the diverging segments in one load bracket.
  Medium risk: the bracket for a partial multi-segment write on a device in service is the hard
  part, and it needs a bus-behaviour proof, not just a byte match. *Decided 2026-10-01: build it,
  after the open hardware checks.*
- **Observe a transmit-only object after a System 7 group-address flash.** The flash rewrites the
  com-object table byte-equal to ETS; the behaviour that depends on the link bit (an object with
  no read flag transmitting after it is linked) has not been observed on the bus
  ([findings.md](findings.md) §7).
- **Execute the declared memory-control-block steps on System B.** The System B download runs a
  fixed load bracket and ignores `LdCtrlWriteProp` to PID 27 and `LdCtrlLoadImageProp`, where ETS
  writes the segment CRC it computed from the image. On the Jung 400021SE that leaves a device that
  verifies and runs, and comes back from its next restart with the application in ERROR
  ([status.md](status.md)). An ETS capture of that device gives the exact bytes; the fix is then a
  hardware restart test, not a read-back.
- **A surgical parameter flash wants to change a byte the full download left.** On the Jung 400021SE
  after a verified secured full download (no project changes since, read-back with no drift), the
  parameter-flash dry run still reports one differing byte: offset `0x1E14` of the parameter segment,
  `00` on the device, `01` in the flash's target (owned). The flash's target owns the default member
  of an idle union (`ownIdleUnionDefaults`), which the full-download image may not write; which of the
  two is right needs an ETS capture of this device's parameter download. Until then a parameter flash
  there writes that byte.
- **Merged parameter load procedures.** Only a minimal single-segment subset of the declared load
  procedures is executed; devices whose procedure declares image-property stamps the engine cannot
  compute are refused (`LOAD_STEP_UNSUPPORTED`) rather than flashed with a partial recipe.
- **Property-based loading** for devices that expose an object model instead of a memory image,
  and the classic fixed-EEPROM models of **System 1 / System 2**. Both are recognised and refused
  today. Each is a generic, mask-keyed capability, not per-device code.
- **The UDP tunnel dies mid-download against Busforge's own bridge.** A full download over a
  saved connection whose `ipTransport` is `udp` fails after a few seconds with `null is not an
  object (evaluating 'kStateSymbol')`, node's dgram internals reached through a handle that is
  already gone; the bridge sees the client stop acknowledging and drops the channel. Reproduced
  twice on 2026-08-30 from the containerised server against `apps/bridge`, where the same download
  over `tcp` completes and verifies. **It is not a general UDP fault**: the same server downloaded
  over UDP to a real MDT KNX-IP interface the same evening without trouble. (That gateway's
  `TUNNEL_ACK_TIMEOUT` over `tcp` was Busforge waiting for tunnelling ACKs that TCP does not use;
  fixed 2026-09-27, TCP to it now works, see [connections.md](connections.md).) Suspect the
  client/server pairing in `ipserver.ts`; the `closed` guard in `connection.ts` covers the
  disconnect race but not this path.
- **Confirm why a long-running server's TCP connects fail on macOS.** On 2026-09-29 the dev server
  got `ECONNREFUSED` from every connect to a listening bridge until it was restarted. Bun reports
  any immediate connect failure that way; macOS Local Network privacy is the likely cause but not
  proven ([findings.md](findings.md) §23). A long-lived Node process next to the server would
  record the real errno when it recurs.
- **Time a large MV-0705 download against the stop grace period.** The 30-minute
  `stop_grace_period` has a margin of about eight over the longest of 686 recorded writes (229 s,
  [deployment.md](deployment.md)); the only MV-0705 device timed has a small image (19 s).

## Verification

- **Show a derived state for a Product whose Hardware and application program were tested on
  another Product.** *Decided 2026-10-01:* evidence stays per Product and such a Product never
  counts as tested, but it gets its own state, `derived`, between technically eligible and tested
  ([evidence-contract.md](evidence-contract.md)). Not implemented: it belongs to the compatibility
  matrix (release-readiness ticket 18).
- **`tools/readback.ts` cannot read MV-0705 devices.** On 2026-09-24 every MV-0705 device of the
  reference installation refused the tool's parameter read (`device refused byte @0x41e4`), so its
  evidence covers System B devices only. The server's read-back reads them; the tool should use the
  same absolute-segment path.
- **Turn the ETS-capture diff into a live read-back gate.** Today `our image == ETS` can only be
  checked where a captured ETS download exists. Diffing our built image against the device itself,
  resolving the device-assigned segment base from the device, would catch that class of bug
  without a capture. This is the one blind spot a read-back can never close.
- **Verify large absolute segments by a device-provided checksum.** System B verifies its whole
  parameter segment with one property read; System 7 reads every written segment back byte for
  byte. Investigate whether these masks expose a per-segment checksum, and fall back to the byte
  read-back on mismatch. The read-back is the evidence behind the `verified` flag and must not be
  removed for speed.
- **Traffic capture in the gateway process.** The tap points and decoders exist; the `--capture`
  flag that writes a decoded transaction log does not. It is what makes a new device family's load
  procedure readable.
- **The unread-attribute audit.** [ets-coverage.md](ets-coverage.md) names a script that lists
  every product-XML attribute the parser never reads, which is how the parity table stays honest.
  The script does not exist; the table is maintained by hand.

## Device coverage

- **Prove a non-TP device.** Powerline, RF and IP masks share the codec and load procedure but
  have never been exercised on that medium. One read-back on real hardware promotes the whole
  row from extrapolation to proof. Parked: no such device is available.
- **Re-programming a device that is running its application: answered, and it works.** On
  the OpenKNX RaumController took three full downloads, each reporting `verified`, two on
  the bench and one onto the device in service in a house. It answered point-to-point management
  throughout. The old sighting of a running device going silent is therefore not a property of a
  running device; it was the gateway addressing limitation plus the firmware's module-state
  deadlock ([commissioning.md](commissioning.md)). What stays unproven is the **bracketed
  group-address flash** on this product, and the surgical parameter flash with it.
- **Compare OpenKNX surgical and full writes on a matching unit.** Neither surgical path has ever
  run on an OpenKNX device, and nothing observed says it fails (see [status.md](status.md)). The
  test: one RaumController on application 0x55 with the same firmware as the house units, a
  serial console for `erase knx` / `erase openknx`, and the configuration saved as a snapshot.
  Change one non-structural parameter and one link, each once by surgical flash, once by full
  download and once by ETS partial download; after each, read back, observe the linked object
  on the bus, cut bus power, and check the device is still configured and logged no watchdog
  restart. Revert between runs. Recovery is a full download, which is proven on this product.
  Parked: the two matching units are installed in the house without easy console access.
- **Devices that answer an opaque device descriptor and expose no parameter model** (IP
  interfaces) need a different read path or genuine secure support; which one is not yet decided.

## KNX Data Secure

- **Recover a device an interrupted flash left unloaded.** A flash cut off inside its load bracket
  (the cause shown on the bench was a stalled TCP stream, [findings.md](findings.md) §25) leaves the
  device without an application until the user starts a full download. Busforge does not repeat or
  finish the bracket by itself. *Decided 2026-10-01: no automatic resume; the UI offers the full
  download right away when a flash broke off inside its bracket.*
- **Another device that only receives on a secured address.** ETS lists another secured device that
  transmits on the address in a receiver's PID 54 ([findings.md](findings.md) §22); whether it also
  lists one whose objects there only receive is not shown, and Busforge refuses it
  (`SECURE_SENDERS_UNPROVEN`). Needs a capture with such a device.
- **Sending: confirmation, extended frames, a shared sender address.** Over UDP the interface's
  L_Data.con is not read, so a sent telegram is reported as handed to the interface, not as on the bus
  (over TCP and USB it is). Secured
  values longer than 6 bits are refused (no extended frame). A sender address also used by another
  tool is not coordinated with that tool's sequence.
- **Monitor replay history across reconnects.** Replay is judged only within one monitor connection.
- **The security object on System 7.** Only System B loads it with the group tables; the others
  refuse a secure device's GA flash and full download.
- **An interrupted activation on hardware.** Losing the answer to the tool-key write (the key is
  stored as pending first) is tested against a fake device only.
- **A stored sequence number is only as fresh as the last session with the device.** Busforge
  records the last sequence a device sent after every session with it, as ETS does; a device another
  tool has talked to since keeps the older value until the next one (lower than the device's, which
  receivers accept). Secured group telegrams
  the monitor decrypts could refresh it as well; they do not today.
- **A receiver whose sender list changed is not flagged.** Linking another device's transmitting
  object to a secured address, or changing that device's individual address, changes the PID 54 of
  every device on it; Busforge, like ETS, shows those receivers as unchanged until their tables are
  written.
- **A link token that does not resolve at import shifts the sending address.** Unresolved `Links`
  entries are dropped before the order is stored, so a second address can take the first (sending)
  slot; the import counts them, the PID 54 sender rule trusts the stored order.
- **Project-level com-object flag overrides** are not parsed; whether an object transmits comes from
  the application program, which matters for the PID 54 sender rule.
- **Export the keys for ETS.** Keys Busforge generates (a tool key it provisions, a group key for an
  address it secures) are known to Busforge alone. A `.knxkeys` export would let an ETS user take
  such a device over; wanted for users, not needed for the bench. *Decided 2026-10-01: build it.*
- **Secure a group address Busforge creates.** Group keys arrive only with a project import, so an
  address created in Busforge is plain, and linking it to a secure device's object programs that
  object as plain. *Decided 2026-10-01: build it (Busforge generates the group key); first observe in
  ETS how it fills the receivers' PID 54 for a new secured address.*
- **A plain device linked to a secured group address** is refused for GA flash and full download
  (`SECURE_GA_WITHOUT_DEVICE_KEY`). ETS keeps such a project; whether and how it programs that device
  is not established. *Decided 2026-10-01: reproduce it in ETS, then build what ETS does; refused
  until then.*
- **No manual way to deposit a tool key.** Keys arrive only with a project import, so the key
  store's `manual` source is currently unreachable. *Decided 2026-10-01: build it, in the device menu;
  the key is checked with a Sync against the device before it is stored.*
- **Individual-address assignment has no secure path.** It is a broadcast operation and cannot use
  a device session, so a secure device cannot be addressed this way.

## Storage and catalog

- **Persist the parsed product model** in the catalog instead of the raw application-program XML,
  so a device page does not re-parse on every open. Deferred until one unified parser existed,
  which it now does.
- **No size guard on plugin baggage blobs** stored in the database. *Decided 2026-10-01: refuse an
  import with a blob over 32 MB or more than 128 MB of baggage per project.*
- **Seed "never programmed" from the ETS project.** ETS leaves `ApplicationProgramLoaded` off a
  device it never downloaded; such a device imports as programmed today. *Decided 2026-10-01: seed the
  flag from it*, accepting that a device another tool programmed then also reads as never programmed.
- **An online product catalog** as a third ingest source, next to `.knxproj` and `.knxprod`.

## Product and UI

- **Hidden preserved links in the replace-device flow.** The server demands a total mapping over
  all stored links; the dialog only offers rows for visible ones, so a device with a link hidden by
  parameter visibility is a dead end (an honest refusal, but no way forward).
- **Channel headings that stay a raw template.** Placeholder substitution from a parameter is
  implemented and works on every bundled application, but one large application was observed
  rendering identical headings for all its channels. Reproduce it before changing anything.
- **Com-objects with no group address still transmit to group address 0/0/0** on at least one
  device. Check whether the association table Busforge writes causes it.
- **Warn when the gateway is handed an address that is not the interface's own**, so an operator
  knows management on it will not work on a USB stick that only answers to its own address.
- **Two identical USB interfaces cannot be told apart by the server.** The saved connection keeps
  a serial and a device path, but only the vendor and product id are passed on when the transport
  is opened. Testable: two identical USB sticks are available.
- **DCA-replacement plugins, phase 2**: writing a device-specific configuration back, instead of
  the read-only view that exists today.
- Remaining parity gaps in the configuration view (HSV colour and picture parameters are shown
  read-only with an explicit marker) are tracked in [ets-coverage.md](ets-coverage.md).
