// judge.mjs — the TWO-AXIS TEAM JUDGE for the TasteLoop demo.
//
// One frozen export:
//   export async function judgeSite({ brand, html, goal })
//     -> { quality, brandAdherence, reasoning, findings, score, category, shot }
//
// THE IMMUTABLE ANCHOR (Invariant 5):
//   The judge is the demo's fixed utility function. It is IDENTICAL for both the
//   memory and no-memory pages, is never `_ablate`-gated, and is never touched by
//   any other change. Its weights, cap, and calibration are LOCKED and committed
//   BEFORE the first scored run — there is NO post-hoc tuning. Because the anchor
//   never moves, a turn-over-turn rise on the memory page is honest: the page got
//   genuinely better against a yardstick it could not bend.
//
// HOW IT SCORES — ALL-LLM VISION, NO REGEX (Guardrail 5):
//   A SINGLE Codex gpt-5.4 vision call grades the RENDERED screenshot on two
//   independent axes:
//     - quality        (0-100): design craft — hierarchy, legibility, layout,
//                                rhythm, persuasive copy. "Is this a good page?"
//     - brandAdherence (0-100): brand fit — does the rendered design honor THIS
//                                brand's palette, type, tone, and DON'Ts?
//   It also returns short `reasoning` and concrete `findings[]`. There is NO
//   deterministic brand lint and NO per-violation regex penalty anywhere in this
//   path — the brand-fit signal is the LLM's `brandAdherence` axis, judged by eye.
//
// THE LOCKED BLEND (computed in JS, deterministically — NOT by the model):
//   score = round( 0.6 * quality + 0.4 * brandAdherence )
//   if (brandAdherence < 50)  score = min(score, 69)   // hard cap: a page that
//                                                       // misses the brand cannot
//                                                       // be labeled "strong".
//   score = clamp(score, 0, 100)
//   The 0.6/0.4 weights and the <50 ⇒ cap-69 rule are LOCKED. The `category` label
//   is always re-derived from the FINAL blended score, so it can never carry an
//   inflated verdict the blend earned down.
//
// WHY THIS MAKES MEMORY WIN ON MERIT:
//   The memory studio recalls real, specific, in-run brand fixes and APPLIES them,
//   so its rendered page reads as more on-brand AND better-crafted. Both axes move
//   up together and the blend rises. The no-memory studio carries nothing between
//   turns, so its page does not gain the same brand fit — the SAME two-axis judge,
//   looking only at the rendered pixels, scores it lower. The win is visible (the
//   judge agrees on both axes) and falsifiable (same anchor, both pages).
//
// VISION: the judge grades the RENDERED page, not the HTML source. We rasterize
// the HTML to a PNG with headless Chrome (`renderShot`) and hand that screenshot
// to the two-axis vision call, which attaches it via `codex exec -i`. The HTML is
// supporting context only — the verdict is about the design as a human would see
// it. The few-shot CALIBRATION below is brand-GENERIC (worked examples that teach
// the two-axis scale, NOT the specific flaws memory happens to fix) so the anchor
// cannot be gamed toward the win.
//
// FROZEN IMPORTS (other team members own these files; we code to their signatures):
//   codexJudgeTwoAxis from ./codex.mjs   — Codex gpt-5.4 vision, two-axis. Bound
//                                          LAZILY (dynamic import at first judge
//                                          call) so judge.mjs loads even before
//                                          that export lands; see crossFileNotes.
//   renderShot        from ./render.mjs  — HTML -> PNG via headless Chrome
//
// No npm deps. Plain ESM, Node 18+.

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { renderShot } from "./render.mjs";

