# COMPONENTS.md — TasteLoop / TikTok For Business Design System

**Status: FROZEN SPEC.** This is the contract implementers build against. The design
system is the single source of truth — there is **no** hand-authored example page. The
builder (Codex) **composes** the marketing page out of the named `.ds-*` components below.
Every distinctive element on the page must come from this vocabulary; nothing brand-defining
is invented from prose.

Source of truth for values: `web/run/tokens.json`. Do not introduce any value not derivable
from that file. The four brand colors are **Razzmatazz `#FE2C55`**, **Splash `#25F4EE`**,
**Black `#000`**, **White `#fff`**; neutrals are UI structure only.

Hard brand laws baked into every component:
- **ONE brand color per composition.** Pair it with black or white. Never two brand colors fighting.
- **Razzmatazz is the ONLY color allowed to emphasize text** (and only ONE keyword per headline). Splash NEVER highlights text; on a Splash field, text/icons are **black**.
- **NO gradients. NO drop shadows. NO effects.** Depth comes from FLAT color blocks + layered/rotated shapes only.
- **CTA = pill (`9999px`).** Image masks = `25%`/`50%` roundness. Bubbles = overlapping circles from the TikTok logo.
- **8px spacing grid; section vertical padding 96px / 128px.** Bold, flat, high-contrast, editorial — full-bleed color-blocked panels, oversized headlines, generous space.

---

## 1. FONT DECISION (resolved)

**Finding:** A disk + repo search (`~/Library/Fonts`, `/Library/Fonts`, `/System/Library/Fonts`,
and a repo-wide `find` for `*sofia*` / `*.woff2` / `*.woff` / `*.ttf`) returned **zero** Sofia Pro
files and **no** self-hostable font binaries anywhere. Sofia Pro is **not** a free Google font, so
the `@import` (League Spartan / Roboto / Baloo 2) never loads it. Naming `'Sofia Pro'` first in the
font vars therefore silently falls through to **Arial/Helvetica** on every render — the generic look.

**Decision: do NOT self-host (nothing to host) and do NOT name a font that never loads.**
Make **League Spartan** — which is already `@import`ed and IS a tight, geometric, high-x-height
display face very close to Sofia Pro — the **honest, cascade-winning** display/heading/body face.
Use **Baloo 2** (already imported, rounded) as the Sofia Pro **Soft** emphasis stand-in. No
`@font-face` block is added (there is no binary to point it at).

> If a real `Sofia-Pro.woff2` / `Sofia-Pro-Soft.woff2` is ever dropped into `web/run/fonts/`, add the
> two `@font-face` blocks below (commented template) and re-prepend `'Sofia Pro'` to the heading/body
> vars. Until a file exists on disk, it must NOT appear in the cascade.

**Exact font-var values to ship in `design-system.css` (replace the current three vars):**

```css
/* Heading + body: League Spartan is the real, loaded display face (Sofia Pro stand-in). */
--font-heading: 'League Spartan', Spartan, Roboto, Helvetica, Arial, sans-serif;
--font-body:    'League Spartan', Roboto, Helvetica, Arial, sans-serif;
/* Emphasis (Sofia Pro Soft stand-in): rounded Baloo 2. */
--font-emphasis: 'Baloo 2', 'League Spartan', Roboto, Helvetica, Arial, sans-serif;
--font-mono:    ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
```

League Spartan ships only at 400–700 in our `@import`; keep using `--font-weight-bold: 700` for
headlines. Because League Spartan runs slightly large/condensed vs Helvetica, keep the existing
`-0.02em` headline tracking — it reads as a confident, editorial display face, not a fallback.

**`@font-face` template — ADD ONLY IF the binaries exist on disk (currently they do NOT):**

```css
/* @font-face { font-family:'Sofia Pro'; src:url('./fonts/Sofia-Pro.woff2') format('woff2'); font-weight:400 700; font-display:swap; } */
/* @font-face { font-family:'Sofia Pro Soft'; src:url('./fonts/Sofia-Pro-Soft.woff2') format('woff2'); font-weight:500 700; font-display:swap; } */
/* then prepend 'Sofia Pro' / 'Sofia Pro Soft' to the heading/body/emphasis vars above. */
```

