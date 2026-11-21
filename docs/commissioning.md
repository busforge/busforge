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
5. prog-mode off  so the device does not also answer the NEXT assignment: A_Restart on the
                  connection of the descriptor read, as ETS ends it on System 1, System 7 and
                  System B; other masks take the same route without a capture of theirs
                  -> once the device answers at its address again (a rebooting device is
                     silent; it is asked again until 10 s have passed), ask who is in programming
                     mode: nobody, or progModeCleared is false
```

How ETS ends programming mode after an address assignment, and what Busforge copies of it:

| Unit | What ETS sends after the descriptor read at the new address | Busforge |
|---|---|---|
| A unit without Data Secure (System 1, System 7 on MV-0701 and MV-0705, System B on a simulated unit) | `A_Restart` on that connection, then `T_Disconnect`; where the unit has a device object, a read of `PID_MAX_APDU_LENGTH` and of the serial number comes first | the same frames, without the two reads |
| A Data Secure unit (the Jung 400021SE with Data Secure on and off in the project, the GVS AMMA with it on) | no `A_IndividualAddress_Write` at all: ETS finds the unit by its serial number, writes the address with `A_IndividualAddress_SerialNumber_Write` secured under the tool key, then, on a secured connection, switches the security mode on, writes the tool key and the sending sequence (PID 59 of the security object) when the project has Data Secure on (reads the security mode when it is off), reads the serial number and ends with a secured confirmed restart | the same frames ([below](#a-data-secure-device)), with the free-address check after the serial read and the programming-mode check after the restart |

No ETS capture shows `PID_PROGMODE` written to end programming mode after an address assignment. ETS
writes it elsewhere: unloading a System B unit (a Theben DALI gateway, MV-07B0), it switches programming
mode off with `A_PropertyValue_Write` of the device object's PID 54, value `00`, which the unit answers
with `00`.

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

`A_IndividualAddress_SerialNumber_Write` reaches every device that holds the serial number it
names, so it needs neither the programming button nor a unique responder, as long as the serial
is unique. That is not a convenience: it is the only thing that works when several virgin
devices share a bus, because they all sit on the factory address `15.15.255` and nothing else
can tell them apart. A point-to-point read at that address returns whichever device answers
first, so it cannot be trusted for identification either.

A serial number is not unique by itself, so Busforge refuses the write (`SERIAL_NOT_UNIQUE`)
where the serial cannot tell the device apart:

- `000000000000` and `FFFFFFFFFFFF`, what a unit holds where no serial number was ever written
  into it, are refused before anything reaches the bus.
- Before the write, the serial-number read must be answered from exactly one address; two
  addresses answering for one serial refuse the assignment, naming both.
- After the write, the verifying read must again be answered from exactly one address, the new
  one; a second unit answering for the serial from elsewhere leaves the write unverified
  (`IA_WRITE_UNVERIFIED`), naming both addresses.

Devices that share a serial and sit on the same address (two virgin units on `15.15.255`)
answer from one address, so the read cannot tell them apart and Busforge does not see the case.
The same holds after the write: a second unit that missed the read before it but took the write
sits on the new address too, answers from it, and the verification passes; this is not covered.
Where units may share a serial, assign their addresses by programming mode.

### A Data Secure device

A device in Data Secure mode takes management only under its tool key, and ETS never sends it the
plain address write. It gives the device its address by serial number, secured, by broadcast under
the device's key, and Busforge sends the same frames:

```
1. probe          A_IndividualAddress_SerialNumber_Read (broadcast, plain)
                  -> the device answers plain from the address it holds
                  -> nobody => refuse (SERIAL_NOT_FOUND)
2. check-free     as above
3. sync           S-A_Sync_Req (SCF 0x92) to 0/0/0 under the key, the device's serial in clear
                  -> S-A_Sync_Rsp from the device to 0/0/0
                  -> none => SECURE_SYNC_NO_RESPONSE, nothing written
4. write          secured A_IndividualAddress_SerialNumber_Write (broadcast)
5. verify         secured A_IndividualAddress_SerialNumber_Read (broadcast)
                  -> answered secured, under the key, from the new address and from nowhere else
6. connection     to the new address, more than a second after the Sync: plain descriptor read
                  (FFFF from a unit in secure mode) and PID_MAX_APDU_LENGTH, then the Sync and,
                  after an FFFF, the descriptor again, secured
7. configuration  Data Secure on:  PID_SECURITY_MODE switched on, the tool key written to PID 56
                                   (the same key), the sending sequence written to PID 59
                  Data Secure off: PID_SECURITY_MODE read twice, nothing written
                  then the serial number (PID 11), which must be the device's
