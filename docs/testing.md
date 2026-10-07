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
| Fixture snapshots (golden) | `packages/product/test/real-catalogue.test.ts` (needs the [private corpus](#the-private-corpus)) | **Stability**: the parse and the image projection over 16 real manufacturer application programs are byte-for-byte unchanged since the last reviewed regeneration | Correctness. A wrong output stays wrong until a device says otherwise |
| Coverage lock | same file, "every UI-exposed param is image-placeable" | Every parameter the config view exposes has a place in the image. The two projections cannot drift apart | That the placement is the one ETS would pick |
| Round-trip lock | same file, "the parameter image codec round-trips" | `build → decode` is its own inverse on every real fixture, so a codec cannot silently lose or shift a value | That the encoding matches the device's reading of it |
| Doc lock | `apps/server/test/device-support-doc.test.ts` (needs the [private corpus](#the-private-corpus)) | [device-support.md](device-support.md) stays in sync with the mask registry: a new or changed mask fails the suite until the table is updated | Anything about hardware |
| Server route tests | `apps/server/test` | Endpoint contracts, the task queue, and above all the **refusals**: flash guards, stale com-object tables, unsupported profiles, secure devices | That a permitted write lands correctly on a device |
| Hardware smoke | `tools/smoke` | That busforge places the intended bytes on a real device **and** that the device acts on them | Only what it was run against |

Everything except the last row runs offline and is bundled in the gate:

```bash
bun run check      # typecheck + lint + tests + build, across every workspace
```

The hardware smoke framework is deliberately **not** part of `bun run check`. It needs a KNX
interface, a powered bus and a device, and sometimes a finger on a programming button.

## The private corpus

Some tests need files the repository does not carry: manufacturer catalogue data, which may not be
redistributed, and captures and backups read from real devices. They live in a directory outside
the repository, the **private corpus**, named by one environment variable and nothing else. Without
it those tests are skipped visibly, and every other test runs; that is how public CI runs.

```bash
export BUSFORGE_CORPUS=/absolute/path/to/busforge-corpus
bun run check
```

It has to be exported. Bun loads the `.env` files of the directory a process starts in, and `bun
run --filter` does not pass the root's on to the workspaces' `bun test`, so a corpus named in a
`.env` would reach the status line and not the tests, or some workspaces and not others. A `.env`
(or `.env.local`, `.env.test`, ...) in the repository root or in a workspace that sets
`BUSFORGE_CORPUS` is therefore refused.

| `BUSFORGE_CORPUS` | What `bun run check` does |
|---|---|
| unset | Runs every test that does not need the corpus. Each corpus test is registered as skipped under the name `[needs private corpus] <name>` (a `corpusDescribe` suite as one skip, `<name> (whole suite)`) and announced while the suite runs, as `[needs private corpus] not run: <name>`, since `bun test` prints skipped tests by name only on a terminal; they count in bun's `skip` total. The check ends with the status line and the files concerned. |
| an absolute path to a complete corpus | Runs every test. The status line says where the corpus is. |
| anything else: relative, not a directory, a file missing | Fails. Every test file that uses the corpus stops with the reason (for an incomplete corpus, each missing file is named), so the check stops at its test step and never reaches the status line; `bun run corpus:status` alone fails with the same reason. |

The status line is the last thing `bun run check` prints (`bun run corpus:status` prints it alone).
Without the corpus:

```
private corpus: absent (BUSFORGE_CORPUS unset); the corpus tests in these 28 test files were skipped, not run:
  apps/server/test/device-support-doc.test.ts
  ...
```

With it:

```
private corpus: present at /absolute/path/to/busforge-corpus; the corpus tests in all 28 test files that have them were enabled
```

A run without the variable also ends green, which is why its last line says what it left out.
Without the corpus, a green run is the gate for a contribution, as it is in public CI; the
maintainers also run the check with the corpus before a change lands. What stays in the repository
are the parts that only point into the corpus: the golden hashes
(`packages/product/test/fixtures/real/golden.json`) and reference vectors such as
`tools/fixtures/raw-acquisition-vectors.json`. The exact list of files a corpus must hold is
`CORPUS_FILES` in `tools/corpus.ts`.

### Writing a test that needs it

Read corpus files only through `tools/corpus.ts` (`catalogueXml`, `listCatalogue`, `captureText`,
`capturePath`, `corpusPath`); each of them refuses when the corpus is absent. Register the test
with `corpusTest` or, for a suite that reads the corpus while it is being collected,
`corpusDescribe` from `tools/corpus-test.ts`. Without the corpus a `corpusDescribe` body is not run
at all and stands as one skipped test; a read at module top level would throw, so it belongs in a
test or a `corpusDescribe` body. A test that does not touch the corpus stays an ordinary `test`,
even in a file that has corpus tests, so it keeps running in public CI.

A new file the tests read from the corpus is added to `CORPUS_FILES` in `tools/corpus.ts`, so a
corpus without it is reported incomplete. A contributor without the corpus attaches the file (a
catalogue, a capture) privately to the issue or pull request, and a maintainer adds it.

The tools that need the corpus refuse without it: `tools/evidence-bundle.ts` and
`packages/product/test/real-catalogue.gen.ts`. `tools/etsdiff.ts` takes its capture and application
as paths and needs no corpus of its own.

## Taking a capture

A capture is the log of `tools/knxproxy.ts`, a KNXnet/IP-over-TCP proxy that passes every frame
between a tool and a KNXnet/IP server on and logs it in the format `tools/etsdiff.ts` reads. It
speaks TCP on both sides, so the server must accept KNXnet/IP over TCP (Tunnelling v2): the
Busforge bridge, or an interface that offers TCP.

```bash
PROXY_PORT=3672 BRIDGE_HOST=<server ip> BRIDGE_PORT=3671 PROXY_LOG=$PWD/<name>.log \
  PROXY_ADVERTISE=<this host's ip>:3672 bun run tools/knxproxy.ts
```

ETS gets this host and port as a KNXnet/IP TCP interface. `PROXY_ADVERTISE` matters for ETS 6: it
follows the control endpoint in the server's search answer and connects there directly, so without
the rewrite the log ends after the search. Check that the log holds ETS's `CONNECT_REQ` before
starting a download.

The setup constraints of a USB interface behind the bridge
([development.md](development.md#capturing-reference-traffic)) apply here as well. A capture
carries the devices' serial numbers and the project's addresses, so it belongs in the corpus, not
in the repository.

## Why the golden snapshot is not a correctness proof

The golden file is generated from busforge's own output. It locks the output against accidental
change, which is exactly what you want when refactoring a parser, and it says nothing at all about
whether the bytes are right. The honest counterpart is a read-back from a real device
(`tools/verify-images.ts` against dumped device memory, see [development.md](development.md)) and the
smoke framework below. See [verification.md](verification.md) for the full model.

## The hardware smoke framework

`tools/smoke/` drives real devices through the production code paths and checks the result twice:
once against the bytes, once against the bus.

### The model

Three terms, defined in [/GLOSSARY.md](../GLOSSARY.md) and used consistently in the code:

- **Capability**: a single programming path busforge can drive. Its name matches a
  `DeviceCapabilities` key (`fullDownload`, `flashLinks`, `flashParams`, `structuralFlash`,
  `readParams`, `readLinks`).
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

### Why capabilities and behaviours

- **Read-back is a write-path proof, not a correctness proof.** A value encoded wrongly but
  consistently reads back green. So read-back stays the capability oracle (Busforge can place the
  bytes and the device accepts them), and a **behaviour** on the bus is the correctness proof.
- **Capabilities are the product's `DeviceCapabilities`, not a parallel vocabulary**, so the test's
  view of what a device supports cannot drift from the server's own endpoint gate.
- **Both channels run over the same hardware.** API-only never catches a broken user-facing path;
  UI-only loses the fast regression.
- **Configuration values are fuzzed** (seeded, bounded, biased to boundaries and enum values) over
  the device's own parameter and com-object model, with "device read-back equals Busforge's image"
  as the oracle. Hard-coded single values cover too little.
- **No mocked-device UI tier.** Pure UI tests without hardware would be a separate subproject, and
  the bugs worth catching there are caught by the UI channel against hardware too.

### The done bar

A device counts as **done** only when every capability its product claims (from
`classify().capabilities()`, plus provisioning and the UI click-through) passes on real hardware in
**both** channels, together with every behaviour its spec declares. One green channel is not done,
and neither is a device that byte-verifies without ever acting on the bus, unless its spec states
why no behaviour is observable (write-only outputs). [status.md](status.md) applies this bar per
spec.

### What each check proves

A **capability** check is a write-path proof. Its oracle is always the same: the device's own
read-back matches busforge's image (zero owned drift, `verified: true`), re-checked through an
independent `read-back` endpoint that decodes on a different path from the flash verify. It proves
busforge can reliably *place* bytes. It does **not** prove the configuration is correct: a
wrongly-but-consistently encoded value, a float of the wrong width for example, reads back green.

A **behaviour** check is the correctness proof. The framework configures the function, links its
com-object to a random group address, flashes, then observes the bus through an independent
tunnel and requires the device to act:

| Kind | Check |
|---|---|
| `heartbeat` | Listen on the object's group address for a telegram within a window (optionally a specific value) |
| `output` | `GroupValueRead` the address, require a `GroupValueResponse` from the device itself |
| `inputToOutput` | Write the input's address, read the output's. A **sequence** of transitions to different values, so a stuck output cannot pass by luck. The runner refuses a spec with fewer than two steps |

These three check in plain. A fresh address the runner creates for `heartbeat` or `output` is set to
Data Secure mode "off", since on a secure device an address in "auto" mode is secured, as ETS does
it; a secured object is checked with `securedOutput`.

This is the only layer that catches a byte-perfect flash of a semantically wrong value: a link,
for example, that byte-verifies green while the device's own com-object table keeps the
Communication flag cleared, so the link is functionally dead.

### What a device spec declares

`tools/smoke/spec.ts` defines `DeviceSpec`, the declarative fixture for one device. It carries only
what the product cannot know:

| Field | Meaning |
|---|---|
| `device` | `appRef`, `productRef`, target individual address, expected mask. Refs are pinned **verbatim** from `GET /api/catalog/products` and `GET .../config`, never reconstructed, so a typo is a compile error rather than a silent no-op |
| `provision` | `skip-if-present` (the device already answers on its address, unattended), `require-prog-mode` (the operator presses the programming button) or `import-knxproj` (the project is imported from `device.knxprod`, password in `BUSFORGE_SMOKE_KNXPROJ_PASSWORD`; the only way a KNX Data Secure device's keys reach the server. The run ends with a restore to the file's configuration, also after a failure) |
| `precondition` | A human-run step printed before provisioning |
| `configure` | Ordered baseline steps (`set` a parameter, `link` a com-object) that bring the device to a known, linkable state |
| `behaviours` | The bus-observable functions to prove. Empty means the device is proven to the byte only, which the report states plainly instead of hiding |
| `fuzz` | The seeded generator's policy: the group-address range to draw from, parameter and com-object exclusion lists, round budgets |
| `structuralTrigger` | A parameter change that alters the com-object table. The `structuralFlash` driver sets it, writes it as one structural flash, writes the revert the same way and requires a read-back without drift; absent, the capability is reported `unproven` |
| `channels` | Which channels this device must pass in (default: both) |
| `secondSyncAfterWrongKey` | Data Secure only: the device leaves the first Sync after a wrong tool key unanswered ([findings.md](findings.md) §30). The robustness check records that silence as its own result and requires the right key to open the session on the next Sync; without the flag a silence fails |
| `unsafe` | A claimed capability that must **not** be exercised on this device, with the hardware reason. Reported as `unsafe`, proven by nothing, never faked green |

`unsafe` is the one honest exception to "exercise everything claimed". It is declared in the spec
and visible in the report, which is the difference between an exception and a silent skip.

### KNX Data Secure devices

A spec with `provision: "import-knxproj"` whose device has a tool key in the project file is run
securely end to end: the server gets the keys from the import, and the runner reads the same file for
its own connections to the device (reboot, load states, firmware), which open a secure session. Neither the
keys nor the password reach the report or the evidence records. On top of the capabilities and
behaviours such a run adds:

| Phase | What must hold |
|---|---|
| `securedOutput` behaviour | The witness sends a GroupValueRead encrypted with the address's key; the device's own secured response must open with that key and carry a sequence above any seen before from it. Needs the witness's tunnel address among the address's senders in the project |
| Robustness | No tool key in the project reports `SECURE_KEY_MISSING`; a different tool key `SECURE_SYNC_NO_RESPONSE`, after which the right key still opens a session; a read-back whose secured answers have a bit flipped reports `SECURE_ANSWER_REJECTED`, one whose answers are an earlier answer delivered again `DEVICE_NOT_ANSWERING`. The last two route the server's read-back through a local pass-through (`tools/smoke/faultproxy.ts`) that changes only the device's secured data answers; a check it never acted on fails |
| Restore | Parameters and links the run changed are set back to the imported file's, written, and then the GA flash dry run must say `unchanged` and a read-back must show no parameter drift |

The saved connection is matched on host and port (`BUSFORGE_BENCH_HOST`, `BUSFORGE_BENCH_PORT`,
default 3681), since one host can offer several interfaces.

### The run

The runner (`tools/smoke/runner.ts`) knows the lifecycle and nothing about any device:

```
preflight (product in catalog, interface reachable)
  → create project, place device, set address
  → provision (assign address, or programming-button flow)
  → baseline configure
  → read capabilities from the product
  → run each claimed capability's driver, in the selected channel
  → persistence (A_Restart, observed reboot, load states still LOADED, read-back equal to the project)
  → ui-click-through (ui channel: every parameter and com-object the API exposes must render)
  → behaviours (observe the bus)
  → refusal probes for unclaimed write capabilities
  → teardown (a failing run keeps its project for post-mortem)
```

Parameter values are generated by a seeded fuzzer (`generate.ts`): a `mulberry32` PRNG, a
per-parameter value strategy (each enum option; min, max, mid and one seeded in-range value for
numbers, honouring `float` and `step`; read-only, non-image and unbounded parameters skipped). The
seed is recorded in the report, so a failing round replays exactly. A parameter that alters the
com-object table runs as a structural flash, or is auto-routed to a full download where the server
refuses it with `COM_OBJECT_TABLE_STALE_USE_DOWNLOAD`. On a device kept addressed between runs, the
UI's full download runs from the flash dialog's full-download action.

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
| `BUSFORGE_BENCH_PORT` | KNXnet/IP port of that interface. The runner's default is `3681`, which matches a bridge started with `--port 3681`; the bridge's own default and a standard gateway use `3671` |
| `BUSFORGE_API` | The server (default `http://localhost:3000`) |
| `BUSFORGE_WEB` | The web app, `ui` channel only (default `http://localhost:5173`) |

Omitting the spec id runs every spec. `--channel` selects one channel per invocation; a device
counts as done only with both green, so it is run once per channel. `bun run smoke` implies
`--report`, writing one JSON artifact per run under `tools/smoke/reports/` (git-ignored) with the
spec, channel, seed, every verdict and the raw `FlashResult`s. Next to each report the run writes
`<report>.evidence.json`: one [evidence record](evidence-contract.md) per observed capability,
click-through and behaviour, with the persistence result on the writes it covers, naming the server build (read from `/api/version` before the first
run), the runner revision, the spec revision (a hash of the spec), the transport and the device's
firmware revision where it reports one (device object PID 9, read over the same interface after
the run). A run that stops before it reaches the device writes no device record, and the runner
refuses to start when it cannot read the server's version. A failure inside a driver is recorded as
a failure even when the harness caused it; a later record that supersedes it must say so.

| Variable | Meaning |
|---|---|
| `BUSFORGE_BENCH_VIA` | `busforge-bridge` or `direct`: how the interface under test reaches the bus. Not detectable on the wire (the bridge's name is configurable), so without it records say `unknown` |

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

### Coverage

The specs in `tools/smoke/specs/` cover System B and System 7 devices of several manufacturers,
including a module device, a device commissioned via `A_MemoryExtended` and a KNX Data Secure
device. That is a handful of devices, not a device fleet: the framework proves the code paths those
devices exercise, and nothing else. Which specs pass, in which channel, is in [status.md](status.md).

### Adding a device

1. Import the product, place the device in a project, and read `GET /api/catalog/products` and
   `GET /api/projects/<pid>/devices/<did>/config`.
2. Copy `appRef`, `productRef`, parameter refs and com-object refs **verbatim** into a new
   `tools/smoke/specs/<id>.ts`. Never reconstruct a ref by hand: a fabricated ref fails preflight,
   and a plausible one is worse.
3. Declare the baseline `configure` that makes the behaviour's objects visible, then the behaviours
   themselves. A device with nothing observable on the bus is byte-only, and the report says so.
4. Register it in `specs/index.ts` and run both channels.