Also update `web/run/tokens.json → type.families` to the same honest stacks so the graph grounding
stops promising a font that never paints (the canonical Font node value should reflect the loaded face).

---

## 2. COMPONENT VOCABULARY

These are the composable classes added to `web/run/design-system.css`. The builder drops the HTML
**skeletons verbatim** and fills copy/colors. Every component is flat, shadowless, on the 8px grid.

**Rename first:** the existing pill misnamed `.ds-bubble` → **`.ds-chip`** (it is a label pill, NOT
the signature device). Free `.ds-bubble*` so the real overlapping-circle device can own that name space
under `.ds-bubble-cluster`.

### 2.0 Real responsive grid columns (the single-column-stack fix)

```css
.ds-grid-2 { display:grid; gap:var(--space-7); grid-template-columns:repeat(2,minmax(0,1fr)); }
.ds-grid-3 { display:grid; gap:var(--space-6); grid-template-columns:repeat(3,minmax(0,1fr)); }
@media (max-width:860px){ .ds-grid-2,.ds-grid-3{ grid-template-columns:1fr; } }
```

`.ds-grid` keeps its role as a bare gap container; **`.ds-grid-2` / `.ds-grid-3` are what actually
create columns** — the current `.ds-grid` had none, which is why everything stacked.

---

### 2.1 `.ds-hero` — split / full-bleed hero (PRIMARY component)

**Purpose:** The opening full-bleed panel. A Razzmatazz (or black) field, an oversized off-grid
headline with ONE Splash/Razzmatazz-emphasized word, a pill CTA, and a real layered media frame +
bubble accents on the other half. This is the page's signature, not a centered text block.

```html
<header class="ds-hero ds-hero-primary">
  <div class="ds-container ds-hero-grid">
    <div class="ds-hero-copy">
      <span class="ds-chip ds-chip-invert">For Business</span>
      <h1 class="ds-h1 ds-hero-title">Grow your brand where culture <span class="ds-emph">starts</span></h1>
      <p class="ds-lead">Reach a billion people through the videos they actually watch.</p>
      <div class="ds-actions">
        <a class="ds-btn ds-btn-on-primary" href="#">Get started</a>
        <a class="ds-btn ds-btn-ghost" href="#">See how it works</a>
      </div>
    </div>
    <div class="ds-hero-media">
      <!-- real media frame + signature bubble cluster (see 2.7 / 2.8) -->
      <figure class="ds-figure ds-figure-50 ds-rotate-6"><img alt="…" src="…"></figure>
      <div class="ds-bubble-cluster" aria-hidden="true"><span></span><span></span><span></span></div>
    </div>
  </div>
</header>
```

```css
.ds-hero { padding-block:var(--space-10); padding-inline:var(--space-5); }
.ds-hero-primary { background:var(--color-primary); color:var(--color-on-primary); }
.ds-hero-dark    { background:var(--color-bg);      color:var(--color-fg); }
.ds-hero-light   { background:var(--color-white);   color:var(--color-fg-ink); }
.ds-hero-grid { max-width:var(--container-max); margin-inline:auto;
  display:grid; gap:var(--space-8); grid-template-columns:1.1fr 0.9fr; align-items:center; }
.ds-hero-title { font-size:clamp(2.75rem,7vw,var(--font-size-h1)); max-width:14ch; }
.ds-hero-media { position:relative; min-height:340px; }
@media (max-width:860px){ .ds-hero-grid{ grid-template-columns:1fr; } }
```

**Brand intent:** full-bleed brand color, headline breaks the grid (`max-width:14ch`), exactly ONE
`.ds-emph` word, CTA pills, and a media half that is NEVER a bare rectangle — it carries the figure +
bubble cluster.

---

### 2.2 `.ds-feature-grid` — 3-up feature grid

**Purpose:** Three flat feature cards in a real row. Replaces the stacked, single-column generic block.

