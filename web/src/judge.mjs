// judge.mjs — the TEAM JUDGE for the TasteLoop demo.
//
// One frozen export:
//   export async function judgeSite({ brand, html, goal })
//     -> { score:int, category:string, reasoning:string, violations:string[] }
//
// HOW IT SCORES (honest, two-stage):
//   1) BASE  — a REAL model call to Codex gpt-5.4 with HIGH reasoning via
//      `codexJudge` (from ./codex.mjs). Codex reads the actual page HTML against
//      the brand and returns a base score (0-100) + a category + reasoning. We
//      use Codex HIGH for the judge specifically because qwen is too noisy to
//      separate two strong, Codex-built pages — the directive is explicit:
//      JUDGE = Codex gpt-5.4 HIGH (NOT qwen).
//   2) PENALTY — a DETERMINISTIC brand lint via `brandRuleViolations(html, brand)`
//      (from ./skills.mjs). Each real, checkable brand-rule violation found in the
//      actual artifact costs PENALTY_PER points (default 20), and the final score
//      is clamped to 0-100.
//
// WHY THIS MAKES MEMORY WIN ON MERIT:
//   The memory studio recalls a real, specific, checkable brand rule (e.g. banned
//   buzzwords, the accent #25F4EE must appear on the primary CTA, a required proof
//   element) and APPLIES it. The no-memory studio never learned it, so its page
//   violates the rule. `brandRuleViolations` catches that violation in the real
//   HTML and the deterministic penalty drops its score — AND because Codex HIGH
//   also reviews the worse page, the base score moves the same direction. Memory
//   wins both honestly (real penalty) and visibly (Codex agrees), and we return
//   the `violations` so the orchestrator can show exactly WHY.
//
// VISION: the base judge grades the RENDERED page, not the HTML source (plan §5).
// We rasterize the HTML to a PNG with headless Chrome (renderShot) and hand that
// screenshot to codexJudge, which attaches it via `codex exec -i` and grades the
// design as a human would see it. The deterministic brand lint still runs on the
// real HTML so the per-violation penalty stays honest and reproducible.
//
// FROZEN IMPORTS (other team members own these files; we code to their signatures):
//   codexJudge          from ./codex.mjs   — Codex gpt-5.4 HIGH base judge (vision)
//   brandRuleViolations from ./skills.mjs  — deterministic brand-rule lint
//   renderShot          from ./render.mjs  — HTML -> PNG via headless Chrome
//
// No npm deps. Plain ESM, Node 18+.

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { codexJudge } from "./codex.mjs";
import { brandRuleViolations } from "./skills.mjs";
import { renderShot } from "./render.mjs";

// Screenshots live under web/run/shots/ (a sibling of web/run/snapshots/). We
// resolve it relative to this module so it works regardless of cwd.
const SHOTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "run", "shots");

// Build a unique-ish PNG path for one judged page.
let shotSeq = 0;
function nextShotPath() {
  shotSeq += 1;
  return join(SHOTS_DIR, `shot-${Date.now()}-${process.pid}-${shotSeq}.png`);
}

// Points deducted per real, checkable brand-rule violation found in the HTML.
// Env-overridable so the demo can be tuned without code changes.
const PENALTY_PER = Number(process.env.JUDGE_PENALTY_PER || 20);

// ---------------------------------------------------------------------------
// small, dependency-free helpers
// ---------------------------------------------------------------------------

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// Coerce anything Codex (or a noisy wrapper) might hand back for a score into a
// clean integer 0-100. Accepts a number, a numeric string, or "87/100".
function coerceScore(v) {
  if (v == null) return null;
  if (typeof v === "number" && Number.isFinite(v)) return clamp(Math.round(v), 0, 100);
  const m = String(v).match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? clamp(Math.round(n), 0, 100) : null;
}

// Map a numeric score to a human category. Used as a fallback when the model
// doesn't supply one, and ALWAYS re-derived after the penalty so the category
// honestly reflects the FINAL score the page earned.
function categoryFor(score) {
  if (score >= 85) return "excellent";
  if (score >= 70) return "strong";
  if (score >= 55) return "decent";
  return "weak";
}

