# Documentation

Busforge is an open commissioning tool for KNX installations. These documents describe what
it does, how it does it, and how far each claim is proven.

Two rules run through all of them: **a claim is only as strong as the read-back behind it**,
and **an unimplemented path refuses rather than guessing**. Where something is unproven, the
document says so.

## Start here

| Document | What it answers |
|---|---|
| [status.md](status.md) | What works, on which real hardware, and how far it is proven. The canonical place for every verification claim. |
| [device-support.md](device-support.md) | How a device is classified from its mask version, and the full mask matrix with per-model support. |
| [compatibility.md](compatibility.md) | Generated: per Product and operation, what the kept evidence records show (tested, derived, eligible, refused). |
| [architecture.md](architecture.md) | How the running system fits together: server, database, web app, bus, and the flash safety model. |
| [roadmap.md](roadmap.md) | What is next, and why. |

## Programming a device

| Document | What it answers |
|---|---|
| [device-memory-model.md](device-memory-model.md) | Device generations, segments, memory layout, how the parameter image and com-object tables are built. |
| [load-procedures.md](load-procedures.md) | The load state machines, the flash bracket, and what makes a write persist. |
| [commissioning.md](commissioning.md) | Address assignment, the full download, and bringing up a factory-fresh device without ETS. |
| [verification.md](verification.md) | How we know the bytes are right, and how to trace a byte-level difference to its cause. |
| [evidence-contract.md](evidence-contract.md) | The evidence axes, the versioned evidence record, how far evidence reaches across products, and when a product counts as qualified. |
| [findings.md](findings.md) | The protocol knowledge log: wire formats, load-procedure behaviour, the gotchas that cost days. |
| [knx-secure.md](knx-secure.md) | KNX Data Secure: design, key handling, and the honest gap. |
| [raw-acquisition.md](raw-acquisition.md) | Design: reading identity, properties and bounded memory from a device Busforge cannot program, read-only, with every refusal recorded. |
| [owned-products.md](owned-products.md) | Every owned application program traced through parser, image and load procedure: which operation is offered, which one plans, and which gaps are defects or missing evidence. |

## The application

| Document | What it answers |
|---|---|
| [ets-coverage.md](ets-coverage.md) | ETS parity: which dynamic elements and parameter types the engine renders and programs. |
| [connections.md](connections.md) | Transports (KNXnet/IP tunnel, KNX USB) and the connection manager. |
| [storage-and-snapshots.md](storage-and-snapshots.md) | The database model, the catalog, and configuration snapshots. |
| [export-format.md](export-format.md) | The `.busforge` export container. |
| [plugins.md](plugins.md) | Native replacements for vendor DCA plugins. |
| [design-system.md](design-system.md) | Brand and visual language. |

## Working on Busforge

| Document | What it answers |
|---|---|
| [development.md](development.md) | Local setup, the check gate, the workspace layout, and the command-line tools. |
| [testing.md](testing.md) | The test levels, what each proves, and the hardware smoke framework. |
| [deployment.md](deployment.md) | Self-hosting: container, volume, environment, reverse proxy. |
| [adr/](adr/) | Architecture decision records. |

Terminology specific to this project is defined in [`../CONTEXT.md`](../CONTEXT.md).