```html
<section class="ds-section ds-bg-light">
  <div class="ds-container">
    <h2 class="ds-h2">Built for <span class="ds-emph">performance</span></h2>
    <div class="ds-feature-grid ds-grid-3">
      <article class="ds-feature">
        <span class="ds-feature-mark" aria-hidden="true"></span>
        <h3 class="ds-subhead">Smart targeting</h3>
        <p class="ds-body-text">Reach the exact audience that converts.</p>
      </article>
      <!-- ×3 -->
    </div>
  </div>
</section>
```

```css
.ds-feature { background:transparent; padding:var(--space-6) 0; }
.ds-feature-mark { display:block; width:48px; height:48px; border-radius:var(--radius-pill);
  background:var(--color-primary); margin-bottom:var(--space-4); }
```

**Brand intent:** flat cards, no shadow, a single circular Razzmatazz "mark" per feature (a nod to the
bubble), generous `--space-6` rhythm. On a light section the marks carry the lone brand color.

---

### 2.3 `.ds-stat-band` — full-bleed stat band

**Purpose:** A high-contrast full-bleed band of oversized numbers — the editorial "proof" beat.

```html
<section class="ds-stat-band ds-bg-secondary">
  <div class="ds-container ds-grid-3">
    <div class="ds-stat"><span class="ds-stat-num">1B+</span><span class="ds-stat-label">monthly users</span></div>
    <!-- ×3 -->
  </div>
</section>
```

```css
.ds-stat-band { padding-block:var(--space-9); padding-inline:var(--space-5); }
.ds-stat-num { display:block; font-family:var(--font-heading); font-weight:var(--font-weight-bold);
  font-size:clamp(3rem,8vw,var(--font-size-h1)); line-height:1; letter-spacing:var(--tracking-headline); }
.ds-stat-label { font-size:var(--font-size-subhead); }
```

**Brand intent:** ONE full-bleed brand field (Splash → black text, or black → white text), numbers at
h1 scale. The lone-color law means the band picks one of Splash/Razzmatazz/black, never both.

---

### 2.4 `.ds-steps` — how-it-works row

**Purpose:** A numbered horizontal "1 → 2 → 3" flow.

```html
<section class="ds-section">
  <div class="ds-container">
    <h2 class="ds-h2">How it works</h2>
    <ol class="ds-steps ds-grid-3">
      <li class="ds-step"><span class="ds-step-num">1</span><h3 class="ds-subhead">Create</h3><p class="ds-body-text">Launch a campaign in minutes.</p></li>
      <!-- ×3 -->
    </ol>
  </div>
</section>
```

```css
.ds-steps { list-style:none; margin:0; padding:0; }
.ds-step-num { display:inline-flex; align-items:center; justify-content:center; width:56px; height:56px;
  border-radius:var(--radius-pill); background:var(--color-primary); color:var(--color-on-primary);
  font-family:var(--font-heading); font-weight:var(--font-weight-bold); font-size:var(--font-size-subhead);
  margin-bottom:var(--space-4); }
```

**Brand intent:** the step numbers are Razzmatazz circles (bubble lineage). Flat, no connectors-with-shadows.

---

### 2.5 `.ds-cta-band` — CTA band (pill)

**Purpose:** The full-bleed closing call to action.

```html
<section class="ds-cta-band ds-bg-primary">
  <div class="ds-container ds-cta-inner">
    <h2 class="ds-h2">Ready to <span class="ds-emph ds-emph-invert">grow</span>?</h2>
    <a class="ds-btn ds-btn-on-primary" href="#">Get started free</a>
  </div>
</section>
```

```css
.ds-cta-band { padding-block:var(--space-10); padding-inline:var(--space-5); }
.ds-cta-inner { max-width:var(--container-max); margin-inline:auto;
  display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:var(--space-6); }
```

**Brand intent:** full-bleed brand color, oversized headline, ONE pill CTA. On a Razzmatazz band the
emphasis word can't be Razzmatazz again — use `.ds-emph-invert` (white/black) so contrast carries focus.

---

### 2.6 `.ds-figure` — real media frame (rounded 25% / 50%)

**Purpose:** The honest replacement for bare rectangles. A masked, optionally Splash-bordered, optionally
rotated media frame. **This is what carries imagery — never a flat `<rect>` skeleton.**

