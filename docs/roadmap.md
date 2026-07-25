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
- **Rewrite the com-object table on an MV-0705 group-address flash**, the way System B already
  does. Blocked on evidence: it needs a **transmit-only** object with no read flag on a
  property-mapped device, and until one is driven the change would be unproven either way
  ([findings.md](findings.md) §7).
- **Merged parameter load procedures.** Only a minimal single-segment subset of the declared load
  procedures is executed; devices whose procedure declares image-property stamps the engine cannot
  compute are refused (`LOAD_STEP_UNSUPPORTED`) rather than flashed with a partial recipe.
- **Property-based loading** for devices that expose an object model instead of a memory image,
  and the classic fixed-EEPROM models of **System 1 / System 2**. Both are recognised and refused
  today. Each is a generic, mask-keyed capability, not per-device code.

## Verification

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
- **Drive the Jung 400021SE through the UI channel** to close its end-to-end bar (click-through
  and editing from the browser; the API path is proven).
- **Re-drive the OpenKNX RaumController**, which shares the group-address flash path that now
  brackets the application object and has not been on a bus since.
- **Re-programming a device that is running its application.** An OpenKNX device was once observed
  to stop answering point-to-point management in that state, and the cause is still unexplained: a
  large part of the original evidence turned out to be a gateway addressing limitation, and the
  rest fits the firmware's module-state deadlock rather than a general property of a running
  device ([commissioning.md](commissioning.md)). Re-test it cleanly, on an interface without that
  limitation, before the device is blamed for anything.
- **Devices that answer an opaque device descriptor and expose no parameter model** (IP
  interfaces) need a different read path or genuine secure support; which one is not yet decided.

## KNX Data Secure

- **Full secure parameter and group-address flash.** Both directions of the secure channel are
  hardware-proven; the composition with the load procedure is not, and it needs a secure device
  that actually has a parameter image (not a gateway).
- **FDSK provisioning** (taking a factory secure device into a project) is designed, not built.
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
