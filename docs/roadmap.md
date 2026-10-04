# Roadmap

What is next, and why. The current honest state of every claim lives in
[status.md](status.md); this page only lists open work. Nothing here is scheduled, and nothing is
started until the capability it depends on is hardware-proven.

## Programming paths

- **Structural flash for more families.** A parameter change that alters the com-object table is
  written as a structural flash ([load-procedures.md](load-procedures.md#structural-flash)) only for
  the application programs in `STRUCTURAL_FLASH` (Jung 400021SE, MDT BE-02001.02); every other device
  still gets the full download for it. Each needs an ETS capture of such a partial download and a bench run of the smoke spec's
  `structuralTrigger` before it is listed: the GVS AMMA (persists at every `LoadCompleted`), the ABB
  US/U 4.2 (memory-mapped System 7), and OpenKNX/thelsing, whose full download has to write the tables
  before the parameter image, which the structural bracket does not.
- **The System 7 parameter flash leaves a deactivated parameter's bytes as they were.** ETS writes where
  its whole image changes, so a parameter a change deactivates goes back to its `<Data>` template value
  ([findings.md](findings.md) §28). The structural flash does that; the plain parameter flash, for a
  change that deactivates parameters without altering the com-object table, still writes only active
  parameters' bytes. The device then holds the old values in bytes nothing reads; not shown to matter.
- **The Jung 400021SE clears the last byte of its parameter segment by itself.** Offset `0x1E14`
  (parameter P-1, default 1) is its own one-byte memory-control-block region. ETS's full download writes
  `01` there, as Busforge's image has it, and minutes later the device holds `00` (2026-10-01,
  [findings.md](findings.md) §27). So a parameter-flash dry run on this device always reports one
  differing byte, and a parameter flash writes it again each time. Whether the byte is a one-shot
  marker the firmware consumes, and so should be left out of the comparison, is not established.
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
  fixed 2026-09-27, TCP to it now works, see [connections.md](connections.md).) **Not reproduced on
  2026-10-01** with the current code: a full download of the MDT over a `udp` connection to the bench
  bridge verified, from the Mac server and from the server in an `oven/bun:1.3` container, and a
  67-second secured read of the Jung over UDP from the container completed. Nothing since names the
  fault as fixed, so the entry stays until a cause is found or it does not recur in use.
- **The bench's TCP tunnel stalls over Wi-Fi, and one stall costs the bridge's only tunnel for 120 s.**
  On 2026-10-01 two secure smoke runs in a row died at their first read (`TUNNEL_CON_TIMEOUT`), and a
  third lost its final restore the same way. Each time the bridge held the stream with unacknowledged
  data towards the Mac (`ss`: `ESTAB`, then `FIN-WAIT-1`/`LAST-ACK`, retransmitting) while new
  connections from the Mac went through, and every reconnect was refused (`0x24`) until the bridge
  reaped the channel ([findings.md](findings.md) §25). The bench host is on Wi-Fi. A wired bench host, the server
  next to the bridge, or a bridge with more than one tunnel address would each take the stall out of
  the runs.
- **A secured full download of the Jung 400021SE closed by the device.** In a 2026-10-01 smoke run the full
  download failed after 23 s with `DEVICE_CLOSED_CONNECTION`; every later
  write of the run verified. Earlier runs the same day passed it. The cause is not known.
- **Confirm why a long-running server's TCP connects fail on macOS.** On 2026-09-29 the dev server
  got `ECONNREFUSED` from every connect to a listening bridge until it was restarted. It recurred on
  2026-10-01 after about an hour: the dev server and the smoke runner (both long-running) were refused
  while a freshly started Bun process connected at once; a UI smoke run died of it mid-way. Bun reports
  any immediate connect failure that way; macOS Local Network privacy is the likely cause but not
  proven ([findings.md](findings.md) §23). A long-lived Node process next to the server would
  record the real errno when it recurs.
- **Time a large MV-0705 download against the stop grace period.** The 30-minute
  `stop_grace_period` has a margin of about eight over the longest of 686 recorded writes (229 s,
  [deployment.md](deployment.md)); the only MV-0705 device timed has a small image (19 s).

## Verification

- **Publish the compatibility matrix on the website.** [compatibility.md](compatibility.md) is
  generated from the kept evidence; the public site should carry it, regenerated automatically, in
  the app's badge language. Waits for the site content and the public cutover.
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

- **No smoke behaviour exercises a fresh address Busforge secures.** The plain behaviours pin their
  fresh addresses to "off"; a group-address flash on a secure device secures a fresh "auto" address with
  a Busforge-generated key, but the specs check only its transfer. A `securedOutput` on a fresh address
  would show the device acting on such a key.
- **The bench bridge held a half-open TCP channel on 2026-10-03.** After a verified full download the
  next server connection stalled (`TUNNEL_CON_TIMEOUT`) and the bridge held an established stream to a
  Mac port that no longer existed, with data queued, while connects got 0x24. The reaper drops a TCP
  channel without a heartbeat after 120 s, and the bridge log of that day shows no channel outliving
  it, so which channel held the address and why is not established. Refusals for want of an address
  are now logged with the holder's peer and silence, which is what the next occurrence needs. (The
  dead USB handle of the same day is fixed: the bridge refuses and reopens, see
  [connections.md](connections.md).)
