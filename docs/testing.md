# Testing

Busforge writes bytes into real KNX devices, so its tests are organised around one question:
**what does this level actually prove?** A green suite proves that the software is stable and that
the codec math holds. It never proves that a device is programmed correctly. Only the hardware
smoke framework can do that, and only for the devices it has actually been run against.

Which devices are proven, and how far, is tracked in [status.md](status.md). This document
describes the machinery, not the claims.

## The levels

| Level | Where | Proves | Does not prove |
|---|---|---|---|
| Unit / codec tests | `packages/knx/test`, `packages/product/test`, `packages/project/test` | Frame and APDU encoding, DPT and parameter codecs, `.knxproj` decryption and parsing, load-plan construction, mask classification | That any of it matches what a device expects |
| Fixture snapshots (golden) | `packages/product/test/real-catalogue.test.ts` | **Stability**: the parse and the image projection over 13 real manufacturer application programs are byte-for-byte unchanged since the last reviewed regeneration | Correctness. A wrong output stays wrong until a device says otherwise |
| Coverage lock | same file, "every UI-exposed param is image-placeable" | Every parameter the config view exposes has a place in the image. The two projections cannot drift apart | That the placement is the one ETS would pick |
| Round-trip lock | same file, "the parameter image codec round-trips" | `build → decode` is its own inverse on every real fixture, so a codec cannot silently lose or shift a value | That the encoding matches the device's reading of it |
| Doc lock | `apps/server/test/device-support-doc.test.ts` | [device-support.md](device-support.md) stays in sync with the mask registry: a new or changed mask fails the suite until the table is updated | Anything about hardware |
| Server route tests | `apps/server/test` | Endpoint contracts, the task queue, and above all the **refusals**: flash guards, stale com-object tables, unsupported profiles, secure devices | That a permitted write lands correctly on a device |
| Hardware smoke | `tools/smoke` | That busforge places the intended bytes on a real device **and** that the device acts on them | Only what it was run against |

Everything except the last row runs offline and is bundled in the gate:

```bash
bun run check      # typecheck + lint + tests + build, across every workspace
```

The MV-0705 group-address route guard test injects a coded failure at tunnel connection
and asserts that exact error on the submitted task. It opens no network connection: a closed local TCP port
is not a deterministic failure because automatic transport selection falls back to UDP.

The hardware smoke framework is deliberately **not** part of `bun run check`. It needs a KNX
interface, a powered bus and a device, and sometimes a finger on a programming button.

### Why the golden snapshot is not a correctness proof

The golden file is generated from busforge's own output. It locks the output against accidental
change, which is exactly what you want when refactoring a parser, and it says nothing at all about
whether the bytes are right. The honest counterpart is a read-back from a real device
(`tools/verify-images.ts` against a dumped corpus, see [development.md](development.md)) and the
smoke framework below. See [verification.md](verification.md) for the full model.

## The hardware smoke framework

`tools/smoke/` drives real devices through the production code paths and checks the result twice:
once against the bytes, once against the bus.

### The model

Three terms, defined in [/CONTEXT.md](../CONTEXT.md) and used consistently in the code:

- **Capability**: a single programming path busforge can drive. Its name matches a
  `DeviceCapabilities` key (`fullDownload`, `flashLinks`, `flashParams`, `readParams`, `readLinks`).
- **Behaviour**: a function the device performs on the bus (`heartbeat`, `output`, `inputToOutput`),
  declared per device.
- **Channel**: the path a capability is driven through over the *same* hardware, `api` (the
  production endpoints directly) or `ui` (the real web app in Chromium). Assertions always read the
  API; the browser is driven, never asked to confirm itself.

**A device never declares its capabilities in the test.** The runner reads them from the product at
run time (`config.capabilities`, that is `classify().capabilities()`) and exercises exactly that
set. Two consequences, both deliberate:

- A capability the product **claims** but the run never exercises is a **hard failure, never a
  skip**.
- A capability the product does **not** claim gets the opposite check: its endpoint must **refuse**
  with a coded error. Guarding the guardrail is part of the run.

### What each check proves

A **capability** check is a write-path proof. Its oracle is always the same: the device's own
read-back matches busforge's image (zero owned drift, `verified: true`), re-checked through an
independent `read-back` endpoint that decodes on a different path from the flash verify. It proves
busforge can reliably *place* bytes. It does **not** prove the configuration is correct: a
wrongly-but-consistently encoded value reads back green, which is exactly how an IEEE-754 float
width bug once survived every offline check.

A **behaviour** check is the correctness proof. The framework configures the function, links its
com-object to a random group address, flashes, then observes the bus through an independent
tunnel and requires the device to act:

