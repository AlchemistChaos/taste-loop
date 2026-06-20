// skills.mjs — the AGENT EXECUTOR + skill/tool palette + the honest brand check.
//
// This is the half of TasteLoop that the MASTER agent's authored team actually
// runs through. The master (a real model call elsewhere) DECIDES, per agent:
//   - role          (what it is)
//   - instructions  (the ACTUAL prompt the agent runs on — author-written)
//   - tools         (granted skills, from the palette below)
// `runAgent` takes ONE such master-authored agent and EXECUTES it: it emits the
// spawn/status/turn events, then makes a REAL model/tool call on the agent's own
// instructions (+ the threaded run context) using exactly the tools it was
// granted. NOTHING here is cosmetic — every agent makes a real call.
//
// Frozen interface this module is coded against (do not change these):
//   deps = { brand, goal, memory, chat, chatJSON, codexBuildSite, codexRun }
//   emit(event)  — orchestrator fills page/gen/t; we pass the typed payload.
//   ctx          — a mutable object the orchestrator threads BETWEEN agents
//                  (copy hints, recalled lessons, prior html, findings, ...).
//
// Exports:
//   async function runAgent({ agent, gen, page, ctx, deps, emit })
//        -> { role, produces, output, htmlRef? }
//   function brandRuleViolations(html, brand) -> string[]   (REAL violations)
//   const TOOL_PALETTE                                       (the skill palette)
//
// `agent` shape (master-authored):
//   {
//     agentId?:   string,   // orchestrator may pre-assign; we derive one if not
//     role:       string,   // e.g. "copywriter", "visual-designer", "critique"
//     version?:   number,   // upskill version (default 1)
//     instructions: string, // the prompt THIS agent runs on (author-written)
//     tools:      string[], // granted skills from TOOL_PALETTE
//   }

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// web/run/snapshots — htmlRef is returned RELATIVE to web/run (per the contract).
// SNAP_DIR is env-overridable so tests can isolate to a temp dir and never
// clobber the live run snapshots.
const __dirname = path.dirname(fileURLToPath(import.meta.url)); // web/src
const RUN_DIR = path.resolve(__dirname, "..", "run");           // web/run

// Resolved lazily so a test can point TASTELOOP_SNAP_DIR at a temp dir without
// the live web/run/snapshots ever being touched.
function snapDir() {
  return process.env.TASTELOOP_SNAP_DIR || path.join(RUN_DIR, "snapshots");
}

// ---------------------------------------------------------------------------
// THE SKILL / TOOL PALETTE
// The master grants a subset of these to each agent. The keys are the exact
// strings that appear in agent.tools and are echoed in agent.spawned.skills.
// ---------------------------------------------------------------------------
export const TOOL_PALETTE = Object.freeze({
  html_build:    "Build a full, self-contained marketing HTML page with Codex (gpt-5.4).",
  svg_image:     "Generate an inline, flat, on-brand <svg> illustration with Codex.",
  cognee_recall: "Recall prior lessons / in-run traces from memory (Cognee).",
  cognee_trace:  "Write a finding to memory (Cognee) as a trace for later distillation.",
  copywriter:    "Write bold, on-brand marketing copy (hero + page angle).",
  info_architect:"Order/define the page's sections for conversion.",
  typographer:   "Tune the type scale and font usage to the brand.",
  critique:      "Audit a page against the brand rules and list concrete findings.",
});

// Banned marketing buzzwords. The TikTok brand voice is "smart and direct" and
// explicitly says to AVOID business jargon — Codex (left to itself) loves to drop
// these into hero copy. The memory studio recalls a rule against them; the
// no-memory studio doesn't, so it tends to ship one. This is a REAL, checkable
// brand-voice violation, not a cosmetic one.
export const BANNED_BUZZWORDS = Object.freeze([
  "revolutionary",
  "cutting-edge",
  "cutting edge",
  "synergy",
  "game-changer",
  "game changer",
  "game-changing",
  "paradigm",
  "best-in-class",
  "best in class",
  "leverage",
  "next-generation",
  "next generation",
  "world-class",
]);

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function agentIdFor(agent, page, gen) {
  if (agent.agentId) return agent.agentId;
  const v = agent.version || 1;
  return `${page}-${agent.role}-v${v}-g${gen}`;
}