```html
<figure class="ds-figure ds-figure-25 ds-figure-bordered ds-rotate-10">
  <img alt="…" src="…">
</figure>
```

```css
.ds-figure { margin:0; overflow:hidden; display:block; background:var(--color-surface); }
.ds-figure img,.ds-figure svg { display:block; width:100%; height:100%; object-fit:cover; }
.ds-figure-25 { border-radius:25%; }
.ds-figure-50 { border-radius:50%; }      /* 50% mask = the editorial circle crop */
.ds-figure-bordered { box-shadow:inset 0 0 0 6px var(--color-secondary); } /* inset stroke ≠ drop shadow */
.ds-rotate-6  { transform:rotate(6deg); }
.ds-rotate-10 { transform:rotate(10deg); } /* doc: images rotate in 10° increments only */
```

**Brand intent:** image masks at the doc-legal 25%/50% roundness, optional Splash inset border (an inset
ring is a stroke, not a forbidden drop shadow), rotation in 10° increments only.

---

### 2.7 `.ds-bubble-cluster` — the TikTok signature (overlapping circles)

**Purpose:** The signature device: overlapping circles derived from the two circles in the TikTok logo.
A Splash circle and a Razzmatazz circle overlap, with a smaller accent. **Decorative — `aria-hidden`.
This is NOT a pill and NOT a label.**

```html
<div class="ds-bubble-cluster" aria-hidden="true">
  <span class="ds-bubble ds-bubble-primary"></span>
  <span class="ds-bubble ds-bubble-secondary"></span>
  <span class="ds-bubble ds-bubble-ink"></span>
</div>
```

```css
.ds-bubble-cluster { position:relative; width:240px; height:240px; }
.ds-bubble { position:absolute; border-radius:var(--radius-pill); display:block; }
.ds-bubble-primary   { width:160px; height:160px; background:var(--color-primary);   top:0;   left:0; }
.ds-bubble-secondary { width:140px; height:140px; background:var(--color-secondary); top:60px; left:90px; }
.ds-bubble-ink       { width:64px;  height:64px;  background:var(--color-black);     top:140px; left:40px; }
```

> Note: this is the one place two brand colors legitimately coexist — they are flat decorative shapes,
> not a text composition. Keep at most one such cluster per panel so the "one brand color" feeling holds
> for the surrounding copy. The cluster anchors hero/empty corners — exactly where the old grey skeleton lived.

---

### 2.8 `.ds-chip` — label pill (the renamed `.ds-bubble`)

**Purpose:** Small eyebrow/label pill above a headline. Pill shape, but a LABEL, not a CTA and not the
signature device.

```html
<span class="ds-chip">New</span>
<span class="ds-chip ds-chip-invert">For Business</span>
```

```css
.ds-chip { display:inline-flex; align-items:center; padding:var(--space-2) var(--space-5);
  border-radius:var(--radius-pill); font-family:var(--font-heading);
  font-weight:var(--font-weight-semibold); font-size:var(--font-size-caption);
  letter-spacing:var(--tracking-caption); background:var(--color-surface); color:var(--color-fg); }
.ds-chip-invert { background:var(--color-white); color:var(--color-fg-ink); } /* on a brand-color field */
.ds-chip-outline { background:transparent; box-shadow:inset 0 0 0 2px currentColor; }
```

### 2.x Supporting helpers (small, required by the skeletons above)

```css
.ds-actions { display:flex; flex-wrap:wrap; gap:var(--space-4); margin-top:var(--space-6); }
.ds-btn-on-primary { background:var(--color-white); color:var(--color-fg-ink); }       /* CTA on a brand field */
.ds-btn-on-primary:hover { background:var(--color-grey-100); }
.ds-btn-ghost { background:transparent; color:currentColor; box-shadow:inset 0 0 0 2px currentColor; }
.ds-emph-invert { color:var(--color-white); font-family:var(--font-emphasis); }         /* emphasis on a Razzmatazz field */
```

