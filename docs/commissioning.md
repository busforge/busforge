# Commissioning: giving a device its address

Taking a virgin KNX device into service means three things: give it a physical (individual)
address, load its application, and write its com-object table. This page covers the first, which
Busforge now does. The other two are still open (see "What is still missing").

## Why the address is a special case

Every other operation Busforge performs opens a connection to a device *at its address*. The
address assignment cannot: a virgin device has no usable address to connect to. So it is done by
**broadcast** (destination `0x0000`), and the device selects itself by having its **programming
mode** switched on, i.e. by the button on its front being pressed.

That is also what makes it dangerous. A broadcast `A_IndividualAddress_Write` is taken by **every**
device in programming mode. Two buttons pressed means two devices with the same address, and a bus
with a duplicated address fails in ways that are miserable to diagnose.

So the write never runs blind:

```
1. probe          A_IndividualAddress_Read (broadcast)
                  -> every device in programming mode answers with its own address
                  -> 0 devices  => refuse (PROG_MODE_NO_DEVICE)
                  -> 2+ devices => refuse (PROG_MODE_MULTIPLE_DEVICES), naming them
2. check-free     does anything already answer on the target address?
                  -> yes, and it is not this device => refuse (IA_ALREADY_IN_USE)
3. write          A_IndividualAddress_Write (broadcast)
4. verify         ask AGAIN who is in programming mode: it must be exactly one device, and it must
                  now answer FROM the new address, and be reachable there for management
                  -> anything else => refuse (IA_WRITE_UNVERIFIED), naming where the device still is
5. prog-mode off  write PID_PROGMODE = 0, so the device does not also answer the NEXT assignment
```

A write we did not verify is not an assignment, it is a hope. Step 4 is what makes the difference,
and it is why the result carries an explicit `verified` flag.

Step 4 checks **identity, not presence**. "Does something answer on the target address?" is not
enough: a device that already sits there answers that just as well, which would turn a write that
never landed into a green result. So the check asks *who is in programming mode* again. That is
still the device we wrote to, and it now reports whatever address it actually holds.

### The blind spot, named

The pre-check (step 2) cannot distinguish an empty address from a device that is **present but
silent right now** (rebooting, busy, a burst of line noise). If a device hides through the whole
pre-check and the write then lands, the bus ends up with two devices on one address, and Busforge
cannot see it. This is inherent to KNX and ETS has the same blind spot; it is not something the
verify step can repair afterwards, because both devices then answer identically.

What Busforge does *not* do is paper over it: a transport failure during the pre-check (a dead
tunnel, a USB error) is **not** read as "the address is free", it is surfaced. Only real silence on
a working bus counts as absent. If you are assigning into a live installation, read the target
address back first and make sure it is genuinely unused.

## Using it

```bash
P=https://busforge.lan.example.org/api/projects/<project-id>

# Who is in programming mode right now? (Read-only. Use it to confirm you pressed exactly one.)
curl -s $P/prog-mode

# Assign the device the address the project holds for it.
curl -s -XPOST $P/devices/<device-id>/assign-ia
# -> {"previous":"15.15.255","assigned":"1.1.x","verified":true,
#     "progModeCleared":true,"progModeError":null}
```

`previous` is where the device answered from before (a factory-fresh device usually reports
`15.15.255`). `progModeCleared` says whether programming mode could be switched back off, and
`progModeError` says why not. If it is `false`, the address is still assigned and verified, but the
device will answer the next assignment too, so switch it off by hand.

## Status

**Implemented and covered by offline tests against a simulated bus (including the dangerous cases:
two devices in programming mode, an address already in use, a device that ignores the write). NOT
YET VERIFIED ON REAL HARDWARE.** Until it has been run against a real device on a bench, treat it
as untested: the honest bar in [verification.md](verification.md) applies.

To verify it on a device:

1. Put the device on a bench bus (never a production actuator: a half-assigned device is a device
   you then have to find again).
2. `GET /api/projects/:id/prog-mode` with **no** button pressed. Expect `[]`.
3. Press the programming button. Probe again. Expect exactly that one device, at its current
   address.
4. `POST /api/projects/:id/devices/:deviceId/assign-ia`. Expect `verified: true`.
5. Probe once more. Expect `[]` (programming mode was switched off).
6. Read the device back (`POST .../read-back`) at its new address. It must answer.

## What is still missing for full commissioning

Address assignment alone does not commission a device. Two gaps remain, both general (not specific
to any manufacturer):

- **Com-object table (L3) authoring.** Busforge keeps the device's com-object table and refuses any
  change that would invalidate it (see [device-support.md](device-support.md)). A virgin device has
  no L3 at all, so it cannot be built up from nothing yet.
- **The full download.** Only the parameter (`par`) download is implemented; the application code
  itself (LSM5) is not written.

Until both land, a device still needs ETS **once**, for its first download. After that Busforge can
read it, verify it, and program its parameters and group addresses.
