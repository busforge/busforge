<p align="center">
  <img src="docs/brand/busforge-banner.png" alt="Busforge, an open commissioning tool for KNX" width="880">
</p>

<p align="center">
  <em>Cross-platform, self-hostable alternative to KNX ETS. Import a project, watch the bus, configure and program real KNX devices, all from a web UI.</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-f3a44a" alt="License: PolyForm Noncommercial 1.0.0">
  <img src="https://img.shields.io/badge/runtime-Bun%20%2B%20TypeScript-e5e8eb" alt="Bun + TypeScript">
  <img src="https://img.shields.io/badge/verified-on%20real%20hardware-54c57a" alt="Verified on real hardware">
</p>

---

Busforge imports a `.knxproj`, browses the installation, watches the bus with decoded
values, edits a device's configuration and **programs ("downloads") real KNX devices**
over IP or USB. It runs as a single self-hostable container. TypeScript on Bun, React
frontend, no ETS and no Windows required.

The hard part is done: Busforge reads a device, reconstructs byte-for-byte what ETS
flashed, and programs parameter and group-address changes that take effect on the bus,
including first-time commissioning of a factory-fresh device. Every claim in this
repository is backed by a read-back from real hardware or explicitly marked as unproven.

<p align="center">
  <img src="docs/brand/busforge-architecture.png" alt="Busforge data flow: knxproj import, parse, SQLite store, web UI, program and flash with verify, KNX bus, live bus monitor feedback" width="900">
</p>

## What it does

| | |
|---|---|
| **Import** | Decrypt and parse `.knxproj` (ETS 5/6) and manufacturer `.knxprod` catalogs |
| **Browse** | Topology, building structure, devices, group addresses, full-text search |
| **Watch** | Live bus monitor with DPT-decoded values and group-address names |
| **Configure** | The complete dynamic parameter UI: conditions, unions, modules, channels, translations |
| **Program** | Parameters, group addresses and full first-time downloads, with backup, verify and revert |
| **Commission** | Assign an individual address and bring up a factory-fresh device without ETS |
| **Verify** | Read a device back and compare it byte-for-byte against the project |
| **Keep** | Snapshots, drift detection, encrypted export/import |

Which of these is proven on which device, and what is still unproven, is tracked
honestly in **[`docs/status.md`](docs/status.md)**. Read it before trusting a capability:
a passing test suite proves stability and codec math, never that a device is programmed
correctly.

## Design principle: refuse, never pretend

Flashing writes bytes into a real device, and wrong bytes mean a misconfigured device in
a live building. Busforge therefore refuses loudly rather than guessing quietly.

- A device family, mask version or segment type that is not implemented is **refused with
  a coded error**, never routed into a path that produces a plausible-looking result.
- Anything the parameter engine cannot render is shown as an explicit "not supported yet"
  marker, never omitted and never shown as an empty control. A silently missing parameter
  would hide both configuration and drift.
- A flash is refused when the stored configuration contains parameters the image builder
  cannot place, so an incomplete render can never reset a device to defaults.
- Every surgical write is backed up first, only applied on a confirmed change, and read
  back afterwards to verify. (A full download rebuilds every byte from the project, so its
  pre-unload backup is opt-in and off by default.)

## Install

Busforge runs as one Docker container. **[`docs/install.md`](docs/install.md)** takes you from
nothing to a project on your bus: start the container, create an empty project or import your ETS
project, bring in the manufacturers' product definitions, set up a KNXnet/IP or USB interface. It
also lists the platforms Busforge has actually run on, and the update, backup and restore route.

