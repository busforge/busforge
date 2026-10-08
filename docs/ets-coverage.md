# ETS coverage

How completely Busforge renders an ETS application program, what it does not support, and the rules
that keep the gaps visible instead of silent. The goal is parity with ETS for the device
configuration view.

This tracks the **engine's coverage of the ETS product format**. Whether a device is actually
programmed correctly is a different question, answered in [status.md](status.md).

## Guiding rule: never drop silently

Anything the engine cannot render must appear in the UI as an explicit "not supported yet" marker.
It is never omitted, and never rendered as an empty or misleading control. A missing parameter that
looks simply absent is worse than a clearly labelled gap: it hides drift (a changed value the user
cannot see) and it makes the change indicator lie. Two mechanisms enforce this:

- An unknown dynamic element becomes an `unsupported` node carrying the original tag, so it appears
  as a warning row in place.
- A parameter whose datapoint type the engine cannot edit keeps a visible row with a "not supported"
  badge and its raw stored value, instead of a blank control.

The change counter is an unfiltered symmetric difference of stored values against the programmed
baseline. It therefore counts changes the page might not be able to render, and that has already
surfaced a real gap. **Completeness of the view is a correctness property, not a UX nicety**: the
change indicator is only as trustworthy as the view is complete, and read-back inherits the same
limit, because it records drift only for the refs the view exposes.

## Dynamic element coverage

| Element | Status | Notes |
|---|---|---|
| `ParameterBlock` (heading from `Text` / `ParamRefId` / `Name`) | full | including item-less collector blocks, which render as an empty navigable section |
| `ParameterBlock` with `Layout="Grid"` / `"Table"` | full | `<Rows>`/`<Columns>` geometry with per-item `Cell="row,col"`; an unreadable geometry is surfaced rather than swallowed |
| `ParameterRefRef` / `ComObjectRefRef` | full | |
| `choose` / `when` / `default` (and the `test` grammar) | full | every test string in the real catalogue fixtures parses; a token outside the known grammar refuses (`PARAM_TEST_UNSUPPORTED`) instead of falling through to `default` |
| `ParameterSeparator` | full | rendered as heading, ruler or error by `UIHint` |
| `Module` instantiation | full | scope rewrite, text-argument substitution, com-object base numbering; arguments from the device's `0.xml`, or resolved from `<Allocators>` for a device placed from the catalog |
| `Repeat` | full | transparent container; expands through module instances |
| `Assign` / union / `TextParameterRefId` substitution | full | |
| `ChannelIndependentBlock` | full | transparent container |
| `Channel` | full | heading shown as a navigable section, with `{{0}}` substitution |
| `Button` | parsed, inert | the scripted action is shown as a named element, not as an "unsupported" marker; it does nothing |
| Unknown or vendor element | surfaced | emitted as an `unsupported` marker, never dropped |

## Parameter type coverage