8. restart        the confirmed restart (erase code 1), secured; then the device must answer at
                  its address again and not in programming mode, as above
```

The route itself needs no programming button, as with the plain serial-number route; the
commissioning dialog still scans for one device in programming mode before it offers the
assignment. The key is the device's tool key from the project; where the project runs the unit
without Data Secure, it is the factory key (FDSK) from its device certificate, which ETS writes as
the tool key when Data Secure goes off, and the frames are the same except for step 7. Busforge
tries the tool key first and then the FDSK, as ETS does on a unit reset to its factory key. A tool
key equal to the FDSK counts as Data Secure off; a tool key without a certificate on file leaves it
to the unit: in secure mode (plain descriptor `FFFF`) step 7 runs as for Data Secure on, otherwise
as for off, so nothing switches a unit's security mode on. An answer to the Sync that does not
authenticate is refused (`SECURE_SYNC_FAILED`). Where no key gets the Sync answered at all, nothing
has been written, and the plain programming-mode route runs, only for the device with that serial
in programming mode (`PROG_MODE_NOT_THIS_DEVICE` otherwise); the result's `route` says which route
the address went (`serial-secured`, `programming-mode`), and `secureNotAnswered` says why the
secured one did not, which the dialog shows.

A step of 6 or 7 that fails leaves the address assigned and proven under the key, and the device not
restarted: `SECURE_IA_CONFIG_FAILED`, naming the step. A unit the project runs without Data Secure
that turns out to be in secure mode under its factory key is one of these (`SECURE_MODE_UNEXPECTED` in
the details): ETS answers that state in a download with a master reset, which an address assignment
does not do.

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
#     "progModeCleared":true,"progModeError":null,"route":"programming-mode"}
```

`previous` is where the device answered from before (a factory-fresh device usually reports
`15.15.255`). `progModeCleared` says whether programming mode could be switched back off, and
`progModeError` says why not. If it is `false`, the address is still assigned and verified,
but the device will answer the next assignment too, so switch it off by hand.

### A product without an application program

Some products carry no application program at all: their Hardware2Program names none (the Hager
TH001 RS 232 interface, a System 1 unit). ETS places them like any product, shows nothing to load but
the address and programs the address only. Busforge does the same: the device imports without an
import gap, the catalogue offers the product for placing, the device page says there is nothing but
the address, and commissioning assigns the address and stops there. A verified assignment marks such a
device programmed, as ETS's `IndividualAddressLoaded` is all ETS records for it. Every operation on an
application (configuration, read-back, flash, download) refuses with `DEVICE_WITHOUT_APPLICATION`.

### Hardware with a PEI program

