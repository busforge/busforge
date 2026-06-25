# ETS coverage and engine status

Living status of how completely busforge renders an ETS application program,
what it does not yet support, and the rules that keep gaps visible instead of
silent. The end goal is 100% parity with ETS for the device configuration view.

## Guiding rule: never drop silently

Anything the engine cannot render must be shown in the UI as an explicit
"not supported yet" marker, never omitted and never rendered as an empty or
misleading control. A missing parameter that looks like it is simply absent is
worse than a clearly labelled gap: it hides drift (a changed value the user
cannot see) and erodes trust in the configuration. Two mechanisms enforce this:

- Unknown dynamic elements become an `unsupported` node (with the original tag)
  instead of being discarded, so they appear as a warning row in place.
- Parameters whose datapoint/type the engine cannot edit keep a visible row with
  a "not supported yet" badge and their raw stored value, instead of a blank
  control.

## What we found (June 2026)

- **`<Repeat>` was dropped entirely.** Channel banks (e.g. the six HMG 6 T
  heating channels) are declared as a `<Module>` wrapped in a `<Repeat>`. The
  dynamic parser had no case for `Repeat`, so it hit `default: return null` and
  discarded the module and every channel under it. Device 1.1.x rendered 12
  blocks / 62 params instead of the real 92 blocks / 597 params. Fixed: `Repeat`
  is now a transparent container and the existing module-instance path expands
  each channel.
- **The "many changes, nothing visible" symptom was a real, honest indicator.**
  The change counter is an unfiltered symmetric difference of stored vs baseline
  values; it correctly counted changed parameters that lived inside the dropped
  `Repeat` channels, which the page then could not render. It was not a counting
  bug and nothing was patched away to hide it. The `Repeat` fix removes the
  cause. Lesson: the change indicator is only as trustworthy as the UI is
  complete, so completeness is a correctness property, not just UX.
- **Read-back inherits UI completeness.** Read-back records drift only for refs
  the config view exposes (`relevantRefs`). Before the `Repeat` fix it ignored
  channel drift. Re-read channel devices captured before the fix.
- **A class of structural drops remains.** `<Channel>` carries a localized label
  (e.g. "Inputs A-F", "Logic", "GRUNDMODUL {{0}}") that ETS shows as a heading;
  the engine flattens it to a transparent container and drops the heading. Same
  failure class as `Repeat`, lower blast radius (a label, not whole params).

## Silently-ignored attributes & semantics (audit 2026-06-23)

We surface unknown *elements* and uneditable *types* in the UI, but for a long
time silently ignored *attributes* and *layout semantics* the catalogues carry,
the class the `DisplayOrder` ordering bug belonged to. Full inventory against the
11 real catalogues: **26 attributes present in the data are not read; 6 are HIGH
impact**, plus ~6 ignored semantics. This list is the backlog toward ETS parity.

HIGH impact (changes what is shown, the order, visibility, or numbering):

| Where | Attribute / semantic | Status | Effect when ignored |
|---|---|---|---|
| ParameterRef (block heading) | `DisplayOrder` | **fixed** | blocks now ordered by it, not document order |
| Enumeration | `DisplayOrder` (2435×) | open | dropdown options shown in document order, not ETS order |
| ParameterRefRef (rows) | `IndentLevel` (904×) | **fixed** | rows now indented by IndentLevel; per-row DisplayOrder is a no-op (within-block document order already equals DisplayOrder) |
| `<Channel>` | heading `Text`/`Number`/`TextParameterRefId` (99×) | **fixed** | channel sections now shown as navigable groups with `{{0}}` substituted |
| ParameterBlock | `Access="None"`/`Read` (29×) | open | we render blocks ETS hides |
| ParameterBlock | `ShowInComObjectTree` (263×) | open | com-object grouping signal ignored |
| ComObject | `ReadOnInitFlag` (2204×) | open | the 6th flag missing on every object (we show only R/W/C/T/U) |
| ParameterBlock (item-less) | self-closing collector blocks | **fixed** | a reached childless header (e.g. "Scene") is shown as an empty navigable section; headers in inactive choose branches stay hidden (no noise) |

