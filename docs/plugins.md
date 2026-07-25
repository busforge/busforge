# Device-configuration plugins

Some KNX devices cannot be expressed by a parameter grid at all: a DALI gateway, a logic module, an
energy meter. For those, the manufacturer ships a **DCA** (Device Configuration App), a plugin that
appears as an extra tab inside ETS. Busforge cannot run one, and does not pretend to. Instead it
detects that a device needs one, keeps that device's data intact, says so plainly, and where a
**native module** exists, renders the same configuration itself.

## What a DCA is, and why it cannot be run

KNX has three related things:

| Kind | What it is | Scope |
|---|---|---|
| **ETS App** | A general add-in for the ETS application (menus, reports, import/export), sold as `.etsapp`. | Extends ETS |
| **DCA** | A device-specific configuration plugin, shown as an extra tab next to Parameters and Group Objects. | Configures one device family |
| **Plug-in** | The pre-ETS5 predecessor of the DCA. | Legacy |

A DCA is a signed **.NET assembly with a WPF user interface**, built against the ETS SDK. ETS hands
it device access at runtime: read and write device memory and interface-object properties, read and
write its own project *baggage*, and online bus access for interactive commissioning. Its
configuration is stored twice: as an opaque blob inside the project archive, and on the device in
interface objects written as **property load images**, not as named parameters. The product XML
describes *that* those images are downloaded, never *what is inside them*.

**The blocker is the host, not the runtime.** An `.etsapp` is not a standalone program: it is a
plugin with no entry point that runs only because ETS hands it the device model, the project, bus
access and a WPF UI host. So running a DCA at all means reimplementing that SDK surface plus a WPF
host, which is Windows-only, large, undocumented and (the assemblies being signed) legally fraught
to re-host. Wine does not help: it supplies the runtime, and running full ETS under it is just
using ETS.

What Busforge does instead is **reimplement one device's configuration natively**, using the
decompiled DCA as the *specification* for its otherwise opaque format. That is finite, per-device
work, and it is owned end to end.

## The baseline: honest about a DCA device even with no module

This holds for every DCA device, module or not.

- **Detect.** An application program whose name or visible description contains the word `DCA` is
  flagged. The manufacturer's own description becomes the hint shown to the user.
- **Preserve.** The archive's `BinaryData/` and `UserFiles/` entries (the *baggage*) are extracted at
  import and stored per project, so a DCA device's state is never dropped. Baggage travels with the
  project through export and import. Baggage that cannot be read is reported at import rather than
  silently skipped.
- **Surface.** The device page shows a clear notice that this device is configured through an ETS
  DCA app and that its device-specific configuration is not shown here, while the standard parameters
  stay editable and programmable.

**Is programming a DCA device dangerous?** The argument that it is not is structural, not
empirical. The two kinds of configuration are independent: a parameter flash writes the parameter
segment, a group-address flash writes the addressing tables, and Busforge **does not implement
property load images at all**. A load procedure that declares one for anything other than a
known-harmless stamp is refused outright (`LOAD_STEP_UNSUPPORTED`), so the device-specific
interface objects are never written. It remains an argument, not evidence: how far the one DCA
device in the corpus (the Theben DALI gateway) has actually been driven is recorded in
[status.md](status.md).

## The native module architecture

Where a native replacement exists, the device page offers it instead of the notice alone.

```
   project import → baggage stored per project
                          │
   ┌──────────────────────┴───────────────────────┐
   │ core                                          │
   │  • configuration engine (parameters, links)   │
   │  • server registry: manifest + evaluate()     │
   │  • baggage endpoint                           │
   └──────────────────────┬───────────────────────┘
                          │ matched by application id → module id
                          ▼
   ┌──────────────────────────────────────────────┐
   │ plugins/<module>                              │
   │  • manifest: what it matches, what it parses  │
   │  • parse(bytes) → typed model                 │
   │  • view: a lazily loaded React component      │
   └──────────────────────────────────────────────┘
```

**Two registries, one id.** The server resolves a module from the device's application program id and
version and puts a small descriptor on the configuration view. The web app looks the same id up in
its own registry and lazily imports the view. The split is deliberate: a module's server-safe entry
point (matching, parsing, the data model) must not pull React into the server process, so the view is
a separate export.

**Version gating is explicit, not silent.** A module declares the application versions it was built
against. A device on another version still matches, but the descriptor is marked incompatible: the
button reads "open anyway", opening it requires an acknowledgement, and the dialog carries a
persistent warning naming both versions. The alternative, quietly rendering a possibly misparsed
configuration, is exactly the failure mode this project exists to avoid.

