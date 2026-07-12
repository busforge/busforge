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

## Status: HARDWARE-VERIFIED (2026-07-12)

Verified on a real bus against a **virgin OpenKNX AB-SmartHouse presence multisensor** (never
programmed, factory address 15.15.255), over a Weinzierl/ABB `147B:5120` USB interface, on an
isolated bench bus:

| Step | Result |
| --- | --- |
| Programming-mode probe, button not pressed | `[]` |
| Programming-mode probe, button pressed | exactly one device, `15.15.255` |
| Assign `1.1.200` | `verified: true`, `progModeCleared: true` |
| Assign `1.1.x` (a second, consecutive assignment) | `verified: true`, `progModeCleared: true` |
| Assign with no device in programming mode | refused `PROG_MODE_NO_DEVICE`, nothing written |

**Cross-checked independently of Busforge's own success message**, which is the part that matters:
after the assignment the device is *silent* on its old address and answers on the new one with the
KNX serial number `00FA00000032` (manufacturer `0x00FA` = OpenKNX), i.e. it is provably the device
we programmed and not something else that happened to be there.

The bench bus turned out to hold **a second unconfigured device, also at 15.15.255** (manufacturer
`0x0085`). That is a duplicate address straight from the factory, and it is the exact hazard named
above. The safety rails held: the programming-mode probe still found exactly one device (only one
button was pressed), and the broadcast write reached only that one. It also means point-to-point
reads at `15.15.255` were answering from *both* devices and could not be trusted, which is worth
remembering when a bench bus has several virgin devices on it.

## The full download: the rest of commissioning

Address assignment alone does not commission a device. The rest, application id + parameter image +
com-object table + group tables, is the **full download** (System B, `POST .../download`), which
authors the com-object table (L3) that the surgical parameter flash keeps from the device. That is
implemented and byte-verified on real hardware; the mechanics, and the several device quirks that
had to be learned to make it survive, are documented in [openknx.md](openknx.md).

One caveat is carried honestly there and repeated here: the download is proven **at the KNX layer**
(all load-state machines LOADED, all tables read back byte-identical, the device's own segment CRC
matching, surviving a reboot), but a device's *application* actually starting after a Busforge-only
download is **not yet demonstrated**. Until it is, treat first-time commissioning as "the stack is
programmed correctly", not "the device is running".

The application **code** (LSM5) is deliberately not part of this: OpenKNX firmware is flashed over
USB as a `.uf2`, and the device's own load procedure only touches the parameter segment. For a
manufacturer device that ships its application in the product database, LSM5 would be a separate
effort.