| Kind | Check |
|---|---|
| `heartbeat` | Listen on the object's group address for a telegram within a window (optionally a specific value) |
| `output` | `GroupValueRead` the address, require a `GroupValueResponse` from the device itself |
| `inputToOutput` | Write the input's address, read the output's. A **sequence** of transitions to different values, so a stuck output cannot pass by luck. The runner refuses a spec with fewer than two steps |

This is the only layer that catches a byte-perfect flash of a semantically wrong value. Bringing it
up found two real product bugs on a System B actuator that a byte-verified read-back could never
have seen (see [findings.md](findings.md)): a group-address flash refused as `RESTART_IGNORED` on a
persist-on-`LoadCompleted` device, and a link that byte-verified green while the device's own
com-object table kept the Communication flag cleared, so the link was functionally dead.

### What a device spec declares

`tools/smoke/spec.ts` defines `DeviceSpec`, the declarative fixture for one device. It carries only
what the product cannot know:

| Field | Meaning |
|---|---|
| `device` | `appRef`, `productRef`, target individual address, expected mask. Refs are pinned **verbatim** from `GET /api/catalog/products` and `GET .../config`, never reconstructed, so a typo is a compile error rather than a silent no-op |
| `provision` | `skip-if-present` (the device already answers on its address, unattended) or `require-prog-mode` (the operator presses the programming button) |
| `precondition` | A human-run step printed before provisioning |
| `configure` | Ordered baseline steps (`set` a parameter, `link` a com-object) that bring the device to a known, linkable state |
| `behaviours` | The bus-observable functions to prove. Empty means the device is proven to the byte only, which the report states plainly instead of hiding |
| `fuzz` | The seeded generator's policy: the group-address range to draw from, parameter and com-object exclusion lists, round budgets |
| `uiFullDownloadTrigger` | A parameter change that alters the com-object table, used to reach the UI's needs-download route on a device kept addressed between runs |
| `channels` | Which channels this device must pass in (default: both) |
| `unsafe` | A claimed capability that must **not** be exercised on this device, with the hardware reason. Reported as `unsafe`, proven by nothing, never faked green |

`unsafe` is the one honest exception to "exercise everything claimed". It is declared in the spec
and visible in the report, which is the difference between an exception and a silent skip.

### The run

The runner (`tools/smoke/runner.ts`) knows the lifecycle and nothing about any device:

```
preflight (product in catalog, interface reachable)
  → create project, place device, set address
  → provision (assign address, or programming-button flow)
  → baseline configure
  → read capabilities from the product
  → run each claimed capability's driver, in the selected channel
  → persistence (A_Restart, observed reboot, read-back equal to the project)
  → ui-click-through (ui channel: every parameter and com-object the API exposes must render)
  → behaviours (observe the bus)
  → refusal probes for unclaimed write capabilities
  → teardown (a failing run keeps its project for post-mortem)
```

Parameter values are generated by a seeded fuzzer (`generate.ts`): a `mulberry32` PRNG, a
per-parameter value strategy (each enum option; min, max, mid and one seeded in-range value for
numbers, honouring `float` and `step`; read-only, non-image and unbounded parameters skipped). The
seed is recorded in the report, so a failing round replays exactly. A parameter that alters the
com-object table is auto-routed to a full download, because the server refuses the surgical flash
with `COM_OBJECT_TABLE_STALE_USE_DOWNLOAD`.

### The honesty contract

The framework invents no notion of success. It consumes the server's own `FlashResult` union
(`unchanged` / `dryRun` / `flashed`, where a `flashed` must carry `verified: boolean` from a
post-restart read-back byte-match), and its retry policy is the project doctrine applied to itself:

> **Retry a transient transport glitch. Never retry a coded refusal.**

`verified: false`, `COM_OBJECT_TABLE_STALE_USE_DOWNLOAD`, `LOAD_PROC_CHECK_FAILED` and friends are
the regressions the framework exists to catch, so they are thrown, never retried away. A run that
cannot complete fails naming the transport error instead of faking a pass. A capability result is
`pass`, `fail`, `unsafe` or `unproven`; only `pass` counts.

### Verification layers

The layers stack, and the report states per layer whether it ran. A layer that did not run is never
implied by one above it.

- **L0, endpoint contract (always).** The `FlashResult`: a dry-run returns `dryRun`, a real
  operation returns `flashed` with `verified: true` and the expected mask. `verified: false` is a
  hard failure even though the HTTP call succeeded, and so is an `unchanged` where a write was
  expected.
- **L1, independent read-back decode.** The device is re-read through the read path (a different
  decoder from the flash verify); the runner asserts zero drift on the flashed refs and the expected
  group addresses on the expected objects.
- **L2, functional bus drive.** The witness tunnel sends `GroupValueRead` / `GroupValueWrite` and
  requires the device to respond or transmit. The only layer that proves the application acts.