- **Sending: confirmation, extended frames, a shared sender address.** Over UDP the interface's
  L_Data.con is not read, so a sent telegram is reported as handed to the interface, not as on the bus
  (over TCP and USB it is). Secured
  values longer than 6 bits are refused (no extended frame). A sender address also used by another
  tool is not coordinated with that tool's sequence.
- **Another secured device whose object only answers reads on a secured address,** or transmits with
  it as a further address, is refused (`SECURE_SENDERS_UNPROVEN`): ETS was seen not to list one that
  only receives (2026-10-01), these two cases not.
- **A group key table that loses entries below the address table's length.** A load writes PID 53 from
  element 1 and never its element 0, as ETS's does, so when the secured addresses shrink while the
  address table does not, an old key can stay at an index that still exists. The verify then fails
  loudly after the write, and nothing in Busforge clears it. ETS was not seen in that case; a capture
  would show whether it writes element 0 there.
- **Monitor replay history across reconnects.** Replay is judged only within one monitor connection.
- **The security object on System 7.** Only System B loads it with the group tables; the others
  refuse a secure device's GA flash and full download.
- **A stored sequence number is only as fresh as the last session with the device.** Busforge
  records the last sequence a device sent after every session with it, as ETS does; a device another
  tool has talked to since keeps the older value until the next one (lower than the device's, which
  receivers accept). Secured group telegrams
  the monitor decrypts could refresh it as well; they do not today.
- **A link token that does not resolve at import shifts the sending address.** Unresolved `Links`
  entries are dropped before the order is stored, so a second address can take the first (sending)
  slot; the import counts them, the PID 54 sender rule trusts the stored order.
- **Project-level com-object flag overrides** are not parsed; whether an object transmits comes from
  the application program, which matters for the PID 54 sender rule.
- **ETS does not take over a device Busforge activated.** The keyring export
  ([knx-secure.md](knx-secure.md#keyring-export)) carries the tool keys, but ETS 6 imports only the
  certificates from it ([findings.md](findings.md#29-ets-imports-only-the-certificates-from-a-keyring)),
  so such a device reaches ETS only after a master reset. Whether xknx or Calimero, given the keyring,
  talk to a device on the bus is not shown: only that they read the file (xknx 3.20.0, offline).
- **A keyring names a lone sender nowhere.** An interface's `Senders` list holds the other senders on
  the address, as ETS writes it, so a project with a single assigned sender (often Busforge's own
  address) puts it in no list, and xknx drops its secured telegrams. Whether ETS lists such a sender
  some other way is not known; an ETS keyring export of such a project would show it.
- **Key changes on hardware.** Peers of an address whose key or senders changed are flagged
  ([knx-secure.md](knx-secure.md#security-object-baseline)), but not shown on hardware: two secure devices
  on a Busforge-secured address, and a plain device on a turned-plain one; and no ETS capture of a key
  Busforge generated.
- **The security flag rebuilds configurations on every project read**: one per secure device and one
  per other device linked to its secured addresses (shared within a read). Fine for the bench and a house;
  a project with many secure devices would want it cached across reads.
- **A secure device whose memory model does not load the security object is not flagged** when its
  keys or senders change: Busforge refuses its group tables, and ETS has to write them.
- **Link writers other than the link editor do not apply the security mode.** Reverting a link or a
  device, restoring a snapshot and replacing a product write links as stored; a plain device that lands
  on a secured address that way is refused at flash time (`SECURE_GA_WITHOUT_DEVICE_KEY`), a mode whose
  key disagrees likewise (`SECURE_GA_FORCED_WITHOUT_KEY`, `SECURE_GA_OFF_WITH_KEY`), never written.
- **Individual-address assignment has no secure path.** It is a broadcast operation and cannot use
  a device session, so a secure device cannot be addressed this way.

## Storage and catalog

- **Persist the parsed product model** in the catalog instead of the raw application-program XML,
  so a device page does not re-parse on every open. Deferred until one unified parser existed,
  which it now does.
- **An online product catalog** as a third ingest source, next to `.knxproj` and `.knxprod`.

## Product and UI

- **Hidden preserved links in the replace-device flow.** The server demands a total mapping over
  all stored links; the dialog only offers rows for visible ones, so a device with a link hidden by
  parameter visibility is a dead end (an honest refusal, but no way forward).
- **Channel headings that stay a raw template.** Placeholder substitution from a parameter is
  implemented and works on every bundled application, but one large application was observed
  rendering identical headings for all its channels. Reproduce it before changing anything.
- **A hidden parameter's old baseline shows as a change nothing can clear.** After a test that set the
  MDT's Input A to "switch / toggle" (subfunction 2) and back to "send contact status", the hidden
  subfunction keeps baseline `2` while the project holds the default: the device shows one change
  although parameter and GA dry runs both say unchanged, and revert would set the hidden value back
  to 2. The change count should leave out a ref the configuration does not show, or the full download
  should settle it.
- **Warn when the gateway is handed an address that is not the interface's own**, so an operator
  knows management on it will not work on a USB stick that only answers to its own address.
- **Show two identical USB interfaces told apart on hardware.** The server opens a USB connection by
  its saved serial and refuses an ambiguous match ([connections.md](connections.md)); that is
  unit-tested only. Parked 2026-10-02: only one stick is available, so two identical interfaces
  attached at once cannot be shown.
- **DCA-replacement plugins, phase 2**: writing a device-specific configuration back, instead of
  the read-only view that exists today.
- Remaining parity gaps in the configuration view (HSV colour and picture parameters are shown
  read-only with an explicit marker) are tracked in [ets-coverage.md](ets-coverage.md).
