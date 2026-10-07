# Busforge Design System

The single source of truth for Busforge's brand and visual language: logo, color, typography, iconography, and the rules that keep new surfaces consistent. The last section is the **diagram palette** for anything that renders diagrams or other assets in the Busforge skin.

Busforge is an open, cross-platform replacement for ETS, the tool that commissions KNX building-automation systems. The visual language is a **dark, precision-instrument** aesthetic: deep slate surfaces, a single forged-amber accent, monospace for all bus data.

---

## Logo

### The mark

The brandmark is a stylized **KNX bus topology**: a horizontal bus line with three device nodes, the center device drawn larger. It reads as "devices on a field bus", the core of what Busforge configures.

![Busforge mark](brand/busforge-mark.svg)

The mark always sits in a **rounded amber tile** with the dark glyph. This container is part of the identity, not optional decoration.

### Lockup

Horizontal lockup: mark + `BUSFORGE` wordmark (Archivo 800, tracked) + the mono tagline.

![Busforge lockup](brand/busforge-lockup.svg)

### Files

| File | Use |
|---|---|
| [`brand/busforge-mark.svg`](brand/busforge-mark.svg) | Full-color mark (amber tile + glyph), rounded |
| [`brand/busforge-mark-square.svg`](brand/busforge-mark-square.svg) | Same, square corners (source for iOS/Android icons) |
| [`brand/busforge-glyph.svg`](brand/busforge-glyph.svg) | Glyph only, for placing inside a colored container |
| [`brand/busforge-lockup.svg`](brand/busforge-lockup.svg) | Mark + wordmark + tagline |
| `apps/web/src/components/Brandmark.tsx` | In-app React component (glyph, `currentColor`) |
| `apps/web/public/favicon.*`, `apple-touch-icon.png`, `android-chrome-*.png` | Shipped favicon set |

### Usage

- **Do** keep the glyph in the amber tile for app/icon contexts.
- **Do** give the lockup clear space of at least the mark's corner radius on every side.
- **Don't** recolor the glyph to anything but `primary-foreground` on `primary`, or a single flat ink on light.
- **Don't** stretch, rotate, or add effects beyond the established soft amber glow (`shadow-primary/50`).

> Honest note on originality: the glyph is intentionally close to the universal Ethernet / bus-topology symbol. There is no trademark conflict, but distinctiveness comes from the amber tile plus the `BUSFORGE` wordmark, not the glyph alone. Keep the lockup intact in brand-facing contexts.

---

## Color

Dark-first. Tokens live in `apps/web/src/index.css` as OKLCH; hex below is for reference and external tools.

| Token | Hex | OKLCH | Role |
|---|---|---|---|
| `background` | `#090e12` | `0.16 0.012 248` | Page background |
| `card` / `popover` | `#13181d` | `0.205 0.013 248` | Raised surfaces |
| `muted` | `#1a2025` | `0.24 0.013 248` | Quiet fills |
| `secondary` | `#1e252b` | `0.26 0.015 248` | Secondary fills |
| `accent` (hover) | `#21272e` | `0.27 0.015 248` | Hover/active surfaces |
| `border` / `input` | `#282f35` | `0.3 0.014 248` | Hairlines, inputs |
| `foreground` | `#e5e8eb` | `0.93 0.005 248` | Primary text |
| `muted-foreground` | `#8d9399` | `0.66 0.012 248` | Secondary text |
| **`primary`** | **`#f3a44a`** | `0.78 0.14 66` | **Forged-amber brand accent** |
| `primary-foreground` | `#221202` | `0.2 0.04 66` | Ink on amber |
| `ok` | `#54c57a` | `0.74 0.15 152` | Success / confirmed state |
| `destructive` | `#ea3c3f` | `0.62 0.21 25` | Errors / destructive actions |

**Rules**

- **One accent.** Amber (`primary`) is the only brand color. Everything else is a slate neutral. Don't introduce a second brand hue.
- `ok` and `destructive` are **status** colors (success, error), not decoration.
- The amber tile uses a subtle top-to-bottom gradient (`#ffc270 → #f3a44a → #e1862a`) for the logo; flat `primary` is fine for UI chips.

---

## Typography

Two families, loaded from Google Fonts in `index.html`.

| Role | Family | Weight | Tracking | Usage |
|---|---|---|---|---|
| Wordmark | Archivo | 800 | `0.2em` | `BUSFORGE` |
| Headings / UI | Archivo | 600–800 | normal | Titles, buttons, labels |
| Body | Archivo | 400–500 | normal | Running text |
| Mono / data | JetBrains Mono | 400–600 | `0.15–0.18em` (uppercase eyebrows) | Bus data, addresses, DPTs, taglines, metadata |

**Load-bearing rule:** anything that is *bus data or technical metadata* (group addresses, DPTs, device counts, taglines) is **JetBrains Mono**, usually small, uppercase, and tracked. Human-readable names and prose are **Archivo**.

```html
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
```

---

## Iconography

- **Library:** [lucide-react](https://lucide.dev). Line icons, ~2px stroke, round caps/joins.
- **Icon-in-tile pattern:** brand/primary actions render an icon in a rounded `bg-primary` tile with `text-primary-foreground` and a soft amber glow. The brandmark uses the exact same pattern.
- Keep one icon metaphor per concept; don't mix filled and line icon sets.

---

## UI conventions

- **Dark, instrument-like.** Slate surfaces, hairline `border`, generous use of `muted-foreground` for secondary info.
- **Amber is focal.** Reserve `primary` for the brand, the active/primary action, and selection. Overuse erases the signal.
- **Radius:** base `0.5rem` (`--radius`); `rounded-md` for tiles, `rounded-xl` for cards/containers.
- **Tooltips** (Radix): instant, multiline; hide secondary detail (DPT/flags) there rather than inline.
- **State in the URL:** filter/search/selection state is URL-encoded so views are shareable and reload-safe.
- **Header lockup:** amber mark tile + `BUSFORGE` (Archivo 800, `0.2em`) + mono tagline (`common.tagline`), as in `Projects.tsx`.

---

## Diagram palette

The palette to give a diagramming tool so its output matches the product. Mapped to the semantic
roles such tools usually expose, **dark** variant (Busforge is dark-first). The docs' SVG diagrams
use it.

| Role | Value | From |
|---|---|---|
| `paper` | `#090e12` | `background` |
| `paper-2` | `#13181d` | `card` |
| `ink` | `#e5e8eb` | `foreground` |
| `muted` | `#8d9399` | `muted-foreground` |
| `soft` | `#717880` | dimmer neutral |
| `rule` | `rgba(229,232,235,0.12)` | `ink @ 12%` |
| `rule-solid` | `rgba(141,147,153,0.25)` | `muted @ 25%` |
| `accent` | `#f3a44a` | `primary` |
| `accent-tint` | `rgba(243,164,74,0.10)` | `primary @ 10%` |
| `link` | `#57b5d8` | secondary status hue |

**Typography mapping:** node names → Archivo 600; sublabels, eyebrows and arrow labels → JetBrains Mono. Busforge ships no serif, so a diagram tool that reserves a serif for titles and callouts may keep its own; that contrast is acceptable in a diagram even though the product UI is sans plus mono only.

**Constraints:** one accent (amber), no rainbow palette, `ink` hits AA on `paper`. Diagrams are dark-first like the product, not light with a dark variant bolted on.
