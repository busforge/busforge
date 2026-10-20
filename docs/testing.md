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
| Capture comparison | `tools/etsdiff.test.ts` (needs the [private corpus](#the-private-corpus)) | **Reference**: the bytes and services Busforge plans for a device equal what ETS wrote to that device in a capture, byte for byte | Wire behaviour no capture holds: timing, restarts, link handling |
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

The kept evidence records are in the corpus as well (`evidence/runs/`, `evidence/reference/`): they
name run times, builds and devices' addresses. `tools/evidence-bundle.ts` generates the shipped
bundle from them ([evidence-contract.md](evidence-contract.md#the-shipped-records)); to keep a smoke
run, copy its report and `<report>.evidence.json` to `evidence/runs/<date>/` in the corpus and run it
with `--write`.

The tools that need the corpus refuse without it: `tools/evidence-bundle.ts` and
`packages/product/test/real-catalogue.gen.ts`. `tools/etsdiff.ts` takes its capture and application
as paths and needs no corpus of its own.

## When a change needs a hardware run

A device that took ETS's download is the hardware proof of ETS's bytes. Once the capture
comparison pins that Busforge plans exactly those bytes for that device, running Busforge's
download on the device again shows nothing new. So:

- **A changed plan whose result a capture comparison pins** (write set, table layout, image bytes)
  needs no hardware run. The comparison is the proof.
- **A hardware run is needed only for what no capture can show**: a service, timing, restart or
  link behaviour the captures do not hold; a device or application without a capture; a claim on
  the behaviour or persistence axes that has never been shown for that product.
- **Missing reference? Take a capture**, then compare offline. Do not put a device into an
  artificial state only to reproduce a capture's starting point.

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

Where the product's read-back reads the device's com-object table (`readbackSupport.flags`), every
read-back of the run must take each object's flags from it; the server only warns when it cannot, so
the run fails instead. `readLinks` names the objects whose flags on the device differ from the
project's without judging them, as it does for links; the write steps and the persistence check judge. `flashLinks` writes more than one link: after the first address it adds a second behind it
(the first stays the sending address) and, where the product's downloads write it, turns the object's
read flag over, both in one GA flash, then takes both back in a second; each write is read back. In
the `ui` channel this goes through the device page's address and flag editors and the flash dialog.

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
| `provision` | `skip-if-present` (the device already answers on its address, unattended), `require-prog-mode` (the operator presses the programming button), `import-knxproj` (the project is imported from `device.knxprod`, password in `BUSFORGE_SMOKE_KNXPROJ_PASSWORD`; the only way a KNX Data Secure device's keys reach the server. The run ends with a restore to the file's configuration, also after a failure) or `in-service` (a commissioned device in use, see [Devices in service](#devices-in-service)) |
| `inService` | `in-service` only: the fingerprint and the steps the run may write |
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
| Restore | Parameters, links and com-object flags the run changed are set back to the imported file's, written, and then a read-back must show no parameter, link or flag drift and the GA flash dry run must say `unchanged` |

The saved connection is matched on host and port (`BUSFORGE_BENCH_HOST`, `BUSFORGE_BENCH_PORT`,
default 3681), since one host can offer several interfaces.

### Devices in service

A device that is commissioned and in use (a unit in a building, not a bench device) gets a spec with
`provision: "in-service"` (`tools/smoke/inservice.ts`). The run never brings such a device to a known
state: the configuration it holds **is** the state. The run takes that configuration over by
read-back and writes only the steps the spec names, each set back and read back before the next. It
never erases, never runs a baseline configuration or the fuzzer, and runs a full download only when
the spec offers one **and** the operator passes `--full-download`. Records go through the same
evidence path as every other run, in both channels.

#### The sequence

```
fingerprint     ask the interface which it is (refused where the unit's restart drops its tunnels),
                then read the spec's interface object properties or memory; any mismatch stops the run
adopt           read-back (assuming the values in assumeParams); the project takes the device's values;
                a second read-back under them must resolve every association, which also ends the
                device's "never programmed" (this application's id, loaded, the image a flash would
                leave as it is); the dry runs of the parameter and GA flash, where the product
                offers them, must find nothing to write (the server keeps a backup of the device's
                memory with each); the configuration found is recorded; the parameters in
                expectParams must hold their expected values, those in assumeParams the assumed ones
capabilities    every write capability the product claims has a step in the spec or an `unsafe`
                reason; readParams and readLinks are claimed; every step's target is checked
params          parameter flash there, parameter flash back, read-back without drift
links           GA flash of the object to the --test-ga address (an unlinked object, or with addToLinked
                the address added behind a linked object's own), read-back, witness behaviours,
                A_Restart + read-back (persistence), GA flash back, read-back without drift
structural      structural flash there, structural flash back, read-back without drift
fullDownload    only with --full-download: the configuration found, downloaded, read-back without drift
final           the same dry runs find nothing to write
```

A phase runs only when the spec has its step. Every write is preceded by a dry run that must offer a
change of the expected kind (surgical, or structural for the structural step); a coded refusal, such
as `COM_OBJECT_TABLE_STALE_USE_DOWNLOAD`, stops the run and is never routed to a download. Before
each write the project must hold the configuration found plus the step and nothing else, and the
other kind of write (parameters or group tables), where the product offers it, must report
`unchanged`, so an edit the step did not ask for never goes out with it. A write that goes out
whatever it finds (the System 1 download, which also writes state it does not read) never reports
`unchanged`: its dry run finds nothing to write when no byte it compares differs, and a step's dry run
must find bytes that differ. A unit that stores a field it does not give back (it reads `FF` there
whatever was written) makes every parameter dry run differ there; the dry run names such bytes
(`readsFF`, the differing bytes the unit reads as `FF`), since only a write tells them from bytes that
hold `FF`. The adoption takes a parameter flash dry run whose differing bytes all read `FF`, names them
in the run's log and the configuration found (`readsFF`), and counts the same bytes as nothing to
write from then on; every parameter write of the run must then show each of them on its write
confirmation alone (`confirmedOnly`), else the unit gave them back and did not hold the configuration
taken over, and the run stops. A spec without a parameter or structural step cannot show them, so its
adoption stops. Every parameter write of the run writes those bytes with the project's value, as they
differ from the unit's read; ETS's full download writes them from the project as well, its parameter
downloads leave them as its record of the unit holds them. So after the run the unit holds the project's
value there, and what it held before is not known (the restore says so). For the structural step the group tables are checked before its
parameter is set (while a change that alters the com-object table is pending, the server's GA flash is
the structural flash itself), and the structural flash then writes them from links that still equal the
configuration found. After each step the read-back must equal the configuration found.

When the run stops with a change still out, it sets the whole project back to the configuration
found and writes the difference with the same kind of flash over the API, then reads back; it never
falls back to a full download. A full download that breaks off is not undone: the device may hold
its application unloaded (a full download unloads before it loads), and the run reports exactly that.
A stop it cannot undo says so and names the configuration found (in the report) and the server's
backups (with the project, which a run on a device in service always keeps) as the starting point for
a recovery by hand.

A stop before a step's first write (`<capability> preflight`) and a failure of the runner's own
connections (`harness: …`, a witness or restart that broke off) fail the run but produce no evidence
record: the device did nothing the record could state. Records of a device in service name the
configuration as "the device's own configuration, taken over by read-back", its origin as unknown,
and never the test address.

Persistence is checked once, while the test link is placed, and the record attributes it to the GA
flash only. A spec without a link step but with a requested full download checks it after the
download instead.

#### Writing a spec

One file per product in `tools/smoke/specs/`, registered in `specs/index.ts`. A spec declares device
data and the steps, nothing else:

```ts
export const exampleInService: DeviceSpec = {
  id: "<product>-in-service",
  device: { appRef: "…", productRef: "…", ia: "1.1.x", mask: "MV-…" },   // verbatim, as for every spec
  provision: "in-service",
  inService: {
    fingerprint: [
      { name: "application id", object: 4, pid: 13, expect: "00faa01255" },  // System B, see below
      { name: "version", object: 0, pid: 25, expect: "0945" },
    ],
    expectParams: [{ name: "module type", paramRefId: "…_R-…", value: "6" }], // optional
    assumeParams: [{ name: "rocker function", paramRefId: "…_R-…", value: "2" }], // optional, no memory location
    param: { paramRefId: "…_R-…", value: "2" },                          // flashParams
    link: { comObjRefId: "…_O-1_R-…" },                                  // flashLinks (addToLinked: true for a linked object)
    structural: { paramRefId: "…_R-…", value: "1" },                     // structuralFlash, optional
    fullDownload: true,                                                  // offered, optional
  },
  configure: [],
  behaviours: [{ kind: "output", label: "…", comObjRefId: "…_O-1_R-…", expectValue: "01" }],
  unsafe: [{ capability: "fullDownload", reason: "…" }],                 // each claimed write without a step
};
```

| Field | Rule |
|---|---|
| `inService.fingerprint` | The application id and the version property of the mask's family (table below), each `expect` as lower-case hex; further properties may follow. Take the values from a collection of the unit (`bun run tools/collect.ts <host[:port]> <ia> <out.json>`, read-only): the `identity` records' `target` (object, PID) and `bytes`. A record with outcome `refused` is a property the unit does not have. A family that keeps the application id in memory names the range instead: `{ name, memory, length, expect }`, the bytes from the collection's memory record |
| `inService.dataSecure` | `true` for a unit that runs KNX Data Secure. Such a unit answers plain reads with nothing usable, and only a project file brings its keys, so the run imports the installation's project file the operator gives (`--knxproj=<file>`, its password in `BUSFORGE_SMOKE_KNXPROJ_PASSWORD`; both belong to the installation, never to the spec) instead of placing the unit from the catalogue. The file's device at the spec's address must be the spec's product and carry a tool key. The server takes the unit's tool key, the keys of its group addresses and, for a KNXnet/IP interface, its IP settings with the import; the runner reads the same file for its own connections (fingerprint, restart), which open the unit's secure session. The configuration found is still the one the read-back takes off the unit, not the file's. The test address must be no group address of the file, and is set to plain (Data Secure "off") before the link, so the unit takes it without a key and the witness reads it plainly. The kept project holds the installation's keys, sealed as any import's |
| `inService.ipInterface` | For a unit that is a KNXnet/IP interface or shares its housing with one: `ia`, that interface's individual address, `restart`, what a restart of the unit does to its tunnels (the run's own included), and `shown`, where that was shown. Before anything reaches the unit the run asks the interface it goes through for its KNXnet/IP device information (a DESCRIPTION_REQUEST on its own connection, as ETS sends it over TCP) and records the individual address and serial number the interface reports, with the run's tunnel address, in the report. With `restart: "drops"` the run refuses that interface, the unit itself should the box report the unit's address, and an interface that reports no individual address, since it could not show it avoids it; with `"keeps"` it may go through it. The server's connection, the witness and the restart go to the same host and port. The bench specs' Data Secure robustness checks (a wrong tool key, altered answers) never run on a device in service |
| `inService.expectParams` | Optional. Parameters whose values the device's own configuration must hold once the project has taken it over, each with a `name` for the report and the value as `GET .../config` shows it. A mismatch, or a parameter the configuration does not show, stops the run after the adoption and before the test address is probed or anything is written. For what the fingerprint cannot tell: products that share application, firmware and hardware type (a module-type parameter), or a setting the run relies on staying as it is (an output's download or bus-return behaviour) |
| `inService.assumeParams` | Optional. Parameters **without a memory location** (a rocker's function, a status LED's mode) that the unit runs off their catalogue default, each with a `name` and the value as `GET .../config` shows it. No read-back sees them, so a unit taken over by read-back alone keeps their defaults, and the objects they show stay hidden: the adoption stops with the unresolved object numbers, split as the read-back splits them, and proposes an assumed value only for objects the unit's own configuration does not place. The first read-back assumes these values; the server takes them only if the unit's configuration then shows an object for every link it holds, and refuses a parameter with a memory location ([architecture.md](architecture.md#read-back-adopting-the-device-state-as-the-baseline)). The values come from the unit's ETS project. The server checks them against the unit's links and its parameter image (a dry run under them must find nothing to write); several values of a parameter may show the same objects, so mostly the image decides. A value another value of its parameter writes the same is taken unproven; the run logs it and records it in the configuration found (`unprovenAssumptions`). A download marker the device clears itself is no difference there ([load-procedures.md](load-procedures.md#the-rules-by-level), R17). Not the parameter of a step, not also in `expectParams` |
| Refs | Every `paramRefId` and `comObjRefId` is the full ref as `GET .../config` lists it; a ref that matches only by its end is refused |
| `inService.param` | A parameter the unit shows, writable, in the parameter image, whose change leaves the com-object table alone (a delay, a threshold, a number; not a channel function or anything that shows or hides objects). `value` must differ from what the unit holds. The run reads the unit's own value and writes it back |
| `inService.link` | An object the unit holds **unlinked**, or with `addToLinked: true` one it holds **linked**: its own addresses stay and the test address is added behind them, then removed again. The object's read flag (the application's, with the project's own laid over it) must be on when a behaviour is an `output`; the run refuses the object otherwise. With `addToLinked` the test address must lie above every address the object holds: an object sends on the address its association table lists first, and the run adds the test address behind the object's own, but only one ETS capture shows an object whose first address is not its lowest ([findings.md](findings.md) §36), so on other products a lower test address could take the sending place. An object answers a read of any of its addresses on its first association, the address it sends on ([findings.md](findings.md#36-ets-lists-the-sending-address-first-and-the-device-sends-on-it)), so with `addToLinked` the `output` witness reads the test address and takes the answer on the object's own first address: a GroupValueResponse from the unit there, after its read went out. It listens half a second before reading; a GroupValueRead of the test address or of any of the object's own addresses by another client that it sees in that time or while it waits, or a response on the first one before its read, would put an answer there that is not the witness's, and the run fails as a harness failure without a behaviour record. Once the test address is removed, the witness reads it again: an answer on the object's first address then fails the behaviour, and only then is a pass recorded. That contrast rules out a unit that answers on its first address whatever is read, and a client reading the object more often than the witness's window; a read the witness cannot see (from another tunnel of the interface) that falls into its first read's window it does not rule out. The addition goes through the channel under test, as the GA flash does: on the `ui` channel the device page's address editor adds the test address behind the object's own and the run waits until the editor lists it there. In both channels the run first creates the object's own addresses in the project, since the project takes a link only to an address it holds. The test group address is not in the spec (it belongs to the installation): the operator gives it with `--test-ga=<main/middle/sub>`. It must be unused **in the whole installation**: the linked object may send on it (on every restart, for one), and any device listening there would act on it. The run refuses an address an object of the unit uses, or one on which anything answers a read or sends within 5 s, but it cannot see a device that only listens; checking that is the operator's job. The run refuses an object whose links do not match the step (linked without `addToLinked`, unlinked with it) and never replaces a link |
| `inService.structural` | Only where the product claims `structuralFlash`: a parameter whose change alters the com-object table, and the value to set. The dry run must offer a structural flash |
| `inService.weatherGuard` | `true` for a weather station whose alarms protect the installation (an awning's wind lock) and which sends no measured value and no alarm while a write runs and while it restarts. The run needs the operator's weather guard, `--weather-guard=wind:<ga>:<threshold m/s>,<name>:<ga>,...` (the installation's addresses and the station's wind alarm threshold, at most 60 m/s, never in the spec), and reads it through the witness before the channel, before every write (each ends with the unit's restart) and before the persistence restart, the undo's writes included. Only the unit's own GroupValueResponse counts. It stops the run when an address is not answered by the unit, the wind (a 2-byte float, DPT 9) is at or above 70 % of the threshold, or any other address (1 bit: rain, an alarm, a lock) reads anything but 0. The reads are a snapshot before each write: nothing is read during a write, which for a full download takes minutes. The undo reads it once before each of its writes; a stop there leaves the change on the unit and the restore failed, named, for the operator to write back once the weather allows |
| `inService.fullDownload` | `true` offers a full download of the configuration found. It runs only with `--full-download` on the command line; without it the capability is reported `unproven` |
| `behaviours` | `output` (a GroupValueRead on the test address is answered, optionally with `expectValue`; with `addToLinked` on the object's own first address, with the control read after the removal, see `inService.link`) or `heartbeat` (the object sends on the test address within `windowMs`; not with `addToLinked`, since the object sends on its own first address), on the linked object, without `ga` or `enable`. Empty leaves the link proven to the byte only, which the records state |
| `unsafe` | Every write capability the product claims (`flashParams`, `flashLinks`, `structuralFlash`, `fullDownload`) without a step here, with the reason. The run stops before its first write when one is missing, and when a step names a capability the product does not claim |
| Steps | At least one of `param`, `link`, `structural`, `fullDownload`. `readParams` and `readLinks` must be claimed by the product (the run takes the configuration over by reading it); they pass on the channel's own read-backs after the steps |
| `configure`, `fuzz`, `structuralTrigger`, `precondition` | Must be empty or absent; the spec is refused otherwise |

The fingerprint follows the mask's family. The application id is PID 13 of the object the mask's
master data names for it, or on System 1 a memory range; the version is the object-0 property the
family's units report, while they refuse the other:

| Family | Application id | Version | Refused, so not in the spec |
|---|---|---|---|
| System 7 | object 3 PID 13 | object 0 PID 9 (firmware revision) | object 0 PID 25 |
| System B | object 4 PID 13 | object 0 PID 25 (version) | object 0 PID 9 |
| System 1 | memory `0x0104`, 4 bytes (manufacturer, application number, version; `BCU1_APPLICATION_ID_RANGE`) | none: the collections of an MV-0012 unit show no object-0 version property; the mask version is the device descriptor, which the read-back checks | |

A System 1 unit has no load-state machines, so its persistence check reads the run error byte
(`0x010D`) instead: `FF` before the restart and after the reboot.

The version columns come from read-only collections of MV-0705 and MV-07B0 units; the rule applies
to the whole family, and a unit of another mask that refuses its version property stops the run at
the fingerprint, before anything is written. A spec for a mask of another family is refused until
its rule is added (`FINGERPRINT_RULES` in `inservice.ts`) from a collection of one of its units.

`bun test tools/smoke/inservice.test.ts` checks every registered device-in-service spec against
these rules, so a spec that breaks one fails `bun run check`.

`tools/smoke/inservice-specs.test.ts` (private corpus) runs every registered device-in-service spec
against the real server routes and the real read and write paths of its family, on its unit emulated
from a read-only collection taken before any write (`packages/product/test/collected-unit.ts`: it
answers only what the collection holds and refuses any other read; on a memory-mapped mask,
MV-0700/0701, it keeps each load-state machine's state in the bytes at `46825 + LSM` and, after a load
event, refuses that machine's PID 5, as no capture shows whether the unit's PID 5 follows). The run must pass, make the
writes its plan lists, and leave the unit's memory as it found it, but for table residues, on a System B application that declares
`DownloadInvisibleParameters="None"` the bits of parameters a reverted step left inactive, holding the
step's value (R14), and the bits of a download marker the real unit clears after a download and the
emulated one keeps (R17, [load-procedures.md](load-procedures.md#the-rules-by-level)). This shows the run gets through the
server's guards, the adoption and the dry runs on the unit's real bytes; it does not show that the
device acts on them (the emulated witness answers when the unit's tables hold the association) or keeps
them (the emulated restart keeps everything). A spec whose unit cannot be emulated is named there with
the reason.

Not supported in this mode: `inputToOutput` behaviours (they need two links), and a secured test
address (the witness reads plainly).

#### Running it

```bash
bun run tools/smoke/runner.ts <spec-id> --plan --test-ga=<a/b/c>      # the sequence, no server, no bus
BUSFORGE_BENCH=1 BUSFORGE_BENCH_HOST=<interface> bun run smoke <spec-id> --channel=api|ui --test-ga=<a/b/c> [--full-download]
BUSFORGE_SMOKE_KNXPROJ_PASSWORD=… BUSFORGE_BENCH=1 BUSFORGE_BENCH_HOST=<interface> bun run smoke <spec-id> … --knxproj=<installation.knxproj>   # a Data Secure unit
BUSFORGE_BENCH=1 BUSFORGE_BENCH_HOST=<interface> bun run smoke <spec-id> … --weather-guard=wind:<ga>:<m/s>,<name>:<ga>,...   # a weather station
```

`--plan` prints the reads and writes in the order the run performs them (and refuses a spec or
options the run would refuse). `--test-ga` is needed whenever the spec has a link step, `--weather-guard` whenever it declares `weatherGuard`. A device-in-service spec
runs only when named: running every spec leaves it out. `BUSFORGE_BENCH_HOST`/`BUSFORGE_BENCH_PORT`
name the interface that reaches the unit, which must be a saved IP connection. The runner's own
connections (fingerprint, witness, restart) are KNXnet/IP tunnelling over TCP to that host and port;
an interface without TCP tunnelling stops the run at the fingerprint.

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

The click-through requires each parameter's row and each com-object's link row to be rendered and
visible. A display parameter (a heading or note without a value) has an empty value cell, so its row
instead must be visible and show the parameter's name. In a grid cell the page carries a parameter's
name only as the cell's tooltip, so there the check proves the row, not the name on screen; the pass
detail counts those rows, and the display parameters without a name to show.

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

Omitting the spec id runs every spec except the device-in-service ones. `--channel` selects one channel per invocation; a device
counts as done only with both green, so it is run once per channel. `bun run smoke` implies
`--report`, writing one JSON artifact per run under `tools/smoke/reports/` (git-ignored) with the
spec, channel, seed, every verdict and the raw `FlashResult`s (`--report=<dir>` picks another directory
inside the repository; one outside it is refused, because a record names its report by its repository
path, and a backup path the server returns is written relative to its data directory). Next to each report the run writes
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
