# Device support

Which KNX devices Busforge can read, program, and verify, and which it deliberately refuses.

The guiding principle is honesty over coverage: a device whose memory model we have not
implemented is **explicitly refused**, never silently routed into a path that fabricates a
result. Whenever you see a ❌ below, the corresponding operation throws a coded error
(`DEVICE_FAMILY_UNSUPPORTED`, `DEVICE_READBACK_UNSUPPORTED`, `GROUP_TABLE_UNREADABLE`) instead
of pretending to succeed.

## How a device is classified

Every KNX device carries a **mask version** (read off the bus via the device descriptor, and
present in the product XML as `MaskVersion`). The mask version is the single identity stamp,
and it projects onto three derived properties:

- **Medium** — twisted pair (TP), powerline (PL), radio frequency (RF), or IP. This only
  changes the transport.
- **System family** — System 1/2/300/7/B, or a non-application device (coupler, interface, IR
  decoder, media coupler, RF-only).
- **Memory model** — how parameters and group tables are laid out in the device, and therefore
  how we read and program it. The family fixes this essentially 1:1.

The two axes are **not** a free cross-product: the mask version is the primary key, and family
fixes the memory model. So this is one list keyed by mask, with the derived columns below.

The registry lives in [`packages/product/src/masks.ts`](../packages/product/src/masks.ts)
(`MASKS`, `maskInfo()`). The strategy that dispatches on the memory model lives in
[`apps/server/src/deviceprofile.ts`](../apps/server/src/deviceprofile.ts) (`classify()` →
`SystemBProfile` / `System7Profile` / `UnsupportedProfile`). Source for the mask data: the KNX
Association "Mask Versions" article and the Calimero `DeviceDescriptor` DD0 enum.

## What maps to what

Busforge implements two memory models:

| Memory model | Family | Profile | Status |
|---|---|---|---|
| `relative` | System B | `SystemBProfile` | Read + flash (params and group addresses). Hardware-proven on TP. |
| `absolute` | System 7 (BIM M112) | `System7Profile` | Read-back hardware-verified. Parameter flash hardware-proven (M-0081). Group-address flash is **built but gated** until an on-hardware identity flash passes. |

Everything else resolves to `UnsupportedProfile`: the family is recognised (so we can name it
and say "not yet"), but every operation throws.

A ✅ means the memory model is implemented. Hardware verification to date is on **twisted-pair**
System B and System 7 devices; the same memory model on PL/RF/IP shares the codec but has not
been exercised on that medium. ⚠️ marks a path that exists in code but is gated off pending a
hardware test.

## The full matrix

<!-- Mirrors packages/product/src/masks.ts (MASKS). Kept honest by apps/server/test/device-support-doc.test.ts,
     which reconstructs every row from the registry and fails if this table drifts. -->


| Mask | Medium | Family | Memory model | Read-back | Flash params | Flash GA |
|---|---|---|---|---|---|---|
| `MV-0001` | TP | Dummy | none | ❌ | ❌ | ❌ |
| `MV-0010` | TP | System 1 (BCU1) | bcu1 | ❌ | ❌ | ❌ |
| `MV-0011` | TP | System 1 (BCU1) | bcu1 | ❌ | ❌ | ❌ |
| `MV-0012` | TP | System 1 (BCU1) | bcu1 | ❌ | ❌ | ❌ |
| `MV-0013` | TP | System 1 (BCU1) | bcu1 | ❌ | ❌ | ❌ |
| `MV-0020` | TP | System 2 (BCU2) | bcu2 | ❌ | ❌ | ❌ |
| `MV-0021` | TP | System 2 (BCU2) | bcu2 | ❌ | ❌ | ❌ |
| `MV-0025` | TP | System 2 (BCU2) | bcu2 | ❌ | ❌ | ❌ |
| `MV-0300` | TP | System 300 | system300 | ❌ | ❌ | ❌ |
| `MV-0310` | TP | Interface | none | ❌ | ❌ | ❌ |
| `MV-0311` | TP | Interface | none | ❌ | ❌ | ❌ |
| `MV-0700` | TP | System 7 (M112) | absolute | ✅ params + links | ✅ | ⚠️ gated |
| `MV-0701` | TP | System 7 (M112) | absolute | ✅ params + links | ✅ | ⚠️ gated |
| `MV-0705` | TP | System 7 (M112) | absolute | ✅ params + links | ✅ | ⚠️ gated |
| `MV-07B0` | TP | System B | relative | ✅ params + links | ✅ | ✅ |
| `MV-0810` | TP | IR decoder | none | ❌ | ❌ | ❌ |
| `MV-0811` | TP | IR decoder | none | ❌ | ❌ | ❌ |
| `MV-0900` | TP | Coupler | none | ❌ | ❌ | ❌ |
| `MV-0910` | TP | Coupler | none | ❌ | ❌ | ❌ |
| `MV-0911` | TP | Coupler | none | ❌ | ❌ | ❌ |
| `MV-0912` | TP | Coupler | none | ❌ | ❌ | ❌ |
| `MV-091A` | TP | Coupler | none | ❌ | ❌ | ❌ |
| `MV-0AFD` | TP | Unknown | none | ❌ | ❌ | ❌ |
| `MV-0AFE` | TP | Unknown | none | ❌ | ❌ | ❌ |
| `MV-1011` | PL | System 1 (BCU1) | bcu1 | ❌ | ❌ | ❌ |
| `MV-1012` | PL | System 1 (BCU1) | bcu1 | ❌ | ❌ | ❌ |
| `MV-1013` | PL | System 1 (BCU1) | bcu1 | ❌ | ❌ | ❌ |
| `MV-1310` | PL | Interface | none | ❌ | ❌ | ❌ |
| `MV-1311` | PL | Interface | none | ❌ | ❌ | ❌ |
| `MV-17B0` | PL | System B | relative | ✅ params + links | ✅ | ✅ |
| `MV-1900` | PL | Media coupler | none | ❌ | ❌ | ❌ |
| `MV-2010` | RF | RF-only | none | ❌ | ❌ | ❌ |
| `MV-2110` | RF | RF-only | none | ❌ | ❌ | ❌ |
| `MV-2311` | RF | Interface | none | ❌ | ❌ | ❌ |
| `MV-2705` | RF | System 7 (M112) | absolute | ✅ params + links | ✅ | ⚠️ gated |
| `MV-27B0` | RF | System B | relative | ✅ params + links | ✅ | ✅ |
| `MV-2920` | RF | Media coupler | none | ❌ | ❌ | ❌ |
| `MV-3012` | IP | System 1 (BCU1) | bcu1 | ❌ | ❌ | ❌ |
| `MV-4012` | IP | System 1 (BCU1) | bcu1 | ❌ | ❌ | ❌ |
| `MV-5705` | IP | System 7 (M112) | absolute | ✅ params + links | ✅ | ⚠️ gated |
| `MV-57B0` | IP | System B | relative | ✅ params + links | ✅ | ✅ |

## Known gaps to close next

- **System 7 group-address flash** is implemented (`buildGroupTablesMv0705` /
  `flashGroupTablesMv0705`, byte-verified against a real device) but gated until an on-hardware
  identity flash passes. Flip `System7Profile.capabilities().flashLinks` to `true` once verified.
- **System 1 / System 2 (BCU1/BCU2)** appear in real projects (e.g. an `MV-0012` device in the
  house project). They are recognised and refused; implementing them means the classic
  fixed-EEPROM address/association/com-object/parameter model, which is a separate effort.
- Non-application devices (couplers, interfaces, media couplers) are out of scope for parameter
  commissioning by design.
