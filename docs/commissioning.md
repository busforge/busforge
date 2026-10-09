# Commissioning: taking a virgin device into service

Taking a factory-fresh KNX device into service means three things: give it a physical
(individual) address, load its application (parameter image, com-object table, group tables),
and make sure that state survives the next power cut. Busforge does all three without ETS.

This page covers the address and the traps a first-time download has to get right. The
mechanics of the load bracket itself are in [load-procedures.md](load-procedures.md), the
memory layout in [device-memory-model.md](device-memory-model.md), and what has actually been
driven on hardware in [status.md](status.md).

## Giving a device its address

Every other operation Busforge performs opens a connection to a device *at its address*.
Address assignment cannot: a virgin device has no usable address to connect to. So it is done
by **broadcast** (destination `0x0000`), and the device selects itself by having its
**programming mode** switched on, that is, by somebody pressing the button on its front.

That is also what makes it dangerous. A broadcast `A_IndividualAddress_Write` is taken by
**every** device in programming mode. Two buttons pressed means two devices with the same
address, and a bus with a duplicated address fails in ways that are miserable to diagnose.

So the write never runs blind:

```
1. probe          A_IndividualAddress_Read (broadcast)
                  -> every device in programming mode answers with its own address
                  -> 0 devices  => refuse (PROG_MODE_NO_DEVICE)
                  -> 2+ devices => refuse (PROG_MODE_MULTIPLE_DEVICES), naming them
2. check-free     does anything already answer on the target address?
                  -> yes, and it is not this device => refuse (IA_ALREADY_IN_USE)
3. write          A_IndividualAddress_Write (broadcast)
4. verify         ask AGAIN who is in programming mode: it must be exactly one device, it must
                  now answer FROM the new address, and be reachable there for management
                  -> anything else => refuse (IA_WRITE_UNVERIFIED), naming where the device still is
5. prog-mode off  write PID_PROGMODE = 0, so the device does not also answer the NEXT assignment
```

An address counts as free when nothing answers there: silence, or, from an interface that
confirms each frame (an ABB KNX-USB stick behind the bridge, for example, and any interface over
TCP, where Busforge waits for the confirmation), a negative `L_Data.con`, meaning no device acknowledged
the frame. The negative confirmation is read that way only when every one of three connection
attempts gets it (a present device that is busy through the interface's own repetitions once is
not an empty address), and only because a device answered the probe of step 1 moments before, so
the line demonstrably carries frames; without that it could as well be a dead line, and it fails
the assignment.

A write that was not verified is not an assignment, it is a hope. Step 4 is the difference,
and it is why the result carries an explicit `verified` flag.

Step 4 checks **identity, not presence**. "Does something answer on the target address?" is
not enough: a device that already sits there answers just as well, which would turn a write
that never landed into a green result. So the check asks *who is in programming mode* again.
That is still the device that was written to, and it now reports whatever address it actually
holds.

### The blind spot, named

The pre-check (step 2) cannot distinguish an empty address from a device that is **present
but silent right now** (rebooting, busy, a burst of line noise). If a device hides through
the whole pre-check and the write then lands, the bus ends up with two devices on one
address, and Busforge cannot see it. This is inherent to KNX and ETS has the same blind spot.
The verify step cannot repair it afterwards, because both devices then answer identically.

What Busforge does *not* do is paper over it: a transport failure during the pre-check (a
dead tunnel, a USB error) is **not** read as "the address is free", it is surfaced. Only real
silence on a working bus counts as absent. When assigning into a live installation, read the
target address back first and make sure it is genuinely unused.

### Assignment by serial number, without the button

`A_IndividualAddress_SerialNumber_Write` names exactly one device, so it needs neither the
programming button nor a unique responder. That is not a convenience: it is the only thing
that works when several virgin devices share a bus, because they all sit on the factory
address `15.15.255` and nothing else can tell them apart. A point-to-point read at that
address returns whichever device answers first, so it cannot be trusted for identification
either.

### Using it