| Type | Status | Notes |
|---|---|---|
| `TypeRestriction` (enumeration) | full | dropdown, options ordered by `DisplayOrder` |
| `TypeNumber` | full | number input; `Increment` becomes the spinner step, `UIHint="Slider"` renders a bounded range slider |
| `TypeFloat` | full | decimal input; the codec takes its width from `Encoding` (KNX 2-byte DPT-9, or IEEE-754 Single) and refuses an unknown width |
| `TypeText` | full | text input; the image writes its ASCII characters and zero bytes to the end of the field, and refuses what no capture shows ([device-memory-model.md](device-memory-model.md#which-parameter-types-reach-the-image-at-all)) |
| `TypeTime` | full | raw integer count of the type's `Unit`; rendered as an `hh:mm:ss` duration for second-based units, else number plus unit |
| `TypeIPAddress` | full | validated dotted quad, 4-byte codec |
| `TypeColor` (RGB) | full | native colour picker, stores `#RRGGBB` |
| `TypeNone` (named) | full | display-only caption, rendered read-only; a nameless one is a pure layout spacer and is dropped |
| `TypeRestriction` `Base="BinaryValue"` | not editable | badge; the image writes the bytes of the enumeration its value names (`Access="None"` object-link tables of the Theben MIX 2) |
| `TypeColor` (HSV and any other space) | not supported | badge; an sRGB picker would mis-encode a non-sRGB register |
| `TypePicture` | not supported | badge |

## Attributes and layout semantics

Unknown *elements* and uneditable *types* are surfaced in the UI. *Attributes* are the quieter
class: an attribute the parser does not read changes what is shown, in what order, or whether it is
shown at all, with nothing on screen to say so. The inventory below was taken against the real
catalogue fixtures and is the parity backlog.

Read and honoured:

| Where | Attribute / semantic | Effect |
|---|---|---|
| `ParameterRef` (block heading) | `DisplayOrder` | blocks are ordered by it, not by document order |
| `Enumeration` | `DisplayOrder` | dropdown options in ETS order |
| `ParameterRefRef` | `IndentLevel` | rows are nested; per-row `DisplayOrder` is a no-op because within a block document order already equals it |
| `Channel` | `Text` / `Number` / `TextParameterRefId` | channel sections become navigable groups with `{{0}}` substituted |
| `ParameterBlock` | `Access="None"` / `"Read"` | a hidden block is not rendered, but its `Assign` side effects still gate later conditions |
| `ComObject` | `ReadOnInitFlag` | the sixth flag, alongside C/R/W/T/U |
| `TypeNumber` | `Increment`, `UIHint="Slider"` | spinner step and slider |
| `Parameter` | `LegacyPatchAlways` | parsed; the parameter is built and owned like any other, because ETS always writes its value over the `<Data>` byte (see [findings.md](findings.md) §8) |
| `ParameterBlock` (item-less) | self-closing collector blocks | a reached childless header renders as an empty navigable section; headers inside an inactive `choose` branch stay hidden |

Not read, with the reason:

| Where | Attribute | Why it is still open |
|---|---|---|
| `ParameterBlock` | `ShowInComObjectTree` | a com-object grouping signal; the com-object list is flat today |
| `Parameter` | `InitialValue` | present once in the catalogues, on a hidden `Access="None"` parameter and equal to `Value`. Honouring it would have zero visible effect. It matters only for "unchanged since factory" detection, which Busforge does not do. Left unread deliberately. |
| `Parameter` | `BaseValue` | on read-only mirror parameters inside modules, pointing at a module `Argument`. The per-instance numbering it describes is resolved through the module offset path instead. |

Safe to ignore: `InternalDescription`, `Tag`, `DefaultUnionParameter`, `Inline`, `Icon`,
`SecurityRequired`, plugin validation, and the sub-attributes of types that are unsupported anyway.

**Keep this inventory current.** It is maintained by hand. The mechanism that would make it
self-checking is a re-runnable audit: a script that, given a project's application XMLs, lists the
attributes present in the data but never read. That script does not exist
([roadmap.md](roadmap.md)). Until it does, a newly ignored attribute is found only by review, not
automatically, and the risk this table is meant to remove stays open.

## One model, two projections

The deep failure mode behind this whole page is structural: **a device can be parsed twice**, once
for the UI and once for the bytes, and the two drift. A feature added to the view then silently
leaves the image builder behind, and the device is programmed with something other than what was on
screen.

Busforge has one parser. `parseAppConfig` reads the memory layout (parameter offsets, segments) in
the same pass as the visibility and localisation data, tagging each entry's provenance (module
definition, union). The image side is not a parser but a thin projection, `toAppModel`, which drops
the module-definition and union entries. The configuration view is the visibility-filtered,
localised projection; the image is the byte projection; both read one model.

Three things hold that together:

1. **Divergence cannot ship silently.** The view surfaces every unknown element and uneditable type
   as a visible marker, and the flash path refuses to program when the stored configuration contains
   parameters the image builder cannot place (`unmappedParamRefs`). A mismatch is always either
   visible or blocked.
2. **Per-instance memory offsets are resolved**, not approximated: a module instance's offset is the
   module definition's static offset plus the instance's value of the `Memory@BaseOffset` argument,
   taken from the device's `0.xml` on import and re-derived from `<Allocators>` for a device placed
   from the catalog. Module instances are byte-placed in both image codecs.
3. **The check locks the invariant.** Per real catalogue fixture, every editable ref the
   configuration view exposes must be placeable by the image builder. The fixtures are in the
   [private corpus](testing.md#the-private-corpus), so public CI skips this lock. This is a **coverage** assertion, not set
   equality: the image is a deliberate superset (`Access="None"` internal parameters, union members,
   the bytes of branches the view never shows), so equality would be wrong. The round trip is locked
   the same way, per fixture: the codec must be its own inverse on the real model wiring, so the
   build and the read-back of the flash-verify path agree. Directional correctness (bit order, DPT
   vectors) is pinned separately, and neither substitutes for the hardware byte-match.

## Notes

- **Mask versions do not select the configuration view, and they do not select the image path
  either.** The image path is chosen by the application's segment structure (`RelativeSegment` vs
  `AbsoluteSegment`), which is why a low mask number can still use the absolute path. Device
  classification is [device-support.md](device-support.md).
- The configuration language follows the UI language, mapped to the nearest catalogue language
  (exact match, then primary subtag, then the catalogue's base text).
- Remaining parity work is listed in [roadmap.md](roadmap.md).