**Component checklist (the ~12 the builder composes from):** `.ds-hero`, `.ds-feature-grid`,
`.ds-stat-band`, `.ds-steps`, `.ds-cta-band`, `.ds-figure`, `.ds-bubble-cluster`, `.ds-chip`,
`.ds-grid-2`, `.ds-grid-3` (+ helpers `.ds-actions`, `.ds-btn-on-primary`, `.ds-btn-ghost`,
`.ds-emph-invert`, `.ds-rotate-6/10`).

---

## 3. BUILD-PROMPT DIRECTIVE (codex.mjs)

Two concrete changes in `web/src/codex.mjs`.

**3a. Raise the section target.** Change the default in the `SECTION_COUNT` clamp (~:71) from `3` to
`5` (keep the 2–6 clamp): `Number(process.env.SECTIONS) || 5`. The default section pool becomes
`["hero", "problem", "how-it-works", "stats", "closing CTA"]` so the trimmed list maps onto real
components.

**3b. Append a COMPOSE directive to the `dsContract` text (~:576-588)** — the exact text to add so
BOTH the fresh and revise prompts tell Codex to compose from named components, not inline-style atoms:

> COMPOSE THE PAGE FROM THESE NAMED COMPONENTS (do NOT inline-style raw atoms, do NOT invent layout from
> scratch): use `.ds-hero` (split full-bleed hero) for the opening; `.ds-feature-grid` with `.ds-grid-3`
> for features; `.ds-stat-band` for proof numbers; `.ds-steps` with `.ds-grid-3` for how-it-works;
> `.ds-cta-band` for the closing call to action; `.ds-figure` (with `.ds-figure-25`/`.ds-figure-50` and
> an optional `.ds-rotate-10`) for ALL imagery; `.ds-bubble-cluster` for the signature overlapping-circle
> accent; `.ds-chip` for eyebrow labels; and `.ds-grid-2`/`.ds-grid-3` for any multi-column row. Drop the
> skeletons in and fill real copy — do NOT rebuild these from `<div>`s + inline styles.

**3c. Replace the vague "MUST VISIBLY be on-brand" sentence (~:665-667) with a concrete ART-DIRECTION
line:**

> ART DIRECTION (non-negotiable): the page is BOLD, flat, editorial. Alternate FULL-BLEED color-blocked
> panels — Razzmatazz, black, and white in sequence (exactly ONE brand color per panel; Splash only as a
> full-bleed accent band or figure border, NEVER on text). The hero headline is OVERSIZED and breaks the
> grid, with exactly ONE word wrapped in `.ds-emph` (Razzmatazz). Use `.ds-bubble-cluster` overlapping
> circles as a recurring accent. Every image is a real `.ds-figure` media frame (rounded 25%/50%, optional
> 10° rotation) — NEVER a bare rectangle or grey placeholder. Generous 96px/128px section padding. NO
> gradients, NO drop shadows; create depth with layered flat shapes only.

This keeps the brand DON'Ts but replaces the single weak "be on-brand" line with a positive,
component-anchored art direction. The `dsContract` already forbids external CSS/CDN — leave that intact.

---

## 4. GRAPH REGISTRATION (Component datapoints)

Register every component as a **graph node** so the memory studio learns which components perform and
lessons anchor to them. New `dpType`: **`Component`**. (We do NOT need a separate `Graphic` type —
`.ds-bubble-cluster` and `.ds-figure` ARE Components; the hero-SVG graphic is covered by the existing
`Shapes`/`bubbles` node. If a distinct generated-graphic node is ever wanted, add `Graphic` the same way.)

**Canonical node id = the component class name verbatim** (`ds-hero`, `ds-feature-grid`,
`ds-stat-band`, `ds-steps`, `ds-cta-band`, `ds-figure`, `ds-bubble-cluster`, `ds-chip`, `ds-grid-2`,
`ds-grid-3`). These are already valid slugs, so pass the id directly — do NOT run them back through
`canonicalToken`, which would not change them but the intent is "id is literal".

**4a. `web/src/brand.mjs` — emit Component datapoints in `buildBrandGraph`.** Add a block (next to the
Shapes block ~:504-513) that pushes one datapoint per component:

```js
// ---- Component DataPoints -> ds-* class nodes (the composable library) ----
const COMPONENTS = [
  ["ds-hero",           "split full-bleed hero with oversized off-grid headline, ONE .ds-emph word, pill CTA, and a layered media frame + bubble cluster"],
  ["ds-feature-grid",   "3-up flat feature grid (use with .ds-grid-3); one circular Razzmatazz mark per feature, no shadows"],
  ["ds-stat-band",      "full-bleed proof band of oversized h1-scale numbers on ONE brand color field"],
  ["ds-steps",          "numbered how-it-works row (use with .ds-grid-3); Razzmatazz circle step numbers"],
  ["ds-cta-band",       "full-bleed closing CTA band on a brand color with ONE pill button"],
  ["ds-figure",         "real media frame — image mask at 25%/50% roundness, optional Splash inset border + 10° rotation; replaces ALL bare-rectangle placeholders"],
  ["ds-bubble-cluster", "the TikTok signature: overlapping circles (Splash + Razzmatazz + black) derived from the logo; decorative accent, NOT a pill"],
  ["ds-chip",           "small eyebrow/label pill (formerly mis-named .ds-bubble); a LABEL, not a CTA and not the signature device"],
  ["ds-grid-2",         "real responsive 2-column grid (collapses to 1 column under 860px)"],
  ["ds-grid-3",         "real responsive 3-column grid (collapses to 1 column under 860px)"],
];
for (const [id, statement] of COMPONENTS) {
  add({ id, dpType: "Component", name: id, value: id, props: { kind: "component", statement } });
}
```

**4b. `web/src/brand.mjs` — `datapointStatement` switch (~:654).** Add a `Component` case with the
statement format. The prefix MUST be a NEW two-word prefix the bridge can map unambiguously:

```js
case "Component":
  return rich
    ? `BRAND COMPONENT token ${node} is a composable .${node} block — ${rich}`
    : `BRAND COMPONENT token ${node} is a composable design-system block.`;
```

(Statement format, canonical: `BRAND COMPONENT token <ds-class> is a composable .<ds-class> block — <what it is + when to use it>`.)