function asLines(x) {
  if (Array.isArray(x)) return x.filter(Boolean).map(String);
  if (x == null) return [];
  return [String(x)];
}

// Extract a single inline <svg>...</svg> from arbitrary model text. Returns "" if
// none found (caller decides what to do — we never fabricate one).
function extractSvg(text) {
  if (!text) return "";
  const m = String(text).match(/<svg[\s\S]*?<\/svg>/i);
  return m ? m[0].trim() : "";
}

// Build the concrete user prompt an agent runs on: its master-authored
// instructions, grounded with the live brand + goal + whatever the prior agents
// threaded into ctx (recalled lessons, copy hints, prior html excerpt, findings).
function groundedPrompt(agent, deps, ctx) {
  const { brand, goal } = deps;
  const parts = [];
  parts.push(agent.instructions || `Act as the ${agent.role}.`);
  parts.push("");
  parts.push(`GOAL: ${goal}`);
  parts.push(
    `BRAND: tone ${JSON.stringify(brand?.tone)}; audience ${brand?.audience}; ` +
    `colors primary ${brand?.colors?.primary} accent ${brand?.colors?.accent}; ` +
    `DON'Ts ${JSON.stringify(brand?.dont || [])}.`
  );
  if (ctx?.lessons?.length) {
    parts.push(
      `RECALLED LESSONS you must honor: ` +
      ctx.lessons.map((l) => l.statement || l).join(" | ")
    );
  }
  if (ctx?.copyHint) parts.push(`COPY DIRECTION so far: ${ctx.copyHint}`);
  if (ctx?.sections?.length) parts.push(`SECTION PLAN: ${ctx.sections.join(", ")}`);
  if (ctx?.findings?.length) parts.push(`PRIOR FINDINGS: ${ctx.findings.join(" | ")}`);
  return parts.join("\n");
}

// A query string for memory recall, derived from the agent + run context.
function recallQuery(agent, ctx) {
  return [
    agent.role,
    "brand design quality gradient buzzword cta accent",
    ctx?.copyHint || "",
  ].join(" ").trim();
}

// ---------------------------------------------------------------------------
// THE EXECUTOR
// ---------------------------------------------------------------------------

/**
 * Execute ONE master-authored agent. Emits its lifecycle events, then makes a
 * REAL call using the tools it was granted, threading its output back to the
 * orchestrator via the return value (which the orchestrator merges into ctx).
 *
 * @param {Object}   a
 * @param {Object}   a.agent  master-authored {role,instructions,tools,version?,agentId?}
 * @param {number}   a.gen    generation index
 * @param {string}   a.page   "memory" | "no-memory"
 * @param {Object}   a.ctx    threaded run context (read + contributed to)
 * @param {Object}   a.deps   { brand, goal, memory, chat, chatJSON, codexBuildSite, codexRun }
 * @param {Function} a.emit   emit(event)
 * @returns {Promise<{role:string, produces:string, output:any, htmlRef?:string}>}
 */
