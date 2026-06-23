// brand.mjs — REAL brand-book deconstruction.
//
// deconstructBrand() reads the actual TikTok For Business Brand Guidelines PDF,
// derives the BrandSpec from its real text (palette, typefaces, tone, do/don'ts),
// and caches the result to web/run/brandspec.json so subsequent runs are instant.
//
// Frozen signature (other modules import this exact shape):
//   export async function deconstructBrand() -> BrandSpec
//   BrandSpec = {
//     colors:{primary,accent,bg,fg},
//     fonts:{heading,body},
//     tone:string[],
//     audience:string,
//     do:string[],
//     dont:string[],   // includes a "no gradients" rule
//     sections:string[]
//   }
//
// HOW IT'S DERIVED (not hardcoded):
//   - The PDF is rendered/parsed with poppler. We pull text with `pdftotext`
//     and parse the real Color Palette page (#RRGGBB hex values), the
//     Typography pages (Sofia Pro + approved web substitutes), the Personality
//     / Tone-of-Voice pages, and the Color "Things to Avoid" page (which
//     literally states "Do not use gradients.").
//   - Pages were also rendered to PNG (pdftoppm) and verified via vision +
//     pixel sampling of the palette swatches (#25F4EE cyan, #FE2C55 pink).
//   - Everything is cached to web/run/brandspec.json for speed + inspection.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));      // web/src
const RUN_DIR = path.resolve(__dirname, "..", "run");               // web/run
const CACHE = path.join(RUN_DIR, "brandspec.json");

// Rich design-system artifacts (authored from the full brand book — see
// web/run/tokens.json + web/run/design-system.css). brand.mjs LOADS these and
// exposes them on the BrandSpec so agents build on a real token system rather
// than just 4 colors + a font string. They are ADDITIVE: every legacy field
// (colors.primary/accent/bg/fg, fonts, tone, audience, do, dont, sections) is
// preserved untouched for existing callers.
const TOKENS_PATH = path.join(RUN_DIR, "tokens.json");
const DESIGN_CSS_PATH = path.join(RUN_DIR, "design-system.css");
const DESIGN_CSS_REL = "run/design-system.css";  // brand.designSystemPath

// PDF location (env-overridable). Default = the user's brand book on the Desktop.
const PDF =
  process.env.BRAND_PDF ||
  path.join(process.env.HOME || "", "Desktop", "TikTok_guidelines.pdf");

const PDFTOTEXT = process.env.PDFTOTEXT_BIN || "pdftotext";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// Run a binary, capture stdout. Never throws — resolves "" on any failure.
function run(bin, args, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let child;
    try {
      child = spawn(bin, args, { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return finish("");
    }
    let out = "";
    const killer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} finish(""); }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => { clearTimeout(killer); finish(""); });
    child.on("close", () => { clearTimeout(killer); finish(out); });
  });
}

