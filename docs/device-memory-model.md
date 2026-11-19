# Device memory model

A KNX device's commissioned state lives in several memory segments, each governed by a
**Load State Machine (LSM)**. Programming a device means driving the right LSM through its
load procedure and writing the segment. This document describes the segments, how the
parameter image is computed from the application program, which bytes Busforge claims
authority over, and where the model stops.

For how the transfer itself is driven see [load-procedures.md](load-procedures.md); for how
the bytes are checked see [verification.md](verification.md). What is proven on real
hardware, per device and per capability, lives in **[status.md](status.md)** and nowhere
else.

## The segments

| LSM | Segment | Holds |
| --- | --- | --- |
| **LSM1** | Address table | The group addresses the device answers to |
| **LSM2** | Association table | Links each group-address entry to a com-object |
| **LSM3** | Com-object table | Com-object descriptors, flags and datapoint sizes |
| **LSM4** | Application / parameter segment | The parameter memory image |
| **LSM5** | Secondary application segment | Extra application code/data on some masks |

Two largely independent axes:

- **Group communication** (LSM1/2/3): which group addresses the device talks on.
- **Parameters** (LSM4, or an absolute segment, see below): how the device behaves.

One can be reconfigured without the other.

## Two parameter models

Not every device stores parameters in an LSM4 memory image. There are two families,
distinguished by the **segment structure the application declares** (`RelativeSegment` vs
`AbsoluteSegment`), not by the mask number. The build picks the path by structure
(`app.absoluteSegments` non-empty selects the absolute path), so a low-numbered mask can
still land on the absolute path.

| Model | Masks seen so far | Parameters live in | Address source |
| --- | --- | --- | --- |
| **Relative segment** | MV-07B0 (System B) | an LSM4 `RelativeSegment` | assigned by the device during allocation, read back via `PID_TABLE_REFERENCE` |
| **Absolute segment** | MV-0700/0701, MV-0705 (System 7) | one or more `AbsoluteSegment`s at fixed EEPROM addresses | a literal `Address` in the application XML |

The absolute-segment family was long assumed to be opaque "property based" storage. It is
not. These devices keep their parameters in fixed-address segments, and the correct image is
the manufacturer `<Data>` default (or a cleared parameter region for `<Data>`-less segments)
overlaid with the visibility-resolved active parameter set. The codec is the same for both
families; the differences are the address source and the load procedure verbs
(`LdCtrlRelSegment` vs `LdCtrlAbsSegment`).

A genuine property-based model does exist (parameters loaded through interface-object
property writes rather than a memory image, as IP interfaces, routers and cEMI servers do).
It is **not implemented**; see the gap table at the end.

## From settings to bytes: the visibility model

### Static declares what exists, Dynamic declares what is active

Every ETS application program has two halves:

- **`<Static>`** declares what exists: parameters, their types (width, signedness, enum or
  number), the `ParameterRef`s that name them, and the memory segments. Every parameter
  carries a `<Memory>` element (segment, `Offset`, `BitOffset`): its fixed address in the
  image.
- **`<Dynamic>`** declares what is active and visible: a tree of blocks, `choose`/`when`
  branches, `Assign`s and modules. The UI walks it to decide what to render, and the same
  structure decides what is written to memory.

A setting is never a byte directly. A setting is a parameter value. Static says where it
lives and how to encode it, Dynamic says whether it is active at all.

### The choose/when gate

```xml
<choose ParamRefId="P-constant-light">
  <when test="1"> ...constant-lighting sub-parameters... </when>
  <when default="true"> ...the simple branch... </when>
</choose>
```

The controlling parameter's current value selects the branch. Only parameters reached inside
a taken branch are **active**: parameters in an untaken branch are neither shown in the UI
nor written to the image. This is the mechanism ETS uses and it mirrors what the firmware
does at runtime, where the controlling value routes execution down one path and the code for
the other path is never entered.

`buildDeviceConfig` (`packages/product/src/config.ts`) walks the Dynamic tree with the
current values and collects `imageValues`: the effective value of every parameter reached in
the active branches. That includes `Access="None"` internal parameters, which ETS hides from
the UI but does write to memory, taking their value from whichever `ParameterRef` the active
branch references.

### ETS evaluates every matching `<when>`, not just the first

A `<choose>` looks like a switch, but ETS evaluates **every** `<when>` whose test matches;
the `default` branch fires only when none match. This differs from first-match only when
tests overlap, which manufacturers use deliberately to drive two independent placements from
one selector. A Theben channel actuator is the canonical case: one choose on the
channel-function parameter places a contact-type field (bits 0-1) under one set of `when`
tests and a union member (bits 2-3) under another, so every value matches exactly two
`when`s and both fields are written. First-match left the union bits unwritten, and a device
read-back disproved it. The resolver (`selectWhens` in `config.ts`) and the module allocator
(`modules.ts`) both walk all matching branches, so the config view, the image build and the
from-scratch instance set stay consistent.

### `<Assign>` targets are written, even when placed only in an inactive branch

`<Assign TargetParamRefRef="T" SourceParamRefRef="S">` sets parameter T's value from S, and
ETS writes T's memory with it. A common manufacturer pattern assigns a hidden
`Access="None"` parameter from a visible one in the ACTIVE branch while placing T's own
`<ParameterRef>` only in a different, inactive branch:

```
<choose ParamRefId="P-38">
  <when test="0"> place P-1; <Assign Target="P-26" Source="P-1"/> </when>   (active)
  <when test="1"> ... place P-26 ... </when>                                (inactive)
</choose>
```

Because the image set is built by visiting reached `<ParameterRef>` nodes, an
assigned-but-not-placed target would keep its default. So `buildDeviceConfig` records each
`<Assign>` target's value in `imageValues` directly (non-memory Merker targets have no
offset and are ignored by the image build). Hardware-confirmed on a Steinel sensor, where
the assigned target landed in the expected bit.

One exception preserves the union invariant: a `<Union>`-member assign target is **not**
recorded. Union branches share one region and the image owns a union byte only for the
actively placed branch; injecting an assigned alternative would let two members claim the
same byte. The active branch's own placement still writes it.

### A block that is invisible still runs its side effects

A `<choose>` can be gated on a Merker (an `Access="None"`, no-memory visibility flag) that
is only placed by a `<ParameterRefRef>` inside an invisible block. Skipping an
`Access="None"` block wholesale therefore leaves the Merker unplaced and the dependent
`choose` reads it as unset, so whole channels vanish from the config view while the image
still materialises them. `buildDeviceConfig` runs an invisible block's Merker/Assign side
effects (with the same `selectWhens` gating, so an inactive branch's placement is still not
reached) without emitting the block.