export async function runAgent({ agent, gen, page, ctx = {}, deps, emit }) {
  if (!agent || !agent.role) throw new Error("runAgent: agent.role is required");
  if (!deps) throw new Error("runAgent: deps is required");
  const e = typeof emit === "function" ? emit : () => {};

  const role = agent.role;
  const version = agent.version || 1;
  const tools = Array.isArray(agent.tools) ? agent.tools : [];
  const has = (t) => tools.includes(t);
  const agentId = agentIdFor(agent, page, gen);
  const instructions = String(agent.instructions || "");

  // 1) SPAWN — echo the master's authorship: the real prompt (truncated) + the
  //    granted skills, per the event contract.
  e({
    type: "agent.spawned",
    agentId,
    role,
    version,
    prompt: instructions.slice(0, 200),
    skills: tools,
  });

  // 2) STATUS + TURN — a status line describing what this agent is doing, then a
  //    counted turn (the orchestrator enforces the global TURN_CAP via emit).
  const doing = statusFor(role, tools, ctx);
  e({ type: "agent.status", agentId, doing });
  e({ type: "agent.turn", agentId });

  // 3) DO THE REAL WORK, routed by the granted tools. Tool routing is checked in
  //    priority order; an agent may hold several tools (e.g. recall THEN build).
  let result;

  // --- memory recall (read) ------------------------------------------------
  if (has("cognee_recall")) {
    result = await runRecall({ agent, agentId, page, ctx, deps, emit: e });
  }

  // --- html build (the page) ----------------------------------------------
  if (has("html_build")) {
    const built = await runHtmlBuild({ agent, agentId, gen, page, ctx, deps, emit: e });
    result = { ...(result || {}), ...built };
  }

  // --- svg image -----------------------------------------------------------
  else if (has("svg_image")) {
    const svg = await runSvgImage({ agent, deps, ctx });
    result = { ...(result || {}), role, produces: "svg", output: svg };
  }

  // --- structured language tools (copy / ia / typography / critique) -------
  else if (
    has("copywriter") || has("info_architect") ||
    has("typographer") || has("critique") ||
    // role-name fallbacks if the master granted no explicit lang tool but the
    // role clearly implies one
    ["copywriter", "info-architect", "typographer", "critique"].includes(role)
  ) {
    const lang = await runLanguageTool({ agent, deps, ctx });
    result = { ...(result || {}), ...lang };
  }

  // --- memory trace (write) — runs AFTER the agent has produced something ---
  if (has("cognee_trace")) {
    await runTrace({ agent, agentId, page, ctx, deps, emit: e, result });
  }

  // Fallback: an agent with NO recognized tool still makes a real call so it's
  // never cosmetic — it reasons on its own instructions and returns text.
  if (!result) {
    const raw = await safeChat(deps, [
      { role: "system", content: `You are the ${role} for a TikTok marketing site team. Be concise and concrete.` },
      { role: "user", content: groundedPrompt(agent, deps, ctx) },
    ]);
    result = { role, produces: "text", output: raw };
  }

  if (!result.role) result.role = role;
  if (!result.produces) result.produces = "text";
  if (!("output" in result)) result.output = null;
  return result;
}

// ---- status line per role -------------------------------------------------
function statusFor(role, tools, ctx) {
  if (tools.includes("cognee_recall")) return "recalling prior lessons & traces from memory";
  if (tools.includes("html_build")) return "building full HTML page with Codex (gpt-5.4)";
  if (tools.includes("svg_image")) return "generating an inline on-brand SVG with Codex";
  if (tools.includes("cognee_trace")) return "writing findings to memory";
  switch (role) {
    case "copywriter": return "writing bold 5-section TikTok copy direction";
    case "info-architect": return "ordering the 5 sections for conversion";
    case "typographer": return "tuning the type scale to the brand font";
    case "critique": return "auditing the page against brand rules";
    case "brand-deconstruct": return "loading the TikTok BrandSpec";
    case "visual-designer": return ctx?.lessons?.length ? "applying learned lessons (v2)" : "directing on-brand layout";
    default: return `working as ${role}`;
  }
}

// ---- tool: cognee_recall --------------------------------------------------
async function runRecall({ agent, agentId, page, ctx, deps, emit }) {
  const { memory } = deps;
  const q = recallQuery(agent, ctx);
  let lessons = [];
  let inRun = [];
  try { lessons = (await memory.recallLessons(q)) || []; } catch { lessons = []; }
  try { inRun = (await memory.recallInRun(`${page}-run`, q)) || []; } catch { inRun = []; }

  // hits surfaced to the UI: lesson statements + in-run snippets.
  const hits = [
    ...lessons.map((l) => ({ snippet: l.statement || String(l) })),
    ...inRun.map((r) => ({ snippet: r.snippet })),
  ];
  emit({ type: "memory.recalled", agentId, hits });

  // Thread the lessons forward so downstream agents (builder, copy) honor them.
  return {
    role: agent.role,
    produces: "recall",
    output: { lessons, inRun },
    lessons, // hoisted for convenience (orchestrator can merge into ctx)
  };
}