// `codexJudgeTwoAxis` is owned by ./codex.mjs (added by that module's owner). We
// bind it LAZILY at first judge call rather than via a static `import` so this
// module stays loadable/smoke-testable even before that export lands (integration
// ordering), and so a missing export surfaces as a clear runtime error on the
// judge path — never a load-time crash of every importer of judge.mjs.
let _codexJudgeTwoAxis = null;
async function getCodexJudgeTwoAxis() {
  if (_codexJudgeTwoAxis) return _codexJudgeTwoAxis;
  const mod = await import("./codex.mjs");
  if (typeof mod.codexJudgeTwoAxis !== "function") {
    throw new Error(
      "judgeSite: ./codex.mjs does not export codexJudgeTwoAxis({brand,html,goal,imagePath}) " +
      "-> {quality,brandAdherence,reasoning,findings} (see CONTRACTS §4 / crossFileNotes)."
    );
  }
  _codexJudgeTwoAxis = mod.codexJudgeTwoAxis;
  return _codexJudgeTwoAxis;
}

// Screenshots live under web/run/shots/ (a sibling of web/run/snapshots/). We
// resolve it relative to this module so it works regardless of cwd.
const SHOTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "run", "shots");

// Build a unique-ish PNG path for one judged page.
let shotSeq = 0;
function nextShotPath() {
  shotSeq += 1;
  return join(SHOTS_DIR, `shot-${Date.now()}-${process.pid}-${shotSeq}.png`);
}

// ---------------------------------------------------------------------------
// LOCKED two-axis calibration (Invariant 5) — brand-GENERIC worked examples.
//
// Ported from evo's few-shot judge structure (worked examples + strict bands),
// adapted to the two-axis design scale. These examples teach the SHAPE of the
// quality/brandAdherence scale in the abstract — they deliberately do NOT name
// gradients, buzzwords, accent colors, or any brand-specific flaw memory fixes,
// so the anchor cannot be calibrated toward the win. The codex.mjs two-axis
// actor may import and inject this verbatim into its prompt.
// ---------------------------------------------------------------------------
export const JUDGE_CALIBRATION = [
  "You are a STRICT senior design & brand judge grading a RENDERED marketing page.",
  "Score TWO independent axes, each 0-100. Be harsh, discriminating, and consistent.",
  "",
  "QUALITY (design craft, brand-agnostic): visual hierarchy, legibility, spacing/",
  "rhythm, layout balance, and whether the copy actually persuades.",
  "  90-100: flawless craft — clear hierarchy, effortless legibility, real copy.",
  "  70-89 : solid, with minor craft flaws.",
  "  50-69 : noticeable craft problems (weak hierarchy, cramped or loose spacing).",
  "  0-49  : broken layout, illegible type, or placeholder/lorem copy.",
  "",
  "BRAND ADHERENCE (fit to THIS brand): does the rendered design honor the brand's",
  "palette, type, tone, and stated DON'Ts as you SEE them in the image?",
  "  90-100: unmistakably this brand — palette, type, and tone all land.",
  "  70-89 : on-brand with small drifts.",
  "  50-69 : recognizable but off in palette, tone, or type.",
  "  0-49  : off-brand, or a stated brand DON'T is visibly present.",
  "",
  "Score the two axes INDEPENDENTLY: a beautiful page can be off-brand (high",
  "quality, low brandAdherence), and a faithfully on-brand page can be poorly",
  "crafted (low quality, high brandAdherence). Do not let one axis pull the other.",
  "",
  "WORKED EXAMPLES (brand-generic — they teach the scale, not any specific flaw):",
  "",
  "EXAMPLE A — strong on both:",
  "A rendered page with a clear single focal headline, a calm consistent type",
  "scale, generous whitespace, one decisive call-to-action, and the brand's exact",
  "palette and tone throughout.",
  "  quality: 88, brandAdherence: 90",
  "  reasoning: Confident hierarchy and clean rhythm; palette and tone read",
  "  unmistakably as the brand.",
  "",
  "EXAMPLE B — well-crafted but off-brand:",
  "A polished, well-spaced page with strong hierarchy, but the colors, type, and",
  "voice belong to a different brand than the one specified.",
  "  quality: 84, brandAdherence: 38",
  "  reasoning: Craft is high, but the rendered palette and tone do not match the",
  "  brand; brand fit is weak.  (Note: brandAdherence < 50 — the blend caps the",
  "  final at 69 no matter how clean the craft.)",
  "",
  "EXAMPLE C — on-brand but poorly crafted:",
  "A page that uses the brand's exact colors, type, and voice, but with a flat,",
  "hierarchy-less wall of same-size text and an unclear primary action.",
  "  quality: 46, brandAdherence: 82",
  "  reasoning: Faithfully on-brand, but the layout has no focal point and the",
  "  reader cannot tell what to do.",
  "",
  "EXAMPLE D — weak on both:",
  "A cramped page with placeholder copy, clashing sizes, and colors and tone that",
  "miss the brand.",
  "  quality: 28, brandAdherence: 30",
  "  reasoning: Broken hierarchy and placeholder copy; neither craft nor brand fit",
  "  is present.",
].join("\n");

