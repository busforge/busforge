# How Busforge verifies what it flashes

Flashing writes bytes into a real KNX device's memory. Wrong bytes mean a
misconfigured device. That is recoverable (re-flash, or ETS as the last resort),
but it is exactly the outcome nobody wants. This document is the honest account of
**how we know the bytes are right**, and, just as important, **where we only know
they are stable, not proven correct**. For which device generations and segments are
supported at all, see [device-memory-model.md](device-memory-model.md).

![Verification model](verification.svg)

## What a `.knxproj` actually contains

A project file does **not** store the bytes that get flashed. It stores the
**ingredients**, and the image is **computed** from them on demand:

| In the file | What it is | Where |
| --- | --- | --- |
| Application program | The manufacturer's parameter definitions, memory **layout** (which parameter sits at which byte/bit), and the default segment image (base64) | `M-XXXX/..._A-....xml`, plaintext in the outer zip |
| Project instance data | The parameter **values** you set, device addresses, group addresses | `0.xml`, WinZip-AES encrypted |

The flashed image is `layout + defaults + your values  ->  build  ->  bytes`. ETS
computes it this way; Busforge computes it this way. Nothing stores the baked
result, so "compare against what was flashed" always means compare against a
**freshly computed** image, never a value read out of the project file.

## Three independent ways we check the image (defense in depth)

Correctness and regression-safety come from three separate sources. They cover
different things and must not be confused.

### 1. Hardware byte-match (ground truth, and what it does NOT prove)

Build the image from project data, then read the **actual device memory** over the
bus and compare byte-for-byte (`tools/paramtest.ts`). This is the
only check that proves our bytes equal what the real hardware (and therefore ETS)
expects. It is the **strongest** evidence and covers the **fewest** devices,
because it needs the physical device on the bus.

**It proves the bytes are RIGHT. It does not prove they are SAVED.** That distinction cost a full
session and a device that came back factory-fresh, so it belongs here rather than in a postmortem
nobody reads twice:

> A System B device (thelsing/knx) does not persist its configuration when it is told the load is
> complete. `LdCtrlLoadCompleted` only flushes a buffer. The flash metadata — the four load states,
> the table addresses, the individual address, everything it validates on the next boot — is written
> from exactly one place reachable over the bus: on receiving **`A_Restart`**.
>
> Before that restart, every check available reads **RAM**. All four load states read LOADED, all
> three tables read back byte-identical, and the device's own CRC over the parameter segment matches
> ours — on a device that has not written one byte to flash and will come back factory-fresh at the
> next power cut. Every one of those checks is *honest*; they are simply answering a different
> question than the one being asked.

So a byte-match is ground truth for **the image**, not for **the download**. Persistence is proven
by the restart itself, and `KnxDevice.restart()` therefore does not assume the reboot happened: it
requires the device to have STOPPED answering on the connection it just acknowledged on
(`packages/knx/test/device-machine.test.ts`, "the reboot is proven, never assumed"). A device that
keeps answering did not reboot and did not save, and that is a `RESTART_IGNORED` failure. The full
story is in [openknx.md](openknx.md).

### 2. Spec conformance (the codec math)

The encoding primitives are tested against KNX reference vectors and known
encodings, independent of any device: DPT-9 float (`21.0 -> 0x0C1A`, `-0.01 ->
0x87FF`), big-endian integers, two's-complement sign, bit-field placement
(`packages/product/test/codec.test.ts`, `image.test.ts`). This proves the codec
arithmetic regardless of which device uses it.

### 3. Stability (golden-master + byte-identity through refactors)

`real-catalogue.test.ts` rebuilds the default image for every real application
program and compares a hash against a committed snapshot (`fixtures/real/golden.json`,
produced by `real-catalogue.gen.ts`). And every refactor of the parser/codec was
checked old-vs-new (the old code pulled from git history) to confirm the bytes did
**not** change. This covers **all 13 devices**, but it only proves the output is
**unchanged from our own previous output**, not that it is correct.

> The golden test compares against **our own frozen output**, committed by us. It
> is a regression guard ("did we change something by accident?"), not a comparison
> against the device or against ETS.

## The honest coverage (what is actually proven, per device)

This is the part that matters most, and it has moved a long way from a single
device. Source 1 now comes in two strengths, and both are honest hardware
evidence:

- an **owned-byte read-back match** (build the image, read the device's memory over
  the bus, compare the bytes Busforge owns) covers **28 of 32 reachable devices**
  (`tools/verify-images.ts`; the 2 KNX-Secure interfaces are read and written over
  the secure channel, and the 4 residual devices are project-vs-device drift or a
  device self-stamped marker, not modelling gaps (see
  [device-memory-model.md](device-memory-model.md)));