// ---- tool: html_build (Codex; writes snapshot; returns htmlRef) -----------
async function runHtmlBuild({ agent, agentId, gen, page, ctx, deps, emit }) {
  const { codexBuildSite, brand, goal } = deps;

  // The single lesson text to enforce — prefer a recalled lesson, else any the
  // orchestrator threaded into ctx (memory page). null on the no-memory page.
  const lessonText =
    pickEnforceableLesson(ctx?.lessons) ||
    (ctx?.lesson ? String(ctx.lesson) : null);

  // Fold the agent's own master-authored instructions into the copy hint so the
  // build reflects what THIS agent was told to do (not a generic template).
  const copyHint = [ctx?.copyHint, agent.instructions]
    .filter(Boolean)
    .join(". ")
    .slice(0, 600);

  const html = await codexBuildSite({ brand, goal, copyHint, lesson: lessonText });

  // Persist a snapshot. The orchestrator owns the seq; we accept ctx.seq and
  // bump it so multiple builds in a gen don't collide.
  const seq = Number.isFinite(ctx?.seq) ? ctx.seq + 1 : 1;
  if (ctx && typeof ctx === "object") ctx.seq = seq;
  const fileName = `${page}-g${gen}-s${seq}.html`;
  const dir = snapDir();
  try { await mkdir(dir, { recursive: true }); } catch { /* ignore */ }
  await writeFile(path.join(dir, fileName), html, "utf8");
  const htmlRef = path.posix.join("snapshots", fileName);

  emit({ type: "design.rendered", htmlRef });

  return { role: agent.role, produces: "html", output: html, html, htmlRef };
}

// ---- tool: svg_image (Codex; inline <svg>) --------------------------------
async function runSvgImage({ agent, deps, ctx }) {
  const { codexRun, brand } = deps;
  const c = brand?.colors || {};
  const prompt =
    groundedPrompt(agent, deps, ctx) + "\n\n" +
    `Produce ONE inline, self-contained, FLAT <svg> illustration on brand ` +
    `(primary ${c.primary}, accent ${c.accent}). Solid fills only — NO gradients, ` +
    `NO external images, NO <defs><linearGradient>. ` +
    `OUTPUT ONLY the <svg>...</svg> element, nothing else.`;
  const raw = await codexRun(prompt, { timeoutMs: 120_000 });
  const svg = extractSvg(raw);
  if (!svg) throw new Error("svg_image: Codex returned no <svg> element");
  return svg;
}