// ---------------------------------------------------------------------------
// small, dependency-free helpers
// ---------------------------------------------------------------------------

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// Coerce anything the vision call (or a noisy wrapper) might hand back for an axis
// into a clean integer 0-100. Accepts a number, a numeric string, or "87/100".
// Returns null when no usable number is present.
function coerceAxis(v) {
  if (v == null) return null;
  if (typeof v === "number" && Number.isFinite(v)) return clamp(Math.round(v), 0, 100);
  const m = String(v).match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? clamp(Math.round(n), 0, 100) : null;
}

// Map the FINAL blended score to a human category. ALWAYS re-derived from the
// final score so the label honestly reflects what the page earned post-blend/cap.
function categoryFor(score) {
  if (score >= 85) return "excellent";
  if (score >= 70) return "strong";
  if (score >= 55) return "decent";
  return "weak";
}

// THE LOCKED BLEND (Invariant 5). Pure, deterministic, computed in JS — never by
// the model. Exported so the smoke-test (and any verifier) exercises the exact
// production math, not a re-implementation.
export function blendTwoAxis(quality, brandAdherence) {
  const q = clamp(Math.round(quality), 0, 100);
  const b = clamp(Math.round(brandAdherence), 0, 100);
  let score = Math.round(0.6 * q + 0.4 * b);
  if (b < 50) score = Math.min(score, 69); // hard cap: missing the brand can't read as "strong"
  score = clamp(score, 0, 100);
  return { quality: q, brandAdherence: b, score, category: categoryFor(score) };
}

// `codexJudgeTwoAxis` is owned by another module; be tolerant of the exact shape
// it returns so a finalized contract there can't silently break the anchor. We
// accept, in priority order:
//   - an object {quality, brandAdherence, reasoning?, findings?}
//   - a JSON string encoding that object (optionally fenced)
// Returns a normalized { quality:int|null, brandAdherence:int|null, reasoning, findings[] }.
function normalizeTwoAxis(result) {
  if (result == null) return { quality: null, brandAdherence: null, reasoning: "", findings: [] };

  // Object result (the expected/native shape).
  if (typeof result === "object" && !Array.isArray(result)) {
    const quality = coerceAxis(result.quality);
    const brandAdherence = coerceAxis(result.brandAdherence ?? result.brand_adherence);
    const reasoning = String(
      result.reasoning || result.reason || result.rationale || result.explanation || ""
    ).trim();
    const findings = Array.isArray(result.findings)
      ? result.findings.map((x) => String(x).trim()).filter(Boolean)
      : [];
    return { quality, brandAdherence, reasoning, findings };
  }

  // String result: try JSON (optionally fenced), then give up cleanly.
  const text = String(result).trim();
  try {
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const obj = JSON.parse(fence ? fence[1].trim() : text);
    if (obj && typeof obj === "object") return normalizeTwoAxis(obj);
  } catch {
    /* not JSON — fall through */
  }
  return { quality: null, brandAdherence: null, reasoning: text, findings: [] };
}

