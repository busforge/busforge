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
| ParameterRef / ParameterRefRef (rows) | `DisplayOrder` / `IndentLevel` (904×) | open | rows inside a block not ordered/indented like ETS |
| `<Channel>` | heading `Text`/`Number`/`TextParameterRefId` (99×) | open | channel section titles (e.g. "GRUNDMODUL {{0}}") dropped entirely |
| ParameterBlock | `Access="None"`/`Read` (29×) | open | we render blocks ETS hides |
| ParameterBlock | `ShowInComObjectTree` (263×) | open | com-object grouping signal ignored |
| ComObject | `ReadOnInitFlag` (2204×) | open | the 6th flag missing on every object (we show only R/W/C/T/U) |
| ParameterBlock (item-less) | self-closing collector blocks | open | item-less section headers dropped (e.g. the `Szenen`/"Scene" section) |

MED: `TypeNumber/@Increment` (spinner step), `TypeNumber/@UIHint=Slider`,
`Parameter/@InitialValue`, `Parameter/@BaseValue` (allocator/module numbering,
flash path), `TypeFloat/@Encoding`. LOW (safe to ignore): `InternalDescription`,
`Tag`, `DefaultUnionParameter`, `Inline`, `Icon`, `SecurityRequired`, plugin
validation, `LegacyPatchAlways`, color/IP/time sub-attributes (types unsupported
anyway).

The flash/image path (`application.ts`) is correct for its scope (reads
Memory/CodeSegment/Offset/BitOffset, SizeInBit, signed Type); its only real gap
is allocator/`Repeat Count` module expansion, guarded by `unmappedParamRefs`.

**Prioritized fixes:** (1) Channel heading text, (2) Enumeration `DisplayOrder`,
(3) per-row `DisplayOrder` ordering, (4) ParameterBlock `Access="None"` hiding,
(5) `IndentLevel` row nesting, (6) `ReadOnInitFlag`, (7) item-less collector
blocks, (8) `Increment`/slider.

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
| Channel | partial | container works, the channel's heading/label is dropped |
| Unknown / vendor element | surfaced | emitted as an `unsupported` marker (no longer silent) |

## Parameter type coverage

| Type | Status | Notes |
|---|---|---|
| TypeRestriction (enumeration) | full | dropdown |
| TypeNumber | full | number input |
| TypeText | full | text input |
| TypeRestriction Base="BinaryValue" | not yet | shown with "not supported" badge |
| TypeFloat | not yet | KNX 2-byte float / IEEE; badge |
| TypeTime | not yet | badge |
| TypeColor | not yet | badge |
| TypeIPAddress | not yet | badge |
| TypeNone (display) | not yet | informational; badge |

## Roadmap (priority order)

1. `<Channel>` heading/label (reuse `blockTitle`; same class as the Repeat fix).
2. Render the remaining parameter types: Float, Time, Color, IP address, Binary,
   and TypeNone displays.
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
2. **One model (the real fix, planned).** A single parse + a single
   module-instance expander that yields the fully-resolved per-instance parameter
   set: id, value, **memory offset**, type, visibility. The UI becomes a
   visibility-filtered, localized projection of that set; the image becomes the
   byte projection. Same parameters, same expansion, consistent by construction.
   The missing technical piece is per-instance memory-offset resolution
   (allocators / 0.xml). Once it exists, delete the second parser.
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
  config view; masks only matter in the flash/image path, which is validated
  byte-for-byte against real hardware.
- The config language follows the UI language, mapped to the nearest catalogue
  language (exact, then primary subtag, then the catalogue's base text).