Busforge is an alpha. What it does not do yet, and the known issues, are in
[`docs/limitations.md`](docs/limitations.md). Report a problem, or a device that works, as a
[GitHub issue](https://github.com/busforge/busforge/issues); [`docs/reporting.md`](docs/reporting.md)
says how, and what stays out of a public issue.

## Run it from source

Requirements: [Bun](https://bun.sh), plus a KNXnet/IP or KNX-USB interface and your own
`.knxproj` for the bus features.

```bash
bun install
bun run dev:server     # API on :3000
bun run dev:web        # web UI on :5173, proxies /api
bun run check          # typecheck, lint, tests and build across every workspace
```

Some tests need files this repository does not carry: manufacturer catalogue data, which may
not be redistributed, and captures and backups read from real devices. They sit in a private
corpus outside the repository. Without it, `bun run check` runs everything else,
skips those tests by name (`[needs private corpus] ...`) and ends with a status line listing
their files; that is how it runs in public CI. With the corpus, export its absolute path first:

```bash
export BUSFORGE_CORPUS=/path/to/busforge-corpus
bun run check          # last line: private corpus: present at /path/to/busforge-corpus; ...
```

See [`docs/testing.md`](docs/testing.md#the-private-corpus) for how those tests run and skip.

For the container, see [Install](#install) and [`docs/deployment.md`](docs/deployment.md) for the
runtime model; [`docs/development.md`](docs/development.md) covers working on the code.

> **Writing to a device follows a real load procedure that unloads tables first.**
> Busforge backs up the segment, writes only on a confirmed change and reads it back to
> verify, but keep a recovery path. See the safety model in
> [`docs/architecture.md`](docs/architecture.md).

## Documentation

Start at **[`docs/README.md`](docs/README.md)** for the full index. The most useful
entry points:

- [`docs/install.md`](docs/install.md): installation, first steps, tested platforms
- [`docs/limitations.md`](docs/limitations.md): what Busforge does not do, and the known issues
- [`docs/reporting.md`](docs/reporting.md): reporting problems and device feedback on GitHub
- [`docs/status.md`](docs/status.md): what works, on which hardware, and how far it is proven
- [`docs/device-support.md`](docs/device-support.md): how a device is classified, and the full mask matrix
- [`docs/findings.md`](docs/findings.md): the protocol knowledge (wire formats, load procedure, gotchas)
- [`docs/architecture.md`](docs/architecture.md): how the running system fits together

The genuinely hard part of this project was protocol **discovery**, the subtle KNXnet/IP
and load-procedure behaviour that no specification spells out. That is captured in
`docs/findings.md`, it is language-agnostic, and it is the most valuable artifact here.

## Why this stack

- **Bun + TypeScript.** One language with the React frontend, native TypeScript, built-in
  WebSocket, and a clean single-container deployment. The KNX code is written
  runtime-agnostic, so it also runs on Node.
- **Own KNX implementation.** Existing open KNX libraries do runtime group communication
  only, not device programming. The management and load procedures had to be implemented
  from scratch either way, so there is no third-party library to depend on.

## Trademarks and independence

Busforge is an **independent, community project**. It is **not affiliated with, endorsed
by, sponsored by, or certified by the KNX Association** or any device manufacturer.

- **KNX** and **ETS** are registered trademarks of the KNX Association cvba. Manufacturer
  and product names are trademarks of their respective owners.
- These names are used **only descriptively**, to identify the standard and the devices
  Busforge interoperates with (nominative use). Busforge does not claim any KNX
  certification and is not "KNX software" in the certified sense.
- The Busforge application and its container image ship **tooling only**, never
  manufacturer product data or any proprietary binary. Users bring their own `.knxproj`
  (which embeds the manufacturer data they legally obtained) or download `.knxprod` from the
  manufacturer. Parsing files you own and speaking the standardized KNX management protocol
  is legitimate interoperability.
- The **source tree** carries no manufacturer catalogue files either: the tests that need
  real application programs read them from a private corpus outside the repository (see
  [Run it from source](#run-it-from-source)). Its test suite does carry two keyring files from the xknx test suite
  under the MIT license (`packages/project/test/fixtures/knxkeys`), which do not enter the
  container image.

## License

Busforge is **source-available under the
[PolyForm Noncommercial License 1.0.0](LICENSE)**, a dual-licensing model:

- **Noncommercial use is free.** Private use, hobby projects, research, education and
  noncommercial organizations may use, modify and share Busforge at no cost under the
  license terms.
- **Commercial use requires a separate commercial license** from the author. Using
  Busforge (or parts of it) in a for-profit or business context, for example an
  integrator commissioning client installations for pay, or a manufacturer embedding it
  in a product or paid service, is **not** granted by the noncommercial license.

For commercial licensing, reach out via the [project homepage](https://fohlmeister.com).
Full terms are in [`LICENSE`](LICENSE). Copyright (c) 2026 Thorben Fohlmeister.
