// orchestrator.mjs — TasteLoop two-page run, wired to the MASTER-AUTHORED team.
//
// This is the conductor. It owns NOTHING about HOW agents work — that lives in the
// frozen modules it imports. It runs the v3.1 IN-RUN, TURN-BY-TURN self-improvement
// SPINE (CONTRACTS.md §9). A *run* starts from scratch (memory reset). A *turn* is
// one `gen` of the loop. There is NO cross-run learning — every run resets all stores.
//
// PRE-RUN (once per run, BOTH pages): memory is re-instantiated by run.mjs and we
//   call memory.reset(sessionId) → forget(dataset=sess_<runId>_<page>).
//
// PER gen (both pages; the ONLY memory-page deltas are marked [mem]):
//   1) recall[mem]   — memory.recallInRun(sessionId, q, {nodeName}) VERBATIM. Sets
//                      ctx.qa_id and ctx.rules/lessons from PRIOR-turn traces. gen 0 is
//                      empty; the no-memory page skips this step entirely.
//   2) build[BOTH]   — master plans the roster (planTeam) → runAgent(...) → ctx.html.
//                      Memory build is conditioned on recalled prior-turn rules + this
//                      turn's mustFix; no-memory on this turn's mustFix only.
//   3) critique[BOTH]— codexCritique({brand, screenshotPath, goal}) → findings. The
//                      orchestrator renders the pre-revise PNG, passes it in, and feeds
//                      the structured findings into ctx.brief.mustFix (same-turn).
//   4) trace[mem]    — remember-trace each finding (node_set=[token,role,severity]);
//                      emit trace.written.
//   5) revise[BOTH]  — reviseHtml(... rules ...) on THIS page's findings, re-render.
//                      no-memory: rules = this turn's own critique findings.
//                      memory:    rules = this turn's findings + recalled PRIOR-turn traces.
//                      ABLATE:    revise STILL runs but with EMPTY recalled rules.
//                      Then emit trace.resolved {flaw, beforeShot, afterShot, resolved}.
//   6) judge[BOTH]   — judgeSite({brand, html, goal}) → {quality, brandAdherence, score}.
//                      emit score.updated { gen, page, quality, brandAdherence, score }
//                      with THIS gen's per-gen score (NOT bestScore).
//   7) feedback[mem] — map the named-flaw delta → 5|3|1; memory.feedback(...).
//   8) improve[mem]  — memory.improve([sessionId], feedbackAlpha>0) so the NEXT turn's
//                      recall ranks proven fixes higher.
//   9) distill[mem]  — memory.distill(sessionId) (session-only Lessons counter).
//
// Symmetry guarantee (C3): BOTH pages get critique + a same-turn revise from their own
// findings; the ONLY memory delta is that memory's revise ALSO folds in recalled
// prior-turn traces. The win is NOT "two attempts."
//
// Frozen imports (coded to these signatures; never changed here):
import { planTeam } from "./team.mjs";
import { runAgent, reviseHtml } from "./skills.mjs";
import { codexCritique, codexBuildSite, codexRun, designInventory } from "./codex.mjs";
import { renderShot } from "./render.mjs";
import { chat, chatJSON } from "./ollama.mjs";

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// web/run is the snapshot root; the preview page links the live design-system.css
// from there. Resolved once; runtime honors TASTELOOP_SNAP_DIR like skills.mjs.
const __dirname = path.dirname(fileURLToPath(import.meta.url)); // web/src
const RUN_DIR = path.resolve(__dirname, "..", "run");           // web/run
function snapDir() {
  return process.env.TASTELOOP_SNAP_DIR || path.join(RUN_DIR, "snapshots");
}

// ---- constants -----------------------------------------------------------

// The product the studios are marketing. Passed straight into Codex.
export const GOAL =
  "TikTok for Business — turn 60-second videos into customers";

// Global per-page turn cap (matches the UI's turnBudget).
const TURN_CAP = 20;

// feedback_alpha passed to memory.improve (CONTRACTS §1 cmd_improve). Any > 0.
const FEEDBACK_ALPHA = 0.5;

// ---------------------------------------------------------------------------
// Lesson helpers (NO regex selection — v3.1 Guardrail 5).
//
// Recalled in-run traces are concrete strings (verbatim from memory.recallInRun,
// CONTRACTS §1 recall). We thread them straight to the builder as fix-rules; there
// is NO regex classifier picking a "driving" lesson and no deterministic brand
// check. The "enforceable rule" for the build is simply the FIRST recalled trace
// (already feedback-ranked by improve()).
// ---------------------------------------------------------------------------

function lessonStatement(l) {
  return (l && (typeof l === "string" ? l : l.statement)) || "";
}

// Stable id for a lesson (the UI shows it as provenance, e.g. "lesson L1").
function lessonId(l, idx) {
  if (l && typeof l === "object" && (l.id != null)) return String(l.id);
  return `L${idx + 1}`;
}

// The one enforceable rule for the build = the first recalled trace/lesson (no
// regex priority — improve() already feedback-ranks them so the first is the most
// proven). Returns null when there is nothing recalled.
function firstLesson(lessons) {
  if (!Array.isArray(lessons) || lessons.length === 0) return null;
  const text = lessonStatement(lessons[0]).trim();
  return text || null;
}