// `codexJudge` is owned by another module; be tolerant of the exact shape it
// returns so a finalized contract there can't silently break the judge. We
// accept, in priority order:
//   - an object {score, category?, reasoning?|reason?|rationale?}
//   - a JSON string encoding that object
//   - raw text containing a number (e.g. "Score: 82 — bold but ...")
// Returns a normalized { score:int|null, category:string|null, reasoning:string }.
function normalizeCodexResult(result) {
  if (result == null) return { score: null, category: null, reasoning: "" };

  // Object result (the expected/native shape).
  if (typeof result === "object") {
    const score = coerceScore(result.score);
    const category = result.category ? String(result.category).trim() : null;
    const reasoning = String(
      result.reasoning || result.reason || result.rationale || result.explanation || ""
    ).trim();
    return { score, category, reasoning };
  }

  // String result: try JSON first, then fall back to scraping a number out of prose.
  const text = String(result).trim();
  try {
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const obj = JSON.parse(fence ? fence[1].trim() : text);
    if (obj && typeof obj === "object") return normalizeCodexResult(obj);
  } catch {
    /* not JSON — fall through to prose scraping */
  }
  return { score: coerceScore(text), category: null, reasoning: text };
}

// ---------------------------------------------------------------------------
// public API (frozen signature)
// ---------------------------------------------------------------------------

/**
 * Judge a generated marketing page. The base score + reasoning come from Codex
 * gpt-5.4 HIGH judging the RENDERED screenshot (vision): we rasterize the HTML to
 * a PNG with headless Chrome and pass it to codexJudge. A deterministic
 * per-violation brand lint on the real HTML then makes a page that breaks a real
 * brand rule score honestly lower.
 *
 * @param {Object}   a
 * @param {Object}   a.brand  BrandSpec from deconstructBrand()
 * @param {string}   a.html   the actual generated page HTML
 * @param {string}   a.goal   the product goal the page is built for
 * @returns {Promise<{score:number, category:string, reasoning:string, violations:string[], shot:string}>}
 */
export async function judgeSite({ brand, html, goal }) {
  if (!brand) throw new Error("judgeSite: missing brand");
  if (!html || !String(html).trim()) throw new Error("judgeSite: missing html");

  // --- 1) DETERMINISTIC brand lint (real, checkable violations) ---
  // Run this first and unconditionally: it is the honest, reproducible part of
  // the score and must never be skipped even if the model call wobbles.
  let violations = [];
  try {
    const v = brandRuleViolations(html, brand);
    if (Array.isArray(v)) {
      violations = v.map((x) => String(x)).filter(Boolean);
    }
  } catch {
    // A lint failure must not crash the judge; treat as no violations found.
    violations = [];
  }

  // --- 2) RENDER the page to a PNG so the judge grades what is SEEN ---
  // renderShot throws on failure (no silent fallback); a missing screenshot must
  // surface, not quietly degrade the judge to a text-only read.
  await mkdir(SHOTS_DIR, { recursive: true });
  const shot = nextShotPath();
  await renderShot(html, shot);

  // --- 3) BASE score + reasoning from Codex gpt-5.4 HIGH (VISION) ---
  // codexJudge is the REAL judge model call (no fallback model). It grades the
  // rendered screenshot via `codex exec -i`. If it throws we surface the error —
  // the directive forbids a cosmetic/qwen judge here.
  const raw = await codexJudge({ brand, html, goal, imagePath: shot });
  const { score: baseScore, category: codexCategory, reasoning: codexReasoning } =
    normalizeCodexResult(raw);

  if (baseScore == null) {
    throw new Error(
      `judgeSite: codexJudge returned no usable score. raw=${JSON.stringify(raw).slice(0, 300)}`
    );
  }

  // --- 4) Apply the honest per-violation penalty and clamp ---
  const penalty = violations.length * PENALTY_PER;
  const finalScore = clamp(baseScore - penalty, 0, 100);

  // Category honestly reflects the FINAL (post-penalty) score — a page penalized
  // below its base must not keep an inflated label from the model.
  const category = penalty > 0 ? categoryFor(finalScore) : (codexCategory || categoryFor(finalScore));

  // Reasoning: lead with the model's rationale, then make the deduction explicit
  // so the UI can show exactly why the page lost points.
  const parts = [];
  if (codexReasoning) parts.push(codexReasoning);
  if (violations.length) {
    parts.push(
      `Brand-rule penalty: -${penalty} (${violations.length} violation${violations.length === 1 ? "" : "s"} ` +
      `× -${PENALTY_PER}) for: ${violations.join("; ")}. Base ${baseScore} → ${finalScore}.`
    );
  }
  const reasoning = parts.join(" ").trim() ||
    `Codex (gpt-5.4 HIGH) scored ${baseScore}; no brand-rule violations detected.`;

  return { score: finalScore, category, reasoning, violations, shot };
}

