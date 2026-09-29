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
  part, and it needs a bus-behaviour proof, not just a byte match.
- **Baselines written before 2026-09-28 lack every module-instance parameter.** Until then a
  verified download or parameter flash never adopted a module device's `…_M-k_MI-n_…` parameters
  into the baseline ([findings.md](findings.md) §17). For a memory-less one that shapes the
  com-object table (the Jung's "Kanalfunktion"), such a baseline still implies the default, so
  switching back to the default looks like no change and the surgical flash is not promoted to a
  download. A read-back cannot repair it: a memory-less parameter is not on the device. Today the
  remedy is one full download of each module device Busforge programmed before the fix; the
  robust one is a migration that marks those baselines as unknown and refuses a table-relevant
  surgical flash until that download.
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
- **Wait for the interface's `L_Data.con` over TCP.** Tunnelling over TCP has no acknowledgement,
  so until the heartbeat notices a half-open link (up to about 90 s) it shows only as
  `DEVICE_NOT_ANSWERING` after the device's retries, and a group or broadcast send reports success
  into nothing ([findings.md](findings.md) §15). Matching the
  confirmation by destination and TPDU (not by sequence, see §5.1) with a short, coded timeout
  would restore a liveness signal and make a negative confirmation (`BUS_SEND_FAILED`) real on IP.
- **Confirm why a long-running server's TCP connects fail on macOS.** On 2026-09-29 the dev server
  got `ECONNREFUSED` from every connect to a listening bridge until it was restarted. Bun reports
  any immediate connect failure that way; macOS Local Network privacy is the likely cause but not
  proven ([findings.md](findings.md) §23). A long-lived Node process next to the server would
  record the real errno when it recurs.
- **Measure the longest download to confirm the stop grace period.** A normal shutdown waits for
  a running write, bounded by the container's `stop_grace_period: 30m`. That figure rests on one
  measurement (71 s for a 21.9 KB OpenKNX image) and an estimate for 12-byte `A_Memory_Write`
  frames; no large MV-0705 download has been timed. Read the durations of real writes from
  the `tasks` table (`finished_at - started_at`) and tighten or raise the period.

## Verification

- **Decide whether a Product may inherit evidence from its KNX Hardware.** Evidence is per Product
  today. An order-number variant of a tested Hardware running the same application program gets
  only a hint in the compatibility matrix ([evidence-contract.md](evidence-contract.md)). Counting
  it as tested needs a reason to believe the variants share electronics and firmware, which the
  catalog alone does not give.
- **Persistence across a bus power loss.** The smoke runner's persistence step restarts the device
  with A_Restart and reads it back ([evidence-contract.md](evidence-contract.md)). A reboot reloads
  the configuration from non-volatile memory, but it is not a power cut: nothing automated removes
  bus power, and on the bench that would also take down the USB interface the bridge drives.
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
  row from extrapolation to proof.
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
- **Devices that answer an opaque device descriptor and expose no parameter model** (IP
  interfaces) need a different read path or genuine secure support; which one is not yet decided.

## KNX Data Secure

- **An aborted secure parameter flash.** One smoke run on the Jung broke off mid parameter flash with
  `DEVICE_NOT_ANSWERING` after the parameter object was unloaded; the device kept no application
  until a full download. Not reproduced with the same seed. Needs the cause (a capture of a failing
  run) and a decision on recovering the device automatically.
- **Senders on a secured address shared by several devices.** Which devices ETS lists in a receiver's
  PID 54 when more than one device is linked to a secured address is not shown (the bench has one
  secure device on it); Busforge refuses such an address (`SECURE_SENDERS_UNPROVEN`). Needs an ETS
  capture with two secure devices on one secured address (the GVS AMMA on the bench is secure-capable).
- **Sending: confirmation, extended frames, a shared sender address.** The interface's L_Data.con is
  not read, so a sent telegram is reported as handed to the interface, not as on the bus. Secured
  values longer than 6 bits are refused (no extended frame). A sender address also used by another
  tool is not coordinated with that tool's sequence.
- **Monitor replay history across reconnects.** Replay is judged only within one monitor connection.
- **The security object on System 7.** Only System B loads it with the group tables; the others
  refuse a secure device's GA flash and full download.
- **Activation UI.** Certificate entry and activation are API-only (`PUT .../certificate`,
  `POST .../secure-activate`), and the project delete dialog cannot yet acknowledge
  `PROJECT_HOLDS_OWN_KEYS` (the API takes `keysExported=1`). The activation with a key Busforge
  generates (none on file) has run against a fake device only.
- **Export the keys for ETS.** Keys Busforge generates (a tool key it provisions, a group key for an
  address it secures) are known to Busforge alone. A `.knxkeys` export would let an ETS user take
  such a device over; wanted for users, not needed for the bench.
- **Secure a group address Busforge creates.** Group keys arrive only with a project import, so an
  address created in Busforge is plain, and linking it to a secure device's object programs that
  object as plain.
- **A plain device linked to a secured group address** is refused for GA flash and full download
  (`SECURE_GA_WITHOUT_DEVICE_KEY`). ETS keeps such a project; whether and how it programs that device
  is not established.
- **No manual way to deposit a tool key.** Keys arrive only with a project import, so the key
  store's `manual` and `provisioned` sources are currently unreachable.
- **Individual-address assignment has no secure path.** It is a broadcast operation and cannot use
  a device session, so a secure device cannot be addressed this way.

## Storage and catalog

- **Persist the parsed product model** in the catalog instead of the raw application-program XML,
  so a device page does not re-parse on every open. Deferred until one unified parser existed,
  which it now does.
- **A placed catalog device has no "never programmed" state.** Its all-defaults configuration
  against an empty baseline reads as clean, so it does not appear in the "to program" filter even
  though nothing has ever been written to it. The flash itself still sends the full image.
- **Restore points stamp a `schema_version` that nothing acts on.** Restoring across an
  incompatible structural migration is neither warned about nor refused.
- **No provenance record of an import.** The source file is not kept, and no hash of it is stored,
  so a project cannot be traced back to the file it came from.
- **No size guard on plugin baggage blobs** stored in the database.
- **An online product catalog** as a third ingest source, next to `.knxproj` and `.knxprod`.

## Product and UI

- **Hidden preserved links in the replace-device flow.** The server demands a total mapping over
  all stored links; the dialog only offers rows for visible ones, so a device with a link hidden by
  parameter visibility is a dead end (an honest refusal, but no way forward).
- **Cancel the read-only phase of a bus task.** A long read blocks the queue with no way out. The
  transport already accepts an abort signal; it is not threaded through.
- **Channel headings that stay a raw template.** Placeholder substitution from a parameter is
  implemented and works on every bundled application, but one large application was observed
  rendering identical headings for all its channels. Reproduce it before changing anything.
- **Com-objects with no group address still transmit to group address 0/0/0** on at least one
  device. Check whether the association table Busforge writes causes it.
- **Warn when the gateway is handed an address that is not the interface's own**, so an operator
  knows management on it will not work on a USB stick that only answers to its own address.
- **Two identical USB interfaces cannot be told apart by the server.** The saved connection keeps
  a serial and a device path, but only the vendor and product id are passed on when the transport
  is opened.
- **DCA-replacement plugins, phase 2**: writing a device-specific configuration back, instead of
  the read-only view that exists today.
- Remaining parity gaps in the configuration view (HSV colour and picture parameters are shown
  read-only with an explicit marker) are tracked in [ets-coverage.md](ets-coverage.md).