### Owned bytes and left-alone bytes

`buildAbsoluteSegmentTargets` / `buildRelativeSegmentTarget`
(`packages/product/src/deviceimage.ts`) lay the resolved values into the segment image and
mark every byte they actually wrote as **owned**.

| Kind | Where it comes from | Flash authority |
| --- | --- | --- |
| **Owned** | encoded from an active, resolved parameter | may be written |
| **Left alone** | manufacturer default, an erased `0xFF` gap, an inactive-branch parameter, an ETS-computed table | never written by ownership; on System 7 a parameter download writes every byte a parameter covers from the image (below) |

Ownership is gated on the encoder actually writing: a type the image does not represent
(a colour outside the RGB space, other) or a malformed value writes nothing and claims no bytes; a
text or colour value the codec refuses fails the build (below).

A second, narrower mask, `verify`, is the subset a post-flash read-back may assert. It
excludes bytes owned only by `Access="None"` device-internal markers (download-recognition
stamps and counters the device rewrites for itself on every download). Those bytes are still
written, because they are part of the correct image, but asserting them would report every
successful flash as failed.

On System 7 a parameter or structural flash that changes anything writes, as ETS's parameter download
does, every byte a parameter's memory covers, and the bits no active parameter lies on with the
image's value, not the unit's: a hidden parameter's bytes at the segment's `<Data>` where
[R14](load-procedures.md#the-rules-by-level) keeps the template. ETS's images show
it: the MDT BE-02001.02's partial and full downloads hold input A's idle union (offsets 48-49 of its
parameter segment) as the `<Data>` `00 00`, so a unit found holding `00 0a` there is written back; the
Theben Meteodata 140 S's download that switches a threshold channel off writes the channel's `<Data>`
back over the values the unit held, and its parameter download's image holds `<Data>` there too
([load-procedures.md](load-procedures.md#the-rules-by-level), `parWriteSet`). A change that leaves
every active parameter as the unit holds it writes nothing, a leftover in a hidden byte included.
Where no capture shows ETS's image, the unit's bits stay: in a segment without `<Data>` (the Steinel
sensor, [below](#segments-without-a-data-default)) and under an active parameter the image does not
encode (a colour on System 7). On System B the bytes Busforge owns (inactive plain parameters at their
default, idle top-level unions at their default, the rules below) are the bytes ETS's captured partial
downloads write.

What a configuration hides depends on parameters without a memory location too, and no read-back
shows their values. ETS's project always holds them; a Busforge project holds them where the device's
configuration came from an ETS project (a `.knxproj` import), or where a read-back assumed every one
the configuration shows that it can assume (an editable enumeration or whole number) and the project
still holds each at the assumed value. Only then does a System 7 flash write a hidden byte the unit
holds otherwise than `<Data>` as ETS does. Otherwise it refuses (`PARAM_HIDDEN_BYTES_UNKNOWN`) and
names the bytes: a project taken over by read-back that left such a parameter at its default would
count as hidden what the unit runs with (on the MDT BE-06001.02, a logic's "Internal input" decides
whether a setting of that logic is shown).

![How a setting becomes a byte, and what we leave alone](mv0705-visibility-model.svg)

### Why a disabled feature's bytes are irrelevant

A byte belonging to a parameter in an untaken branch is one the firmware never reads,
because the controlling parameter's value routes execution away from it. Whatever it holds
(0, a leftover value, junk from a previous configuration) cannot change the device's
behaviour. The claim is sound because the byte's relevance is gated by the very parameter
value that was already resolved: the branch is inactive if and only if the firmware does not
consult those bytes.

**Honest caveat.** "Irrelevant" is an inference about firmware behaviour from the visibility
model, not something instrumented at the silicon level. It is the same bet ETS makes: ETS
writes its precomputed image there, Busforge writes the same on System 7 (above) and leaves the
device's existing value where no ETS download writes one, and both assume the firmware respects
its own visibility gating. The read-back corpus supports the
bet (toggling a feature on a real device changes exactly the active bytes), it does not
prove it.

### Unions

A `<Union>` is the same idea applied to shared memory: several parameters get one memory
base, and only the visible branch is active. Ownership needs no special case: an inactive
union branch is simply unowned, exactly like an inactive `choose` branch.

The parsing detail matters, because it is easy to miss: the **`<Union>` element carries the
real `<Memory>`** (code segment plus base offset and bit), and its child `<Parameter>`s have
no `<Memory>` of their own, only a *relative* `Offset`/`BitOffset` into it. A parser that
looks for a `<Memory>` child on the parameter gives union members no location at all and
silently drops them from the image, which makes a union-heavy device look unsupported when its
parameters are merely unplaced. A union member's location is `union base + relative offset`.

An application can activate two members of one union at once, on the same bits. ETS logs the overlap as an
error and writes one member: in its full download of the OpenKNX RaumController, whose 1-Wire device id
(a text) and family code share their first byte, it holds the family code's value, the member that comes
later both among the `ParameterRef`s and in the configuration's parameter tree. Busforge writes that
member where the two orders agree. Where they disagree, no capture shows which member ETS writes: a
write whose members would leave different bits there is refused (`PARAM_UNION_OVERLAP`), and a
read-back leaves those bits out. Members that agree on their shared bits build either way.

### Calculated parameters

A `<ParameterCalculation>` computes parameters from others with a script: its `LRTransformation` sets
the `RParameters` from the `LParameters`, its `RLTransformation` the reverse. ETS runs it once a
parameter it reads holds another value than its default, and stores the results as the parameters'
values; with every input at its default the results keep their values. bussard's synthetic captures
of `syn-param-calculation` show both: at the defaults both outputs hold their declared default, with
the input changed both hold the script's result, the shown read-only one and the hidden
`LegacyPatchAlways` one.

Busforge computes them the same way, from the configuration alone: where an input is off its
default, the image is built with the script's results stored on their parameters; otherwise with
what the configuration stores. It runs the inline JavaScript and VBScript of product data in its own
interpreter (`packages/product/src/script/`): a whitelisted subset, tokenised, parsed and walked,
with no I/O and a step budget. A calculation in a `<ModuleDef>` runs in each module instance the
configuration places. Calculations that feed each other are recomputed until their results settle.

What Busforge cannot compute as ETS does, it does not compute, and a write keeps the refusal
`PARAM_CALCULATION_UNSUPPORTED` for it:

- a script outside the subset (a function, an object, `new`, a JavaScript statement that does not
  end, a VBScript division by zero or overflow, the step budget, which also counts the array elements
  and characters a run builds), or one named by `LRTransformationFunc` from the application's
  `<Script>` (the OpenKNX applications use these);
- a script that reads one of its results before setting it, declares one without a value, or leaves
  a result with memory unset: that result is what ETS computed when it last ran, which the
  configuration does not show;
- a result its parameter's type does not take (a fraction for an integer, a value out of range), a
  boolean result (no capture shows how ETS stores one), or a parameter type scripts are not run with;
- a result that a `<choose>` tests or an `<Assign>` reads or sets, or that lies in a property: the
  com-object and property writes do not recompute it (the MDT BE-06001.02 and BE-02001.02 counters);
- results that do not settle, and two calculations computing different values for one parameter.

For these, a write refuses where a parameter on one side of the calculation takes another value
than the device holds and the other side reaches the image: one of its parameters has memory or lies
in a property, or is one a `<choose>` tests or an `<Assign>` reads or sets. A parameter or structural
flash compares with the configuration the device was last programmed with; a full download, the
System 1 download and the parameter flash of a device never programmed from this project, with the
defaults. A calculation whose other side reaches nothing refuses nothing.

Two cases of a computed calculation are refused too, since no capture shows them:

- a result the user can edit, set to another value than the script computes: ETS would run the
  `RLTransformation` and change the inputs. A flash accepts it where an input changed since the device
  was programmed and the result is still the one stored then, the earlier computation's;
- a result with memory that no active branch places, unless the image holds the computed value
  (`LegacyPatchAlways` on a relative segment, as the capture shows) or the result is its default.

Where the configuration hides a computed parameter on System 7, its bits keep the unit's value rather
than the segment's `<Data>`.

On the device page, a calculation's parameters say what Busforge computes. A read-only result shows the
value the image is built with, marked as computed, not the value the project stores; a result the user
can edit keeps the stored value and names the computed one beside it. An input names each result and
its value, also where the configuration does not show the result: the Jung 400021SE's dimming time is
entered in seconds and milliseconds that the device does not hold, and the page names the hidden
parameter the image holds and its value. A calculation Busforge does not run marks its parameters as
not computed, with the reason in the user's language (a script the interpreter refuses keeps the
interpreter's own words, in English), in warning tone where a change of them is refused.

## Ownership rules, in detail

The rules below are hardware-derived. They are the difference between a re-configuration
that preserves a working device and one that corrupts a channel.

- **A plain top-level memory parameter is owned at its effective value when active, and at its
  default when inactive where [R14](load-procedures.md#the-rules-by-level) has ETS write the
  default.** ETS writes every such default and the device holds it: without this fallback, a freshly
  ETS-flashed power supply misses 51 bytes of its image.
- **A `<Union>` member or a module-instance (`…_MI-…`) parameter is owned only when it is the
  ACTIVE branch.** Overlapping branches must not all be written.
- **An inactive `Access="None"` parameter is not owned.** The device byte stays.
- **A `BinaryValue` parameter writes the bytes of the enumeration its value names**, of any
  width. The Theben MIX 2 carries one `<Union>` of `Access="None"` "Objektlink" members per module
  slot (offsets 330, 842 and 1354 of its parameter segment, 21 to 116 bytes each), one member per
  module type, chosen in a hidden parameter block by the slot's module type; the active member is
  owned and written, as ETS's image holds it. A value with no declared bytes, or bytes that do not
  fill the type from bit 0, is refused (`PARAM_BINARY_VALUE_UNDECLARED`).
- **An integer parameter wider than 6 bytes is never owned.** The integer codec caps there
  (`MAX_INT_BYTES`). A text parameter of any width is owned like a plain parameter and writes its
  characters (below).
- **An inactive plain parameter is owned at its default, or left at the template, as the
  application's `DownloadInvisibleParameters` option and `MinEtsVersion` decide**
  ([load-procedures.md](load-procedures.md#the-rules-by-level), R14, `hiddenParameterRule`). Under
  `"None"` one every placement of which lies in a `<when>` of a `choose` that was evaluated and not
  taken (a module slot left empty, a channel function not chosen) is not owned: ETS leaves its bytes
  at the allocation fill and out of its parameter download (Theben MIX 2; the Jung 400021SE declares
  it too). A `choose` on a Merker no active branch places rejects nothing; the `LegacyPatchAlways`
  parameter it gates on the MIX 2 is written at its default. An application without the option and
  with `MinEtsVersion` 5 or later gets every such parameter written at its default, as the GVS AMMA's
  ETS downloads show. A combination no ETS download shows is refused (`PARAM_HIDDEN_UNSUPPORTED`) where
  the default and the template differ.
- **A displaced channel variant is not owned.** A channel configured as a module occupies the
  memory of the simple-channel variant. The top-level variant's parameters still parse and
  still carry an offset there, but the memory belongs to the module instance, so an inactive
  top-level parameter whose offset falls inside an active module region must not be written.
  Owning it would push a default into channel memory.

Consequence and scope: re-configuring an already-commissioned device is safe, because the
ETS-computed regions are preserved. A first-time commissioning of a complex module device
from scratch can still need ETS once, to lay down the object-link allocation. The post-flash
verify compares only owned (and verifiable) bytes, because a reload recomputes the rest.

For the repeatable method that finds a new not-owned case, see the drift-forensics section
of [verification.md](verification.md): trace every byte-level diff to its parameter, classify
it, and decide own-versus-preserve before flashing.

## Bit fields are not necessarily byte-aligned

A parameter occupies `SizeInBit` bits starting at `BitOffset`, counted **MSB-first** from the
byte at its `Offset`. Both numbers matter, and a field straddles byte boundaries whenever
`BitOffset + SizeInBit` is not a multiple of 8. Manufacturers pack memory exactly this way:

| Product | Type | Layout |
| --- | --- | --- |
| OpenKNX RaumController | `PT-DelayTime` | 14 bits at BitOffset 2 (the low 14 bits of a 2-byte word) |
| Theben channel actuator | an 11-bit time | 11 bits at BitOffset 5 (3 low bits of one byte plus all of the next) |

So the codec (`image.ts`) computes a field's byte span as `ceil((BitOffset + SizeInBit) / 8)`
and splices the value into the big-endian word it spans, touching no neighbouring bit. Both
shortcuts are wrong and both are silent: a span computed as `SizeInBit >> 3` (floor) makes a
14-bit field one byte, and ignoring `BitOffset` for widths of 8 bits and up places the field in
the wrong bits and throws a raw `RangeError` once the value exceeds 255. The offline corpus
cannot catch either, because none of the 110 such parameters in the catalogue fixtures is ever
written; the first write of one is a device operation (enabling an OpenKNX channel writes a
14-bit delay).

MSB-first is not a convention choice: KNX numbers `BitOffset` from the most significant bit,
so a width-`w` field at offset `b` inside an `n`-byte span is shifted left by
`n*8 - b - w`. An LSB-first codec agrees on byte-aligned fields only, and disagrees with every
sub-byte device on hardware. A value that does not fit its declared type is refused
(`PARAM_VALUE_OUT_OF_RANGE`) rather than masked into the field.

## Float widths come from the encoding, not the size

`<TypeFloat Encoding="IEEE-754 Single">` carries **no `SizeInBit`**. Defaulting every
`TypeFloat` to 16 bits silently encodes an IEEE-754 single as a 2-byte DPT-9 half float,
which is how a pair of latitude/longitude parameters ended up wrong on an OpenKNX device
while every read-back check still passed. The float width is derived from `Encoding`
("IEEE-754 Single" gives 32 bits, "DPT 9" gives 16), and the codec refuses any other width
rather than writing a wrong-sized value.

A DPT-9 value is encoded as ETS writes it: the smallest exponent whose mantissa fits, the
mantissa rounded once, at that exponent, from the exact decimal value. 1000 Lux is `36 1A`
(100000 / 2^6 = 1562.5 → 1562); ETS's download of an MDT BE-02001.02 shows it. 10000 is
`4F A1` (1953.125 → 1953). A tie goes to the even mantissa, up or down, and a negative value
rounds its magnitude the same way: ETS writes 20.51 as `0C 02` (1025.5 → 1026), 20.53 as `0C 02`
(1026.5 → 1026) and -20.51 and -20.53 both as `8B FE` (-1026), and rounds 41.03 (1025.75) to `14 02`
rather than truncating it, shown by ETS's downloads of the same MDT input. A mantissa one step
off passes a read-back unseen, since the device holds what was written.

A DPT-9 value outside -671088.64 to 670433.28 is refused
(`PARAM_VALUE_OUT_OF_RANGE`), not saturated: `7F FF` is DPT 9's "invalid data", so a saturated maximum
would tell the device the value is invalid. 670760.96, the nominal maximum, would encode to `7F FF`, so it
is refused. Saving such a value into a parameter is refused at once (`PARAM_VALUE_NOT_OF_TYPE`), and a
device that holds `7F FF` is shown as holding no value of that parameter (it reads back as 670760.96,
which no parameter takes).

## Which parameter types reach the image at all

Only `Value` (enum/restriction), `Number`, `Float`, `IPAddress`, `Text` and an RGB `Color` are
encoded into the parameter image. Time-of-day, a colour in any other space, raw data and unrecognised
bases write nothing and therefore own nothing. Where no capture shows how ETS encodes a colour (any space
but RGB, and every colour on an absolute segment, System 7), a parameter or structural flash refuses
(`PARAM_COLOR_UNSUPPORTED`) when a colour in use differs from the configuration the device was last
programmed with, or comes into use, and a full download, like the parameter flash of a device never
programmed from this project, refuses any colour in use: it knows no configuration the device holds,
and would leave either the segment's `<Data>` or the unit's bytes where the colour lies. Seven type details are easy to get wrong:

- **An RGB `TypeColor` is three bytes, red, green, blue** (System B). The type declares no
  `SizeInBit`; the value `#RRGGBB` goes into the three bytes at the parameter's offset in that order,
  and a read-back gives it back as `#RRGGBB` in upper case, as ETS stores it. ETS's parameter downloads
  onto the Jung 400021SE show it: "Colour value when pressed" set to `#123456` and then `#A1B2C3`
  wrote `12 34 56` and `A1 B2 C3`, and each of those downloads changed exactly the bytes Busforge's
  image changes. A colour that does not start at a byte, a value that is no `#RRGGBB`, and a colour in
  an application with little-endian parameters are refused.

- **`TypeText` is its characters, then zero bytes to the end of the field** (System B and
  System 7). A value as long as its field fills it without a closing zero, and on System B the
  segment's `<Data>` does not enter: ETS writes the parameter's value over whatever `<Data>` holds there. ETS's images
  show it on three products: the Theben DALI-Gateway KNX plus holds its admin password "dali" in its
  8-byte field as `64 61 6c 69 00 00 00 00`; the MDT IP Interface/Router holds every text field at its
  value with zeros behind it (an empty description as 30 zero bytes where `<Data>` holds
  "Statuselement00"), its 30-character device name in its 30-byte field without a zero, and its
  parameter downloads write a changed device name and the change back the same way; on the Theben
  Meteodata 140 S (System 7) the partial download that switches a threshold channel on writes "20,0"
  into its 5-byte field as `32 30 2c 30 00` over a `<Data>` byte `32`, and "1,0" into its 4-byte field
  as `31 2c 30 00` over a `<Data>` byte `19`. A text value is text, never a number: "123" is
  `31 32 33 00…`. A character beyond ASCII takes the bytes of the application's
  `<Options TextParameterEncoding>`, which ETS's downloads of two synthetic System B products show
  (bussard's, MIT): where the application declares none, one byte per character, "Störung" as
  `53 74 F6 72 75 6E 67 00…`; where it declares `utf-8`, UTF-8, "Süd" as `53 C3 BC 64`, the field's
  size counted in bytes. The encoding is the application's, so System 7 takes the same bytes, and its field checks count them; no
  System 7 capture shows a character beyond ASCII. What no capture shows is refused
  (`PARAM_TEXT_UNSUPPORTED`, `PARAM_TEXT_TOO_LONG`): where the application declares no encoding a
  character above `FF` or one where ISO 8859-1, Windows-1252 and ISO 8859-15 give different bytes
  (`80`-`9F`, and `A4`, `A6`, `A8`, `B4`, `B8`, `BC`-`BE`: the euro sign is one of them), a character beyond ASCII under any other declared encoding (an OpenKNX
  application declares `iso-8859-15`), a zero character, a value longer than its field, a value as long as
  its field where the application declares `<Options TextParameterZeroTerminate="true">` and on any
  System 7 application (no System 7 capture shows a field filled), on System 7 a zero over a non-zero
  `<Data>` byte (the Meteodata's `<Data>` holds zeros behind the characters), a field that is not
  whole bytes from bit 0, and any text parameter of a System 1 application. A value that begins or ends
  with a blank is refused as well (`PARAM_TEXT_EDGE_BLANK`): XML keeps those characters, so Busforge
  reads a value as written, blanks included and character references (`&#x9;`, `&#xA;`) decoded: a
  `Parameter`'s and a `ParameterRef`'s `Value` and `InitialValue`, an `Assign`'s `Value`, their
  translations, and a project's `ParameterInstanceRef` `Value` (every other attribute and text node is
  trimmed, and a value of any other type than text compares and validates without its blanks). No ETS image shows whether ETS writes such blanks into the device or drops them. A
  read-back leaves such a field out of its comparison instead of refusing the whole read.

- **A device placed in Busforge, or given another product, starts its text parameters at their
  `InitialValue`**, translated into the language the client works in, as ETS does for a device added to a project of that
  language: ETS's download of a synthetic product (bussard's) added to a German project wrote the
  de-DE `InitialValue` "Bussardhorst Süd", not the `Value` "Buzzard nest". That start value is the
  parameter's default on the device page: the device's baseline starts at it, so the parameter shows no
  change and a revert returns to it. A device imported from ETS keeps the values ETS stored. An
  `InitialValue` in a form no capture shows (untranslated, on a
  `ParameterRef`, beside a `ParameterRef`'s own `Value`, on a parameter that is no text, in a module
  definition)
  refuses the placement (`PARAM_INITIAL_VALUE_UNSUPPORTED`) where it differs from the default and its
  parameter reaches the device: in memory, in a property, tested by a `<choose>`, or computed
  with by an `<Assign>` or a `<ParameterCalculation>` into one that does. The Jung 400021SE translates such `InitialValue`s on memoryless
  module texts its `<Assign>`s pass among themselves to name its pages; they keep their default.

- **`TypeRawData` writes nothing.** No ETS download shows its layout, so the segment's `<Data>` or
  the unit's bytes stay where it lies. A raw-data parameter in use away from its default (a full
  download) or from the configuration the device was last programmed with (a parameter or structural
  flash) refuses the operation (`PARAM_RAW_DATA_UNSUPPORTED`), and on a device never programmed from
  this project the parameter flash refuses one in use at any value: it would keep the unit's bytes there.

- **`TypeTime` is a raw unsigned integer**, a count of its `Unit` (seconds, milliseconds),
  and ETS stores it exactly that way (hardware-confirmed: a 60-second duration is stored as
  `0x003C`). Treating it as an unrepresentable "other" type leaves its bytes at the default
  instead.
- **`TypeIPAddress` carries no `SizeInBit`.** It is a 4-byte host address written as
  big-endian octets, so the width is pinned to 32 rather than read from the XML.
- **Signedness must be tested exactly.** KNX writes `TypeNumber@Type` as `signedInt` or
  `unsignedInt`, and a naive `includes("signed")` also matches `unsignedInt`, which
  mis-decodes every unsigned value from 128 upwards as negative on read-back.

## Segments without a `<Data>` default

Some applications declare parameter segments with no `<Data>` default (a self-closing
`AbsoluteSegment`; a Steinel sensor is the reference case). A segment with no manufacturer
image has no precomputed default, so it is built like this:

- **Gaps** (bytes owned by no parameter) stay at the erased EEPROM state `0xFF`.
- **Parameter-owned bytes** start at `0x00` (ETS clears parameter memory before download, so
  a disabled feature's parameters read back as 0), then the active values overlay them.

This is safe by construction: every device that ships a full-size `<Data>` never takes the
path. It leaves one **irreducible residual**: a handful of parameters that sit in an inactive
branch yet hold a non-zero default on the device. Reconstructing those exactly would mean
reproducing ETS's full default-image computation, the very thing `<Data>` normally ships
precomputed. Because the flash writes there only owned bytes and keeps the unit's bits in every other
byte it covers, those bytes are never changed, so
the gap costs nothing: "we cannot reconstruct them" stays "we leave them alone" instead of
becoming "we flash them wrong".

## Module and channel placement

Module placement is not a separate storage class, it is a per-instance offset modifier on
either layout. The effective device offset of a module parameter is

```
its static offset in the ModuleDef + the per-instance value of the Memory@BaseOffset argument
```

That per-instance base comes from one of two interchangeable sources:

- **An imported project**: ETS pins it into `0.xml` as `<ModuleInstance>` arguments.
- **A device placed from the catalogue** (no project): Busforge re-runs the application's
  `<Allocators>` to compute the identical value. The counter is `Start + cumulative
  Allocates`, walked over the visibility-resolved active tree, with `<Repeat Count="k">`
  instantiating k copies. The re-run was validated against real multi-channel devices,
  reproducing all 67 of their project-pinned module instances exactly.

Both memory models resolve module offsets, and both have been exercised on hardware
([status.md](status.md)).

## The com-object table (L3)

L3 is the table a device consults for **every** group telegram: which com-objects exist,
each one's datapoint size, its KNX flags and its priority. A wrong byte does not fail
loudly, it mis-communicates: an object goes deaf, answers a read it should not, or
interprets a 2-byte float as a 1-byte scale. The firmware performs no validation on this
table, so there is no safety net between the builder and a misbehaving device.

### System B layout

```
[count: u16 BE][entry x count],  entry = [flags: u8][sizeCode: u8],  entry i is com-object i (1-based)
flags: bit7 Update | bit6 Transmit | bit5 ReadOnInit | bit4 Write | bit3 Read | bit2 Communication
       bits1..0 priority (00 System, 01 Normal, 10 Urgent, 11 Low)
```

An all-zero entry is an object that does not communicate: that is how numbering gaps and
objects the active configuration does not reach are represented. The layout is not a guess
for this family; OpenKNX devices run the open thelsing/knx stack, so it is read off the
firmware that consumes it (`group_object_table_object.cpp`, `group_object.cpp`), and Kaenx's
independent implementation agrees bit for bit.

An object numbered 0 has no entry: entry 0 is the count. ETS 6.4.1, downloading products that
number their objects from 0 into a device simulator
([third-party test data](testing.md#third-party-test-data)), writes the count (the highest object
number) in that place, the entries of objects 1 and up after it, and links object 0's group
addresses to object 0 in the association table: objects 0 (`C W`) and 1 (`C R T`) give
`00 01 4B 00` without links and `00 01 4F 00` with both linked. Busforge writes the same. What a
device does with object 0 is not shown, and no manufacturer's application in the test corpus
numbers a System B object 0 outside a module. A write that would have to carry object 0's flags is refused: a project
override of them (`COM_OBJECT_OVERRIDE_UNWRITABLE`) and a secured group address on it
(`COM_OBJECT_NUMBER_INVALID`). An application that declares no object numbered 1 or higher would
get a table of no entries, which no capture shows; its full download and group-address flash are
refused before they are offered (`COM_OBJECT_TABLE_EMPTY`). The device page offers no flag
edit on object 0, and a read-back takes no flags of it.

A configuration that activates no object (every output of the GVS AMMA disabled) still gets the
table: ETS writes the declared count with every entry `0x0000`, and so does Busforge.

The size field is the KNX "value field type" code, which is genuinely irregular (5 bytes is
code 15, not 11), so it is written out rather than computed. The size comes from ETS's
human-readable object size ("1 Bit", "14 Bytes"), not from the datapoint type: in one
OpenKNX application 451 of 1255 com-objects carry no datapoint type at all.

**Priority is only ever exercised at Low.** Nothing in the corpus uses High or Alert, so the
first device that does is also the device that confirms the mapping; a wrong priority costs
bus arbitration order, not data.

### Two things the firmware will not protect you from

1. `TableObject::loadEvent` accepts whatever bytes it is given. LoadCompleted checks no
   length, no checksum, no id. A wrong table is simply believed.
2. `getGroupObject(n)` indexes the table with **no bounds check**. If the table is shorter
   than the highest com-object number the firmware actually uses, the device reads and
   writes past the end of its own heap array.

So the table must be as long as the highest com-object number the application **declares**
(across every choose branch and every module instance), not the highest number the current
configuration activates. Sizing it to the active maximum was hardware-fatal: an OpenKNX
application declares objects up to 1359 and its modules address them by fixed number, so a
table claiming 138 sent the firmware off the end of its array on boot, and the device
death-looped and reverted to factory. `buildDeviceConfig` reports `maxComObjectNumber` and
`buildComObjectTable` sizes to it.

### The Communication flag on unlinked objects

ETS clears the Communication flag on every object **without** a group-address link: an
object with no association cannot communicate. Busforge matches that byte for byte
(hardware-verified against an ETS-programmed device, where this flag on the unlinked objects
was the only remaining difference). The object stays fully present, it just does not
advertise communication. The consequence for a group-address flash is in
[findings.md](findings.md) §7: writing only L1+L2 to link an object whose L3 still says
`comm=0` produces a link that verifies green and is functionally dead.

This holds for what the captures show: applications that name **no ETS download plugin**,
on products whose catalogue entry carries **no factory image** (`Hardware2Program/@LoadedImage`).
Every application in the test corpus is such an application. ETS downloads an application that
names a plugin (`<Static><Extension EtsDownloadPlugin="{GUID}">`, a non-empty value) through
that plugin, and no capture shows what it writes into the com-object table. For such an
application Busforge refuses the full download and every group-address flash that writes the
table, and with them the structural flash, before anything is sent
(`COM_OBJECT_TABLE_DOWNLOAD_PLUGIN`); the parameter flash, which leaves the table as the device
holds it, stays offered on a device the project has programmed, and a device it never programmed
is pointed at ETS (`NEVER_PROGRAMMED_USE_ETS`). A factory image that holds
the com-object table is not yet detected: the catalogue attribute does not reach the write
path, so such a product is written by the rule above ([roadmap.md](roadmap.md)). No product
in the test corpus carries one.

### MV-0705 layout: manufacturer template plus overlay

Property-mapped System 7 uses a different layout, and it is **not** rebuilt from scratch:

```
[count: u8][ramEnd: u16 BE]  then one 4-byte entry per com-object, entry i is com-object i (0-based)
entry = [dataPtr: u16 BE][config: u8][type: u8]
config: bits0-1 priority | 0x04 linked | 0x08 read | 0x10 write | 0x40 transmit | 0x80 update
```

There is no read-on-init bit. `0x04` is the object's communication flag: set on an object that has a
group-address link and whose communication flag is on. ETS keeps the address and association of a
linked object whose communication flag the project sets off and clears the bit, and sets it again when
the flag is back on (MDT BE-02001.02, partial downloads of each). A linked object whose application
itself sets communication off is not captured; Busforge refuses to write its table
(`COM_OBJECT_APP_COMM_OFF_LINKED`). No System 7 application in the test corpus declares one. `0x80` is set in the manufacturer's template of many entries; on a
configured object it is the object's update flag, set where the resolved flags say `UpdateFlag` and
cleared otherwise, on every System 7 application that names this table's segment (a family rule,
[load-procedures.md](load-procedures.md#the-rules-by-level), R13). The captures that show it are of
three applications of two manufacturers: the Theben TheLuxa P300 (object 116, `UpdateFlag="Enabled"`,
written `0xCB` over the template's `0xDF`), the Theben Meteodata 140 S (MV-0701, the same table
layout, twelve configured objects) and the MDT BE-06001.02 (objects 36 and 39 written `0xD3`); every
other System 7 capture compared (Gira, Auro, MDT BE-02001.02, ABB) agrees with it. `dataPtr` points into the `0x07xx` RAM value
segment. L3 lives at the application's `<ComObjectTable CodeSegment>` fixed absolute address
and is **not** behind the object-3 table pointer (`tableAddr(3)` returns 0 on MV-0705,
unlike System B).

The decisive finding is that this segment ships a base64 `<Data>` blob which is the
manufacturer's complete static image of L3 (header, every entry's data pointer, type, and a
template config byte, often with `0x80` set). ETS writes that image and
then overlays only the dynamic state. So the build is:

1. Start from the segment `<Data>` (authoritative for the header, data pointers, sizes and
   every inactive entry).
2. **Configured objects** (those the active configuration reaches):
   `config = priority | linked | read | write | transmit | update` from the resolved flags,
   `type` rewritten from the resolved size.
3. **Unconfigured objects**: keep the template entry verbatim, clearing only a stale linked
   bit.

This is robust by construction (the manufacturer image is the base, only what ETS changes is
changed) rather than rebuilding every byte from first principles. The bit layout is a
correlation fit over 169 configured objects across 23 devices; the plausible alternative
formulas (`read = read || transmit`, `transmit = transmit && !write`) fit that same corpus
measurably worse.

The **entry-to-object-number mapping is 0-based**, byte-checked against two ETS full-download
captures of one product. A manufacturer numbering its MV-0705 objects from 1 would either trip
the builder's range guard or shift the whole table by one slot, so the mapping needs its own
byte check on every further product ([status.md](status.md)).

### Known residuals on MV-0705 L3

Six of 24 devices across five MV-0705 application families do not byte-match exactly. The
residuals decompose into named, bounded cases, none of them a missed general rule:

- **Two isolated single-flag anomalies** on specific manufacturer objects (one sensor output
  keeps the base ComObject's read flag although the active `ComObjectRef` disables it; one
  object's transmit flag resolves differently). The corpus honours 349 other refs that
  disable the read flag, so this is not a general "read from base" rule, and no
  flags-derived formula explains it. Device-specific, and a per-object patch would be
  exactly the hand-coded special-casing this project rejects.
- **The module "configured" predicate.** Neither "configured = linked" nor "configured =
  reached" holds for module com-objects: a channel's selected mode picks which
  `ComObjectRef` is live, and only that ref's object is configured. The current active-set
  walk over-includes refs from module instances whose mode does not select them. Top-level
  objects are unaffected (the device configures a reached top-level object even when
  unlinked).
- **Large or special objects.** A 14-byte "software version" object (object 116 of the Theben
  TheLuxa P300) keeps `0x80` where 3-, 6- and 8-byte siblings have it cleared: the object is
  configured and declares `UpdateFlag="Enabled"`, and ETS writes `0xCB`, the update flag in `0x80`
  (above).
- **Device drift**, settled by a clean ETS re-flash rather than by code.

None of these shows in the configurations driven on hardware, so a full download of a device
whose configuration exercises them must be byte-checked before it is trusted.

## Reading device memory

### Chunking and internal read boundaries

`KnxDevice.memRead` reads a segment in chunks. On the classic path a chunk is 12 bytes, the most a
standard frame carries; a device that declares `PID_MAX_APDU_LENGTH` gets requests up to that length
minus the 3 octets of APCI and address, capped at 48 bytes, the size extended reads are shown to
carry over a KNX-USB interface and a KNX IP interface (the path has its own limit, which the
device's property does not know). The OpenKNX RaumController declares 254 and is read in 48-byte
chunks, which takes its 21.6 KB parameter read over a KNX IP interface to about 100 s, against
241 s in 12-byte chunks.
Some BIM M112 devices have **internal read boundaries**: they refuse any single
`A_Memory_Read` that spans the boundary and answer with an empty data response. Every byte
is individually readable; only a request that straddles the line is refused.

So `memRead` places bytes **by address** and, on a short or empty chunk response, shrinks
the request until it fits inside a boundary and advances only by what was actually returned.
A loop that instead concatenates chunk responses and advances by the *requested* length turns
a refused chunk into a buffer that is both short and **misaligned**, silently corrupting the
read-back of every segment that crosses such a boundary.

`memWrite` uses a fixed-chunk loop and is **not** boundary-aware, but its read-back verify
uses the corrected `memRead`, so a write that crossed a boundary fails loudly (verify
mismatch) instead of corrupting silently. No flash target Busforge has driven crosses one, so
that path is untested on hardware and deliberately left unchanged.

### A_MemoryExtended: reaching a segment above 64 KB

The classic `A_Memory_Read` / `A_Memory_Write` services carry a **2-byte** address, so they
reach `0x0000`-`0xFFFF` and no further. Several System B devices allocate their parameter
segment above that (a Jung 2-fold universal interface puts its parameter image at
`0x15000`). Those are served by **A_MemoryExtended**, the KNX service with a 3-byte (24-bit)
address, where the application declares it (below). An address outside even that space is refused (`MEMORY_ADDRESS_TOO_HIGH`) rather
than truncated and written to the wrong place.

- **APCIs**: `A_MemoryExtended_Write` = `0x1FB`, `_Write_Response` = `0x1FC`,
  `A_MemoryExtended_Read` = `0x1FD`, `_Read_Response` = `0x1FE`. Unlike classic memory, the
  byte **count is a payload octet**, not folded into the low APCI bits.
- **Request**: `[count(1)][address(3, big-endian)][data…(write only)]`.
- **Response**: `[returnCode(1)][address(3)]`, then the data for a read (the count is not
  repeated). A non-zero return code, or an echoed address that is not the one asked for, is
  **refused**, never taken as proof.
- `A_MemoryExtended_Write` is a **confirmed service**: every write is answered, so the return
  code is the per-chunk write proof, the extended counterpart of the classic verify-mode
  echo.
- The response layout was decoded byte for byte from a live device: a read at `0x15000`
  answered `00 01 50 00 <data>` (return code 0, address `0x015000`), and a read at `0x0000`
  answered `fd 00 00 00` (return code `0xFD`, that address is forbidden, a legitimate
  refusal).

Past `0xFFFF` the **application decides**, as ETS does. Where it declares `<Options
SupportsExtendedMemoryServices="true">`, `memRead` and `memWrite` serve a range whose last byte
exceeds `0xFFFF` entirely by the extended path; everything at or below stays on the classic path
(except the confirmed write below). Where it does not, the range is written with **A_UserMemory**,
the service ETS writes it with there (below); a range whose application option was never set is
refused before any request (`MEMORY_SERVICES_UNDECIDED`). Every device session takes the option from
the project's application before its first request. The collector is the one reader that may know
no application: there it reads past `0xFFFF` with `A_MemoryExtended` and records whatever comes back,
silence included.

#### A_UserMemory: past 64 KB without the extended services

ETS's downloads of one application in two forms, an 8448-octet parameter segment placed at `0x10000`
with and without the option, show the split for the part above `0xFFFF`. They come from a device
simulator (third-party test data, [testing.md](testing.md#third-party-test-data)), so they show what
ETS sends and what the simulator answered, never how a real device answers; no unit of ours places
memory there without the option.

- **APCIs**: `A_UserMemory_Write` = `0x2C2`, `A_UserMemory_Response` = `0x2C1`
  (`A_UserMemory_Read` = `0x2C0`).
- **Request**: `[x][address bits 15-0 (2)][data…]`, `x` = address bits 16-19 in the high nibble and
  the count (1-15) in the low one: a 20-bit address. ETS's first write is `C2 1F 00 00 01 01 2C FF…`
  (`0x10000`, 15 octets).
- **15 octets per write**, the count's maximum, at the simulator's maximum APDU of 66 behind an
  interface that announces none: 564 writes for the 8448 octets. Busforge sizes them as
  `writeChunks` does: the shorter of the device's and the interface's APDU less 4, at most 15;
  where the interface announces none, the extended path limit (which carries those 19 octets); where
  the device declares none, the standard frame (11 octets, which no capture shows).
- **Each write is answered** by an `A_UserMemory_Response` with the same three octets and data. ETS
  reads no device-control property (verify mode) before these writes; whether a real device answers
  only in verify mode the capture cannot show. Busforge awaits the answer for every write and refuses
  one for another address or with other bytes (`FLASH_VERIFY_MISMATCH`). It deviates from ETS here:
  a System B full download switches verify mode on before its unload, so these writes go out in
  verify mode, where ETS reads that property only after them, before its first classic write. The
  answer is awaited either way.
- **Not read.** No capture shows `A_UserMemory_Read`, so a read past `0xFFFF` on such an application,
  and a write that would be read back, are refused before any request (`USER_MEMORY_UNSUPPORTED`): a
  backup, a comparison, a parameter or structural flash and the partial form of the full download read
  the segment first and refuse before they write. A full download writes the segment, and its check
  after the restart takes the segment's CRC in its memory-control block; where that proves nothing the
  download is reported unverified. A secured session with `A_UserMemory` is refused too, and so is a
  write across `0x10000` (ETS writes below it classic and from it with `A_UserMemory`): no capture
  shows either.

With the option, ETS writes every memory with `A_MemoryExtended_Write` of 61 octets (66 less 5),
the tables below `0xFFFF` too, and reads no device-control property. Busforge writes the same way
where the device declares `PID_MAX_APDU_LENGTH` (below), and ETS's own downloads of our units with the
option show the same (no `PID 14` read, every write extended). Its chunk differs where the interface
announces nothing: Busforge then keeps the measured path limit of 32.

`memWrite` selects **by application and device, as ETS does**. The caller sets whether the
application declares `<Options SupportsExtendedMemoryServices="true">`; before its first write on a
connection the device reads `PID_MAX_APDU_LENGTH` (device object, PID 56). Where both hold, it writes
with the confirmed `A_MemoryExtended_Write` at every address, in chunks of at most that length minus
the 5 octets around the data; otherwise with the classic service. A device declaring the property
whose application's option was never set is refused before anything is written. ETS captures show
this split: the GVS AMMA (55), the Jung 400021SE (233), the Theben MIX 2 (55) and OpenKNX (254),
all declaring the option, are written extended only; the ABB US/U 4.2 and the MDT BE-02001.02
(property absent) and the Theben DALI-Gateway (55, no option) classic only. The DALI-Gateway
acknowledges an extended write on the transport layer and never answers it. The difference
matters: the classic write is acknowledged by the transport layer before the firmware has stored it, and after a segment reallocation the GVS AMMA was overtaken by the
next chunk ([findings.md](findings.md) §13). A confirmed write is **not read back before the
restart**, whatever the caller asks: ETS reads nothing back, and on thelsing/OpenKNX a read returns
the flash while the write still sits in a RAM buffer ([findings.md](findings.md) §16). The
operation's read-back after the restart is the proof.

**Chunk sizes differ by direction**, and the reason is the transport, not the service. Over
a KNX-USB HID interface a request is a single report with no fragmentation. A read request
is tiny (the data comes back in the reassembled response), so it can ask for many bytes; a
write request **carries** its data, so a large write overflows the single report and the send
is dropped. The limits are measured on hardware and split into `EXT_READ_CHUNK = 48` and
`EXT_WRITE_CHUNK = 32` (override with `KNX_EXT_{READ,WRITE}_CHUNK`). At the classic 12-byte
default a 10 KB segment costs roughly 850 round trips per pass.

## What is not modelled

"How many models are there" is two independent questions, and they have to be kept apart.

**Axis A, parameter memory layout.** A small finite set: relative segment, absolute segment,
module placement as a per-instance offset modifier on either, and the genuine
property/interface-object model.

**Axis B, load procedure**, orthogonal to the layout. Modern devices ship the procedure as
data in the product XML (`LdCtrl…` load controls, selected by mask version); legacy BCU1/BCU2
masks have it hardcoded per mask. See [load-procedures.md](load-procedures.md).

A device is end-to-end programmable only when both axes are handled.

| Gap | What it is | Status |
| --- | --- | --- |
| **True property-based loading** | parameters loaded via interface-object property writes instead of a memory image (IP interfaces, routers, cEMI servers). Needs a generic `A_PropertyValue_Write` download path | not implemented |
| **Legacy System 1 / BCU1** | MV-001x, the mask's `DefaultProcedure`, one EEPROM segment at `0x0100` holding parameters and tables | config shown, read back (parameters; group tables when empty); the MV-0012 download of a Data Secure KNXnet/IP interface written as ETS runs it, every other write refused ([load-procedures.md](load-procedures.md#system-1-the-mv-0012-download)) |
| **Application code (LSM5)** | a separate application-program download | not implemented as its own capability. A System 7 full download does write the static code segments the load procedure declares, straight from their `<Data>` (see [load-procedures.md](load-procedures.md)); OpenKNX does not need it at all (firmware ships as a USB `.uf2`) |
| **KNX IP Secure** | encrypted tunnelling/routing | out of scope. KNX **Data** Secure is implemented, see [knx-secure.md](knx-secure.md) |
| **Non-TP media (RF, PL, IP)** | different addressing and services than TP | code-shared, never exercised on the wire. The PL/RF/IP masks run the same codec and load procedure as their TP siblings, so they are implemented but unproven; see [status.md](status.md) |

None of these needs a hand-written per-device recipe. They are selected by mask version and,
for modern devices, described by the product XML, exactly the model ETS uses.

## Read-back dumps

To develop against ground truth, the devices of an installation can be read back from the bus
(read-only, `tools/readback.ts` and `tools/dump-param-memory.ts`). The raw dumps land under
`readback/` of the server's data directory (`apps/server/data/` by default, where they are
**gitignored on purpose**): they are a real installation's
memory, including its group addresses, the same class of personal data as a project's instance
file. They are not committed, and no test in this repository requires them.