MED impact, resolved:

| Where | Attribute | Status | Notes |
|---|---|---|---|
| TypeNumber | `Increment` | **fixed** | becomes the number input's spinner step (e.g. PSU current in 5 mA steps); verified live on 1.1.x |
| TypeNumber | `UIHint="Slider"` | **fixed** | a bounded number renders as a range slider with a live readout; verified live on 1.1.x (0-255) |

MED impact, analyzed and deferred (each with a concrete reason, not silently skipped):

- `Parameter/@InitialValue` (1× in the catalogues): on a hidden `Access="None"`
  parameter and equal to `Value`. We already drop `Access="None"` rows and the
  view is driven by `Value`, so honoring `InitialValue` would have **zero visible
  effect**. Reading it would only matter for "unchanged since factory" detection,
  which busforge does not do. Left unread on purpose.
- `Parameter/@BaseValue` (5×): on read-only mirror parameters inside modules,
  pointing at a module `Argument`. This is the per-instance allocator/numbering
  mechanism, i.e. exactly the work tracked under "Planned: unify the model"
  below. Deferred to that effort, not addressed piecemeal.
- `TypeFloat/@Encoding` (3×): `TypeFloat` is wholly unsupported today (shown with
  a "not supported" badge), so its `Encoding` is moot until float rendering lands
  (roadmap item 2). Surfaced via the unsupported-type badge already.

LOW (safe to ignore): `InternalDescription`,
`Tag`, `DefaultUnionParameter`, `Inline`, `Icon`, `SecurityRequired`, plugin
validation, `LegacyPatchAlways`, color/IP/time sub-attributes (types unsupported
anyway).

The flash/image path (`application.ts`) is correct for its scope (reads
Memory/CodeSegment/Offset/BitOffset, SizeInBit, signed Type); its only real gap
is allocator/`Repeat Count` module expansion, guarded by `unmappedParamRefs`.

**Prioritized fixes:** (1) Channel heading text, (2) Enumeration `DisplayOrder`,
(3) per-row `DisplayOrder` ordering, (4) ParameterBlock `Access="None"` hiding,
(5) `IndentLevel` row nesting, (6) `ReadOnInitFlag`, (7) item-less collector
blocks, (8) `Increment`/slider. All landed; the only remaining attribute work
(`BaseValue` allocator) is folded into the model-unification effort below.

**Visibility mechanism:** keep this inventory current and provide a re-runnable
audit (a dev script that, given a project's app XMLs, lists attributes present
but unread) so a new ignored attribute is found by us, not by the user.

## Dynamic element coverage

| Element | Status | Notes |
|---|---|---|
| ParameterBlock (+ heading from Text / ParamRefId / Name) | full | |
| ParameterRefRef / ComObjectRefRef | full | |
| choose / when / default (+ `test` grammar) | full | all catalogue test strings parse |
| ParameterSeparator | full | rendered as heading / ruler / error |
| Module instantiation (+ scope rewrite, com-object base numbering) | full | from the device's 0.xml instances |
| Repeat | full | transparent container; expands via module instances |
| Assign / Union / TextParameterRefId substitution | full | |
| ChannelIndependentBlock | full | transparent container |
| Channel | full | heading shown as a navigable section (Text + `{{0}}` substitution) |
| Unknown / vendor element | surfaced | emitted as an `unsupported` marker (no longer silent) |

## Parameter type coverage