// ---- structured language tools (real chatJSON) ----------------------------
async function runLanguageTool({ agent, deps, ctx }) {
  const role = agent.role;
  const grounded = groundedPrompt(agent, deps, ctx);

  // Each lang tool asks for a small, typed JSON shape so the orchestrator can
  // thread the result deterministically. The agent's master-authored
  // instructions remain the lead system/user content (this is a real call).
  let schema;
  let sys;
  if (role === "copywriter" || hasTool(agent, "copywriter")) {
    sys = 'Return ONLY JSON: {"hero":string,"angle":string}. ' +
      "hero = a punchy hero headline (no business jargon/buzzwords); " +
      "angle = a one-line copy direction for the whole page.";
    schema = "copy";
  } else if (role === "info-architect" || hasTool(agent, "info_architect")) {
    sys = 'Return ONLY JSON: {"sections":[string,...]}. ' +
      "5 section names ordered for conversion.";
    schema = "ia";
  } else if (role === "typographer" || hasTool(agent, "typographer")) {
    sys = 'Return ONLY JSON: {"scale":string,"notes":string}. ' +
      "scale = a concise type-scale recommendation; notes = font usage guidance.";
    schema = "type";
  } else {
    // critique (default)
    sys = 'Return ONLY JSON: {"findings":[string,...]}. ' +
      "1-4 concrete, actionable brand/design problems.";
    schema = "critique";
  }

  const obj = await safeChatJSON(deps, [
    { role: "system", content: `You are the ${role} for a TikTok marketing site team. ${sys}` },
    { role: "user", content: grounded },
  ]);

  // Normalize each schema into a stable {output, ...threaded} shape.
  if (schema === "copy") {
    const hero = String(obj?.hero || "").trim();
    const angle = String(obj?.angle || "").trim();
    const parts = [];
    if (hero) parts.push(`Hero headline tone: "${hero}"`);
    if (angle) parts.push(angle);
    const copyHint = parts.join(". ");
    return { role, produces: "copy", output: { hero, angle }, copyHint };
  }
  if (schema === "ia") {
    const sections = asLines(obj?.sections).slice(0, 5);
    return { role, produces: "ia", output: { sections }, sections };
  }
  if (schema === "type") {
    return { role, produces: "type", output: { scale: String(obj?.scale || ""), notes: String(obj?.notes || "") } };
  }
  // critique
  let findings = asLines(obj?.findings);
  if (findings.length === 0) findings = ["Strengthen visual hierarchy; emphasize the primary CTA."];
  return { role, produces: "critique", output: { findings }, findings };
}

function hasTool(agent, t) {
  return Array.isArray(agent.tools) && agent.tools.includes(t);
}

// ---- tool: cognee_trace (write findings to memory) ------------------------
async function runTrace({ agent, agentId, page, ctx, deps, emit, result }) {
  const { memory } = deps;
  const sessionId = `${page}-run`;
  // Trace whatever the agent just produced that's worth remembering: critique
  // findings if present, else any ctx findings.
  const findings =
    (result && result.findings) ||
    (result && result.output && result.output.findings) ||
    ctx?.findings ||
    [];
  for (const finding of asLines(findings)) {
    const severity = /gradient|forbid|violat|buzzword|jargon|cta|accent/i.test(finding)
      ? "high" : "medium";
    try {
      await memory.writeTrace(sessionId, { role: agent.role, finding, severity });
      emit({ type: "trace.written", agentId, summary: finding });
    } catch { /* ignore individual trace failures */ }
  }
}

