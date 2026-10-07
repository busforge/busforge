# tools

Operator and development CLIs that talk to a live KNX bus, or to data dumped from one. Not part of
the app, not part of `bun run check`. Read-only unless noted.

Full usage, flags and the reasoning behind each tool: [`docs/development.md`](../docs/development.md).
The hardware smoke framework in `smoke/` has its own document, [`docs/testing.md`](../docs/testing.md).

| Tool | One line |
|---|---|
| `readback.ts` | Dump a real device's commissioned memory and byte-compare it against what busforge builds. The ground truth the flash paths are developed against |
| `dump-param-memory.ts` | Dump every reachable device's parameter memory into a corpus (database-sourced, no project password) |
| `verify-images.ts` | Offline: byte-verify the image build against that corpus, owned-scoped |
| `paramtest.ts` | One device, one memory read: build the parameter image from files and compare it against the device |
| `etsdiff.ts` | Diff Busforge's full-download image, segment by segment, against what ETS wrote in a captured full download (the reference-axis gate, see docs/verification.md) |
| `knxproxy.ts` | KNXnet/IP-over-TCP logging proxy between ETS (or Busforge) and a KNXnet/IP server: the capture `etsdiff.ts` reads (docs/testing.md, "Taking a capture") |
| `secure-capture-decode.ts` | Decrypt the KNX Data Secure frames of a logging-proxy capture offline, with keys given only in the environment (FDSK, tool key, group keys); see docs/knx-secure.md |
| `intake.ts` | Take a diagnostic package a user sent into the private corpus with its provenance and consent, list the received packages, delete one (the procedure is internal, kept in the corpus) |
| `flashtest.ts` | **Writes to a real device.** Live group-address flash harness with revert |
| `udp-ssh-relay.ts` | Carry KNXnet/IP over an SSH TCP forward when the direct UDP route is broken |
| `smoke/runner.ts` | The hardware smoke framework: capabilities and behaviours on real devices, in the `api` and `ui` channels |

Output written by the read-back tools is **real device memory**, including group addresses from a
real installation. Keep it in a git-ignored location; it is the same class of data as a project's
instance file.
