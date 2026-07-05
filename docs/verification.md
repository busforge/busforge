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

### 1. Hardware byte-match (ground truth)

Build the image from project data, then read the **actual device memory** over the
bus and compare byte-for-byte (`packages/product/src/paramtest.ts`). This is the
only check that proves our bytes equal what the real hardware (and therefore ETS)
expects. It is the **strongest** evidence and covers the **fewest** devices,
because it needs the physical device on the bus.

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

This is the part that matters most. We have read back only a **fraction** of the
hardware. The parameter-image ground truth (source 1) currently covers **one**
device.

| Application program | Device | Param-image hardware byte-match (source 1) | Codec math (source 2) | Stability pinned (source 3) |
| --- | --- | --- | --- | --- |
| `M-0162_A-0004-11-F245` | MEAN WELL PSU 1.1.x | **yes** (full 212-byte LSM4 image, flash + read-back verified) | yes | yes |
| `M-0048_A-493B-21-B471` | Theben 1.1.x/1.1.x | **yes** (module-instance param change flashed + restored, byte-checked on 1.1.x; see device-memory-model.md); group/association tables verified on 1.1.x | yes | yes |
| the other 11 programs | various | **no** | yes | yes |

What this means concretely:

- The **general mechanism** (segment default, parameter offsets, big-endian
  integers, value precedence) is hardware-proven on the PSU.
- A **specific codec path** that the PSU does not use (the PSU has no unions, and
  exercises only the types it happens to contain) is proven by source 2 (the spec
  math) and pinned by source 3 (stability), but is **not** independently confirmed
  against real hardware for the other devices.
- For the other 12 devices, "the image is correct" rests on: the codec primitives
  being right (sources 1+2) **and** those devices using only already-proven
  primitives. A device relying on a path no hardware-verified device exercised is
  trusted by **extrapolation, not proof**.

## What protects you when flashing an un-verified device

Even for a device whose image we have never read back, the flash path does not
fly blind (`apps/server/src/flash.ts`):

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
bun run packages/product/src/paramtest.ts <interface-ip> <ia> <app-xml> <0.xml> <device-id>
```