**4c. `web/src/cognee_bridge.py` — `_STMT_PREFIX_TYPE` tuple (~:830).** Add the prefix→type row so the
bridge types these nodes as `Component` (order doesn't matter, prefixes are disjoint):

```python
("BRAND COMPONENT", "Component"),
```

The bridge's `BrandToken` DataPoint already carries an arbitrary `dp_type` string and reads `statement`
verbatim for grounding, so no other bridge change is required — `Component` flows through `_dp_type_for`
and the grounding query exactly like `Color`/`Section`. (If `Graphic` is later added, register
`("BRAND GRAPHIC", "Graphic")` and the matching `datapointStatement` case identically.)

**Result:** `buildBrandGraph` emits 10 new `Component` nodes; the bridge ingests one typed `BrandToken`
(dp_type `Component`) per class with a verbatim grounding statement; lessons/critique traces can anchor
to `ds-hero`, `ds-figure`, etc., so the studio learns which components win.

---

## 5. THE NEW HERO (templateHeroDataUri)

Replace the flat-rectangle + grey-skeleton-bar SVG (`web/src/skills.mjs` ~:975) with a composed brand
**SCENE** — overlapping bubbles + layered, 10°-rotated flat color blocks that FILL the frame. Still a
pure keyless inline SVG (no model call, no network), still base64 data-URI'd. It should read as the
`.ds-bubble-cluster` + `.ds-figure` look so the embedded hero matches the composed page.

**Spec for the SVG `templateHeroDataUri` produces (1200×630, solid fills only, no gradients, no `filter`/shadow):**

1. **Field:** full-bleed `bg` rect (black) — OR the `primary` field if you want a Razzmatazz hero; pick ONE.
2. **Layered rotated blocks (depth via layering, not shadow):** two large flat rectangles, one `primary`
   and one `white`, each `transform="rotate(10 …)"` / `rotate(-10 …)` and overlapping toward the center —
   filling the frame, not floating in a corner.
3. **Bubble cluster (the signature):** three overlapping circles — a large `primary` circle, an
   overlapping `accent` (Splash) circle, and a small `black` (or `white`) circle — placed so they read as
   the TikTok-logo device. No circle is a thin "skeleton bar."
4. **NO text-skeleton bars.** Remove the two grey `rect` headline stand-ins entirely — the real headline is
   live `.ds-h1` HTML over/beside the figure, not faked inside the image.
5. Use the brand roles already resolved in the function (`primary`/`accent`/`bg`/`fg`); keep the `esc()`
   escaping and the existing `if (!primary && !accent) return "";` guard.

Reference SVG body (replace the inner markup between the `<svg …>` open and `</svg>`):

```js
`<rect width="${W}" height="${H}" fill="${esc(bg)}"/>` +
`<g transform="rotate(-10 ${W*0.34} ${H*0.5})"><rect x="${W*0.06}" y="${H*0.16}" width="${W*0.52}" height="${H*0.68}" fill="${esc(primary)}"/></g>` +
`<g transform="rotate(10 ${W*0.7} ${H*0.5})"><rect x="${W*0.5}" y="${H*0.1}" width="${W*0.42}" height="${H*0.5}" fill="${esc(fg)}" opacity="0.96"/></g>` +
`<circle cx="${W*0.7}" cy="${H*0.62}" r="${H*0.22}" fill="${esc(primary)}"/>` +
`<circle cx="${W*0.82}" cy="${H*0.72}" r="${H*0.16}" fill="${esc(accent)}"/>` +
`<circle cx="${W*0.6}" cy="${H*0.78}" r="${H*0.07}" fill="${esc(bg)}"/>`
```

This yields a bold, flat, layered, on-brand poster (overlapping bubbles + rotated color blocks) that fills
the frame — the amateur tell (flat rect + grey bars) is gone, and it visually matches the composed page.

---

## 6. FILE OWNERSHIP MAP (disjoint)

Each file has exactly one owner; no two implementers edit the same file.

| Owner / lane | File | Scope (only this) |
|---|---|---|
| **Design-system author** | `web/run/design-system.css` | §1 font vars (League Spartan/Baloo, no Sofia), §2 all new `.ds-*` components + grid columns + `.ds-bubble`→`.ds-chip` rename + the `.ds-bubble-cluster`/helper classes |
| **Token author** | `web/run/tokens.json` | §1 only: update `type.families` heading/body/emphasis to the honest loaded stacks (READ-only for all other values) |
| **Hero author** | `web/src/skills.mjs` | §5 only: rewrite `templateHeroDataUri` inner SVG to the composed bubble + rotated-block scene; remove grey skeleton bars |
| **Build-prompt author** | `web/src/codex.mjs` | §3 only: `SECTION_COUNT` default 3→5 + pool, COMPOSE directive appended to `dsContract`, ART-DIRECTION line replacing the vague on-brand sentence |
| **Graph author (JS)** | `web/src/brand.mjs` | §4a/§4b only: emit `Component` datapoints in `buildBrandGraph`, add `Component` case to `datapointStatement` |
| **Graph author (bridge)** | `web/src/cognee_bridge.py` | §4c only: add `("BRAND COMPONENT", "Component")` to `_STMT_PREFIX_TYPE` |

**Cross-lane contracts (must agree, do not drift):**
- The 10 component class names are IDENTICAL across `design-system.css` (defines), `codex.mjs` (lists in
  COMPOSE), and `brand.mjs` (registers as node ids). One canonical list: `ds-hero, ds-feature-grid,
  ds-stat-band, ds-steps, ds-cta-band, ds-figure, ds-bubble-cluster, ds-chip, ds-grid-2, ds-grid-3`.
- The statement prefix `BRAND COMPONENT` is IDENTICAL in `brand.mjs` (`datapointStatement`) and
  `cognee_bridge.py` (`_STMT_PREFIX_TYPE`) — they must match exactly or the node types as `Token`.
- Font stacks in `design-system.css` (§1 vars) and `tokens.json` (`type.families`) MUST match.
- `templateHeroDataUri` (skills.mjs) and the hero CSS (`.ds-hero-media`/`.ds-figure`) share the
  overlapping-bubble + rotated-block visual language so the embedded hero matches the composed page.