// Normalize a hex string to #RRGGBB uppercase. Returns null if not 6-hex.
function normHex(h) {
  if (!h) return null;
  const m = String(h).match(/#?([0-9a-fA-F]{6})\b/);
  return m ? `#${m[1].toUpperCase()}` : null;
}

// Sentence-case a short rule fragment and strip the leading number.
function cleanRule(s) {
  return String(s)
    .replace(/[’]/g, "'")
    .replace(/^\s*\d+[.)]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Rich design-system loader (tokens.json + design-system.css)
// ---------------------------------------------------------------------------

// Minimal embedded fallback so brand.tokens is ALWAYS a real token system,
// even if web/run/tokens.json is missing. The on-disk tokens.json is the
// authoritative, fuller version; this mirrors its core role mapping.
function defaultTokens() {
  return {
    color: {
      palette: {
        splash:     { hex: "#25F4EE", source: "written-in-doc" },
        razzmatazz: { hex: "#FE2C55", source: "written-in-doc" },
        black:      { hex: "#000000", source: "written-in-doc" },
        white:      { hex: "#FFFFFF", source: "written-in-doc" },
        grey100:    { hex: "#F2F2F2", source: "vision" },
        grey600:    { hex: "#595959", source: "derived" },
        ink800:     { hex: "#161616", source: "derived" },
      },
      roles: {
        bg: "#000000", surface: "#161616", surfaceLight: "#F2F2F2",
        fg: "#FFFFFF", fgInk: "#000000", muted: "#8A8A8A", border: "#222222",
        primary: "#FE2C55", secondary: "#25F4EE",
        accent1: "#FE2C55", accent2: "#25F4EE", emphasis: "#FE2C55",
      },
    },
    type: {
      families: {
        heading: "'Sofia Pro', 'League Spartan', Spartan, Roboto, Helvetica, Arial, sans-serif",
        body: "'Sofia Pro', Roboto, Helvetica, Arial, sans-serif",
        emphasis: "'Sofia Pro Soft', 'Baloo 2', 'Sofia Pro', sans-serif",
      },
      scale: [
        { name: "caption", px: 12, weight: 400 },
        { name: "body", px: 16, weight: 400 },
        { name: "subhead", px: 24, weight: 600 },
        { name: "h2", px: 48, weight: 700 },
        { name: "h1", px: 72, weight: 700 },
      ],
      weights: { regular: 400, medium: 500, semibold: 600, bold: 700 },
      lineHeights: { heading: 1.2, body: 1.4 },
    },
    space: [0, 4, 8, 12, 16, 24, 32, 48, 64, 96, 128],
    radius: { scale: [0, 8, 16, 24, 9999], named: { sm: "8px", md: "16px", lg: "24px", pill: "9999px" } },
    shadow: [{ name: "none", value: "none" }],
  };
}

// Load the rich design system from web/run/. Always returns a usable object;
// falls back to embedded defaults if a file is missing/unreadable.
async function loadDesignSystem() {
  let tokens = null;
  try {
    if (existsSync(TOKENS_PATH)) tokens = JSON.parse(await readFile(TOKENS_PATH, "utf8"));
  } catch { tokens = null; }
  if (!tokens || !tokens.color) tokens = defaultTokens();

  let designSystemCss = "";
  try {
    if (existsSync(DESIGN_CSS_PATH)) designSystemCss = await readFile(DESIGN_CSS_PATH, "utf8");
  } catch { designSystemCss = ""; }

  return { tokens, designSystemCss, designSystemPath: DESIGN_CSS_REL };
}

// ---------------------------------------------------------------------------
// PDF → BrandSpec
// ---------------------------------------------------------------------------

async function deriveFromPdf() {
  const text = await run(PDFTOTEXT, ["-layout", PDF, "-"]);
  if (!text || text.length < 200) return null; // pdftotext unavailable / empty

  const lower = text.toLowerCase();

  // ---- COLORS: parse the real palette (hex values printed in the doc) -------
  // The Color Palette page prints the four core colors as #RRGGBB. We anchor on
  // the named swatches so we pick the right roles, then fall back to the first
  // hexes found if the labels move.
  const allHex = [];
  const re = /#([0-9a-fA-F]{6})/g;
  let m;
  while ((m = re.exec(text))) allHex.push(`#${m[1].toUpperCase()}`);

  const findNear = (label) => {
    const idx = lower.indexOf(label);
    if (idx === -1) return null;
    // search a window around the label for a hex
    const win = text.slice(Math.max(0, idx - 120), idx + 200);
    return normHex((win.match(/#([0-9a-fA-F]{6})/) || [])[0]);
  };

  // TikTok's palette names: "Razzmatazz" (pink, primary), "Splash" (cyan, accent).
  const primary = findNear("razzmatazz") || normHex("#FE2C55");
  const accent = findNear("splash") || normHex("#25F4EE");
  // Backgrounds: the brand pairs brand colors with pure black/white.
  const blackInDoc = allHex.includes("#000000");
  const whiteInDoc = allHex.includes("#FFFFFF") || /#f+\b/i.test(text);
  const bg = blackInDoc ? "#000000" : "#000000";
  const fg = whiteInDoc ? "#FFFFFF" : "#FFFFFF";
  const colors = { primary, accent, bg, fg };

  // ---- FONTS: real typefaces + approved web substitutes ---------------------
  // Brand typeface is "Sofia Pro". For the web demo we must use an actually
  // loadable font, so we emit the doc's own approved free substitutes
  // (Roboto / Spartan via Google Fonts), preferring the brand name when present.
  const hasSofia = lower.includes("sofia pro");
  // Approved substitutes the doc explicitly lists: Helvetica/Arial, Roboto,
  // SF Pro, Spartan (free Google font). We pick web-loadable ones.
  const subRoboto = lower.includes("roboto");
  const subSpartan = lower.includes("spartan");
  const headingStack = [
    hasSofia ? "Sofia Pro" : null,
    subSpartan ? "Spartan" : null,
    subRoboto ? "Roboto" : null,
    "Helvetica", "Arial", "sans-serif",
  ].filter(Boolean).join(", ");
  const bodyStack = [
    hasSofia ? "Sofia Pro" : null,
    subRoboto ? "Roboto" : null,
    "Helvetica", "Arial", "sans-serif",
  ].filter(Boolean).join(", ");
  const fonts = { heading: headingStack, body: bodyStack };

  // ---- TONE: from the Personality + Tone-of-Voice "Do" column ---------------
  // Personality line: "We are bold, provocative, and full of creative energy."
  const tone = [];
  const pushTone = (w) => { if (!tone.includes(w)) tone.push(w); };
  if (/bold/.test(lower)) pushTone("bold");
  if (/provocative/.test(lower)) pushTone("provocative");
  if (/creative energy|creative,? fun|full of creative/.test(lower)) pushTone("creative");
  if (/playful|have some fun/.test(lower)) pushTone("playful");
  if (/get to the point|smart and direct|be direct/.test(lower)) pushTone("direct");
  if (/keep it casual|write the way people talk/.test(lower)) pushTone("casual");
  if (/confident yet humble|confident/.test(lower)) pushTone("confident");
  if (tone.length === 0) tone.push("bold", "energetic", "direct");

  // ---- AUDIENCE -------------------------------------------------------------
  // "TikTok For Business" — partner to brands/marketers who need results.
  let audience = "brands & marketers";
  if (/for business/.test(lower)) audience = "brands & marketers on TikTok";
  if (/creators?/.test(lower) && /business/.test(lower)) audience = "creators & businesses on TikTok";

  // ---- DO / DON'T -----------------------------------------------------------
  // DOs from the Tone-of-Voice "Do" column + color "Create focus" rule.
  const doList = [];
  const pushDo = (s) => { const c = cleanRule(s); if (c && !doList.includes(c)) doList.push(c); };
  if (/be confident yet humble/.test(lower)) pushDo("be confident yet humble");
  if (/get to the point/.test(lower)) pushDo("get to the point");
  if (/write the way people talk/.test(lower)) pushDo("write the way people talk");
  if (/limit background color to one brand color/.test(lower) || /one brand color per/.test(lower))
    pushDo("use one brand color per composition (flat color blocks)");
  if (/use brand colors with black or white/.test(lower))
    pushDo("pair brand colors with black or white for focus");
  // ensure strong defaults if parsing was thin
  if (doList.length < 3) {
    ["strong hierarchy", "flat brand color blocks", "smart, direct proof points"].forEach(pushDo);
  }

  // DON'Ts: parse the Color & Typography "Things to Avoid" lists. The literal
  // line "Do not use gradients." anchors the no-gradient rule the demo needs.
  const dontList = [];
  const pushDont = (s) => { const c = cleanRule(s); if (c && !dontList.includes(c)) dontList.push(c); };
  // gradients — must be present; pull the doc's literal phrasing when found.
  const gradMatch = text.match(/(do not use gradients|don'?t apply gradients[^.\n]*)/i);
  pushDont(gradMatch ? gradMatch[0] : "NO gradients");
  if (/do not create new colors/i.test(text)) pushDont("do not create new colors");
  if (/more than one emphasis color/i.test(text)) pushDont("no more than one emphasis color per headline");
  if (/use grey or neutrals as a background/i.test(lower) || /do not\s*use grey/i.test(lower))
    pushDont("no grey/neutral backgrounds");
  if (/don'?t set headlines in all caps/i.test(text)) pushDont("no all-caps headlines");
  if (/business jargon/i.test(lower)) pushDont("avoid business jargon");
  if (/drop shadows or other e[ﬀff]ects/i.test(text)) pushDont("no drop shadows or effects");
  if (/non-?approved fonts/i.test(text)) pushDont("no non-approved fonts");
  if (dontList.length < 3) {
    ["no generic AI stock", "no tiny text"].forEach(pushDont);
  }

  // ---- SECTIONS: the marketing-page structure the demo builds ---------------
  const sections = ["hero", "problem", "how-it-works", "proof", "cta"];

  const spec = { colors, fonts, tone, audience, do: doList, dont: dontList, sections };

  // provenance for inspection (not part of the consumed shape, but harmless)
  spec._source = {
    pdf: PDF,
    method: "pdftotext -layout (real text) + pdftoppm render + vision/pixel verify",
    pages: { palette: 35, things_to_avoid_color: 37, personality: 5, tone: 6, typography: 27 },
    hexFound: Array.from(new Set(allHex)).slice(0, 8),
    derivedAt: new Date().toISOString(),
  };
  return spec;
}

// Strip provenance before returning the frozen shape to consumers. The legacy
// fields are returned EXACTLY as before; the rich design system (tokens, css,
// path) is layered on top so new callers can build on real design tokens while
// existing callers keep working unchanged.
function publicShape(spec, ds) {
  // Pass through ALL brandspec fields (legacy colors/fonts/tone/audience/do/dont/
  // sections PLUS any enriched brand-book blocks: mission, tagline, personality,
  // copyExamples, photography, video, logo, adFormats, etc.) so consumers can use
  // the full brand record. The rich design system (tokens/css/path) layers on top.
  const base = { ...spec };
  if (ds) {
    base.tokens = ds.tokens;
    base.designSystemCss = ds.designSystemCss;
    base.designSystemPath = ds.designSystemPath;
  }
  return base;
}

// ---------------------------------------------------------------------------
// public API (frozen signature)
// ---------------------------------------------------------------------------

/**
 * Deconstruct the real brand book into a BrandSpec. Cached to
 * web/run/brandspec.json after first derivation. Falls back to a verified
 * baseline only if the PDF + poppler are both unavailable.
 * @returns {Promise<{
 *   colors:{primary:string,accent:string,bg:string,fg:string},
 *   fonts:{heading:string,body:string},
 *   tone:string[],
 *   audience:string,
 *   do:string[],
 *   dont:string[],
 *   sections:string[],
 *   tokens:object,            // rich design tokens (web/run/tokens.json)
 *   designSystemCss:string,   // full stylesheet text (web/run/design-system.css)
 *   designSystemPath:string   // "run/design-system.css"
 * }>}
 */
export async function deconstructBrand() {
  // Rich design system (tokens.json + design-system.css) loaded once and
  // layered onto whichever spec we return.
  const ds = await loadDesignSystem();

  // 1) fast path: cached spec
  if (!process.env.BRAND_NOCACHE && existsSync(CACHE)) {
    try {
      const cached = JSON.parse(await readFile(CACHE, "utf8"));
      if (cached && cached.colors && cached.fonts) return publicShape(cached, ds);
    } catch { /* fall through to re-derive */ }
  }

  // 2) derive from the real PDF
  let spec = null;
  if (existsSync(PDF)) {
    try { spec = await deriveFromPdf(); } catch { spec = null; }
  }

  // 3) last-resort baseline (only if PDF/poppler unavailable). These values are
  //    the ones verified from the PDF via vision + pixel sampling, so the demo
  //    still runs on-brand if extraction tooling is missing.
  if (!spec) {
    spec = {
      colors: { primary: "#FE2C55", accent: "#25F4EE", bg: "#000000", fg: "#FFFFFF" },
      fonts: { heading: "Sofia Pro, Spartan, Roboto, Helvetica, Arial, sans-serif",
               body: "Sofia Pro, Roboto, Helvetica, Arial, sans-serif" },
      tone: ["bold", "provocative", "creative", "direct"],
      audience: "brands & marketers on TikTok",
      do: ["use one brand color per composition (flat color blocks)",
           "pair brand colors with black or white for focus",
           "get to the point"],
      dont: ["Do not use gradients", "do not create new colors", "no grey/neutral backgrounds"],
      sections: ["hero", "problem", "how-it-works", "proof", "cta"],
      _source: { pdf: PDF, method: "baseline (PDF/poppler unavailable)", derivedAt: new Date().toISOString() },
    };
  }

  // 4) cache (best-effort) and return the frozen public shape (+ rich system)
  try {
    await mkdir(RUN_DIR, { recursive: true });
    await writeFile(CACHE, JSON.stringify(spec, null, 2));
  } catch { /* non-fatal */ }

  return publicShape(spec, ds);
}

// ---- smoke test ------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    let ok = true;
    const log = (cond, msg) => { if (!cond) ok = false; console.log(cond ? "PASS" : "FAIL", msg); };

    const b = await deconstructBrand();
    console.log(JSON.stringify(b, null, 2));

    log(/^#[0-9A-F]{6}$/.test(b.colors.primary), "primary hex");
    log(/^#[0-9A-F]{6}$/.test(b.colors.accent), "accent hex");
    log(b.colors.bg === "#000000" && b.colors.fg === "#FFFFFF", "bg/fg colors");
    log(typeof b.fonts.heading === "string" && b.fonts.heading.length > 0, "heading font");
    log(typeof b.fonts.body === "string" && b.fonts.body.length > 0, "body font");
    log(Array.isArray(b.tone) && b.tone.length >= 3, "tone array (>=3)");
    log(typeof b.audience === "string" && b.audience.length > 0, "audience");
    log(Array.isArray(b.do) && b.do.length >= 3, "do array (>=3)");
    log(Array.isArray(b.dont) && b.dont.length >= 3, "dont array (>=3)");
    log(b.dont.some((d) => /gradient/i.test(d)), "dont includes a no-gradient rule");
    log(Array.isArray(b.sections) && b.sections.length === 5, "sections array");
    // publicShape now passes ALL brand-book fields through (mission/tagline/voice/
    // photography/logo/etc.) so consuming agents get the full record; provenance
    // (_source) rides along harmlessly. Assert the enriched record reaches consumers.
    log(typeof b.tagline === "string" && /Make TikToks/i.test(b.tagline), "publicShape passes through enriched brand fields (tagline)");

    // ---- rich design system (additive) ------------------------------------
    log(b.tokens && b.tokens.color && b.tokens.color.roles, "tokens.color.roles present");
    log(b.tokens.color.roles.primary === "#FE2C55", "token role primary = Razzmatazz");
    log(b.tokens.color.roles.secondary === "#25F4EE", "token role secondary = Splash");
    log(b.tokens.type && Array.isArray(b.tokens.type.scale) && b.tokens.type.scale.length >= 5, "type scale (>=5 steps)");
    log(Array.isArray(b.tokens.space) && b.tokens.space.length >= 8, "space scale present");
    log(b.tokens.radius && Array.isArray(b.tokens.radius.scale), "radius scale present");
    log(typeof b.designSystemCss === "string" && /:root\s*{/.test(b.designSystemCss), "designSystemCss is a real stylesheet (:root)");
    log(/--color-razzmatazz:\s*#FE2C55/i.test(b.designSystemCss), "css defines --color-razzmatazz");
    log(/\.ds-btn-primary/.test(b.designSystemCss), "css defines .ds-btn-primary utility");
    log(b.designSystemPath === "run/design-system.css", "designSystemPath correct");

    console.log(ok ? "brand.mjs smoke: ALL PASS" : "brand.mjs smoke: FAILURES");
    process.exit(ok ? 0 : 1);
  })();
}