The address the project holds for a device is set in the device menu, **Change individual
address…** (or `PUT .../devices/<device-id>/address` with `{"ia":"1.1.5"}`). That changes the project
only: a device already on the bus keeps the address it holds, and every read and write goes to the new
one and finds nothing there until it is assigned. The dialog therefore offers the assignment right
after saving; it opens the commissioning dialog, whose download step is optional. An address another
device of the project holds is refused (`IA_TAKEN`). Other secured devices list this one's address in
their PID 54; they show as "Security changed" until their group addresses are flashed
([knx-secure.md](knx-secure.md#security-object-baseline)).

```bash
P=http://localhost:3000/api/projects/<project-id>

# Who is in programming mode right now? (Read-only. Use it to confirm exactly one button.)
curl -s $P/prog-mode

# Assign the device the address the project holds for it.
curl -s -XPOST $P/devices/<device-id>/assign-ia
# -> {"previous":"15.15.255","assigned":"1.1.5","verified":true,
#     "progModeCleared":true,"progModeError":null}
```

`previous` is where the device answered from before (a factory-fresh device usually reports
`15.15.255`). `progModeCleared` says whether programming mode could be switched back off, and
`progModeError` says why not. If it is `false`, the address is still assigned and verified,
but the device will answer the next assignment too, so switch it off by hand.

## The full download

Address assignment alone does not commission a device. The rest (application id, parameter
image, com-object table, group tables) is the **full download**, `POST .../download`. Which
families it supports and how the bracket is built is in
[load-procedures.md](load-procedures.md).

The full download is also the **resolution when a surgical flash cannot proceed**. A
parameter or group-address edit that would change the com-object table (a channel toggled, a
flag flipped) is written as a structural flash where the family supports it
([load-procedures.md](load-procedures.md#structural-flash)); where it does not but can commission
from scratch, the refusal carries a distinct code (`COM_OBJECT_TABLE_STALE_USE_DOWNLOAD`; where the
application's declared load procedure has a step the full download cannot execute,
`COM_OBJECT_TABLE_STALE_USE_ETS`, which names ETS and offers nothing) and the
UI offers the full download instead, run on the device's existing address, with no
programming-mode press and no address reassignment. The flash dialog also offers the full download
as an action of its own. It offers it as the way forward for a device that has its address but never
had an application loaded (`DEVICE_NOT_PROGRAMMED`), for example one just activated for KNX Data
Secure after a master reset, where the application can be commissioned from scratch; for any
other application the dialog offers nothing on that code, and the backend refuses the download
too. So the same edit ETS would apply by re-downloading the whole device is applied here the
same way, instead of being turned away.

## What a first-time download has to get right

None of these is visible in the code, each one has left a real device broken, and each is
pinned by a test.

### 1. The com-object table must cover every DECLARED object

The firmware indexes its group-object array by fixed object number with **no bounds check**.
A table sized to the highest *active* object number sends the firmware off the end of its own
array on boot. On an OpenKNX device that meant a watchdog reset loop and, after five fast
resets, the firmware erasing its own KNX flash region back to factory. The table must be as
long as the highest object number the application **declares**, across every choose branch and
every module instance. See [device-memory-model.md](device-memory-model.md), "The com-object
table (L3)".

### 2. Unlinked objects must have their Communication flag cleared

ETS clears the Communication flag on every com-object without a group-address link. Matching
that is not cosmetic: it is what makes a later group-address flash behave, and it is the
difference between a link that works and one that reads back byte-perfect and is deaf. The
full story is in [findings.md](findings.md) §7.

### 3. A link to an object the configuration does not activate is refused

If a group-address link targets a com-object the active configuration does not activate, the
association table would point at an entry the device treats as "does not communicate". That
would leave a group address the UI calls programmed and the device ignores, so the download
refuses (`LINK_COM_OBJECT_INACTIVE`) instead of filtering the link away.

### 4. The closing restart is what makes it stick, on some stacks

On the thelsing/knx stack, `LdCtrlLoadCompleted` persists nothing and the flash metadata is
written only on receiving `A_Restart`. Every check before that restart reads RAM, so a device
whose closing `A_Restart` never arrived answers every question correctly (all four load states
LOADED, all three tables byte-identical, its own CRC over the parameter segment matching ours)
and still comes back factory-fresh at the next power cut. Two things make that failure
invisible: a restart fired into a connection that has already timed out, and a restart fired
blind with its error swallowed.

Both are guarded: the link is re-opened before the restart, and the restart proves the reboot
rather than assuming it. Other firmware persists at `LoadCompleted` and never goes silent, and
that relaxation is opt-in per manufacturer and only where it was hardware-verified. See
[load-procedures.md](load-procedures.md).

### 5. Do not send what the device already knows

A large parameter segment can be over 21 KB of which only a few dozen bytes are non-zero. The
allocation asks the device to pre-fill the segment with the mask's declared fill byte, so the
only bytes that need to cross the bus are the ones that carry information: tens of telegrams,
not thousands.

This is not a speed optimisation. Writing every byte kills a device that commits its flash
while the writes keep coming: its watchdog resets it mid-commit and it comes back
factory-fresh, having discarded everything. On such a device the same download is four
minutes and a dead device when written densely, 42 seconds and a working one when written
sparsely.

### 6. Every write is confirmed, one way or another

A dropped write is silent, and without confirmation it surfaces (if at all) a thousand
telegrams away from where it happened. There are two equivalent guarantees:

- **Read-back verify**: `memWrite` reads every write back. This is what every surgical flash and
  the System 7 full download do, on both memory models, and it is the mechanism those proven
  flash paths rest on.
- **Verify mode**: `PID_DEVICE_CONTROL` bit 2, in which the device echoes every memory write
  with what actually landed. Some applications ask for it explicitly
  (`LdCtrlWriteRelMem Verify="true"`), and ETS enables it with a read-modify-write on the
  device object before a download. The **System B full download** takes that route: it switches
  verify mode on as its first step and off as its last, and every table and every sparse
  parameter run is echo-checked as it is written instead of being read back
  (`planSystemBFullDownload`). No other path enables it.

A device whose application declares `SupportsExtendedMemoryServices` and that declares
`PID_MAX_APDU_LENGTH` is written with the confirmed `A_MemoryExtended_Write` instead
([device-memory-model.md](device-memory-model.md)) and is not put into verify mode, as ETS does not. Its return code says a chunk was accepted, not what was stored,
so where the plan asks for the echo the written range is read back instead.

For a large segment, reading everything back is thousands of extra telegrams, so the System B
full download verifies the parameter image against the device's own segment CRC instead and
falls back to a full read-back when the device reports no usable CRC.

### 7. A wrong byte can pass every check

Two cases make this concrete, and both are a class rather than a one-off:

- **A float encoded at the wrong width.** `<TypeFloat Encoding="IEEE-754 Single">` carries no
  `SizeInBit`, and defaulting to 16 bits encodes a 32-bit float as a 2-byte DPT-9. The device
  faithfully holds the wrong bytes and every read-back and CRC check passes.
- **A com-object table sized to the wrong maximum** (trap 1), which also verifies green,
  because the verification compares the device against the very table that was built.

The point is structural: a read-back proves `device == our image`, never
`our image == what ETS would write`. Closing that gap needs a different oracle, which is what
the ETS-capture diff in [verification.md](verification.md) is for.

## OpenKNX devices

OpenKNX devices (`OAM-*` firmware on RP2040/ESP32 hardware, thelsing/knx stack) are a
first-class target and the strongest argument for an ETS replacement: OpenKNX is not a KNX
Association member and may therefore not publish a signed `.knxprod` at all, so its users are
pushed through a Windows-only toolchain.

### The product database, without ETS

The application XML (the ETS-format manufacturer file that normally sits inside a `.knxprod`
zip) is **published as a plain file in the GitHub release**, precisely so users can build the
`.knxprod` themselves. It can also be regenerated from source on macOS or Linux with
`OpenKNXproducer`, which targets .NET and runs anywhere (only the Toolbox GUI is
Windows-only). **ETS is needed for exactly one step**: hashing and signing the `.knxprod`.
Without it the producer prints `No ETS found, skipped knxprod creation!` and exits 0, having
already written the full application XML, which is byte-comparable to the released one.

So the ETS dependency is not in the data, it is in the packaging, which Busforge does not
need: it reads the application XML.

**Hard rule from OpenKNX:** firmware (`.uf2`) and product database must come from the **same
release**, or the device refuses programming.

One application covers all variants of a family: a device build target is a firmware option,
not a separate product database.

### What these applications look like

Two structural facts differ from every manufacturer device in the corpus, and both mattered:

- **No ETS modules.** Zero `<Module>` and `<Repeat>` nodes and no `<Allocators>`: the
  generator expands channels at *generation* time into flat parameters gated by `<choose>`.
  The whole module/per-instance-offset machinery is simply not exercised.
- **Unions everywhere.** In one application 62,801 of 66,061 parameters are union members.
  That is how the generator packs 21 KB of channel configuration.

The application code (LSM5) is deliberately never downloaded, and does not need to be:
OpenKNX firmware is flashed over USB as a `.uf2`, and the device's own load procedure only
touches the parameter segment.

### The module-state restore hazard (upstream firmware behaviour)

This is the one operational precondition, and it is not Busforge's bug. It is worth writing
down because it produces a device that looks bricked.

1. OpenKNX firmware keeps a **second flash region** for module runtime state, separate from
   the KNX stack's region. It is written on bus power loss (a save pin), on any `A_Restart`
   of a device that booted configured, or by the console `save` command.
2. A boot that **restores** that module state can deadlock the main loop, hard, with no
   fallback and no data-link acknowledgement.
3. The firmware requests a 16-second watchdog, but the RP2040 hardware caps it at about 8.3
   seconds, so a deadlocked boot is reset every ~8.3 s.
4. After **five consecutive watchdog resets under 30 s uptime the firmware erases the KNX
   flash region at boot** (`The knx flash is erased due to too many restarts (5)`). That is
   the "reverted to factory" symptom. The counter is zeroed on power-on and after 30 s of
   uptime, which is why the failure looks timing dependent.
5. The auto-erase wipes **only the KNX region**. The module state survives, so every
   re-commissioning dies again at its closing restart until the module region is erased too.

Which of two failure modes appears is decided by one application parameter: with the
watchdog parameter **off**, a configured boot deactivates the watchdog before the restore
runs, so the deadlock is a permanent wedge (USB dead, no auto-erase rescue); with it **on**,
the device resets every ~8.3 s until the auto-erase reverts it, which at least self-heals.

**The procedure**: erase both flash regions (KNX and module) over the console before
commissioning any device that has been commissioned before. A truly virgin device restores
nothing and is safe. The programming-button cold-boot recovery is **not** a substitute: it
erases only the KNX region and, on its way out, re-saves the module state.

Two console-side traps produce false evidence about all of this:

- **Opening the USB-CDC port toggles DTR, which resets the chip.** A tight-reconnecting
  serial logger reboots a configured device on every reconnect, and because the platform
  reboots via the watchdog block, a host-triggered reset can even register as watchdog-caused
  and drive the destructive auto-erase. Hold the port open once, never re-open in a loop.
- **The console `restart` command does not persist the KNX stack.** Verifying a download by
  console-restarting the device destroys the very state under test. Only a bus `A_Restart`
  persists it, and only a power cycle preserves what is in flash.

**A configured device that stops answering point-to-point management is not a known property
of this firmware.** The sightings on record are the module-state deadlock above, plus an
interface that only passes point-to-point frames addressed to its own address
([connections.md](connections.md)); healthy configured devices answer management normally.
Re-test cleanly, on an interface without that limitation, before attributing it to a running
application ([roadmap.md](roadmap.md)).

## After the download

A commissioned device is not proven by the download reporting success. The bar is the device
doing its job on the bus: booting its application, answering a `GroupValueRead` on a flashed
link, and still doing so after a power cycle where that is the relevant question. Which
devices have cleared which part of that bar is recorded in [status.md](status.md), and the
harness that drives it is in [testing.md](testing.md).