// Pick a recalled lesson worth ENFORCING in the build. Prefer ones tied to the
// demo's headline wins (gradient / buzzword / accent-on-CTA), else the first.
function pickEnforceableLesson(lessons) {
  if (!Array.isArray(lessons) || lessons.length === 0) return null;
  const txt = (l) => (l && (l.statement || l)) || "";
  const priority = lessons.find((l) => /gradient|buzzword|jargon|accent|cta|#25f4ee/i.test(txt(l)));
  return String(txt(priority || lessons[0])).trim() || null;
}

// ---- resilient model wrappers (a failed support call must not abort a run) -
async function safeChat(deps, messages) {
  try { return await deps.chat(messages, { temperature: 0.6 }); }
  catch { return ""; }
}
async function safeChatJSON(deps, messages) {
  try { return await deps.chatJSON(messages, { temperature: 0.4 }); }
  catch { return {}; }
}

// ---------------------------------------------------------------------------
// THE HONEST BRAND CHECK
// Deterministic, REAL violations in an actual HTML artifact. Each entry is a
// human-readable string. Used by the judge path so the memory page — which
// recalled & applied these rules — scores higher honestly and visibly.
// ---------------------------------------------------------------------------

/**
 * @param {string} html  the produced page HTML
 * @param {object} brand BrandSpec (colors.accent, colors.primary, dont[])
 * @returns {string[]} concrete violation strings (empty array == clean)
 */
export function brandRuleViolations(html, brand) {
  const out = [];
  const h = String(html || "");
  const lower = h.toLowerCase();

  // 1) GRADIENTS — the brand literally says "Do not use gradients."
  if (/gradient/i.test(lower) || /linear-gradient|radial-gradient|bg-gradient|<lineargradient|<radialgradient/i.test(lower)) {
    out.push("Gradient present — the brand forbids gradients (flat brand-color blocks only).");
  }

  // 2) BANNED BUZZWORDS — "smart and direct" voice; avoid business jargon. Match
  //    on whole-ish word boundaries so we don't false-positive on substrings.
  for (const word of BANNED_BUZZWORDS) {
    const re = new RegExp(`(^|[^a-z])${escapeRegExp(word.toLowerCase())}([^a-z]|$)`, "i");
    if (re.test(lower)) {
      out.push(`Banned buzzword "${word}" in copy — brand voice avoids business jargon.`);
    }
  }

  // 3) ACCENT MISSING FROM THE PRIMARY CTA — the cyan accent (#25F4EE) is a
  //    signature brand element and should appear on the primary call-to-action.
  //    We flag when the accent hex appears NOWHERE in the document at all (a
  //    strong, checkable signal the accent was dropped from CTAs/links).
  const accent = (brand?.colors?.accent || "#25F4EE").toLowerCase();
  if (accent && !lower.includes(accent.toLowerCase())) {
    out.push(`Accent color ${accent} is absent from the page — it should anchor the primary CTA / links.`);
  }

  return out;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ===========================================================================
// SMOKE TEST — `node web/src/skills.mjs`
// Verifies runAgent's SHAPE + event emissions with a STUB deps (no network,
// no Codex, no Ollama, no python), and exercises brandRuleViolations.
// ===========================================================================
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    let ok = true;
    const log = (cond, msg) => { if (!cond) ok = false; console.log(cond ? "PASS" : "FAIL", msg); };

    // Isolate snapshot writes to a temp dir so the live web/run/snapshots is
    // never clobbered by the stub builds.
    const os = await import("node:os");
    const { mkdtemp } = await import("node:fs/promises");
    process.env.TASTELOOP_SNAP_DIR = await mkdtemp(path.join(os.tmpdir(), "tl-snap-"));

    // ---- stub deps (every "real call" is replaced with a deterministic stub) ----
    const events = [];
    const emit = (ev) => events.push(ev);
    const calls = { chat: 0, chatJSON: 0, codexBuild: 0, codexRun: 0, recallLessons: 0, recallInRun: 0, writeTrace: 0 };

    const brand = {
      colors: { primary: "#FE2C55", accent: "#25F4EE", bg: "#000000", fg: "#FFFFFF" },
      fonts: { heading: "Inter", body: "Inter" },
      tone: ["bold", "direct"],
      audience: "brands & marketers",
      dont: ["Do not use gradients", "avoid business jargon"],
      sections: ["hero", "problem", "how-it-works", "proof", "cta"],
    };

    const memory = {
      async recallLessons() { calls.recallLessons++; return [{ statement: "Never use gradients; flat color blocks only." }]; },
      async recallInRun() { calls.recallInRun++; return [{ snippet: "hero had a gradient last run", role: "memory" }]; },
      async writeTrace() { calls.writeTrace++; },
    };

    const deps = {
      brand,
      goal: "TikTok for Business — turn 60s videos into customers",
      memory,
      async chat() { calls.chat++; return "stub freeform text"; },
      async chatJSON() {
        calls.chatJSON++;
        // Return a superset; runLanguageTool reads only what each schema needs.
        return { hero: "Go viral. Get customers.", angle: "Sound-on demand engine", sections: ["a","b","c","d","e"], findings: ["weak CTA contrast"], scale: "1.25 ratio", notes: "use heading font for h1-h3" };
      },
      async codexBuildSite() { calls.codexBuild++; return "<!doctype html><html><head></head><body><a style='background:#25F4EE'>CTA</a></body></html>"; },
      async codexRun() { calls.codexRun++; return "<svg viewBox='0 0 10 10'><rect width='10' height='10' fill='#FE2C55'/></svg>"; },
    };

    const baseCtx = () => ({ copyHint: "", seq: 0 });

    // ---- 1) copywriter (lang tool) ----
    events.length = 0;
    let r = await runAgent({
      agent: { role: "copywriter", version: 1, instructions: "Write a punchy hero for TikTok for Business; avoid jargon.", tools: ["copywriter"] },
      gen: 0, page: "memory", ctx: baseCtx(), deps, emit,
    });
    const spawn1 = events.find((e) => e.type === "agent.spawned");
    log(spawn1 && spawn1.role === "copywriter", "copywriter: emits agent.spawned");
    log(spawn1 && typeof spawn1.prompt === "string" && spawn1.prompt.length <= 200, "spawned.prompt is instructions slice<=200");
    log(spawn1 && Array.isArray(spawn1.skills) && spawn1.skills.includes("copywriter"), "spawned.skills == agent.tools");
    log(events.some((e) => e.type === "agent.status"), "copywriter: emits agent.status");
    log(events.some((e) => e.type === "agent.turn"), "copywriter: emits agent.turn");
    log(r.role === "copywriter" && r.produces === "copy", "copywriter: returns {role,produces:copy}");
    log(typeof r.copyHint === "string" && r.copyHint.includes("Go viral"), "copywriter: threads copyHint");
    log(calls.chatJSON === 1, "copywriter: made exactly one real chatJSON call");

    // ---- 2) info-architect ----
    r = await runAgent({
      agent: { role: "info-architect", version: 1, instructions: "Order 5 sections for conversion.", tools: ["info_architect"] },
      gen: 0, page: "memory", ctx: baseCtx(), deps, emit,
    });
    log(r.produces === "ia" && Array.isArray(r.sections) && r.sections.length === 5, "info-architect: returns 5 sections threaded");

    // ---- 3) critique (lang tool) ----
    r = await runAgent({
      agent: { role: "critique", version: 1, instructions: "Audit the page against brand DON'Ts.", tools: ["critique"] },
      gen: 0, page: "memory", ctx: baseCtx(), deps, emit,
    });
    log(r.produces === "critique" && Array.isArray(r.findings) && r.findings.length >= 1, "critique: returns findings");

    // ---- 4) cognee_recall ----
    events.length = 0;
    r = await runAgent({
      agent: { role: "memory-recaller", version: 1, instructions: "Recall lessons before the build.", tools: ["cognee_recall"] },
      gen: 1, page: "memory", ctx: baseCtx(), deps, emit,
    });
    log(events.some((e) => e.type === "memory.recalled" && Array.isArray(e.hits) && e.hits.length >= 1), "recall: emits memory.recalled with hits");
    log(Array.isArray(r.lessons) && r.lessons.length >= 1, "recall: threads lessons");
    log(calls.recallLessons === 1 && calls.recallInRun === 1, "recall: made real recall calls");

    // ---- 5) html_build (writes a snapshot, returns htmlRef) ----
    events.length = 0;
    const buildCtx = { copyHint: "Go viral.", seq: 0, lessons: [{ statement: "Never use gradients." }] };
    r = await runAgent({
      agent: { role: "frontend-implementer", version: 2, instructions: "Build the full page with Codex.", tools: ["html_build"] },
      gen: 0, page: "memory", ctx: buildCtx, deps, emit,
    });
    log(r.produces === "html" && typeof r.output === "string" && r.output.includes("<html"), "html_build: returns html output");
    log(typeof r.htmlRef === "string" && r.htmlRef.startsWith("snapshots/") && r.htmlRef.endsWith(".html"), "html_build: returns htmlRef under snapshots/");
    log(events.some((e) => e.type === "design.rendered" && e.htmlRef === r.htmlRef), "html_build: emits design.rendered");
    log(buildCtx.seq === 1, "html_build: bumped ctx.seq");
    log(calls.codexBuild === 1, "html_build: made real codexBuildSite call");
    // verify the file actually landed
    const { access } = await import("node:fs/promises");
    let wrote = true;
    try { await access(path.join(snapDir(), path.basename(r.htmlRef))); } catch { wrote = false; }
    log(wrote, "html_build: snapshot file written to disk (temp dir)");

    // ---- 6) svg_image ----
    r = await runAgent({
      agent: { role: "image-sourcer", version: 1, instructions: "Make a flat brand SVG.", tools: ["svg_image"] },
      gen: 0, page: "memory", ctx: baseCtx(), deps, emit,
    });
    log(r.produces === "svg" && typeof r.output === "string" && r.output.startsWith("<svg"), "svg_image: returns <svg> output");
    log(calls.codexRun === 1, "svg_image: made real codexRun call");

    // ---- 7) cognee_trace (write) — critique + trace combined ----
    events.length = 0;
    calls.writeTrace = 0;
    r = await runAgent({
      agent: { role: "critique", version: 1, instructions: "Audit then remember the findings.", tools: ["critique", "cognee_trace"] },
      gen: 0, page: "memory", ctx: baseCtx(), deps, emit,
    });
    log(events.some((e) => e.type === "trace.written"), "cognee_trace: emits trace.written");
    log(calls.writeTrace >= 1, "cognee_trace: made real writeTrace call");

    // ---- 8) tool-less agent still makes a real call (not cosmetic) ----
    calls.chat = 0;
    r = await runAgent({
      agent: { role: "brand-deconstruct", version: 1, instructions: "Summarize the brand.", tools: [] },
      gen: 0, page: "no-memory", ctx: baseCtx(), deps, emit,
    });
    log(calls.chat === 1, "tool-less agent: still made a real chat call (none cosmetic)");
    log(r.produces === "text", "tool-less agent: returns text produces");

    // ---- 9) agentId derivation + spawn for no-memory ----
    events.length = 0;
    await runAgent({
      agent: { role: "copywriter", version: 1, instructions: "x", tools: ["copywriter"] },
      gen: 2, page: "no-memory", ctx: baseCtx(), deps, emit,
    });
    const sp = events.find((e) => e.type === "agent.spawned");
    log(sp && sp.agentId === "no-memory-copywriter-v1-g2", `agentId derived correctly (got ${sp && sp.agentId})`);

    // ===================== brandRuleViolations =====================
    const clean = "<!doctype html><html><body><a style='background:#25F4EE'>Start free</a><h1>Go viral. Get customers.</h1></body></html>";
    log(brandRuleViolations(clean, brand).length === 0, "violations: clean on-brand page -> []");

    const grad = "<!doctype html><html><body><div style='background:linear-gradient(#FE2C55,#25F4EE)'>hi</div><a style='background:#25F4EE'>cta</a></body></html>";
    log(brandRuleViolations(grad, brand).some((v) => /gradient/i.test(v)), "violations: gradient flagged");

    const buzz = "<!doctype html><html><body><h1>The revolutionary, game-changer platform</h1><a style='background:#25F4EE'>cta</a></body></html>";
    const buzzV = brandRuleViolations(buzz, brand);
    log(buzzV.some((v) => /revolutionary/i.test(v)) && buzzV.some((v) => /game-changer/i.test(v)), "violations: buzzwords flagged");

    const noAccent = "<!doctype html><html><body><a style='background:#FE2C55'>cta</a><h1>Go viral.</h1></body></html>";
    log(brandRuleViolations(noAccent, brand).some((v) => /accent/i.test(v)), "violations: missing accent flagged");

    // word-boundary: 'leverage' as a substring shouldn't false-fire on e.g. 'cleverages'? ('clever' isn't banned; check no false positive on 'overage')
    const fp = "<!doctype html><html><body><a style='background:#25F4EE'>cta</a><p>data coverage and overage</p></body></html>";
    log(!brandRuleViolations(fp, brand).some((v) => /leverage/i.test(v)), "violations: no false positive on 'coverage/overage'");

    console.log(ok ? "\nskills.mjs smoke: ALL PASS" : "\nskills.mjs smoke: FAILURES");
    process.exit(ok ? 0 : 1);
  })().catch((err) => {
    console.error("SMOKE CRASHED:", err && err.stack ? err.stack : err);
    process.exit(1);
  });
}