If the server resolves a module the client does not ship, no button is rendered at all. If the
device has no matching baggage entry, the dialog says there is no stored configuration rather than
showing an empty table.

## The module contract

The manifest and matcher, exported from the module's server-safe entry:

```ts
export interface DcaManifest {
  id: string;
  displayName: string;
  /** Short, generic kind shown in the device notice, e.g. "DALI configuration". */
  category: string;
  /** Application-program id prefix, stable across the version digits. */
  appIdPrefix: string;
  /** The DCA AppId from the bundled AddInManifest.xml, for reference/diagnostics. */
  dcaAppId?: string;
  /** ETS ApplicationVersion values this module was built against and verified on. */
  compatibleAppVersions: number[];
  /** The baggage entry (by name token) this module parses. */
  baggageToken: string;
}

export interface MatchResult { matched: boolean; compatible: boolean }
export function evaluate(appId: string | undefined, appVersion: number): MatchResult;
```

The client side, registered under the same id:

```ts
export interface DcaModuleClient<M = unknown> {
  parse: (bytes: Uint8Array) => M;
  baggageToken: string;              // baggage entry name (substring) this module consumes
  View: LazyExoticComponent<ComponentType<{ model: M }>>;
}
```

The registry stores modules type-erased, because every module has its own model type. The erasure
happens at a single helper so that a module's parser and its view are still checked **against each
other** at the point of registration: a view cannot be paired with a parser for a different model.

`parse` is pure and takes bytes, which is what makes a module testable against a recorded blob with
no device, no bus and no server.

## The shipped module

`plugins/dca-theben-dali-e64` replaces the Theben DALI gateway's DCA with a **read-only** view. It
decodes the device's backup store (UTF-16 XML, detected by byte-order mark or a leading-`<`
heuristic rather than by trusting a declared encoding, so it behaves identically in the browser and
under Bun) into a typed model, and renders three sections: fixtures with their names, groups, short
and long addresses, lamp type and commissioning state; groups with their fixture counts; and scenes.

Field meanings were recovered from the decompiled DCA and implemented from that documentation. The
parser is covered by tests against a recorded backup store.

**There is no write path.** Nothing in this module touches the bus or the device. Writing a
device-specific configuration back is on [roadmap.md](roadmap.md).

## Two sources of truth

A DCA's blob mirrors most of its configuration, but at runtime the DCA treats the **ETS parameter
set** as authoritative for some fields (lamp type, colour-control type, dim curves, descriptions).
Busforge parses those parameters for every device already. So:

- **Read-only display** needs the blob alone.
- **Full fidelity, and any write-back**, needs the blob *and* the ETS parameters, kept consistent.

That is why the read-only view is not merely a smaller version of the write path; the write path has
a consistency problem the read path does not.

## Adding a module

The framework generalises; each module is bespoke. Every DCA has the same shape (a .NET assembly
handed a small, fixed SDK surface), so the host side is written once. What is per-device is the
format and the programming layer: the persisted config format varies, property ids and byte layouts
are per manufacturer, and a firmware or DCA revision can change either. That is why a module declares
the versions it was verified against.

1. Get the device's `.etsapp` and its `BinaryData` blob out of a project. Both sit in the encrypted
   inner archive that Busforge already decrypts.
2. Inspect the blob. Try a UTF-16 decode first; many are XML.
3. Decompile the assembly (`.etsapp` is a zip containing the .NET assembly; `ilspycmd` or an
   equivalent decompiler produces readable C#). Find the serializer to document the format, the
   device layer (property ids and any command handshake) for a future write path, and the localised
   text resources for labels.
4. **Implement from the documented format, not by copying decompiled code.** Treat decompilation as
   a way to document behaviour. Reimplementing a third party's proprietary format in an open
   repository is sensitive; keep modules per-device and opt-in, and get a real review before
   publishing a module for third-party hardware. (Not legal advice.)
5. Create a workspace package under `plugins/` with two exports: a server-safe entry (manifest,
   `evaluate`, `parse`, the model) and a `./view` React entry with `react` as a peer dependency.
6. Register it: add the manifest and matcher to the server registry, add the parser plus lazy view to
   the web registry under the same id, and add the package as a dependency of both apps.
7. Ship a parse test against a recorded blob fixture. That fixture is the module's regression guard,
   and it is the only part of a module that can be verified without the physical device.