### Running it

Prerequisites:

- A KNXnet/IP interface (or the busforge bridge with a KNX-USB interface) reachable on the network,
  saved as an IP connection in busforge.
- The device under test on that bus, and its product imported into the catalog.
- `bun run dev:server`, plus `bun run dev:web` for the `ui` channel.

```bash
BUSFORGE_BENCH=1 bun run smoke <spec-id> --channel=api|ui [--seed=N]
```

| Variable | Meaning |
|---|---|
| `BUSFORGE_BENCH` | Must be `1`. Without it the runner exits "refused: no bench", never "passed" |
| `BUSFORGE_BENCH_HOST` | Host of the KNX interface this run drives. **Required, there is no default**: it must match a saved IP connection in busforge, and the runner refuses in preflight without it |
| `BUSFORGE_BENCH_PORT` | KNXnet/IP port of that interface (default `3681`, the busforge bridge's port; a standard gateway uses `3671`) |
| `BUSFORGE_API` | The server (default `http://localhost:3000`) |
| `BUSFORGE_WEB` | The web app, `ui` channel only (default `http://localhost:5173`) |

Omitting the spec id runs every spec. `--channel` selects one channel per invocation; a device
counts as done only with both green, so it is run once per channel. `bun run smoke` implies
`--report`, writing one JSON artifact per run under `tools/smoke/reports/` (git-ignored) with the
spec, channel, seed, every verdict and the raw `FlashResult`s. Next to each report the run writes
`<report>.evidence.json`: one [evidence record](evidence-contract.md) per observed capability,
click-through and behaviour, with the persistence result on the writes it covers, naming the server build (read from `/api/version` before the first
run), the runner revision, the spec revision (a hash of the spec), the transport and the device's
firmware revision where it reports one (device object PID 9, read over the bench interface after
the run). A run that stops before it reaches the device writes no device record, and the runner
refuses to start when it cannot read the server's version. A failure inside a driver is recorded as
a failure even when the harness caused it; a later record that supersedes it must say so.

| Variable | Meaning |
|---|---|
| `BUSFORGE_BENCH_VIA` | `busforge-bridge` or `direct`: how the bench interface reaches the bus. Not detectable on the wire (the bridge's name is configurable), so without it records say `unknown` |

The witness opens its own tunnel for group traffic only. An interface with a single tunnel channel
(a typical KNX-USB stick behind the bridge) can serve it only between the server's bus operations,
which the framework respects: every flash completes and releases the bus before the witness
connects.

### What it catches, and what it does not

**Catches** regressions anywhere in the production write path (catalog parse, config engine, image
and table builders, load procedures, transport, bridge), including the "looks done but isn't"
class: a download that stops verifying, a parameter that silently stops landing, a group address
that decodes differently on read-back, a UI flow that no longer reaches the endpoint, a capability
that silently flipped, byte drift, and, through behaviours, a functionally dead flash that still
byte-verifies.

**Does not catch:**

- **Behaviour beyond the declared behaviours.** Each spec declares a few, so a byte-verified
  download with a semantically wrong parameter elsewhere still passes.
- **Other devices of the same class.** A green spec proves *that* device; siblings sharing the code
  path stay "code-shared, unproven" (see [device-support.md](device-support.md)).
- **Media other than the one tested.** The specs run on TP; RF, PL and IP-medium variants are
  unproven.
- **The assign-address blind spot** ([commissioning.md](commissioning.md)): a silent device on the
  target address during the pre-check is invisible to KNX itself.
- **Timing, soak and power-loss persistence.** One lifecycle pass says nothing about days on a bus,
  and the persistence step reboots the device with A_Restart; it does not cut bus power.
- **Firmware-side failure modes** such as a device that only tolerates full downloads: the framework
  surfaces them honestly but cannot prevent them.

### Coverage today

Five device specs exist (`tools/smoke/specs/`), covering System B and System 7 devices across
several manufacturers, including a module device and a device commissioned via `A_MemoryExtended`.
That is a handful of devices, not a device fleet: the framework proves the code paths those devices
exercise, and nothing else. Which specs are green, in which channel, is in [status.md](status.md).

### Adding a device

1. Import the product, place the device in a project, and read `GET /api/catalog/products` and
   `GET /api/projects/<pid>/devices/<did>/config`.
2. Copy `appRef`, `productRef`, parameter refs and com-object refs **verbatim** into a new
   `tools/smoke/specs/<id>.ts`. Never reconstruct a ref by hand: a fabricated ref fails preflight,
   and a plausible one is worse.
3. Declare the baseline `configure` that makes the behaviour's objects visible, then the behaviours
   themselves. A device with nothing observable on the bus is byte-only, and the report says so.
4. Register it in `specs/index.ts` and run both channels.