- a **full flash round-trip** (apply a real parameter change over the bus and
  restore it, byte-checked each way) has been driven on the devices in the table
  below, across both memory models (relative/System B and absolute/MV-0705) and the
  module per-instance offset path.

| Device (family) | Param-image hardware byte-match (source 1) | Codec (2) | Stability (3) |
| --- | --- | --- | --- |
| MEAN WELL PSU 1.1.x (`M-0162_A-0004`, relative/System B) | **full round-trip**: 212-byte LSM4 image flashed + read back; a value changed, flashed, and reverted, byte-checked | yes | yes |
| Theben HMG 1.1.x (`M-0048_A-493B`, relative, module) | **full round-trip**: a module-instance param change flashed + restored, byte-checked; build byte-matches the owned bytes on 1.1.x; group/association tables verified on 1.1.x | yes | yes |
| Auro detector 1.1.x (`M-0081`, absolute/MV-0705) | **full round-trip**: a param change applied + restored, and a GA re-point + revert, byte-verified | yes | yes |
| M-0008 1.1.x (absolute/MV-0705) | **full round-trip**: a param change applied + restored, byte-checked | yes | yes |
| M-0048 1.1.x (absolute/MV-0705) | **full round-trip**: a param change applied + restored, byte-checked | yes | yes |
| Steinel M-008E 1.1.x (absolute, data-less) | **full round-trip**: a param change applied + restored, byte-checked (the device self-stamps `AS-4B00[0:2]`, which our build over-claims) | yes | yes |
| M-0083 1.1.56 (absolute, module) | **full round-trip**: a module-param change applied + restored, byte-checked | yes | yes |
| the remaining reachable devices | **owned-byte read-back match** only (part of 28/32), not an independent flash round-trip | yes | yes |

Two bench devices outside the reference project (so with no source-3 golden pin)
carry the strongest evidence of all, a full first-time commission:

- **GVS AMMA (M-0085, System B):** flashed from virgin state; the parameter segment
  reads back byte-identical (0 of 2816 bytes differ) and survived a power cycle
  byte-identical.
- **OpenKNX AB-PRE (MV-07B0):** individual-address assignment plus a full download
  (application id + parameter image + com-object table + group tables) verified
  byte-for-byte at the KNX layer, after which the device boots its application and
  sends its heartbeat on the bus.

What this means concretely:

- The **general mechanism** (segment default, parameter offsets, big-endian
  integers, value precedence, module per-instance offsets) is hardware-proven
  across both memory models, not on a single device.
- Where source 1 is only an **owned-byte** match, the bytes ETS computes and
  Busforge deliberately does not own (a wide `Access="None"` object-link union, an
  unused erased-flash region) are carried over from the device unchanged rather than
  proven; the surgical flash preserves them, and a from-scratch commission of such a
  device still needs ETS once (see [device-memory-model.md](device-memory-model.md)).
- A **codec path that no hardware-verified device exercises** is still trusted by
  source 2 (spec math) + source 3 (stability), not by proof. That set is much
  smaller than it was, but it is not empty: a device relying on such a path is
  trusted by **extrapolation, not proof**.

## What protects you when flashing an un-verified device

Even for a device whose image we have never read back, the flash path does not
fly blind (`runFlashOp` in `packages/product/src/profiles.ts`, with the mask gate
and pre-flash backup in `apps/server/src/deviceprofile.ts`):

1. **Mask check** — refuse if the device's application mask does not match the
   program (wrong device or wrong application).
2. **Backup** — read and save the current segment to disk before writing, so the
   previous bytes are always recoverable.
3. **Dry run** — show exactly which bytes would change before anything is written.
4. **Post-flash read-back verify** — read the segment back after writing and confirm
   it matches what we intended; never report success on a mismatch.

The one thing read-back-verify **cannot** tell you: it confirms "the device now
holds the bytes we built", not "the bytes we built are what ETS would have built".
If our codec produced a wrong image for a never-read device, the flash would write
it, read it back, and "verify" happily, leaving the device misconfigured (still
recoverable, but wrong). Closing that gap requires source 1.

**Recommendation:** before trusting a flash on a new device type, run a read-back
byte-compare first (source 1) to promote it from "stability-pinned" to
"hardware-verified". Read-back-first is the safety philosophy the whole project is
built on.

## Running the checks

```bash
# Stability (all 13 real devices), runs in CI as part of `bun run check`:
bun test packages/product/test/real-catalogue.test.ts

# Regenerate the golden after an intentional, reviewed parser/codec change:
bun run packages/product/test/real-catalogue.gen.ts

# Hardware byte-match against a live device (source 1):
bun run tools/paramtest.ts <interface-ip> <ia> <app-xml> <0.xml> <device-id>
```
