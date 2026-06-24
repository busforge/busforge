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

For the verification model and the per-device support matrix this feeds, see
[`docs/verification.md`](../docs/verification.md) and
[`docs/device-memory-model.md`](../docs/device-memory-model.md).
