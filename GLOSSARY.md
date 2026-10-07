# Busforge

Glossary for Busforge. Only terms whose meaning is specific to this project and easy to
confuse; general programming concepts do not belong here.

## Device model

**DeviceProfile**:
The abstract base class (`packages/product/src/profiles.ts`) for a family of KNX devices that
share a memory model and load procedure. Concrete profiles are `SystemBProfile`,
`System7Profile`, `UnsupportedProfile`; a device is dispatched to one by `classify()` on its mask.
_Avoid_: driver, handler, adapter.

**DeviceCapabilities**:
The record a `DeviceProfile` returns from `capabilities()` declaring what it can do:
`readParams, readLinks, flashParams, flashLinks, fullDownload, structuralFlash`. It is the single
source of truth for what a device supports, used to gate the server endpoints and surfaced to
clients.
_Avoid_: features, supports, abilities.

## Testing

**Evidence record**:
One observation about one product in the versioned format `busforge.evidence/1`
(`packages/product/src/evidence.ts`, [docs/evidence-contract.md](docs/evidence-contract.md)): identity,
firmware, build, transport, scope, origin and a result on each evidence axis. Unknown facts stay unknown.
_Avoid_: test result, report (a smoke report is one source of records).

**Evidence axis**:
One of the four independent questions a record answers: **transfer** (the device holds what was
written), **reference** (the bytes match an independent source), **behaviour** (the device acts on
the bus) and **persistence** (the configuration survives a restart or power cycle). No axis implies another.
_Avoid_: verified (without naming the axis).

**Independent reference**:
An ETS download of the same configuration, or a device commissioned by another tool that Busforge
has never written to. Only this can show that Busforge builds the right bytes; a read-back of bytes
Busforge wrote cannot.
_Avoid_: ground truth for a self-written dump.

**Hardware, Product, application program** (KNX catalog):
A manufacturer's **Hardware** is one physical device design; its **Products** are the order-number
variants of that hardware; **Hardware2Program** names the application programs it can run. Evidence
belongs to the Product it was taken on; another Product on the same Hardware or with the same
application program gets a factual hint, never a test state.
_Avoid_: sibling product, product family, compatibility class.

**Transfer verification**:
Evidence that a device returns the bytes submitted to it, within the checked ranges;
it does not establish that those bytes encode the intended configuration or survive power loss.
_Avoid_: configuration correctness proof.

**Compatibility matrix**:
The per-Product table of operations and their evidence state, built from the kept evidence records
([docs/compatibility.md](docs/compatibility.md)). A Product that is not in it has no kept evidence.
_Avoid_: market coverage percentage, mask count used as compatibility evidence.

**Diagnostic package**:
The cleaned file a read-only acquisition of one device produces in the app: the device's answers,
without the installation's ids, connection address and device serial number, reviewed in full
before the user saves it. A cancelled acquisition produces none
([docs/raw-acquisition.md](docs/raw-acquisition.md#diagnostic-package)).
_Avoid_: export (reserved for the project archive), dump.

**Capability**:
A single programming path busforge can drive, exercised and verified against real hardware by the
smoke framework (`tools/smoke/`). Its name matches a `DeviceCapabilities` key wherever one exists
(`flashParams`, `flashLinks`, `fullDownload`, `readParams`, `readLinks`). What a device claims is
read from the product, not hand-declared. A capability check is a **write-path proof**: its oracle
is the device read-back matching busforge's own image (zero owned-diff, verified). It proves
busforge can reliably *place* bytes; it does **not** prove the configuration is behaviourally
correct (a wrongly-but-consistently-encoded value reads back green). Behaviour proves that.
_Avoid_: phase, step, operation, scenario.

**Behaviour**:
A behaviourally-testable function a device performs on the bus (e.g. `heartbeat`, `output`/readable
status, `input`→output), declared per device in its `DeviceSpec` with a binding (which params enable
it, which com-objects, DPT/interval). The framework configures it (using capabilities), assigns a
random group address, flashes, then **observes the bus** (listen / GroupValueRead / GroupValueWrite
then read the effect). This is the real **correctness proof**; read-back is not.
_Avoid_: function (overloaded), feature, scenario.

**Profile capability**:
A `Capability` that corresponds to a `DeviceCapabilities` key, i.e. a per-family behaviour of the
`DeviceProfile` (e.g. `flashParams`). Which ones apply to a device come from `classify().capabilities()`.

**Lifecycle capability**:
A `Capability` that is not a `DeviceProfile` concern and applies to any device: `provision`
(assign an individual address), `place`/`delete` (project-level), `ui-click-through` (render every
parameter and com-object and verify against the device). Layered on top of the profile capabilities.

**Channel**:
The path a capability is driven through, over the *same* real hardware: `api` (the production
endpoints directly, the fast regression path) or `ui` (the real web app in a browser, the
user-facing path). Assertions always read the API; the browser is driven, never asked to confirm
itself.