| Type | Status | Notes |
|---|---|---|
| TypeRestriction (enumeration) | full | dropdown |
| TypeNumber | full | number input; `Increment` spinner step; `UIHint="Slider"` renders a range slider |
| TypeText | full | text input |
| TypeRestriction Base="BinaryValue" | not yet | shown with "not supported" badge |
| TypeFloat | not yet | KNX 2-byte float / IEEE; badge |
| TypeTime | not yet | badge |
| TypeColor (RGB) | full | native colour picker; stores #RRGGBB |
| TypeColor (HSV) | not yet | badge; sRGB picker would mis-encode HSV, pending encoding check |
| TypeIPAddress | not yet | badge |
| TypeNone (display) | not yet | informational; badge |

## Roadmap (priority order)

1. `<Channel>` heading/label (reuse `blockTitle`; same class as the Repeat fix).
2. Render the remaining parameter types: Float, Time, IP address, Binary,
   and TypeNone displays (Color is done: native picker).
3. Allocator-based module numbering / `Repeat Count` without 0.xml instances
   (needed once we support adding channels, not just reading existing config).

## Planned: unify the model (parse = UI = image)

The deeper problem behind the `Repeat` and the channel-flash bugs is structural:
there are **two independent parsers** with different coverage that have drifted.

- `parseAppConfig` (config UI) expands modules/Repeat, evaluates visibility, and
  localizes, but knows nothing about memory layout.
- `parseApplication` (image/flash) knows static refs, segments, and memory
  offsets, but does **not** expand module instances at all.

They read the same XML and must describe the same device, but a feature added to
one side (module/Repeat support landed in the UI parser) silently leaves the
other behind. What we parse, what we show, and what we program must be the same
model. The plan, in three stages:

1. **Make divergence impossible to ship silently (done).** The UI surfaces every
   unknown element / uneditable type as a visible "not supported" marker, and the
   flash path refuses to program when the stored configuration contains
   parameters the image builder cannot place (`unmappedParamRefs`). A mismatch is
   now always either visible or blocked, never silent.
2. **One parse, two projections (done).** There is now a single parser
   (`parseAppConfig`): it reads the memory layout (parameter offsets, segments) in
   the same pass as the visibility/i18n data, tagging each entry's provenance
   (module-def / union). `parseApplication` is no longer a parser, it is a thin
   projection (`toAppModel`) onto the flat image model, dropping module-def and
   union entries so it stays **byte-identical** to the standalone parser it
   replaced (verified old-vs-new on every real catalogue app program, including the
   ones flashed on hardware; the regression is pinned by `sample-image-app.xml`).
   A field authored as a child element rather than an attribute (a segment's base64
   `Data`) is read uniformly via `attrOrText`, restoring the transparency the merged
   parser had. The UI is the visibility-filtered, localized projection; the image is
   the byte projection; both read one model.
   - **Still open (the hard part):** per-instance **memory-offset** resolution for
     module instances (allocators / 0.xml). Until it exists, module instances are
     not byte-placed, so the flash path still refuses them via `unmappedParamRefs`
     (stage 1). Once it lands, module devices become flashable and the projection's
     module-def exclusion is lifted.
3. **Lock it in CI (planned).** A coverage test per catalogue/device asserting the
   UI-exposed param-ref set equals the image-placeable set; today that would fail
   for module devices (they genuinely diverge), so the enforced form today is the
   runtime guard from stage 1. When stage 2 lands, flip the test to an equality
   assertion so any feature added to one projection but not the other fails the
   build. Add round-trip tests too (build image -> read back -> decode == stored).

Also to verify: whether the GA-flash path (`flash-ga`) has the same
module/channel gap as the parameter-image path.

## Notes

- Mask versions (MV-0012/0701/0705/07B0) are intentionally irrelevant to the
  config view. They also do not select the flash/image path: that is chosen by the
  app's segment structure (`RelativeSegment` vs `AbsoluteSegment`), so e.g. MV-0701
  uses the absolute path despite the low number. The image path is validated
  byte-for-byte against real hardware.
- The config language follows the UI language, mapped to the nearest catalogue
  language (exact, then primary subtag, then the catalogue's base text).