Some hardware runs a second program next to its application, the PEI program on load-state machine 5:
its product's Hardware2Program names both. Which of the two is the application only the programs say,
by their `ProgramType`: Busforge runs the one that declares itself the application, so the imported
file has to carry both, and where it does not or they do not tell, the device imports without its
application (`APP_PROGRAM_MISSING`). Busforge's full download loads the application only, and on
System B unloads the PEI program first and never loads it again
([load-procedures.md](load-procedures.md#the-rules-by-level), R9). The import records such hardware, the
device page withholds the full download, and the download is refused before anything is sent
(`HARDWARE_PEI_PROGRAM_UNSUPPORTED`), on System 1 the parameter download too, which is its full download. A never-programmed device of this kind is pointed at ETS, as is a
change that needs its com-object table rewritten and no structural flash can write.

## Finding a device by its programming LED

Which of twenty identical actuators in a cabinet is `1.1.5`? The device menu's **Find device…**
switches the device's programming mode on over a connection, so its programming LED lights up, holds it
for 30 seconds (or until **Switch off**), and switches it off again:

```text
1. connect       T_Connect to the device's address; read its mask (descriptor)
2. family gate   System B, or System 7 with property-mapped load control; otherwise LOCATE_UNSUPPORTED_FAMILY,
                 nothing written
3. read PID 54   device object, programming mode (bit 0); no element -> LOCATE_NO_PROG_MODE_PROPERTY,
                 nothing written
4. write 01      the device answers with the value it holds; not on -> LOCATE_PROG_MODE_NOT_TAKEN
5. hold          read PID 54 every 2 s: keeps the connection open (a device closes an idle one after 6 s)
                 and notices the button pressed on the device, which ends the hold
6. write 00      always, also after an error or a stop; then read PID 54 back: it must read 0
```

A device already in programming mode (its button pressed) is held and switched off the same way: off is
the state every run ends in.

Step 6 is the one that matters: a device left in programming mode takes part in the next address
assignment on its line. If the write or the read-back fails, it is tried once more with the interface's
transport opened again and a new connection to the device; if that fails too, the task fails with
`LOCATE_PROG_MODE_LEFT_ON`, and the message asks for the programming button to be pressed until the LED
is off. A run that broke off before (a read during the hold unanswered) and then switched the mode off
fails with `LOCATE_INTERRUPTED`, which says the mode is off and read back. While the LED is on the bus queue runs nothing
else, so no address assignment of this server meets the device in programming mode. A Data Secure
device is switched under its tool key, like every other access to it.

Refused, and why:

| Device | Why |
|---|---|
| System 1 (BCU1) | no device object; programming mode is a memory byte |
| System 7 with memory-mapped load control (MV-0700, MV-0701) | the ABB US/U 4.2 (MV-0701) answers PID 54 with no element; its programming mode is the memory byte at `0x0060` |
| Couplers, interfaces, other families | no application family Busforge drives |

Switching programming mode through memory is not done: no ETS capture shows it.

```bash
# Programming LED on for 30 s, then off and read back; answers 202 with the queued task.
curl -s -XPOST $P/devices/<device-id>/locate -H 'content-type: application/json' -d '{"seconds":30}'
# Stop early: cancel the running task. Programming mode still goes off; the result says how it ended.
curl -s -XPOST $P/tasks/<task-id>/cancel
# task result: {"kind":"located","endedBy":"time"|"cancel"|"device","heldMs":...,"progModeOff":true}
```

`seconds` is a whole number from 1 to 120 (`LOCATE_DURATION_INVALID` otherwise).

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

ETS clears the Communication flag on every com-object without a group-address link, for an
application that names no ETS download plugin on a product without a factory image (one that names
a plugin is refused the writes of the table, `COM_OBJECT_TABLE_DOWNLOAD_PLUGIN`, see
[device-memory-model.md](device-memory-model.md#the-communication-flag-on-unlinked-objects)). Matching
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
telegrams away from where it happened. Two mechanisms catch it:

- **Read-back verify**: `memWrite` reads every write back. This is what the System 7 full download
  and the partial form of the System B full download do, and what every flash does on a mask that
  declares no verify mode (the memory-mapped MV-0700/0701, System 1).
- **Verify mode**: `PID_DEVICE_CONTROL` bit 2, in which the device answers every memory write.
  ETS switches it on in its full and its partial downloads on every mask whose master data declares
  it (the mask's `VerifyMode` feature: System B and the property-mapped System 7 masks, not the
  memory-mapped MV-0700/0701): it reads the device control right before its first classic
  `A_Memory_Write` and writes it back with bit 2 set (`04`, or `05` where the device reports its
  application stopped), takes the device's answer to that write, once, and leaves it to the closing
  restart to clear. Busforge's downloads do the same, and read and write the device control nowhere
  else: a device that does not report it, or answers the write without bit 2, stops the download
  there (`DEVICE_CONTROL_UNREADABLE`), with its load-state machines unloaded. Every classic write
  then takes the device's answer. The **parameter, group-address and structural flashes** take that
  answer as each write's check and read nothing back before the restart, as ETS
  (`withVerifyModeEchoed`); so does the declared form of the System B full download
  (`planSystemBFullDownload`). The full download in its other forms switches it on in the same place
  (`withVerifyMode`) and reads every write back besides. The answer stops the download at a
  dropped chunk but is no proof of storage (thelsing/knx answers with a copy of the request data,
  [findings.md](findings.md) §5); after the restart the device's CRCs over each segment, or the
  segment read back, prove it ([load-procedures.md](load-procedures.md#full-download-coverage)).

A device whose application declares `SupportsExtendedMemoryServices` and that declares
`PID_MAX_APDU_LENGTH` is written with the confirmed `A_MemoryExtended_Write` instead
([device-memory-model.md](device-memory-model.md)) and is not put into verify mode, as ETS does not.
Its return code says a chunk was accepted, not what was stored, and it is not read back before the
restart (on thelsing/OpenKNX a read then still shows the flash's old bytes, [findings.md](findings.md)
§16); the operation's check after the restart proves what was stored.

For a large segment, reading everything back is thousands of extra telegrams, so the System B
full download verifies each segment (the parameter image and the three tables) region by region
against the CRCs the device reports in its memory-control block, and reads back every region whose
CRC does not match or that the device does not report
([load-procedures.md](load-procedures.md#full-download-coverage)).

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