// ---------------------------------------------------------------------------
// smoke test — `node web/src/judge.mjs` (no network / no Codex required).
// Stubs the two frozen imports via module-local fakes to prove the penalty math,
// clamping, category re-derivation, and tolerant result-parsing are correct.
// ---------------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    let ok = true;
    const log = (cond, msg, extra = "") => {
      if (!cond) ok = false;
      console.log(cond ? "PASS" : "FAIL", msg, extra);
    };

    // Re-implement judgeSite's pure logic against stubs so we can exercise it
    // without importing real Codex/skills (those are owned/validated elsewhere).
    const fakeJudge = async ({ baseRaw, viols }) => {
      const norm = normalizeCodexResult(baseRaw);
      const violations = (viols || []).map(String).filter(Boolean);
      const penalty = violations.length * PENALTY_PER;
      const finalScore = clamp((norm.score ?? 0) - penalty, 0, 100);
      const category = penalty > 0 ? categoryFor(finalScore) : (norm.category || categoryFor(finalScore));
      return { score: finalScore, category, violations, base: norm.score, reasoning: norm.reasoning };
    };

    // 1) Clean page, object result: no penalty, keeps Codex category.
    let r = await fakeJudge({ baseRaw: { score: 88, category: "excellent", reasoning: "flat + bold" }, viols: [] });
    log(r.score === 88 && r.category === "excellent" && r.violations.length === 0, "clean object result", JSON.stringify(r));

    // 2) Two violations: -40, category re-derived from FINAL score.
    r = await fakeJudge({ baseRaw: { score: 90, category: "excellent" }, viols: ["banned buzzword: revolutionary", "accent not on CTA"] });
    log(r.score === 90 - 2 * PENALTY_PER && r.category === categoryFor(r.score) && r.category !== "excellent",
      "two violations penalize + re-categorize", JSON.stringify(r));

    // 3) Clamp at 0: huge penalty can't go negative.
    r = await fakeJudge({ baseRaw: { score: 30 }, viols: ["a", "b", "c"] });
    log(r.score === 0 && r.category === "weak", "penalty clamps to 0", JSON.stringify(r));

    // 4) String/JSON result is tolerated.
    r = await fakeJudge({ baseRaw: '{"score": 75, "reasoning": "strong"}', viols: [] });
    log(r.score === 75 && r.base === 75, "JSON-string result parsed", JSON.stringify(r));

    // 5) Prose result with an embedded number is scraped.
    r = await fakeJudge({ baseRaw: "Overall I'd give this an 82/100 — bold and on brand.", viols: [] });
    log(r.score === 82, "prose result scraped", JSON.stringify(r));

    // 6) coerceScore edge cases.
    log(coerceScore(120) === 100 && coerceScore(-5) === 0 && coerceScore("87") === 87 && coerceScore("n/a") === null,
      "coerceScore clamps + parses");

    // 7) categoryFor thresholds.
    log(categoryFor(85) === "excellent" && categoryFor(70) === "strong" && categoryFor(55) === "decent" && categoryFor(54) === "weak",
      "categoryFor thresholds");

    console.log(ok ? "judge.mjs smoke: ALL PASS" : "judge.mjs smoke: FAILURES");
    process.exit(ok ? 0 : 1);
  })().catch((err) => {
    console.error("judge.mjs smoke FAILED:", err.message);
    process.exit(1);
  });
}