// ---------------------------------------------------------------------------
// public API (frozen signature)
// ---------------------------------------------------------------------------

/**
 * Judge a generated marketing page on two independent axes. A SINGLE Codex
 * gpt-5.4 vision call grades the RENDERED screenshot (we rasterize the HTML to a
 * PNG with headless Chrome and pass it via `codex exec -i`) and returns
 * {quality, brandAdherence, reasoning, findings}. The LOCKED blend
 * (0.6*quality + 0.4*brandAdherence, with brandAdherence<50 ⇒ cap 69) is then
 * computed deterministically in JS. No regex, no brand lint, no per-violation
 * penalty — the brand signal is the LLM's `brandAdherence` axis.
 *
 * @param {Object}   a
 * @param {Object}   a.brand  BrandSpec from deconstructBrand()
 * @param {string}   a.html   the actual generated page HTML
 * @param {string}   a.goal   the product goal the page is built for
 * @returns {Promise<{quality:number, brandAdherence:number, reasoning:string,
 *                     findings:string[], score:number, category:string, shot:string}>}
 */
export async function judgeSite({ brand, html, goal }) {
  if (!brand) throw new Error("judgeSite: missing brand");
  if (!html || !String(html).trim()) throw new Error("judgeSite: missing html");

  // --- 1) RENDER the page to a PNG so the judge grades what is SEEN ---
  // renderShot throws on failure (no silent fallback); a missing screenshot must
  // surface, not quietly degrade the judge to a text-only read.
  await mkdir(SHOTS_DIR, { recursive: true });
  const shot = nextShotPath();
  await renderShot(html, shot);

  // --- 2) TWO-AXIS score + reasoning from Codex gpt-5.4 (VISION) ---
  // codexJudgeTwoAxis is the REAL judge model call (no fallback model). It grades
  // the rendered screenshot via `codex exec -i` and returns the two axes directly.
  // If it throws we surface the error — the anchor must never silently degrade.
  const codexJudgeTwoAxis = await getCodexJudgeTwoAxis();
  const raw = await codexJudgeTwoAxis({ brand, html, goal, imagePath: shot });
  const { quality, brandAdherence, reasoning: visionReasoning, findings } =
    normalizeTwoAxis(raw);

  if (quality == null || brandAdherence == null) {
    throw new Error(
      `judgeSite: codexJudgeTwoAxis returned no usable axes. raw=${JSON.stringify(raw).slice(0, 300)}`
    );
  }

  // --- 3) Apply the LOCKED blend + cap (deterministic, in JS) ---
  const blended = blendTwoAxis(quality, brandAdherence);

  // Reasoning: lead with the model's rationale; make the two axes + the blend
  // explicit so the UI can show exactly how the score was earned.
  const reasoning =
    (visionReasoning ? visionReasoning + " " : "") +
    `quality ${blended.quality}, brandAdherence ${blended.brandAdherence} → ` +
    `score ${blended.score} (0.6·q + 0.4·b` +
    (blended.brandAdherence < 50 ? ", capped at 69 for brand miss" : "") +
    `).`;

  return {
    quality: blended.quality,
    brandAdherence: blended.brandAdherence,
    reasoning: reasoning.trim(),
    findings,
    score: blended.score,
    category: blended.category,
    shot,
  };
}