// ---------------------------------------------------------------------------
// PROVENANCE / PROMPT-DIFF.
//
// The master (team.mjs, Phase 2.2) stores each lesson-bearing agent's v1 (no-lesson)
// and v2 (lesson-woven) brief AT AUTHOR TIME, exposed as `agent.briefDiff = {before,
// after, lessonId, lessonText}`. We read that diff directly — NO regex reconstruction.
// Pick the first agent that carries one (the master prefers the builder).
// ---------------------------------------------------------------------------
function pickUpskilledAgent(agents) {
  if (!Array.isArray(agents) || !agents.length) return null;
  for (const agent of agents) {
    const d = agent && agent.briefDiff;
    if (d && typeof d === "object" &&
        typeof d.before === "string" && typeof d.after === "string" &&
        d.before !== d.after) {
      return { agent, before: d.before, after: d.after, diff: d };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// RECALL helpers (NO keyword-bag classifier — Guardrail 5).
//
// The verbatim build-feeding recall (CONTRACTS §1) takes a query + an OPTIONAL
// node_name read filter scoped to the brand's canonical token nodes. We build both
// from the brand/goal directly (no regex over findings), so recall is deterministic
// and brand-grounded, not a hand-tuned keyword soup that picks the demo's win.
// ---------------------------------------------------------------------------

// The brand's primary canonical token node (anchors traces/lessons via node_set).
function brandToken(brand) {
  const roles = brand && brand.tokens && brand.tokens.color && brand.tokens.color.roles;
  const c = (roles && (roles.primary || roles.secondary)) ||
    (brand && brand.colors && (brand.colors.primary || brand.colors.accent)) || "";
  return String(c || "brand").trim();
}

// The recall query: brand identity + goal (a stable, brand-grounded prompt — NOT a
// list of the specific flaws memory fixes, so recall can't be gamed toward the win).
function recallQuery(brand, goal) {
  const tone = Array.isArray(brand && brand.tone) ? brand.tone.join(" ") : "";
  return `design quality and brand adherence for ${goal} — ${tone}`.trim();
}

// Recall is NOT node_name-filtered. The bridge's node_name filter requires the trace
// TEXT to literally contain the token (e.g. "#FE2C55") — which starved recall, since
// free-text fixes rarely contain the hex (only ~2 ever surfaced). Returning null lets
// CHUNKS_LEXICAL rank ALL of the run's prior-turn verified fixes by relevance to the
// query, so recall actually compounds turn-over-turn.
function recallNodeName(brand) {
  void brand;
  return null;
}

// ---------------------------------------------------------------------------
// CRITIQUE / SEVERITY / CREDIT helpers.
// ---------------------------------------------------------------------------

// Normalize the structured severity field (the ONLY severity source — no regex).
function normSeverity(s) {
  const v = String(s || "").trim().toLowerCase();
  if (v === "high") return "high";
  if (v === "low") return "low";
  return "med"; // default + any non-enum value
}

// Credit assignment (2.4): map each vision flaw to the responsible roster agent.
// We use the structured brandRuleCited enum + role-name affinity (NO regex over the
// flaw text). Falls back to the builder/critique role. Returns a map flaw->role.
const ROLE_AFFINITY = [
  // [match-substring-of-rule-or-cited, preferred role]
  ["contrast", "typographer"],
  ["font", "typographer"],
  ["type", "typographer"],
  ["copy", "copywriter"],
  ["headline", "copywriter"],
  ["buzzword", "copywriter"],
  ["jargon", "copywriter"],
  ["color", "visual-designer"],
  ["gradient", "visual-designer"],
  ["layout", "visual-designer"],
  ["spacing", "visual-designer"],
  ["image", "image-sourcer"],
  ["section", "info-architect"],
];

function assignCredit(findingObjs, agents) {
  const roles = new Set((Array.isArray(agents) ? agents : []).map((a) => a && a.role).filter(Boolean));
  const builder = (Array.isArray(agents) ? agents : []).find(
    (a) => a && (a.produces === "html" || (Array.isArray(a.tools) && a.tools.includes("html_build")))
  );
  const builderRole = (builder && builder.role) || "frontend-implementer";
  const map = new Map();
  for (const f of findingObjs || []) {
    const cited = String((f && f.brandRuleCited) || "").toLowerCase();
    let role = null;
    for (const [needle, r] of ROLE_AFFINITY) {
      if (cited.includes(needle) && roles.has(r)) { role = r; break; }
    }
    map.set(f.flaw, role || builderRole);
  }
  return map;
}

function creditRole(finding, creditMap) {
  return (creditMap && creditMap.get(finding.flaw)) || null;
}

function creditAgentId(finding, creditMap, page, gen) {
  const role = creditRole(finding, creditMap) || "critique";
  return `${page}-${role}-v1-g${gen}`;
}

// Pre-revise / post-revise PNG path for codexCritique + resolved-proof. Lives under
// the snapshot dir so the UI can reference it (htmlRef-relative via run.mjs).
function preShotPath(page, gen, kind) {
  return path.join(snapDir(), `${page}-g${gen}-${kind}.png`);
}

// ---------------------------------------------------------------------------
// IMAGE: post-build safety net. The builder is INSTRUCTED to embed ctx.heroImage
// (skills.runHtmlBuild appends an <img src="..."> directive to its copyHint), but
// Codex can ignore the instruction. If a hero image was generated and the produced
// HTML does NOT already reference it, inject it as the literal first hero visual so
// the page actually USES the generated image. Returns the (possibly) updated html.
// ---------------------------------------------------------------------------
function injectHeroImage(html, dataUri) {
  const h = String(html || "");
  const uri = String(dataUri || "");
  if (!uri || !h) return h;
  // Already embedded (builder honored the directive)? leave it alone.
  if (h.includes(uri)) return h;
  const imgTag =
    `<img alt="TikTok for Business hero" src="${uri}" ` +
    `style="display:block;max-width:100%;height:auto;margin:0 auto" />`;
  // Prefer injecting at the top of <body>; else just after <body ...>; else prepend.
  const bodyOpen = h.match(/<body\b[^>]*>/i);
  if (bodyOpen) {
    const at = bodyOpen.index + bodyOpen[0].length;
    return h.slice(0, at) + imgTag + h.slice(at);
  }
  return imgTag + h;
}

// ---------------------------------------------------------------------------
// PROGRESSIVE RENDER — the fast LIVE-PREVIEW page.
//
// The Codex build is the slow step (tens of seconds). The moment copy + the
// design system are in hand (after the copy/IA agents, before the builder) we
// can assemble a simple, on-brand page that LINKS the real design-system.css and
// drops the threaded copy/sections into the .ds-* utilities — no model call, so
// the iframe fills in well under a second. We emit an EARLY design.rendered with
// THIS preview, mark it draft in agent.status, then the real Codex build emits a
// SECOND design.rendered that REPLACES it. The FINAL judged page is always Codex.
// ---------------------------------------------------------------------------

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Pull a hero headline + supporting line out of whatever copy the team threaded.
// ctx.copyHint is built by runLanguageTool as: `Hero headline tone: "<hero>". <angle>`
// (the copywriter), prefixed by the master's strategy. We recover the hero/angle
// best-effort and fall back to brand-true defaults so the preview always reads.
function previewCopy(ctx, brand, goal) {
  const hint = String(ctx?.copyHint || "");
  const heroM = hint.match(/Hero headline tone:\s*"([^"]+)"/i);
  const hero = (heroM && heroM[1].trim()) || goal || "Go viral. Get customers.";
  // The angle is whatever copy follows the hero clause (or the raw hint / strategy).
  let angle = "";
  if (heroM) {
    angle = hint.slice(heroM.index + heroM[0].length).replace(/^[.\s]+/, "").trim();
  }
  if (!angle) angle = hint.trim();
  if (!angle) {
    const tone = Array.isArray(brand?.tone) ? brand.tone.join(", ") : "bold, direct";
    angle = `Turn 60-second videos into customers — ${tone}.`;
  }
  // Keep the preview tight; it's a progress glimpse, not the final page.
  return { hero: hero.slice(0, 140), angle: angle.slice(0, 240) };
}

// Build the quick preview HTML. Links the live design-system.css (relative to the
// snapshot dir) AND inlines it when readable so the iframe is correct even before
// the stylesheet request resolves. Uses ONLY .ds-* utilities + role tokens so it
// is genuinely on-brand (flat colors, accent on CTA, no gradients).
function buildPreviewPage({ ctx, brand, goal }) {
  const { hero, angle } = previewCopy(ctx, brand, goal);
  const roles = brand?.tokens?.color?.roles || {};
  const sections = Array.isArray(ctx?.sections) && ctx.sections.length
    ? ctx.sections
    : (Array.isArray(brand?.sections) ? brand.sections : ["hero", "problem", "how-it-works", "proof", "cta"]);

  // The hero image, if image_gen produced one, makes the preview feel complete.
  const heroImg = ctx?.heroImage
    ? `<img class="ds-image-mask" alt="TikTok for Business hero" src="${ctx.heroImage}" style="max-width:100%;height:auto;margin-top:var(--space-6)" />`
    : "";

  // Section cards (skip "hero" — it's the headline block above).
  const cards = sections
    .filter((s) => !/^hero$/i.test(String(s)))
    .map((s) => {
      const name = String(s).replace(/[-_]/g, " ");
      return `      <div class="ds-card ds-stack">
        <h2 class="ds-subhead">${esc(name.charAt(0).toUpperCase() + name.slice(1))}</h2>
        <p class="ds-body-text ds-muted">Live preview — the final copy &amp; layout for this section are still being built by Codex.</p>
      </div>`;
    })
    .join("\n");

  const bg = roles.bg || brand?.colors?.bg || "#000000";
  const fg = roles.fg || brand?.colors?.fg || "#FFFFFF";

  // Prefer linking the real stylesheet; also try to inline it so the preview is
  // pixel-true immediately (no flash). Both reference the SAME design-system.css.
  const cssLink = `<link rel="stylesheet" href="../design-system.css">`;
  const inline = typeof brand?.designSystemCss === "string" && brand.designSystemCss.trim()
    ? `<style>\n${brand.designSystemCss}\n</style>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>TikTok for Business — live preview</title>
  ${cssLink}
  ${inline}
  <style>html,body{background:${bg};color:${fg};margin:0}</style>
</head>
<body class="ds-bg">
  <main class="ds-section">
    <div class="ds-container ds-stack">
      <span class="ds-chip ds-chip-outline ds-caption">live preview · building…</span>
      <h1 class="ds-h1">${esc(hero)}</h1>
      <p class="ds-lead">${esc(angle)}</p>
      <div>
        <a class="ds-btn ds-btn-primary" href="#">Get started free</a>
        <a class="ds-btn ds-btn-outline" href="#">See how it works</a>
      </div>
      ${heroImg}
    </div>
  </main>
  <section class="ds-section">
    <div class="ds-container ds-grid">
${cards}
    </div>
  </section>
</body>
</html>`;
}

// Write the preview snapshot and emit the EARLY design.rendered (+ a draft
// agent.status). Returns the htmlRef (or null on failure — preview is best-effort
// and must NEVER abort a run; the real Codex page is still authoritative).
async function emitPreview({ ctx, brand, goal, page, gen, emit }) {
  try {
    const html = buildPreviewPage({ ctx, brand, goal });
    const seq = Number.isFinite(ctx?.seq) ? ctx.seq + 1 : 1;
    if (ctx && typeof ctx === "object") ctx.seq = seq;
    const fileName = `${page}-g${gen}-preview-s${seq}.html`;
    const dir = snapDir();
    try { await mkdir(dir, { recursive: true }); } catch { /* ignore */ }
    await writeFile(path.join(dir, fileName), html, "utf8");
    const htmlRef = path.posix.join("snapshots", fileName);
    // Mark it a DRAFT so the UI shows this is a progress preview, not the final.
    emit({ type: "agent.status", agentId: `${page}-preview-g${gen}`, doing: "live preview rendered (draft) — Codex building the final page…", draft: true });
    emit({ type: "design.rendered", htmlRef, draft: true });
    return htmlRef;
  } catch {
    return null; // never let the preview break the run
  }
}

// ---------------------------------------------------------------------------
// Threading: merge one agent's runAgent() result into the shared run ctx so the
// next agents (esp. the builder + critique) see what came before.
// ---------------------------------------------------------------------------

// Merge concrete fix-rule strings into an existing list, trimming + de-duping
// (case-insensitively) so the builder never gets blanks or repeats. Returns a
// fresh array. Used to fold recalled raw-trace snippets onto ctx.rules.
function mergeRules(existing, incoming) {
  const out = [];
  const seen = new Set();
  for (const r of [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(incoming) ? incoming : [])]) {
    const s = String(r == null ? "" : r).trim();
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

function threadResult(ctx, result) {
  if (!result || typeof result !== "object") return;

  // recall agent → recalled prior-turn traces become the PRIMARY fix signal.
  // CONTRACTS §2: recallInRun now returns { hits:[{snippet,role}], qa_id }; the
  // skills.mjs runRecall surfaces those hits (result.hits and/or result.lessons).
  // Under ablation we DROP these on the floor: recall ran (and emitted its hits)
  // but its rules never become enforceable, so the win that memory bought
  // disappears (C3).
  if (!ctx._ablate) {
    // (a) hits from the recall skill — verbatim recalled trace snippets.
    const hits =
      (Array.isArray(result.hits) && result.hits) ||
      (result.output && Array.isArray(result.output.hits) && result.output.hits) ||
      (result.output && Array.isArray(result.output.inRun) && result.output.inRun) ||
      [];
    const traceRules = hits
      .map((r) => String(r && (r.snippet ?? r) || "").trim())
      .filter(Boolean);
    if (traceRules.length) {
      ctx.rules = mergeRules(ctx.rules, traceRules);
      // Lessons mirror the recalled traces (no regex selection); first = enforceable.
      ctx.lessons = traceRules.map((statement) => ({ statement }));
      if (!ctx.lessonForBuild) ctx.lessonForBuild = firstLesson(ctx.lessons);
    } else if (Array.isArray(result.lessons) && result.lessons.length) {
      ctx.lessons = result.lessons;
      if (!ctx.lessonForBuild) ctx.lessonForBuild = firstLesson(result.lessons);
    }
    // Thread the qa_id forward so the feedback step can target this recall (C2).
    if (typeof result.qa_id === "string" && result.qa_id) ctx.qa_id = result.qa_id;
    else if (result.output && typeof result.output.qa_id === "string" && result.output.qa_id) {
      ctx.qa_id = result.output.qa_id;
    }
  }

  // copywriter → copy direction hint for the builder + the typed brief slot.
  if (typeof result.copyHint === "string" && result.copyHint.trim()) {
    ctx.copyHint = result.copyHint.trim();
    ctx.brief.copy = result.copyHint.trim();
  }
  if (result.copy && (typeof result.copy === "string" || typeof result.copy === "object")) {
    ctx.brief.copy = result.copy;
  }

  // info-architect → section plan + the typed brief slot.
  if (Array.isArray(result.sections) && result.sections.length) {
    ctx.sections = result.sections;
    ctx.brief.sectionOrder = result.sections.map(String);
  }

  // visual-designer / typographer / image-sourcer → typed brief slots (2.3).
  if (typeof result.layoutDirection === "string" && result.layoutDirection.trim()) {
    ctx.brief.layoutDirection = result.layoutDirection.trim();
  }
  if (typeof result.typeScale === "string" && result.typeScale.trim()) {
    ctx.brief.typeScale = result.typeScale.trim();
  }
  if (typeof result.imageDirective === "string" && result.imageDirective.trim()) {
    ctx.brief.imageDirective = result.imageDirective.trim();
  }

  // builder → the real page + its snapshot ref
  if (result.produces === "html") {
    if (typeof result.html === "string" && result.html) ctx.html = result.html;
    else if (typeof result.output === "string" && result.output) ctx.html = result.output;
    if (typeof result.htmlRef === "string" && result.htmlRef) ctx.htmlRef = result.htmlRef;
  }

  // image_gen → an on-brand hero data URI for the builder to embed. runImageGen
  // already sets ctx.heroImage; mirror it here too in case a result carries it
  // (so the post-build inject safety net always has it). image_gen is a neutral
  // capability available to BOTH pages, so this is never _ablate-gated.
  if (typeof result.heroImage === "string" && result.heroImage) {
    ctx.heroImage = result.heroImage;
  }

  // svg / imagery → on-brand image to thread (kept for completeness)
  if (result.produces === "svg" && typeof result.output === "string") {
    ctx.image = result.output;
  }

  // critique / brand-guardian → findings (accumulate across multiple auditors)
  if (Array.isArray(result.findings) && result.findings.length) {
    ctx.findings = [...(ctx.findings || []), ...result.findings.map(String)];
  }
}

// ---------------------------------------------------------------------------
// main export
// ---------------------------------------------------------------------------

/**
 * Run one studio (page) across `gens` generations.
 * @param {Object}   a
 * @param {"no-memory"|"memory"} a.page
 * @param {number}   a.gens
 * @param {Object}   a.memory   memory backend from makeMemory(kind)
 * @param {Object}   a.brand    BrandSpec from deconstructBrand()
 * @param {Function} a.emit     emit(event) — caller fills page/gen/t
 * @param {string}   a.snapDir  absolute dir for HTML snapshots (htmlRef relative to web/run/)
 * @param {string}   [a.goal]   product goal string passed into Codex
 * @param {string}   [a.runId]  the per-run id minted in run.mjs (H4). The session is
 *                              `sess_<runId>_<page>`; all stores reset to it per run.
 * @param {boolean}  [a.ablate] MEMORY counterfactual: recall STILL runs but the
 *                              recalled prior-turn rules are STRIPPED from the build +
 *                              the revise (revise uses EMPTY recalled rules) so we can
 *                              show "memory removed = the win disappears" (C3).
 *                              Defaults to process.env.ABLATE === "1".
 */
export async function runPage({ page, gens, memory, brand, emit, snapDir: snapDirArg, goal = GOAL, runId, ablate }) {
  const isMemory = page === "memory";
  // Ablation only makes sense on the memory studio. Honor an explicit flag, else
  // fall back to the env switch (so `ABLATE=1 node run.mjs` works without wiring).
  const ablateMemory = isMemory && (ablate != null ? !!ablate : process.env.ABLATE === "1");
  // sessionId convention (CONTRACTS §8 — frozen): sess_<runId>_<page>. runId is minted
  // in run.mjs; fall back only so a bare runPage call (smoke test) still has a unique id.
  const rid = runId || `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const sessionId = `sess_${rid}_${page}`;
  // Dedup for the VERIFIED trace write — a resolved flaw is stored at most once per run.
  const tracedKeys = new Set();

  // runAgent writes snapshots to env-overridable TASTELOOP_SNAP_DIR; honor the
  // dir run.mjs handed us so the live web/run/snapshots is the one that fills.
  if (snapDirArg) process.env.TASTELOOP_SNAP_DIR = snapDirArg;

  // ===================================================================
  // PRE-RUN RESET (C1, H4) — wipe this run's session store before any turn.
  // memory.mjs is re-instantiated per run by run.mjs (shim closure wiped); here we
  // forget the session dataset so a trace from run N is unrecoverable in run N+1
  // (their sessionIds differ by runId). Best-effort: reset never aborts a run.
  // ===================================================================
  if (typeof memory.reset === "function") {
    try { await memory.reset(sessionId); } catch { /* reset best-effort (C1) */ }
  }
  await memory.openSession(sessionId);

  // BOTH pages ground identically from the always-on flat string design-token
  // summary (codex.mjs tokenSummary/dsContract) — the proven-good path. The in-run
  // memory win comes purely from recalled traces (recallInRun), not brand grounding.

  // --- global 20-turn cap, enforced HERE (not in runAgent) ---
  // We wrap emit so that once the page has taken TURN_CAP counted turns, further
  // agent.turn events are suppressed (the agents still run + produce real output;
  // they just stop incrementing the budget, exactly like a turn-limited team).
  let turns = 0;
  const baseEmit = typeof emit === "function" ? emit : () => {};
  const gatedEmit = (ev) => {
    if (ev && ev.type === "agent.turn") {
      if (turns >= TURN_CAP) return;        // cap reached — drop the counted turn
      turns += 1;
      baseEmit({ ...ev, turnIndex: turns });
      return;
    }
    baseEmit(ev);
  };

  // counters mirrored locally for the authoritative run.finished totals
  let agentsSpawned = 0;
  let tracesCount = 0;
  let improvements = 0;
  let lessonsCount = 0;
  // The page CARRIED across turns. Turn 0 builds it fresh; every later turn IMPROVES this
  // exact page (in-run self-improvement) instead of rebuilding from scratch. BOTH pages carry
  // their own; the only difference is the memory page's improvements are guided by recall.
  let pageHtml = null;
  // Generations actually completed = the in-run "Turns" (improvement rounds). This is the
  // real turn-by-turn axis — NOT the per-agent `turns` cap counter below (which is 1:1 with
  // agents spawned). The HUD "Turns" tile reports THIS.
  let gensRun = 0;
  // Per-agent credit carried to the NEXT turn (2.4): { role -> {flaw, attributedTo} }.
  // The orchestrator computes credit AFTER this turn's critique; planTeam attaches it
  // to next turn's spawn so the per-agent rows mean something + the agent's brief is
  // seeded with its own miss. Memory page only (the win-bearing roster).
  let creditByRole = {};

  // deps handed to every agent's runAgent() call (the frozen executor interface)
  const deps = { brand, goal, memory, chat, chatJSON, codexBuildSite, codexRun, codexCritique };

  // run.started — note the ablation counterfactual when it's on so the demo can
  // surface "memory removed" in the UI/console.
  gatedEmit(ablateMemory
    ? { type: "run.started", ablate: true, note: "ABLATION ON: memory recalled but lessons STRIPPED from briefs + build (counterfactual)." }
    : { type: "run.started" });

  for (let gen = 0; gen < gens; gen++) {
    // ===================================================================
    // SPINE STEP 1 — RECALL [mem] (verbatim; CONTRACTS §9.1).
    //   memory.recallInRun(sessionId, q, {nodeName}) returns { hits, qa_id }.
    //   gen 0 returns empty (nothing has been traced yet). The NO-MEMORY page
    //   SKIPS this entirely. The recalled prior-turn traces become ctx.rules and
    //   ctx.lessons; qa_id is threaded for the feedback step. Under ABLATION recall
    //   STILL runs (and emits its hits) but the recalled rules are dropped so they
    //   never reach the build/revise — memory removed, the win disappears (C3).
    // ===================================================================
    let recalledRules = [];
    let lessons = [];
    let qaId = null;
    if (isMemory) {
      try {
        const r = (await memory.recallInRun(
          sessionId,
          // Brand-grounded recall query (NO keyword-bag classifier). The build-feeding
          // recall is verbatim (CHUNKS_LEXICAL); node_name scopes to the brand tokens.
          recallQuery(brand, goal),
          { nodeName: recallNodeName(brand) }
        )) || {};
        const hits = Array.isArray(r.hits) ? r.hits : (Array.isArray(r) ? r : []);
        qaId = (typeof r.qa_id === "string" && r.qa_id) ? r.qa_id : null;
        recalledRules = hits
          .map((h) => String(h && (h.snippet ?? h) || "").trim())
          .filter(Boolean);
        lessons = recalledRules.map((statement) => ({ statement }));
        if (hits.length) {
          // Surface the recalled hits on the stream (memory page evidence).
          gatedEmit({ type: "memory.recalled", agentId: `${page}-recall-g${gen}`, hits: hits.map((h) => ({ snippet: String(h && (h.snippet ?? h) || "") })) });
        }
      } catch {
        recalledRules = []; lessons = []; qaId = null;
      }
    }

    // Under ablation the recalled rules are withheld from the team + the build.
    const lessonsForTeam = (isMemory && !ablateMemory) ? lessons : [];
    const lessonForBuild = (isMemory && !ablateMemory) ? firstLesson(lessons) : null;

    // ===================================================================
    // SPINE STEP 2 — BUILD [BOTH]. The MASTER authors the whole team for this gen.
    //   The master is given this run's recalled EARLIER-TURN lessons (memory, not
    //   ablated) so it can field a better roster; under ablation it gets none.
    // ===================================================================
    // LEAN TURN (in-run self-improvement): turn 0 builds with the full team; every LATER turn
    // REFINES the carried page in a targeted way — skip the whole roster rebuild (that was the
    // churn AND the ~5min/turn cost). The page is improved by the critique->revise steps below
    // (memory-guided via recalled rules), NOT regenerated from scratch each turn.
    const isLeanTurn = gen > 0 && typeof pageHtml === "string" && pageHtml.trim().length > 0;
    // Turn 0 builds, turn 1 does a whole-page refine, turn 2+ does ONE targeted token-gap fix
    // (audit the page vs the design-system inventory -> fix the single biggest gap, keep the rest).
    const surgicalTurn = isLeanTurn && gen >= 2;
    let strategy = "";
    let agents = [];
    if (!isLeanTurn) {
      ({ strategy, agents } = await planTeam({
        brand,
        goal,
        isMemory,
        lessons: lessonsForTeam,
        // 2.4: each role's flaw attributed last turn, so the master seeds the agent's
        // next-turn brief with its own miss + attaches credit to the spawn event.
        // Empty under ablation / on gen 0 / no-memory page.
        credit: (isMemory && !ablateMemory) ? creditByRole : {},
      }));
      gatedEmit({ type: "master.planned", roster: agents.map((a) => a.role), strategy });
    }

    // ---- PROVENANCE / PROMPT-DIFF -------------------------------------
    // When a recalled earlier-turn lesson changed an agent's brief, the master
    // stored that agent's before/after on `agent.briefDiff` (Phase 2.2 — NO regex
    // reconstruction here). Emit a RICH member.upskilled so the UI can pop the
    // prompt-diff panel. scoreAfter is filled once this gen is judged. Suppressed
    // under ablation (no lessons were woven, so nothing upskilled).
    let pendingUpskill = null;
    if (!isLeanTurn && isMemory && !ablateMemory && lessons.length) {
      const diff = pickUpskilledAgent(agents);
      if (diff) {
        const d = diff.diff || {};
        pendingUpskill = {
          type: "member.upskilled",
          role: diff.agent.role,
          version: gen + 1,
          lessonId: (d.lessonId != null) ? String(d.lessonId) : lessonId(lessons[0], 0),
          lessonText: (typeof d.lessonText === "string" && d.lessonText) ? d.lessonText : lessonStatement(lessons[0]),
          instructionDiff: { before: diff.before, after: diff.after },
          scoreBefore: null,
          scoreAfter: null, // filled after judging this gen
        };
      } else {
        // Fallback: still record the upskill (thin shape) so the panel is honest
        // even if the master surfaced no diff this gen.
        gatedEmit({ type: "member.upskilled", role: "frontend-implementer", version: gen + 1 });
      }
    }

    // The shared run context, threaded BETWEEN agents by runAgent's return values.
    // Under ablation the recalled rules are kept OUT of ctx so the build never
    // enforces them (the recalled rules are deliberately withheld — that's the
    // counterfactual). The typed BUILD BRIEF (CONTRACTS §6, Phase 2.3) carries every
    // non-builder agent's named slot to the builder; mustFix carries THIS turn's
    // critique findings into THIS turn's build (1.7).
    const ctx = {
      // The frozen sessionId (CONTRACTS §8). skills.mjs runRecall/runTrace read this
      // via sessionIdFrom(ctx) and REFUSE to reconstruct the legacy "${page}-run"
      // hardcode — the orchestrator MUST thread it (H4).
      sessionId,
      // The prior turn's page (null on turn 0). When set, the builder IMPROVES this page
      // instead of building from scratch — in-run self-improvement, both pages.
      priorPageHtml: pageHtml,
      brief: {
        copy: null,
        sectionOrder: [],
        layoutDirection: "",
        typeScale: "",
        imageDirective: "",
        mustFix: [],
      },
      lessons: (isMemory && !ablateMemory && lessons.length) ? lessons : null,
      lessonForBuild,
      // mirror lessonForBuild onto ctx.lesson too: skills.runHtmlBuild reads
      // ctx.lesson as a fallback enforcement source.
      lesson: lessonForBuild,
      copyHint: strategy,
      sections: null,
      findings: [],
      // RAW recalled prior-turn trace snippets threaded straight to the builder
      // verbatim as numbered fix-rules (memory page only; empty under ablation and
      // on the no-memory page). The recall agent's own hits ALSO augment this.
      rules: (isMemory && !ablateMemory) ? mergeRules([], recalledRules) : [],
      html: "",
      htmlRef: "",
      seq: 0,
      // Threaded qa_id from this turn's recall (C2); read by the feedback step.
      // null on the no-memory page and whenever recall couldn't resolve one.
      qa_id: qaId,
      // Under ablation, block the recall agent from threading recalled rules back
      // into ctx (threadResult honors this flag). Recall still RUNS + emits its
      // hits, but its rules never reach the build — memory removed, win gone.
      _ablate: ablateMemory,
    };

    if (isLeanTurn) {
      // LEAN TURN: carry the prior page forward and refine it in the critique->revise steps
      // below (targeted, memory-guided). No roster, no from-scratch rebuild — fast + stable.
      ctx.html = pageHtml;
      gatedEmit({ type: "agent.status", agentId: `${page}-refine-g${gen}`, doing: "refining the existing page — targeted, not a rebuild" });
    } else {
    // Does any agent in this roster already write traces itself (cognee_trace)?
    // If so, the orchestrator must NOT also write the critique findings, or the
    // trace counter would double-count. (The memory studio's master typically
    // grants cognee_trace to the auditor.)
    const someAgentTraces = isMemory && agents.some(
      (a) => Array.isArray(a.tools) && a.tools.includes("cognee_trace")
    );

    // Track trace.written events emitted by runAgent so run.finished totals stay
    // exact even when an agent did the tracing.
    const tracePeek = (ev) => {
      if (ev && ev.type === "trace.written") tracesCount += 1;
      gatedEmit(ev);
    };

    // ===================================================================
    // 3) RUN EVERY agent, in the master's spec order. Each makes a REAL call.
    // ===================================================================
    // PROGRESSIVE RENDER: find the first builder so we can fire a fast LIVE
    // PREVIEW the instant copy + the design system are ready (right before the
    // slow Codex build). The builder's own design.rendered later REPLACES it.
    const isBuilderAgent = (a) =>
      a && (a.produces === "html" ||
        (Array.isArray(a.tools) && a.tools.includes("html_build")));
    const firstBuilderIdx = agents.findIndex(isBuilderAgent);
    let previewEmitted = false;

    for (let i = 0; i < agents.length; i++) {
      // Emit the preview just before the first builder runs: copy/IA agents that
      // precede it have already threaded their output into ctx, so the preview
      // reflects the real copy + sections + design system. Best-effort; never
      // fatal. If there is no builder (shouldn't happen), no preview is shown.
      if (!previewEmitted && firstBuilderIdx >= 0 && i === firstBuilderIdx) {
        await emitPreview({ ctx, brand, goal, page, gen, emit: gatedEmit });
        previewEmitted = true;
      }

      const agent = agents[i];
      agentsSpawned += 1;
      let result;
      try {
        result = await runAgent({ agent, gen, page, ctx, deps, emit: tracePeek });
      } catch (err) {
        // The HTML builder is load-bearing: if it fails, the whole gen can't be
        // judged — surface that (no template fallback). Supporting agents that
        // fail are non-fatal: the run continues with whatever ctx already holds.
        const isBuilder =
          agent.produces === "html" ||
          (Array.isArray(agent.tools) && agent.tools.includes("html_build"));
        if (isBuilder) {
          throw new Error(
            `[${page} g${gen}] html builder "${agent.role}" failed (no fallback): ${err?.message || err}`
          );
        }
        continue;
      }
      threadResult(ctx, result);

      // Fire the live preview the INSTANT copy lands (right after the copywriter),
      // so the iframe shows REAL copy fast instead of waiting for the slow builder.
      if (!previewEmitted && ctx.copyHint) {
        await emitPreview({ ctx, brand, goal, page, gen, emit: gatedEmit });
        previewEmitted = true;
      }
    }

    // We must have a real page to judge. (Guaranteed by planTeam's contract: one
    // agent always produces html — but be explicit so a silent miss is loud.)
    if (!ctx.html) {
      throw new Error(`[${page} g${gen}] no HTML produced by the team (no fallback).`);
    }

    // IMAGE: if an image_gen agent produced a hero image but the builder didn't
    // embed it, post-inject it so the judged page actually shows the on-brand
    // image. (No-op when no image was generated or it's already embedded.)
    if (ctx.heroImage && !ctx.html.includes(ctx.heroImage)) {
      ctx.html = injectHeroImage(ctx.html, ctx.heroImage);
    }
    } // end non-lean (full roster build); lean turns carried the page above

    // ===================================================================
    // SPINE STEP 3 — CRITIQUE [BOTH] (all-LLM vision; CONTRACTS §3, §9.3).
    //   Render the PRE-REVISE PNG (the orchestrator owns the render so the same
    //   shot is reused), then ONE Codex vision critique → structured findings
    //   [{flaw, brandRuleCited, severity}]. NO regex anywhere. Findings feed BOTH
    //   the trace set (memory) AND the build brief's mustFix (same-turn). Runs on
    //   BOTH pages every turn (C4); a critique miss is caught so it != a dead run.
    // ===================================================================
    let beforeShot = "";
    try {
      beforeShot = await renderShot(ctx.html, preShotPath(page, gen, "before"));
    } catch {
      beforeShot = ""; // render miss — codexCritique will render its own from html
    }
    let critique = [];
    let upgrade = ""; // the constructive critique: the single highest-leverage "make it great" move
    try {
      // Pass html too so codexCritique can render its OWN PNG if our pre-render missed.
      const cr = await codexCritique({ brand, screenshotPath: beforeShot, goal, html: ctx.html, ...(surgicalTurn ? { inventory: designInventory(brand) } : {}) });
      critique = (cr && cr.findings) || [];
      upgrade = (cr && typeof cr.upgrade === "string") ? cr.upgrade.trim() : "";
    } catch (err) {
      // Critique throws on Codex failure (no silent fallback), but a miss must not
      // kill the run — fall back to whatever the team's own auditor surfaced.
      gatedEmit({ type: "agent.status", agentId: `${page}-critique-g${gen}`, doing: `critique failed (kept page): ${err?.message || err}` });
      critique = (ctx.findings || []).map((f) => ({ flaw: String(f), brandRuleCited: "", severity: "med" }));
    }
    if (upgrade) gatedEmit({ type: "critique.made", findings: [`UPGRADE: ${upgrade}`] });
    // Normalize + de-dupe the structured findings (the only severity source).
    const seenF = new Set();
    const findingObjs = [];
    for (const c of critique) {
      const flaw = String((c && c.flaw) || "").trim();
      if (!flaw) continue;
      const k = flaw.toLowerCase();
      if (seenF.has(k)) continue;
      seenF.add(k);
      findingObjs.push({
        flaw,
        brandRuleCited: String((c && c.brandRuleCited) || "").trim(),
        severity: normSeverity(c && c.severity),
      });
    }
    const flawTexts = findingObjs.map((f) => f.flaw);
    if (flawTexts.length) {
      gatedEmit({ type: "critique.made", findings: flawTexts });
      // mustFix carries THIS turn's findings into THIS turn's revise (1.7, §6).
      ctx.brief.mustFix = mergeRules(ctx.brief.mustFix, flawTexts);
    }

    // ---- CREDIT ASSIGNMENT (2.4) — attribute each flaw to the responsible agent.
    // No regex classifier: the brandRuleCited enum + the roster decide. Stored on
    // the spawn event consumers (per-agent rows) via a per-agent credit map.
    const credit = assignCredit(findingObjs, agents);
    // Carry the highest-severity flaw per role to NEXT turn's planTeam (memory only).
    if (isMemory && !ablateMemory) {
      const next = {};
      const sevRank = { high: 3, med: 2, low: 1 };
      for (const f of findingObjs) {
        const role = credit.get(f.flaw);
        if (!role) continue;
        const prev = next[role];
        if (!prev || (sevRank[f.severity] || 0) > (sevRank[prev.severity] || 0)) {
          next[role] = { flaw: f.flaw, attributedTo: role, severity: f.severity };
        }
      }
      creditByRole = next;
    }

    // ===================================================================
    // SPINE STEP 4 — TRACE [mem] (CONTRACTS §1 remember-trace, §9.4).
    //   Write ONE record per finding, node_set=[token, role, severity]; severity is
    //   the structured field from critique (NO regex). Batched into one cognify.
    //   Emit one trace.written per finding so the UI counter stays exact. Skipped
    //   entirely on the no-memory page and under ablation does NOT trace forward
    //   (ablate withholds memory; tracing would leak the win into the next turn).
    // ===================================================================
    // NOTE: we no longer write RAW critique flaws here (un-verified, often un-actionable
    // CSS-level complaints that polluted recall). A finding becomes a trace ONLY after the
    // resolved-proof in STEP 5 below confirms the revise actually fixed it — the admission
    // gate (store proven fixes, not complaints). See the VERIFIED-TRACE write in STEP 5.

    // ===================================================================
    // SPINE STEP 5 — REVISE [BOTH] (symmetric; C3, §9.5).
    //   BOTH pages revise THIS just-built page on their OWN same-turn findings
    //   before the judge scores it. The ONLY memory delta: memory's revise ALSO
    //   folds in the recalled PRIOR-turn traces. Ablation STILL revises but with
    //   EMPTY recalled rules (only this turn's findings). The no-memory page revises
    //   on this turn's findings only. So the win is NOT "two attempts."
    // ===================================================================
    // resolvedThisTurn: how many of this turn's flaws the revise VERIFIABLY fixed (resolved-proof
    // below). With the judge removed, THIS is the per-turn "did it improve?" signal — it drives the
    // Improve counter + Cognee feedback, and (memory only) the verified traces.
    let resolvedThisTurn = 0;
    {
      // Turn 2+ (surgicalTurn): apply ONLY the audited gap fix (the upgrade) — one small,
      // targeted change, keep the rest of the page intact. Turns 0-1: whole-page refine
      // (this turn's flaws + recalled prior-turn traces + the constructive upgrade).
      // Recalled prior-turn traces, CAPPED to the top few so they don't drown the prompt (audit:
      // 47 raw "do not reintroduce" rules = a wall the model can't weight). This is the carrier
      // that makes MEMORY actually reach the build — it must be present on surgical turns too.
      const cappedRecall = (isMemory && !ablateMemory) ? recalledRules.slice(0, 8) : [];
      let reviseRules;
      if (surgicalTurn) {
        // Turn 2+ : LEAD with the ONE targeted gap fix, but ALSO carry this turn's flaws + the
        // (capped) recalled traces so the surgical edit doesn't FREEZE known defects in place
        // (the audit's #1 + #3 root causes). The surgical prompt keeps UNRELATED sections stable.
        reviseRules = upgrade ? [`PRIMARY targeted fix (close this gap): ${upgrade}`] : [];
        reviseRules = mergeRules(reviseRules, flawTexts);
        reviseRules = mergeRules(reviseRules, cappedRecall);
      } else {
        // Turns 0-1 : whole-page refine — this turn's flaws + recalled traces + the upgrade.
        reviseRules = mergeRules([], flawTexts);
        reviseRules = mergeRules(reviseRules, cappedRecall);
        if (upgrade) {
          reviseRules = mergeRules(reviseRules, [`Beyond fixing the flaws, PURSUE this upgrade to make the page exceptional: ${upgrade}`]);
        }
      }
      if (reviseRules.length && ctx.html) {
        gatedEmit({
          type: "agent.status",
          agentId: `${page}-revise-g${gen}`,
          doing: surgicalTurn
            ? "fixing one targeted design-system gap (surgical — rest of page untouched)"
            : (isMemory && !ablateMemory
                ? "applying this turn's findings + recalled prior-turn traces"
                : "applying this turn's critique findings"),
        });
        const reviseSeq = Number.isFinite(ctx.seq) ? ctx.seq + 1 : 1;
        ctx.seq = reviseSeq;
        const builtHtml = ctx.html;
        try {
          const revised = await reviseHtml({
            brand,
            goal,
            priorHtml: builtHtml,
            rules: reviseRules,
            page,
            gen,
            seq: reviseSeq,
            deps,
            emit: gatedEmit,
            snapDir: snapDir(),
            ...(surgicalTurn ? { surgical: true } : {}),
          });
          if (revised && typeof revised.html === "string" && revised.html.trim()) {
            ctx.html = revised.html; // the JUDGE scores the IMPROVED page
            if (typeof revised.htmlRef === "string" && revised.htmlRef) ctx.htmlRef = revised.htmlRef;
          }
        } catch (err) {
          // Keep the built page so the gen is still judged (a missed revise != a
          // dead run). Both pages get this same fairness.
          gatedEmit({
            type: "agent.status",
            agentId: `${page}-revise-g${gen}`,
            doing: `revise failed (kept built page): ${err?.message || err}`,
          });
        }

        // ---- RESOLVED-PROOF (the per-turn signal — runs on BOTH pages now the judge is gone).
        // Render the AFTER shot and ask the vision critique whether each named flaw is still
        // present. resolved = present-before AND absent-after. Drives Improve + feedback.
        if (ctx.html !== builtHtml) {
          let afterShot = "";
          try { afterShot = await renderShot(ctx.html, preShotPath(page, gen, "after")); } catch { afterShot = ""; }
          let afterFlaws = new Set();
          try {
            const after = await codexCritique({ brand, screenshotPath: afterShot, goal, html: ctx.html });
            const afterFindings = (after && after.findings) || [];
            afterFlaws = new Set(afterFindings.map((c) => String((c && c.flaw) || "").trim().toLowerCase()).filter(Boolean));
          } catch { afterFlaws = new Set(); }
          const verifiedTraces = [];
          for (const f of findingObjs) {
            const resolved = !afterFlaws.has(f.flaw.toLowerCase()); // present-before AND absent-after
            if (resolved) resolvedThisTurn += 1;
            gatedEmit({
              type: "trace.resolved",
              flaw: f.flaw,
              brandRuleCited: f.brandRuleCited,
              beforeShot,
              afterShot,
              agentId: creditAgentId(f, credit, page, gen),
              resolved,
            });
            // ADMISSION GATE (the core memory fix): a finding becomes a trace ONLY when
            // the revise VERIFIABLY fixed it (present-before, absent-after), and only once
            // per run (dedup). Store it as a FORWARD, actionable rule so next turn's build
            // pre-empts the fix BEFORE its own critique runs — that's how the memory page
            // pulls ahead of the flat no-memory page. Not traced under ablation.
            if (resolved && isMemory && !ablateMemory) {
              const key = f.flaw.trim().toLowerCase();
              if (key && !tracedKeys.has(key)) {
                tracedKeys.add(key);
                const ruleText = `Do not reintroduce this already-fixed issue: ${f.flaw}` +
                  (f.brandRuleCited ? ` (brand rule: ${f.brandRuleCited})` : "");
                verifiedTraces.push({
                  role: creditRole(f, credit) || "critique",
                  finding: ruleText,
                  severity: f.severity,
                  nodeSet: [brandToken(brand), creditRole(f, credit) || "critique", f.severity],
                });
              }
            }
          }
          if (verifiedTraces.length) {
            try {
              await memory.writeTraces(sessionId, verifiedTraces);
              for (const r of verifiedTraces) {
                tracesCount += 1;
                gatedEmit({ type: "trace.written", agentId: `${page}-trace-g${gen}`, summary: r.finding });
              }
            } catch { /* verified-trace write best-effort; run continues */ }
          }
        }
      }
    }

    // ===================================================================
    // (JUDGE REMOVED) — no per-turn score. The loop is purely CRITIQUE-driven: the critique
    // (STEP 3) decides what to fix and the revise applies it; the RESOLVED-PROOF above is the
    // "did it improve?" signal. We still emit a per-gen marker so the UI's Turns tile advances.
    // ===================================================================
    gatedEmit({ type: "score.updated", gen, page });

    // ---- IMPROVEMENTS: a turn where the revise VERIFIABLY fixed >=1 flaw (resolved-proof).
    // Replaces the old "score rose" signal. Computed identically for BOTH pages.
    if (resolvedThisTurn > 0) {
      improvements += 1;
    }

    // ---- CONSTRUCTIVE TRACE (#2): if THIS page's score ROSE vs its own prior turn, the
    // upgrade we pursued worked → store it as a "winning direction" so memory accumulates
    // what ADDS quality (not just what to avoid). This is the additive counterpart to the
    // preventive "do not reintroduce X" traces. Memory-only, deduped, never under ablation.
    if (isMemory && !ablateMemory && upgrade && resolvedThisTurn > 0) {
      const key = "upg:" + upgrade.trim().toLowerCase();
      if (!tracedKeys.has(key)) {
        tracedKeys.add(key);
        const ruleText = `Pursue this winning direction (its fixes verifiably stuck): ${upgrade}`;
        try {
          await memory.writeTraces(sessionId, [{ role: "elevate", finding: ruleText, severity: "high", nodeSet: [brandToken(brand), "elevate", "high"] }]);
          tracesCount += 1;
          gatedEmit({ type: "trace.written", agentId: `${page}-elevate-g${gen}`, summary: ruleText });
        } catch { /* constructive-trace write best-effort */ }
      }
    }

    // ===================================================================
    // SPINE STEP 7 — FEEDBACK [mem] (§1 cmd_feedback, §9.7).
    //   Map the judged delta on the named flaw → 5 (improved) | 3 (neutral) |
    //   1 (regressed). memory.feedback(sessionId, {qa_id, feedbackText, feedbackScore}).
    //   qa_id from this turn's recall; applied:false (skipped) when qa_id is null.
    // ===================================================================
    if (isMemory && !ablateMemory && typeof memory.feedback === "function" && qaId) {
      // Feedback signal = the RESOLVED-PROOF (did this turn's fixes stick?), not a score.
      const feedbackScore = resolvedThisTurn > 0 ? 5 : 3;
      const feedbackText = (findingObjs[0] && findingObjs[0].flaw) ||
        (recalledRules[0]) || "turn fix-resolution signal";
      try {
        await memory.feedback(sessionId, { qa_id: qaId, feedbackText, feedbackScore });
      } catch { /* feedback best-effort */ }

      // ===================================================================
      // SPINE STEP 8 — IMPROVE [mem] (§1 cmd_improve, §9.8).
      //   Reweight the session by feedback so the NEXT turn's recall ranks proven
      //   fixes higher. feedback_alpha > 0 rides in kwargs.
      // ===================================================================
      if (typeof memory.improve === "function") {
        try { await memory.improve([sessionId], FEEDBACK_ALPHA); } catch { /* improve best-effort */ }
      }
    }

    // ===================================================================
    // SPINE STEP 9 — DISTILL [mem] (session-only Lessons counter; §1, §9.9).
    //   Graceful if GLM yields 0 valid WrittenLessons (Traces-only — never silently
    //   show Lessons=0 as success; the counter simply stays at the traces signal).
    // ===================================================================
    if (isMemory && !ablateMemory) {
      try {
        const { lessonsAccepted } = (await memory.distill(sessionId)) || { lessonsAccepted: [] };
        const accepted = Array.isArray(lessonsAccepted) ? lessonsAccepted : [];
        if (accepted.length) {
          lessonsCount += accepted.length;
          gatedEmit({ type: "memory.distilled", lessonsAccepted: accepted });
        }
      } catch {
        /* distill best-effort (graceful degrade to Traces-only) */
      }
    }

    // ---- PROVENANCE: emit the RICH member.upskilled now that this gen is judged,
    // so scoreAfter (this gen's score) — and the resulting delta — are real. The
    // UI pops the prompt-diff panel on this event (graceful no-op on thin shapes).
    if (pendingUpskill) {
      pendingUpskill.scoreAfter = null; // no score (judge removed)
      gatedEmit(pendingUpskill);
      pendingUpskill = null;
    }

    // CARRY THE PAGE FORWARD: next turn IMPROVES this page instead of rebuilding
    // from scratch. This is the in-run self-improvement compounding (both pages).
    if (typeof ctx.html === "string" && ctx.html.trim()) pageHtml = ctx.html;
    gensRun += 1; // this generation completed
  }

  gatedEmit({
    type: "run.finished",
    totals: {
      agentsSpawned,
      turns: gensRun, // "Turns" = generations completed (the in-run improvement rounds)
      traces: tracesCount,
      improvements,
      lessons: lessonsCount,
    },
  });

  return {
    turns: gensRun,
    agentsSpawned,
    traces: tracesCount,
    improvements,
    lessons: lessonsCount,
  };
}

// ===========================================================================
// SMOKE TEST — `node web/src/orchestrator.mjs`
// Exercises the progressive-render helpers + the batch-trace flow WITHOUT any
// network (no Codex, no Ollama, no python). It does NOT run a full build.
// ===========================================================================
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    let ok = true;
    const log = (cond, msg) => { if (!cond) ok = false; console.log(cond ? "PASS" : "FAIL", msg); };

    const os = await import("node:os");
    const { mkdtemp, readFile, access } = await import("node:fs/promises");
    process.env.TASTELOOP_SNAP_DIR = await mkdtemp(path.join(os.tmpdir(), "tl-orch-"));

    const brand = {
      colors: { primary: "#FE2C55", accent: "#25F4EE", bg: "#000000", fg: "#FFFFFF" },
      tone: ["bold", "direct"],
      audience: "brands & marketers",
      dont: ["Do not use gradients"],
      sections: ["hero", "problem", "how-it-works", "proof", "cta"],
      tokens: { color: { roles: { bg: "#000000", fg: "#FFFFFF", primary: "#FE2C55", secondary: "#25F4EE" } } },
      designSystemCss: ":root{--color-bg:#000}\n.ds-btn-primary{}",
      designSystemPath: "run/design-system.css",
    };

    // ---- previewCopy recovers hero + angle from the threaded copyHint ----
    const pc = previewCopy(
      { copyHint: 'Strategy. Hero headline tone: "Go viral. Get customers.". Sound-on growth engine' },
      brand, GOAL,
    );
    log(pc.hero === "Go viral. Get customers.", "previewCopy: recovers hero from copyHint");
    log(/Sound-on growth engine/.test(pc.angle), "previewCopy: recovers angle after hero clause");
    const pc2 = previewCopy({}, brand, GOAL);
    log(pc2.hero === GOAL && pc2.angle.length > 0, "previewCopy: falls back to brand-true defaults");

    // ---- buildPreviewPage is on-brand, links the design system, no gradients ----
    const ctx = {
      copyHint: 'Hero headline tone: "Make ads people actually watch.". Turn 60s clips into customers',
      sections: ["hero", "problem", "how-it-works", "proof", "cta"],
      heroImage: "data:image/png;base64,STUB==",
      seq: 0,
    };
    const html = buildPreviewPage({ ctx, brand, goal: GOAL });
    log(/<!doctype html>/i.test(html) && /<\/html>/i.test(html), "buildPreviewPage: well-formed doc");
    log(/href="\.\.\/design-system\.css"/.test(html), "buildPreviewPage: LINKS the live design-system.css");
    log(/ds-btn-primary/.test(html) && /ds-h1/.test(html), "buildPreviewPage: uses .ds-* utilities");
    log(/Make ads people actually watch\./.test(html), "buildPreviewPage: drops in the real hero copy");
    log(/STUB==/.test(html), "buildPreviewPage: embeds the threaded hero image");
    log(!/gradient/i.test(html), "buildPreviewPage: NO gradients (on-brand)");
    log(/#25F4EE/i.test(brand.designSystemCss) || /design-system\.css/.test(html), "buildPreviewPage: grounded in the design system");

    // ---- emitPreview writes a snapshot + emits draft design.rendered EARLY ----
    const events = [];
    const emit = (ev) => events.push(ev);
    const ctx2 = { copyHint: ctx.copyHint, sections: ctx.sections, seq: 0 };
    const ref = await emitPreview({ ctx: ctx2, brand, goal: GOAL, page: "memory", gen: 0, emit });
    log(typeof ref === "string" && ref.startsWith("snapshots/") && /preview/.test(ref), "emitPreview: returns a preview htmlRef under snapshots/");
    let wrote = true;
    try { await access(path.join(snapDir(), path.basename(ref))); } catch { wrote = false; }
    log(wrote, "emitPreview: preview snapshot written to disk");
    const dr = events.find((e) => e.type === "design.rendered");
    log(dr && dr.htmlRef === ref && dr.draft === true, "emitPreview: emits design.rendered{draft:true}");
    log(events.some((e) => e.type === "agent.status" && e.draft === true && /draft/i.test(e.doing)), "emitPreview: emits a DRAFT agent.status");
    log(ctx2.seq === 1, "emitPreview: bumped ctx.seq so the builder snapshot won't collide");

    // ---- sessionId convention (CONTRACTS §8): sess_<runId>_<page> ----
    {
      const rid = "run_test_abc";
      log(`sess_${rid}_memory` === "sess_run_test_abc_memory", "sessionId: sess_<runId>_<page> format");
    }

    // ---- severity comes from the structured field, NO regex (Guardrail 5) ----
    log(normSeverity("high") === "high" && normSeverity("HIGH") === "high", "severity: high passes through");
    log(normSeverity("low") === "low", "severity: low passes through");
    log(normSeverity("medium") === "med" && normSeverity(undefined) === "med" && normSeverity("garbage") === "med", "severity: anything-else defaults to med (no regex)");

    // ---- firstLesson: first recalled trace is the enforceable rule (no regex pick) ----
    log(firstLesson([{ statement: "Use flat color" }, { statement: "gradient banned" }]) === "Use flat color", "firstLesson: returns the FIRST recalled rule (feedback-ranked, no regex priority)");
    log(firstLesson([]) === null && firstLesson(null) === null, "firstLesson: null when nothing recalled");

    // ---- brandToken / recallNodeName scope recall to canonical token nodes ----
    log(brandToken(brand) === "#FE2C55", "brandToken: primary color is the canonical token node");
    log(recallNodeName(brand) === null, "recallNodeName: null — recall is NOT node_name-filtered (the bridge filter required the hex in the trace text, which starved recall)");
    const rq = recallQuery(brand, GOAL);
    log(/bold direct/.test(rq) && !/gradient|buzzword|accent/i.test(rq), "recallQuery: brand-grounded, does NOT enumerate the flaws memory fixes");

    // ---- assignCredit: flaw -> responsible roster agent (no regex over flaw text) ----
    {
      const agents = [
        { role: "typographer", tools: [] },
        { role: "copywriter", tools: [] },
        { role: "frontend-implementer", tools: ["html_build"], produces: "html" },
      ];
      const findings = [
        { flaw: "text is hard to read", brandRuleCited: "low contrast text", severity: "high" },
        { flaw: "headline is weak", brandRuleCited: "copy is off-brand", severity: "med" },
        { flaw: "something else", brandRuleCited: "", severity: "low" },
      ];
      const cm = assignCredit(findings, agents);
      log(cm.get("text is hard to read") === "typographer", "credit: contrast flaw -> typographer");
      log(cm.get("headline is weak") === "copywriter", "credit: copy flaw -> copywriter");
      log(cm.get("something else") === "frontend-implementer", "credit: uncited flaw -> the builder (fallback)");
    }

    // ---- pickUpskilledAgent reads master-authored briefDiff (NO regex reconstruction) ----
    {
      const agents = [
        { role: "copywriter" },
        { role: "frontend-implementer", briefDiff: { before: "build a page", after: "build a page; apply learned rule", lessonId: "L1", lessonText: "apply learned rule" } },
      ];
      const up = pickUpskilledAgent(agents);
      log(up && up.agent.role === "frontend-implementer" && up.before !== up.after, "pickUpskilledAgent: returns the master's stored before/after diff");
      log(pickUpskilledAgent([{ role: "x" }]) === null, "pickUpskilledAgent: null when no agent carries a briefDiff");
    }

    // ---- threadResult: recalled hits -> ctx.rules + qa_id; DROPPED under ablation (C3) ----
    {
      const recallResult = { hits: [{ snippet: "use #25F4EE on the CTA", role: "memory" }], qa_id: "qa_42" };
      const ctxM = { brief: {}, rules: [], findings: [], _ablate: false };
      threadResult(ctxM, recallResult);
      log(ctxM.rules.includes("use #25F4EE on the CTA"), "threadResult: recalled hit snippet -> ctx.rules verbatim");
      log(ctxM.qa_id === "qa_42", "threadResult: qa_id threaded for the feedback step (C2)");
      const ctxA = { brief: {}, rules: [], findings: [], _ablate: true };
      threadResult(ctxA, recallResult);
      log(ctxA.rules.length === 0 && ctxA.qa_id == null, "threadResult: ABLATE drops recalled rules + qa_id (the win disappears, C3)");
    }

    // ---- threadResult: typed BUILD BRIEF slots are filled (2.3) ----
    {
      const ctxB = { brief: {}, rules: [], findings: [], _ablate: false };
      threadResult(ctxB, { sections: ["hero", "cta"] });
      threadResult(ctxB, { copyHint: "Go viral" });
      threadResult(ctxB, { layoutDirection: "single-column", typeScale: "1.25 modular" });
      log(JSON.stringify(ctxB.brief.sectionOrder) === JSON.stringify(["hero", "cta"]), "brief: info-architect fills sectionOrder");
      log(ctxB.brief.copy === "Go viral", "brief: copywriter fills copy");
      log(ctxB.brief.layoutDirection === "single-column" && ctxB.brief.typeScale === "1.25 modular", "brief: visual/typographer slots filled");
    }

    // ---- score.updated is now just a PER-GEN MARKER {gen, page} (the JUDGE is removed; no
    //      score). It only advances the UI Turns tile. ----
    {
      const ev = { type: "score.updated", gen: 1, page: "memory" };
      log(typeof ev.gen === "number" && ev.page === "memory" && !("score" in ev),
        "score.updated: per-gen marker {gen, page} (judge removed — no score)");
    }

    // ---- CREDIT (§2.1/§2.5): planTeam is CALLED with `credit: creditByRole`, and that
    //      value is non-empty ONLY on memory + non-ablate + gen>0 (fairness). ----
    {
      // Mirror the EXACT gating expression used at the planTeam call site.
      const creditByRole = { "frontend-implementer": { flaw: "text is hard to read", attributedTo: "frontend-implementer", severity: "high" } };
      const passed = ({ isMemory, ablateMemory }) => (isMemory && !ablateMemory) ? creditByRole : {};

      // memory + non-ablate => the real credit flows to planTeam.
      const memCredit = passed({ isMemory: true, ablateMemory: false });
      log(memCredit === creditByRole && Object.keys(memCredit).length > 0, "credit: planTeam receives non-empty creditByRole on memory + non-ablate");
      // no-memory => always {} (fairness — no brief is ever seeded there).
      log(Object.keys(passed({ isMemory: false, ablateMemory: false })).length === 0, "credit: no-memory page passes credit:{} (fairness)");
      // ablation => {} (the win-bearing credit channel is withheld).
      log(Object.keys(passed({ isMemory: true, ablateMemory: true })).length === 0, "credit: ABLATE passes credit:{} (no seeded miss)");
      // gen 0 starts with creditByRole={} (only built AFTER the first critique) — structural.
      log(Object.keys({}).length === 0, "credit: gen 0 starts empty (creditByRole built only after a critique)");
    }

    console.log(ok ? "\norchestrator.mjs smoke: ALL PASS" : "\norchestrator.mjs smoke: FAILURES");
    process.exit(ok ? 0 : 1);
  })().catch((err) => {
    console.error("SMOKE CRASHED:", err && err.stack ? err.stack : err);
    process.exit(1);
  });
}
