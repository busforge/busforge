# tools

Operator / development tooling that talks to a live KNX bus. Not part of the app.

## readback.ts

Dump a real device's commissioned memory over the bus and compare it against what
Busforge builds, to develop and regression-test the flash paths against ground truth.
Read-only and safe: it never writes to a device.

```
bun run tools/readback.ts <project.knxproj> <password> <interface-ip> <out-dir> [--mode=all|params|tables]
```

- `params` — for every device with an LSM4 parameter image: build our image from the
  project, read the device, and byte-compare. Writes `<ia>__<app>.built.bin`,
  `<ia>__<app>.device.bin`, and `params.json`.
- `tables` — read every device's LSM1/2/3 group tables with a **full, count-based
  read** (no cap, not truncated). Writes `tables.json`.
- `all` (default) — both.

KNX Secure devices (descriptor `MV-FFFF`) are skipped (no plain access).

Example:

```
bun run tools/readback.ts ~/house.knxproj '<password>' 198.51.100.10 ./apps/server/data/readback
```

> **The output is real device memory** (parameter images, and group-address tables
> that contain your installation's group addresses). It is the same class of personal
> data as a project's instance file. Write it to a **gitignored** location and never
> commit it. The tool drops a `DO_NOT_COMMIT_device_memory.txt` marker in the output
> directory as a reminder.

## dump-param-memory.ts

Dump every reachable device's parameter memory into a ground-truth corpus, for both
the LSM4 (RelativeSegment) and MV-0705 (AbsoluteSegment) models. Read-only. Unlike
`readback.ts` it is **DB-sourced** (no `.knxproj` password): app programs and values
come from `apps/server/data/busforge.db`.

```
bun run tools/dump-param-memory.ts <interface-ip> [out-dir]
```

For each device it locates the parameter segments (RelativeSegment via the device
allocator, AbsoluteSegment at its fixed XML address), reads them, and writes one
`<ia>__<seg>.device.bin` per segment plus `manifest.json`. Default out-dir
`apps/server/data/readback/parammem` (gitignored, real device memory).

## verify-images.ts

Byte-verify the image build against the corpus produced by `dump-param-memory.ts`.
**Offline** (no bus): it reads the dumped `.bin` files and compares them against what
Busforge builds. This is the honest correctness check, against the real device rather
than our own frozen golden snapshot.

```
bun run tools/verify-images.ts [corpus-dir]
```

Reports per-device byte-match, and for context the union-parameter count (the known
residual until union placement lands). MV-0705 devices build via
`buildAbsoluteSegmentImages`; LSM4 devices via `buildParameterImage`.

For the verification model and the per-device support matrix this feeds, see
[`docs/verification.md`](../docs/verification.md),
[`docs/device-memory-model.md`](../docs/device-memory-model.md), and
[`docs/mv0705-spike-findings.md`](../docs/mv0705-spike-findings.md).