// ---------------------------------------------------------------------------
// smoke test — `node web/src/judge.mjs` (no network / no Codex required).
// Exercises the REAL exported blend math (blendTwoAxis) + the tolerant two-axis
// parser, proving the LOCKED weights, the <50 ⇒ cap-69 rule, clamping, and the
// final-score-derived category. No penalty math (it no longer exists).
// ---------------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    let ok = true;
    const log = (cond, msg, extra = "") => {
      if (!cond) ok = false;
      console.log(cond ? "PASS" : "FAIL", msg, extra);
    };

    // 1) Blend uses the LOCKED 0.6/0.4 weights.
    let r = blendTwoAxis(90, 80);
    log(r.score === Math.round(0.6 * 90 + 0.4 * 80) && r.score === 86, "blend 0.6q+0.4b", JSON.stringify(r));

    // 2) Both-high page is "excellent" via the final score, not a model label.
    r = blendTwoAxis(95, 92);
    log(r.score === 94 && r.category === "excellent", "high/high → excellent", JSON.stringify(r));

    // 3) brandAdherence < 50 ⇒ final capped at 69 even with elite quality.
    r = blendTwoAxis(100, 40);
    const uncapped = Math.round(0.6 * 100 + 0.4 * 40); // = 76
    log(uncapped === 76 && r.score === 69 && r.category === "decent", "brand<50 caps at 69", JSON.stringify(r));

    // 4) brandAdherence exactly 50 is NOT capped (strict < 50).
    r = blendTwoAxis(80, 50);
    log(r.score === Math.round(0.6 * 80 + 0.4 * 50) && r.score === 68, "brand==50 not capped", JSON.stringify(r));

    // 5) Axes are clamped into 0-100 before blending.
    r = blendTwoAxis(130, -10);
    log(r.quality === 100 && r.brandAdherence === 0 && r.score === 60, "axis clamp + blend", JSON.stringify(r));
    // brandAdherence 0 < 50 ⇒ cap 69, but 60 <= 69 so cap is inert here.
    log(r.score === 60, "cap inert when below cap", JSON.stringify(r));

    // 6) Category is re-derived from the FINAL (post-cap) score.
    r = blendTwoAxis(100, 49); // raw 0.6*100+0.4*49 = 80, but brand<50 ⇒ cap 69
    log(r.score === 69 && r.category === categoryFor(69) && r.category === "decent", "category from final post-cap", JSON.stringify(r));

    // 7) Tolerant parser: object shape (incl. snake_case + findings).
    let n = normalizeTwoAxis({ quality: 87, brand_adherence: "82/100", reasoning: "ok", findings: ["thin CTA", ""] });
    log(n.quality === 87 && n.brandAdherence === 82 && n.findings.length === 1, "parse object + snake_case + findings", JSON.stringify(n));

    // 8) Tolerant parser: fenced JSON string.
    n = normalizeTwoAxis('```json\n{"quality": 70, "brandAdherence": 65, "findings": []}\n```');
    log(n.quality === 70 && n.brandAdherence === 65, "parse fenced JSON string", JSON.stringify(n));

    // 9) Missing axes → nulls (judgeSite would throw on these).
    n = normalizeTwoAxis({ reasoning: "no scores" });
    log(n.quality === null && n.brandAdherence === null, "missing axes → null", JSON.stringify(n));

    // 10) coerceAxis edge cases.
    log(coerceAxis(120) === 100 && coerceAxis(-5) === 0 && coerceAxis("87") === 87 && coerceAxis("n/a") === null,
      "coerceAxis clamps + parses");

    // 11) categoryFor thresholds (derived from FINAL score).
    log(categoryFor(85) === "excellent" && categoryFor(70) === "strong" && categoryFor(55) === "decent" && categoryFor(54) === "weak",
      "categoryFor thresholds");

    // 12) Calibration is brand-generic: it must NOT enumerate the specific flaws
    //     memory fixes (no gradient/buzzword/accent-hex leakage into the anchor).
    const calib = JUDGE_CALIBRATION.toLowerCase();
    log(!/gradient|buzzword|#25f4ee|#fe2c55/.test(calib), "calibration is brand-generic (no flaw enumeration)");

    console.log(ok ? "judge.mjs smoke: ALL PASS" : "judge.mjs smoke: FAILURES");
    process.exit(ok ? 0 : 1);
  })().catch((err) => {
    console.error("judge.mjs smoke FAILED:", err.message);
    process.exit(1);
  });
}
