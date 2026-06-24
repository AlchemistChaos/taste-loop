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
//   const SKILL_REGISTRY  { name: { name, params, run, status } }  (v3.1 A.1)
//   const SKILL_PALETTE   string[]   (the skill names — generated from the registry)
//   const TOOL_PALETTE    { name: description }  (legacy alias of SKILL_PALETTE prose)
//   function brandRuleViolations(html, brand) -> string[]   (REAL violations; KEPT
//        for compile-safety of judge.mjs/orchestrator.mjs until their owners drop
//        their imports — NOT used on any scoring/trace path in THIS module.)
//
// v3.1 (A.1): the `runAgent` if/else routing ladder + the `statusFor` ladder are
// REPLACED by SKILL_REGISTRY + GENERIC DISPATCH. `runAgent` iterates the agent's
// granted tools and invokes `SKILL_REGISTRY[name].run(...)`, merging returns into
// `result` — no priority if/else. Before running a skill it is allow-listed:
//   - the skill MUST be in the agent's granted set;
//   - for name ∈ {cognee_recall, cognee_trace} the page MUST be "memory" else THROW.
// This makes the A/B independent variable (access to in-run memory) STRUCTURALLY
// enforced. `critique` is an ALWAYS-RUN entry on BOTH pages (a neutral quality
// capability, not memory-only — C4). NO regex anywhere (severity comes from the
// codexCritique structured field; lesson selection is no longer regex-driven).
//
// `agent` shape (master-authored):
//   {
//     agentId?:   string,   // orchestrator may pre-assign; we derive one if not
//     role:       string,   // e.g. "copywriter", "visual-designer", "critique"
//     version?:   number,   // upskill version (default 1)
//     instructions: string, // the prompt THIS agent runs on (author-written)
//     tools:      string[], // granted skills from SKILL_PALETTE
//   }

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// image.mjs is built in parallel; code to its frozen shape:
//   generateImage({ prompt, brand }) -> { path, dataUri }
// We import lazily inside the skill so this module still loads/smoke-tests even
// if image.mjs hasn't landed yet (the smoke test stubs generateImage via deps).
let _generateImage = null;
async function loadGenerateImage() {
  if (_generateImage) return _generateImage;
  const mod = await import("./image.mjs");
  _generateImage = mod.generateImage || mod.default;
  return _generateImage;
}

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
// THE SKILL / TOOL PALETTE (descriptions)
// The master grants a subset of these to each agent. The keys are the exact
// strings that appear in agent.tools and are echoed in agent.spawned.skills.
//
// v3.1: this is the prose source for SKILL_PALETTE / the master's allowed-tools
// prompt. The runnable behaviour for each name lives in SKILL_REGISTRY (below);
// the two are kept in lockstep by an assertion in the smoke test. `brand_tokens`
// is DELETED (theater) — it is in NEITHER this map NOR the registry NOR the
// palette. The ONLY memory-exclusive bundle is {cognee_recall, cognee_trace}.
// ---------------------------------------------------------------------------
export const TOOL_PALETTE = Object.freeze({
  html_build:    "Build a full, self-contained marketing HTML page with Codex (gpt-5.4).",
  svg_image:     "Generate an inline, flat, on-brand <svg> illustration with Codex.",
  cognee_recall: "Recall prior in-run traces from memory (Cognee) — memory page only.",
  cognee_trace:  "Write a finding to memory (Cognee) as an in-run trace — memory page only.",
  copywriter:    "Write bold, on-brand marketing copy (hero + page angle).",
  info_architect:"Order/define the page's sections for conversion.",
  typographer:   "Tune the type scale and font usage to the brand.",
  critique:      "Audit a page against the brand rules and list concrete findings (all-LLM vision when available).",
  // Real, grantable capabilities — each EXECUTES against the brand/imagery/HTML.
  image_gen:     "Generate a real on-brand hero image via gpt-image-1 (returns a data URI to embed); skipped without OPENAI_API_KEY.",
  a11y_check:    "Run a real accessibility check on the HTML (alt text, button/aria).",
  contrast_check:"Parse colors in the HTML and flag low-contrast text/bg pairs.",
  copy_lint:     "Scan copy/HTML for banned business buzzwords (brand voice).",
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
  // Coerce each item to a string, extracting .flaw/.finding/.statement when it's an
  // object (the local-model critique fallback returns [{flaw:"…"}]). Blind String()
  // on an object yields "[object Object]" — the trace-corruption bug.
  const one = (v) => (v && typeof v === "object")
    ? String(v.flaw ?? v.finding ?? v.statement ?? v.text ?? "")
    : String(v == null ? "" : v);
  if (Array.isArray(x)) return x.map(one).map((s) => s.trim()).filter(Boolean);
  if (x == null) return [];
  const s = one(x).trim();
  return s ? [s] : [];
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

// The session-keyed identifier for every Cognee call (H4 / CONTRACTS §8). The
// orchestrator MUST thread `ctx.sessionId = "sess_" + runId + "_" + page`. We
// READ it here; we do NOT reconstruct the legacy `${page}-run` hardcode. If it's
// missing the caller wired the run incorrectly — fail loudly rather than write to
// a wrong/cross-run dataset.
function sessionIdFrom(ctx, page) {
  const sid = ctx && typeof ctx === "object" ? ctx.sessionId : null;
  if (typeof sid === "string" && sid) return sid;
  throw new Error(
    `skills.mjs: ctx.sessionId is required (expected "sess_<runId>_${page}"); ` +
    `the orchestrator must thread it (CONTRACTS §8 / H4). Refusing to reconstruct ` +
    `the legacy "${page}-run" hardcode.`
  );
}

// ---------------------------------------------------------------------------
// THE SKILL REGISTRY (A.1) — replaces the if/else routing + statusFor ladder.
//
// Each entry: { name, params, run, status }.
//   run:    async ({ agent, agentId, gen, page, ctx, deps, emit, result }) -> result
//           (the merged-return value the orchestrator folds into ctx)
//   status: ({ role, ctx }) -> "<status doing-line>"
//
// `runAgent` iterates the agent's granted tools in DISPATCH_ORDER (the data-flow
// order: read -> imagery -> build -> audit -> language -> write) and runs each
// entry, merging returns. There is NO priority if/else and NO role-name routing.
// `critique` ALWAYS runs (both pages) even when not explicitly granted, because
// it is a neutral quality capability the demo's spine depends on (C4).
// ---------------------------------------------------------------------------

// The single source of truth for the order skills run within ONE agent. Keeps
// the read->build->audit->write data-flow the old ladder encoded, without any
// priority if/else. `critique` is appended in runAgent (always-run).
const DISPATCH_ORDER = Object.freeze([
  "cognee_recall",  // read memory first (threads recalled rules onto ctx)
  "image_gen",      // produce a hero image (threads ctx.heroImage) before the build
  "svg_image",      // OR an inline SVG hero (threads ctx.brief.imageDirective)
  "html_build",     // build the page (consumes the whole brief incl. recalled rules)
  "a11y_check",     // audit produced/ctx HTML
  "contrast_check",
  "copy_lint",
  "copywriter",     // language tools fill typed brief slots
  "info_architect",
  "typographer",
  "critique",       // always-run quality capability (both pages)
  "cognee_trace",   // write findings to memory LAST (memory page only)
]);

export const SKILL_REGISTRY = Object.freeze({
  cognee_recall: {
    name: "cognee_recall",
    params: { reads: ["ctx.sessionId", "agent.role"], writes: ["ctx.rules", "ctx.lessons"] },
    run: async ({ agent, agentId, page, ctx, deps, emit }) =>
      runRecall({ agent, agentId, page, ctx, deps, emit }),
    status: () => "recalling prior in-run traces from memory",
  },

  image_gen: {
    name: "image_gen",
    params: { writes: ["ctx.heroImage", "ctx.brief.imageDirective"] },
    run: async ({ agent, agentId, page, ctx, deps, emit, result }) => {
      const img = await runImageGen({ agent, agentId, page, ctx, deps, emit });
      return { ...(result || {}), ...img };
    },
    status: () => "generating an on-brand hero image to embed",
  },

  svg_image: {
    name: "svg_image",
    params: { writes: ["ctx.brief.imageDirective"] },
    run: async ({ agent, page, ctx, deps, result }) => {
      const svg = await runSvgImage({ agent, deps, ctx });
      // Wire the SVG into the typed BUILD BRIEF as an image directive so the
      // builder actually consumes it (no dropped agent output, Phase 2.3).
      if (svg && ctx && typeof ctx === "object") {
        ctx.brief = ctx.brief || {};
        ctx.brief.imageDirective =
          "Embed this exact inline on-brand SVG as the hero visual: " + svg;
      }
      return { ...(result || {}), role: agent.role, produces: "svg", output: svg };
    },
    status: () => "generating an inline on-brand SVG with Codex",
  },

  html_build: {
    name: "html_build",
    params: { reads: ["ctx.brief", "ctx.rules", "ctx.lessons", "ctx.heroImage"], writes: ["ctx.html", "ctx.htmlRef"] },
    run: async ({ agent, agentId, gen, page, ctx, deps, emit, result }) => {
      const built = await runHtmlBuild({ agent, agentId, gen, page, ctx, deps, emit });
      return { ...(result || {}), ...built };
    },
    status: () => "building full HTML page with Codex (gpt-5.4)",
  },

  a11y_check: {
    name: "a11y_check",
    params: { reads: ["result.html", "ctx.html"], writes: ["ctx.findings"] },
    run: async ({ agent, agentId, ctx, deps, emit, result }) => {
      const audit = runChecks({ agent, agentId, tools: ["a11y_check"], ctx, deps, emit, result });
      return { ...(result || {}), ...audit };
    },
    status: () => "running an accessibility check on the built page",
  },

  contrast_check: {
    name: "contrast_check",
    params: { reads: ["result.html", "ctx.html"], writes: ["ctx.findings"] },
    run: async ({ agent, agentId, ctx, deps, emit, result }) => {
      const audit = runChecks({ agent, agentId, tools: ["contrast_check"], ctx, deps, emit, result });
      return { ...(result || {}), ...audit };
    },
    status: () => "checking color contrast on the built page",
  },

  copy_lint: {
    name: "copy_lint",
    params: { reads: ["result.html", "ctx.html"], writes: ["ctx.findings"] },
    run: async ({ agent, agentId, ctx, deps, emit, result }) => {
      const audit = runChecks({ agent, agentId, tools: ["copy_lint"], ctx, deps, emit, result });
      return { ...(result || {}), ...audit };
    },
    status: () => "linting copy for banned business buzzwords",
  },

  copywriter: {
    name: "copywriter",
    params: { writes: ["ctx.brief.copy", "ctx.copyHint"] },
    run: async ({ agent, ctx, deps, result }) => {
      const lang = await runLanguageTool({ agent, deps, ctx, schema: "copy" });
      return { ...(result || {}), ...lang };
    },
    status: () => "writing bold 5-section TikTok copy direction",
  },

  info_architect: {
    name: "info_architect",
    params: { writes: ["ctx.brief.sectionOrder", "ctx.sections"] },
    run: async ({ agent, ctx, deps, result }) => {
      const lang = await runLanguageTool({ agent, deps, ctx, schema: "ia" });
      return { ...(result || {}), ...lang };
    },
    status: () => "ordering the 5 sections for conversion",
  },

  typographer: {
    name: "typographer",
    params: { writes: ["ctx.brief.typeScale"] },
    run: async ({ agent, ctx, deps, result }) => {
      const lang = await runLanguageTool({ agent, deps, ctx, schema: "type" });
      return { ...(result || {}), ...lang };
    },
    status: () => "tuning the type scale to the brand font",
  },

  critique: {
    name: "critique",
    params: { reads: ["ctx.html", "deps.codexCritique"], writes: ["result.findings", "ctx.brief.mustFix"] },
    run: async ({ agent, agentId, page, ctx, deps, emit, result }) => {
      // ALWAYS-RUN: critique AUGMENTS the existing primary result (findings +
      // structured critiqueFindings); it MUST NOT clobber produces/output/html/
      // role of the skill that actually produced the page (e.g. a builder or
      // copywriter that also ran this turn). Only fold in finding channels.
      const crit = await runCritique({ agent, agentId, page, ctx, deps, emit, result });
      const merged = result ? { ...result } : {};
      const priorFindings = Array.isArray(merged.findings) ? merged.findings : [];
      merged.findings = dedupeRules([...priorFindings, ...crit.findings]);
      merged.critiqueFindings = [
        ...(Array.isArray(merged.critiqueFindings) ? merged.critiqueFindings : []),
        ...crit.critiqueFindings,
      ];
      // If nothing primary ran, the critique IS the primary result.
      if (!result) {
        merged.role = crit.role;
        merged.produces = crit.produces;
        merged.output = crit.output;
      }
      return merged;
    },
    status: () => "auditing the page against brand rules",
  },

  cognee_trace: {
    name: "cognee_trace",
    params: { reads: ["ctx.sessionId", "result.findings"] },
    run: async ({ agent, agentId, page, ctx, deps, emit, result }) => {
      await runTrace({ agent, agentId, page, ctx, deps, emit, result });
      return result;
    },
    status: () => "writing findings to memory",
  },
});

// Generated from the registry — the master's allowed-tools list. No chip can be
// theater because the prompt list IS the dispatch table. `brand_tokens` cannot
// appear because it is not a registry key.
export const SKILL_PALETTE = Object.freeze(Object.keys(SKILL_REGISTRY));

// The memory-exclusive bundle (Invariant 4): the ONLY skills gated to the memory
// page. Every other skill is symmetric (available to BOTH pages).
const MEMORY_ONLY_SKILLS = Object.freeze(new Set(["cognee_recall", "cognee_trace"]));

// ---------------------------------------------------------------------------
// THE EXECUTOR
// ---------------------------------------------------------------------------

/**
 * Execute ONE master-authored agent. Emits its lifecycle events, then makes a
 * REAL call using the tools it was granted (generic registry dispatch — no
 * if/else ladder), threading its output back to the orchestrator via the return
 * value (which the orchestrator merges into ctx).
 *
 * @param {Object}   a
 * @param {Object}   a.agent  master-authored {role,instructions,tools,version?,agentId?}
 * @param {number}   a.gen    generation index
 * @param {string}   a.page   "memory" | "no-memory"
 * @param {Object}   a.ctx    threaded run context (read + contributed to). The
 *                            orchestrator MUST set ctx.sessionId = sess_<runId>_<page>.
 * @param {Object}   a.deps   { brand, goal, memory, chat, chatJSON, codexBuildSite, codexRun, codexCritique? }
 * @param {Function} a.emit   emit(event)
 * @returns {Promise<{role:string, produces:string, output:any, htmlRef?:string}>}
 */
export async function runAgent({ agent, gen, page, ctx = {}, deps, emit }) {
  if (!agent || !agent.role) throw new Error("runAgent: agent.role is required");
  if (!deps) throw new Error("runAgent: deps is required");
  const e = typeof emit === "function" ? emit : () => {};

  const role = agent.role;
  const version = agent.version || 1;
  const granted = Array.isArray(agent.tools) ? agent.tools : [];
  const grantedSet = new Set(granted);
  const agentId = agentIdFor(agent, page, gen);
  const instructions = String(agent.instructions || "");

  // The typed BUILD BRIEF lives on ctx (Phase 2.3). Ensure it exists so every
  // slot-filling skill writes into the SAME object the builder consumes.
  if (ctx && typeof ctx === "object") ctx.brief = ctx.brief || {};

  // 1) SPAWN — echo the master's authorship: the real prompt (truncated) + the
  //    granted skills, per the event contract. Plus the CREDIT signals the master
  //    authored on this agent (§2.4): grantProvenance ([{skill,fromLesson}] — which
  //    recalled lesson motivated which granted tool) and credit ({flaw,attributedTo}
  //    — the prior-turn miss this role is being held to). Both are PASS-THROUGH from
  //    the master-authored agent object and both are OPTIONAL: we omit the field
  //    entirely when absent (app.js renderGrantProvenance/renderCredit no-op on
  //    absence; app.js:240/261 + graph seeds at app.js:847/850). No-memory spawns
  //    carry NEITHER — team.mjs only sets them on the memory page (fairness).
  e({
    type: "agent.spawned",
    agentId,
    role,
    version,
    prompt: instructions.slice(0, 200),
    skills: granted,
    ...(Array.isArray(agent.grantProvenance) && agent.grantProvenance.length
      ? { grantProvenance: agent.grantProvenance }
      : {}),
    ...(agent.credit && typeof agent.credit === "object" && agent.credit.flaw
      ? { credit: agent.credit }
      : {}),
  });

  // 2) STATUS + TURN — a status line describing what this agent is doing (from
  //    the registry), then a counted turn (orchestrator enforces TURN_CAP).
  e({ type: "agent.status", agentId, doing: statusFor(role, granted, ctx) });
  e({ type: "agent.turn", agentId });

  // 3) GENERIC DISPATCH — run each granted skill in DISPATCH_ORDER, merging
  //    returns into `result`. `critique` ALWAYS runs (both pages), even if the
  //    master didn't explicitly grant it (C4 — a neutral quality capability the
  //    spine depends on). Each skill is ALLOW-LISTED before it runs.
  let result;
  for (const name of DISPATCH_ORDER) {
    const isCritique = name === "critique";
    const wantsRun = grantedSet.has(name) || isCritique;
    if (!wantsRun) continue;

    const entry = SKILL_REGISTRY[name];
    if (!entry) continue; // unknown tool name — silently skipped (master may over-grant)

    // CALL-TIME ALLOW-LISTING (structural A/B enforcement):
    //   - cognee_recall/cognee_trace MUST only run on the memory page; a grant on
    //     the no-memory page is a fairness violation — THROW (never silently run).
    //   - every other skill is symmetric (both pages).
    if (MEMORY_ONLY_SKILLS.has(name) && page !== "memory") {
      throw new Error(
        `runAgent: skill "${name}" is memory-only but page is "${page}" ` +
        `(agent "${role}") — the {cognee_recall, cognee_trace} bundle is the ONLY ` +
        `memory-exclusive capability; granting it to no-memory breaks A/B fairness.`
      );
    }

    result = await entry.run({ agent, agentId, gen, page, ctx, deps, emit: e, result });
  }

  // Fallback: an agent with NO dispatched skill still makes a real call so it's
  // never cosmetic — it reasons on its own instructions and returns text. (The
  // always-run critique only sets findings; if nothing produced a primary result
  // we still want a real call.)
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

// ---- status line per agent (generated from the registry) ------------------
// Picks the highest-priority granted skill's status() (DISPATCH_ORDER priority),
// falling back to a role-based line for tool-less / role-only agents. No regex.
function statusFor(role, granted, ctx) {
  const grantedSet = new Set(granted);
  for (const name of DISPATCH_ORDER) {
    if (name === "critique") continue; // critique is always-run; don't let it mask the primary skill
    if (grantedSet.has(name) && SKILL_REGISTRY[name]) {
      return SKILL_REGISTRY[name].status({ role, ctx });
    }
  }
  if (grantedSet.has("critique")) return SKILL_REGISTRY.critique.status({ role, ctx });
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
// VERBATIM in-run recall (C2/H5). Uses the threaded sessionId (sess_<runId>_<page>),
// NOT the legacy `${page}-run` hardcode. The cross-run `recallLessons` path is GONE
// (C1d — no cross-run learning). `recallInRun` now returns { hits, qa_id }; we read
// `.hits` and thread `qa_id` onto ctx for the orchestrator's feedback step.
async function runRecall({ agent, agentId, page, ctx, deps, emit }) {
  const { memory } = deps;
  const sessionId = sessionIdFrom(ctx, page);
  const q = recallQuery(agent, ctx);

  // Optional read filter: scope to this agent's role + the brand tokens we care
  // about, OR-joined by the bridge. Best-effort; the bridge tolerates absence.
  const nodeName = [agent.role].filter(Boolean);

  let hits = [];
  let qa_id = null;
  try {
    const recalled = (await memory.recallInRun(sessionId, q, { nodeName })) || {};
    hits = Array.isArray(recalled.hits) ? recalled.hits : [];
    qa_id = recalled.qa_id ?? null;
  } catch {
    hits = [];
    qa_id = null;
  }

  // Thread qa_id onto ctx so the orchestrator's feedback step can resolve it.
  if (ctx && typeof ctx === "object") ctx.qa_id = qa_id;

  // hits surfaced to the UI: the verbatim in-run trace snippets.
  emit({ type: "memory.recalled", agentId, hits });

  // The recalled VERBATIM snippets become raw fix-rules the orchestrator threads
  // onto ctx.rules (output.inRun preserves the legacy threadResult contract).
  const inRun = hits.map((h) => ({ snippet: h.snippet, role: h.role || "memory" }));
  return {
    role: agent.role,
    produces: "recall",
    output: { inRun, qa_id },
    // hoisted for convenience: treat verbatim snippets as recalled "rules" the
    // builder must honor. (No distilled lesson objects on this path anymore.)
    lessons: inRun.map((r) => ({ statement: r.snippet })),
  };
}

// ---- tool: html_build (Codex; writes snapshot; returns htmlRef) -----------
// Consumes the typed BUILD BRIEF (Phase 2.3): every non-builder agent fills a
// named slot on ctx.brief and the builder consumes the WHOLE brief — no dropped
// agent output. Slots: copy, sectionOrder, layoutDirection, typeScale,
// imageDirective, mustFix[]. mustFix carries THIS turn's critique findings into
// THIS turn's build (1.7). NO regex lesson-selection.
async function runHtmlBuild({ agent, agentId, gen, page, ctx, deps, emit }) {
  const { codexBuildSite, brand, goal } = deps;
  const brief = (ctx && ctx.brief) || {};

  // The single recalled rule to enforce as the build's lead "lesson" — prefer the
  // first verbatim recalled rule, else any the orchestrator threaded into ctx
  // (memory page). null on the no-memory page. (No regex selection — the recall
  // is already feedback-ranked so the first hit is the proven one.)
  const lessonText =
    firstRule(ctx?.lessons) ||
    (ctx?.lessonForBuild ? String(ctx.lessonForBuild) : null) ||
    (ctx?.lesson ? String(ctx.lesson) : null);

  // Fold the agent's own master-authored instructions into the copy hint so the
  // build reflects what THIS agent was told to do (not a generic template).
  let copyHint = [ctx?.copyHint, agent.instructions]
    .filter(Boolean)
    .join(". ")
    .slice(0, 600);

  // TYPED BUILD BRIEF — append every filled slot so the builder consumes the
  // whole brief (the slot-filling agents' output is never dropped). Appended
  // AFTER the 600-char truncation so the brief is never clipped.
  const briefBlock = renderBriefBlock(brief);
  if (briefBlock) copyHint += `. ${briefBlock}`;

  // Ground the build from the flat design-token system (designSystemBrief). BOTH
  // pages ground identically from these real tokens — the same proven-good path —
  // so the A/B is fair and the in-run memory win comes purely from recalled traces.
  const dsBrief = designSystemBrief(brand);
  if (dsBrief) copyHint += `. ${dsBrief}`;

  // Hero imagery: prefer an image_gen data URI (ctx.heroImage); else any inline
  // SVG directive an svg_image agent filled into the brief. Append AFTER the
  // truncation so the (long) data URI / SVG isn't clipped.
  if (ctx?.heroImage) {
    copyHint += `. Embed this exact on-brand hero image as the hero visual via <img alt="TikTok for Business hero" src="${ctx.heroImage}">`;
  } else if (brief.imageDirective) {
    copyHint += `. ${brief.imageDirective}`;
  }

  // Thread the concrete brand/design FIX-RULES into the build. These come from
  // (a) the recalled in-run traces the orchestrator folded onto ctx.rules and
  // (b) THIS turn's critique findings (brief.mustFix). codexBuildSite applies
  // every rule verbatim on a fresh build. Only pass a clean array of non-empty
  // strings; absent/empty => the build is unchanged (no-memory page has only
  // its own same-turn mustFix, never recalled prior-turn rules).
  const rules = dedupeRules([
    ...asLines(ctx?.rules),
    ...asLines(brief.mustFix),
  ]);

  // IN-RUN SELF-IMPROVEMENT: if a prior-turn page was carried in (ctx.priorPageHtml),
  // IMPROVE it (codexBuildSite REVISE mode via priorHtml) instead of building from scratch.
  // Turn 0 has none -> fresh build. Both pages do this; the memory page's `rules` carry the
  // recalled prior-turn fixes that guide the improvement (no-memory's rules are empty).
  const priorPageHtml =
    ctx && typeof ctx.priorPageHtml === "string" && ctx.priorPageHtml.trim()
      ? ctx.priorPageHtml
      : null;
  const html = await codexBuildSite({
    brand,
    goal,
    copyHint,
    lesson: lessonText,
    ...(rules.length ? { rules } : {}),
    ...(priorPageHtml ? { priorHtml: priorPageHtml } : {}),
  });

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

// ---------------------------------------------------------------------------
// reviseHtml — the IN-RUN "recall traces -> revise THIS page" loop.
//
// This is the second half of the memory win: the critique's CONCRETE findings
// (raw traces recalled in-run, NOT distilled) are fed back to Codex as numbered
// fix-rules ALONGSIDE the prior HTML, and Codex returns a CORRECTED full document
// that applies EVERY rule (accent added, gradient removed, buzzword cut) while
// staying on the design system. The SAME gen page visibly improves — so memory
// wins. The no-memory studio never calls this, so it keeps its flaws.
//
// Frozen interface (coded to exactly):
//   reviseHtml({ brand, goal, priorHtml, rules, page, gen, seq, deps, emit, snapDir })
//     -> { html, htmlRef }
//
// - Calls deps.codexBuildSite({ brand, goal, priorHtml, rules }) — priorHtml
//   triggers REVISE MODE in codex.mjs (correct the prior doc against the rules).
// - Writes the snapshot as `<page>-g<gen>-revise-s<seq>.html`.
// - Emits agent.status("revising the page from recalled traces") BEFORE the build
//   and design.rendered{htmlRef} AFTER the corrected page is written.
// - THROWS on failure (no fallback) — a failed revise must surface, not paper over.
// ---------------------------------------------------------------------------
export async function reviseHtml({ brand, goal, priorHtml, rules, page, gen, seq, deps, emit, snapDir: snapDirArg }) {
  if (!deps || typeof deps.codexBuildSite !== "function") {
    throw new Error("reviseHtml: deps.codexBuildSite is required");
  }
  if (!priorHtml || !String(priorHtml).trim()) {
    throw new Error("reviseHtml: priorHtml is required to revise (no fallback)");
  }
  const e = typeof emit === "function" ? emit : () => {};
  const b = brand || deps.brand;
  const g = goal || deps.goal;
  const agentId = `${page}-revise-g${gen}`;

  // Normalize the recalled traces into a clean array of concrete fix-rules.
  const ruleList = asLines(rules).map((s) => s.trim()).filter(Boolean);

  // Announce the in-run revise so the UI shows memory acting on its own traces.
  e({ type: "agent.status", agentId, doing: "revising the page from recalled traces" });

  // REVISE MODE: priorHtml + numbered rules => a corrected full HTML doc that
  // applies EVERY rule, still on the design system. No fallback — throws on fail.
  const html = await deps.codexBuildSite({
    brand: b,
    goal: g,
    priorHtml: String(priorHtml),
    rules: ruleList,
  });

  // Persist the corrected snapshot under the frozen revise name. Prefer the
  // explicitly-passed snapDir; fall back to the module's env-resolved one so a
  // caller that omits it (or a test) still writes somewhere isolated.
  const dir = snapDirArg || snapDir();
  const s = Number.isFinite(seq) ? seq : 1;
  const fileName = `${page}-g${gen}-revise-s${s}.html`;
  try { await mkdir(dir, { recursive: true }); } catch { /* ignore */ }
  await writeFile(path.join(dir, fileName), html, "utf8");
  const htmlRef = path.posix.join("snapshots", fileName);

  // The corrected page replaces the prior one in the live preview.
  e({ type: "design.rendered", htmlRef });

  return { html, htmlRef };
}

// ---- design-system brief (REAL tokens -> a build directive) ----------------
// codexBuildSite only consumes brand colors/fonts/tone/dont; it ignores the
// rich design system on brand.tokens / brand.designSystemCss. This distills the
// token roles, type scale, spacing/radius and the design-system's hard usage
// rules into a compact directive we thread through copyHint so the produced page
// actually uses the real palette + system, not a generic Tailwind look.
// Returns "" if no tokens are present (so legacy brands still build unchanged).
// This is the SHARED brand grounding — BOTH pages ground from it identically.
function designSystemBrief(brand) {
  const tokens = brand && brand.tokens;
  const roles = tokens && tokens.color && tokens.color.roles;
  if (!roles) return "";

  const parts = [];
  parts.push(
    "Use the brand DESIGN SYSTEM (not generic styling). Color roles: " +
    [
      roles.bg && `bg ${roles.bg}`,
      roles.surface && `surface ${roles.surface}`,
      roles.fg && `text ${roles.fg}`,
      roles.muted && `muted ${roles.muted}`,
      roles.primary && `primary ${roles.primary}`,
      roles.secondary && `secondary/accent ${roles.secondary}`,
      roles.emphasis && `emphasis ${roles.emphasis}`,
    ].filter(Boolean).join(", ") + "."
  );

  // COLOR COMPOSITION RULES from the brand book (the heart of on-brand layout):
  // one brand color per composition, focus via black/white, Razzmatazz-only text
  // emphasis, Splash never on text, never invent new colors.
  const usage = tokens.color && tokens.color.usage;
  if (usage) {
    if (usage.razzmatazz) parts.push(`Razzmatazz #FE2C55 (primary): ${usage.razzmatazz}`);
    if (usage.splash) parts.push(`Splash #25F4EE (accent): ${usage.splash}`);
    if (usage.neutrals) parts.push(`Neutrals: ${usage.neutrals}`);
  }
  parts.push("Use ONE brand color per composition; create focus with black or white; never invent new colors.");

  // TYPOGRAPHY: Sofia Pro for headings/body; Sofia Pro Soft for emphasis ONLY.
  const families = tokens.type && tokens.type.families;
  if (families) {
    parts.push(
      `Typography: Sofia Pro is the heading/body typeface; Sofia Pro Soft is for EMPHASIS only ` +
      `(combine with Sofia Pro to highlight ONE keyword, in Razzmatazz). Left or center align; ` +
      `no all-caps/all-lowercase headlines; no gradients/shadows on type; never set body copy in Bold.`
    );
  }

  // Type scale (largest few steps) so headings honor the real scale.
  const scale = tokens.type && Array.isArray(tokens.type.scale) ? tokens.type.scale : [];
  if (scale.length) {
    const steps = scale
      .slice()
      .sort((a, b) => (b.px || 0) - (a.px || 0))
      .slice(0, 3)
      .map((s) => `${s.name || "step"} ${s.px}px/${s.weight || 400}`)
      .join(", ");
    if (steps) parts.push(`Type scale (top sizes): ${steps}.`);
  }

  // Spacing + radius rhythm so layout matches the system's grid.
  const space = tokens.space;
  if (Array.isArray(space) && space.length) {
    parts.push(`Spacing scale (8px rhythm, px): ${space.join(", ")} — use these for padding/margins, with generous section padding (96/128px).`);
  }
  const radius = tokens.radius;
  if (radius) {
    const named = radius.named && Object.entries(radius.named)
      .map(([k, v]) => `${k} ${v}`).join(", ");
    if (named) parts.push(`Radius tokens: ${named}. CTA buttons are PILLS (100% roundness); image masks use 25%/50%; roundness limited to 25/50/100%.`);
  }

  // DEPTH/EFFECTS: NO shadows — flat color blocks + layered shapes.
  parts.push("Depth/effects: NO drop shadows or other effects — create depth with FLAT color blocks + layered shapes, not shadows. NO gradients.");

  // SHAPES: bubbles derived from the TikTok logo circles.
  const shapes = tokens.shapes;
  if (shapes) {
    const rot = shapes.imageRotationIncrementDeg || 10;
    parts.push(`Shapes: use BUBBLES derived from the two circles in the TikTok logo (and bubbles/pills as CTAs); images may rotate in ${rot}° increments.`);
  }

  // Hard usage rules baked into the system. Prefer rules pulled from the actual
  // stylesheet comment header so they track design-system.css, with safe defaults.
  const ruleLines = designSystemRules(brand.designSystemCss);
  if (ruleLines.length) parts.push(`DESIGN-SYSTEM RULES: ${ruleLines.join(" ")}`);

  // Point Codex at the real stylesheet so it can mirror the .ds-* utilities.
  if (brand.designSystemPath) {
    parts.push(
      `These tokens come from the design system at ${brand.designSystemPath}; ` +
      `define matching CSS variables (--color-*, --font-*, --space-*, --radius-*) ` +
      `in a <style> block and build with them.`
    );
  }

  // COMPONENT COMPOSITION (COMPONENTS.md §2-§3): the design system is the single
  // source of truth — COMPOSE the page out of these named .ds-* components, do NOT
  // inline-style raw atoms or invent distinctive layout from prose. The class names
  // are the canonical library list and MUST stay identical to the .ds-* classes in
  // design-system.css and the Component node ids in brand.mjs (cross-lane contract).
  parts.push(
    "COMPOSE THE PAGE FROM THESE NAMED COMPONENTS (do NOT inline-style raw atoms, do NOT invent layout from scratch): " +
    "use .ds-hero (split full-bleed hero) for the opening; .ds-feature-grid with .ds-grid-3 for features; " +
    ".ds-stat-band for proof numbers; .ds-steps with .ds-grid-3 for how-it-works; .ds-cta-band for the closing " +
    "call to action; .ds-figure (with .ds-figure-25/.ds-figure-50 and an optional .ds-rotate-10) for ALL imagery — " +
    "NEVER a bare rectangle or grey placeholder; .ds-bubble-cluster for the signature overlapping-circle accent; " +
    ".ds-chip for eyebrow labels; and .ds-grid-2/.ds-grid-3 for any multi-column row. Drop the component skeletons " +
    "in and fill real copy."
  );
  return parts.join(" ");
}

// Extract the design system's hard usage rules. Reads the "Hard brand rules"
// block from the stylesheet header when available so the directive stays in sync
// with web/run/design-system.css; otherwise falls back to the known invariants.
function designSystemRules(css) {
  const text = String(css || "");
  const rules = [];
  if (text) {
    // The stylesheet header lists rules as " - <rule>" lines under a heading.
    const block = text.match(/hard brand rules[^\n]*\n([\s\S]*?)\*\//i);
    const body = block ? block[1] : "";
    for (const line of body.split("\n")) {
      const m = line.match(/^\s*[-•]\s*(.+?)\s*$/);
      if (m && m[1]) rules.push(m[1].replace(/\s+/g, " ").trim());
    }
  }
  if (rules.length) return rules.slice(0, 6);
  // Defaults mirror the system's invariants when the css header isn't parseable.
  return [
    "NO gradients.",
    "NO drop shadows / effects.",
    "One brand color per composition; pair with black or white.",
    "Razzmatazz (#FE2C55) is the ONLY color allowed to emphasize text.",
    "Splash (#25F4EE) NEVER highlights text; on Splash, text is black.",
    "100%-round pills are reserved for CTA buttons.",
  ];
}

// ---- tool: svg_image (Codex; inline <svg>) --------------------------------
async function runSvgImage({ agent, deps, ctx }) {
  const { codexRun, brand } = deps;
  const c = brand?.colors || {};
  // Use the design-system color roles when present so the SVG matches the page.
  const roles = brand?.tokens?.color?.roles || {};
  const primary = roles.primary || c.primary;
  const accent = roles.secondary || c.accent;
  const prompt =
    groundedPrompt(agent, deps, ctx) + "\n\n" +
    `Produce ONE inline, self-contained, FLAT <svg> illustration on brand ` +
    `(primary ${primary}, accent ${accent}). Solid fills only — NO gradients, ` +
    `NO external images, NO <defs><linearGradient>. ` +
    `OUTPUT ONLY the <svg>...</svg> element, nothing else.`;
  const raw = await codexRun(prompt, { timeoutMs: 120_000 });
  const svg = extractSvg(raw);
  if (!svg) throw new Error("svg_image: Codex returned no <svg> element");
  return svg;
}

// ---- tool: image_gen (REAL on-brand image; threads a data URI to embed) ----
// Calls generateImage({prompt,brand}) from ./image.mjs (frozen {path,dataUri}).
// The data URI is threaded onto ctx.heroImage so the html_build agent embeds it,
// and returned as result.output. A test may inject deps.generateImage to stub.
async function runImageGen({ agent, agentId, page, ctx, deps, emit }) {
  const { brand } = deps;

  // NO-KEY BEHAVIOR (build-quality): the OpenAI Images API (image.mjs) requires
  // OPENAI_API_KEY. Without a key we DO NOT inject a synthetic hero — the old
  // keyless template SVG rendered as amateur colored-block junk and read as
  // "unfinished". Instead we ship NO hero image; the builder then produces a strong
  // TYPE-LED hero (the build prompt forbids invented/placeholder graphics). When a
  // key IS set, real gpt-image-1 art flows below. Identical on BOTH pages (fairness,
  // never _ablate-gated): both get a real image with a key, neither without — so no
  // image-capability asymmetry is introduced.
  const injected = typeof deps?.generateImage === "function";
  if (!injected && !process.env.OPENAI_API_KEY) {
    emit({ type: "agent.status", agentId, doing: "no hero image (no OPENAI_API_KEY) — type-led hero" });
    return {
      role: agent.role,
      produces: "image",
      output: { dataUri: "", path: "", skipped: "no_api_key" },
    };
  }

  const c = brand?.colors || {};
  // Prefer the design system's resolved color roles when present so the image
  // uses the same palette/contrast pairing the page will (e.g. on Splash, black).
  const roles = brand?.tokens?.color?.roles || {};
  const primary = roles.primary || c.primary;
  const accent = roles.secondary || c.accent;
  const bg = roles.bg || c.bg;
  const prompt = [
    groundedPrompt(agent, deps, ctx),
    "",
    `Generate ONE polished, on-brand HERO IMAGE for a "${deps?.goal || "TikTok for Business"}" marketing page — a real, concrete marketing subject (e.g. a creator filming a short vertical video on a phone, a phone showing a short-form video feed, or the product UI in use), NOT abstract colored blocks or shapes.`,
    `Style: flat, bold, ${Array.isArray(brand?.tone) ? brand.tone.join("/") : brand?.tone}; clean composition with a clear focal subject.`,
    `Use only the brand design-system palette (primary ${primary}, accent ${accent} on ${bg}). NO gradients, no off-palette colors, no generic AI stock look, no text/lorem baked into the image.`,
  ].join("\n");

  // Prefer an injected generateImage (tests/orchestrator), else load image.mjs.
  // image.mjs is built in parallel; if it isn't present yet, OR the API errors at
  // runtime, degrade gracefully (the agent still completes, just without an
  // embedded image) rather than crash the run.
  let img = null;
  try {
    const gen = injected ? deps.generateImage : await loadGenerateImage();
    // image.mjs's frozen signature requires a non-empty `name` (it slugifies it
    // into the output filename and throws if absent). Derive a stable per-page
    // per-generation name so concurrent builds don't collide.
    img = await gen({ prompt, brand, name: `hero-${page}-${agent.version || 1}` });
  } catch {
    img = null;
  }

  const dataUri = img && typeof img.dataUri === "string" ? img.dataUri : "";
  const imgPath = img && typeof img.path === "string" ? img.path : "";

  // Thread the data URI forward so the builder embeds the produced image.
  if (dataUri && ctx && typeof ctx === "object") ctx.heroImage = dataUri;

  emit({ type: "agent.status", agentId, doing: dataUri ? "generated an on-brand hero image" : "image generation produced no image" });

  return {
    role: agent.role,
    produces: "image",
    output: { dataUri, path: imgPath },
    heroImage: dataUri || undefined,
  };
}

// ---- keyless pure-JS TEMPLATE SVG hero (Phase 2.5) -------------------------
// A truly keyless on-brand hero: composes a FLAT SVG (solid fills only — NO
// gradients) from the brand's design-system color roles + tone, base64-encodes
// it as a data: URI the builder embeds exactly like a generated image. No model
// call, no network, no API key — so the run completes (and shows a hero) on both
// pages regardless of OPENAI_API_KEY. Returns "" only if the brand has no usable
// colors (the builder then ships without a hero, as before).
function templateHeroDataUri(brand, goal) {
  const c = (brand && brand.colors) || {};
  const roles = (brand && brand.tokens && brand.tokens.color && brand.tokens.color.roles) || {};
  const bg = roles.bg || c.bg || "#000000";
  const primary = roles.primary || c.primary || "#FE2C55";
  const accent = roles.secondary || c.accent || "#25F4EE";
  const fg = roles.fg || c.fg || "#FFFFFF";
  if (!primary && !accent) return "";

  // A composed brand SCENE that FILLS the frame (COMPONENTS.md §5) — NOT the old
  // flat-rect + grey-skeleton-bar amateur tell. It reads as the page's own
  // .ds-bubble-cluster + .ds-figure language so the embedded hero matches the
  // composed page: a full-bleed field, two large flat rectangles rotated ±10° and
  // overlapping toward the center (depth via LAYERING, never shadow), then the
  // signature TikTok bubble cluster — a large primary circle, an overlapping
  // accent (Splash) circle, and a small bg circle, derived from the logo's two
  // circles. Solid fills only — NO gradients, NO filter/shadow. There are NO
  // grey text-skeleton bars: the real headline is live .ds-h1 HTML beside this
  // figure, never faked inside the image.
  const W = 1200, H = 630;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="On-brand hero">` +
      `<rect width="${W}" height="${H}" fill="${esc(bg)}"/>` +
      `<g transform="rotate(-10 ${W * 0.34} ${H * 0.5})"><rect x="${W * 0.06}" y="${H * 0.16}" width="${W * 0.52}" height="${H * 0.68}" fill="${esc(primary)}"/></g>` +
      `<g transform="rotate(10 ${W * 0.7} ${H * 0.5})"><rect x="${W * 0.5}" y="${H * 0.1}" width="${W * 0.42}" height="${H * 0.5}" fill="${esc(fg)}" opacity="0.96"/></g>` +
      `<circle cx="${W * 0.7}" cy="${H * 0.62}" r="${H * 0.22}" fill="${esc(primary)}"/>` +
      `<circle cx="${W * 0.82}" cy="${H * 0.72}" r="${H * 0.16}" fill="${esc(accent)}"/>` +
      `<circle cx="${W * 0.6}" cy="${H * 0.78}" r="${H * 0.07}" fill="${esc(bg)}"/>` +
    `</svg>`;
  const b64 = Buffer.from(svg, "utf8").toString("base64");
  return `data:image/svg+xml;base64,${b64}`;
}

// Minimal XML-attribute escaper for color/string values placed into SVG markup.
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// REAL QUALITY-CHECK SKILLS (a11y_check / contrast_check / copy_lint)
// Each is a deterministic check on an actual HTML artifact (no model call).
// The orchestrator/builder threads ctx.html; an agent that also built the page
// audits its own fresh output. Issues fold into result.findings + ctx.findings
// and the agent re-emits agent.status naming the skill it ran.
// ---------------------------------------------------------------------------

function runChecks({ agent, agentId, tools, ctx, deps, emit, result }) {
  const has = (t) => tools.includes(t);
  // The HTML this agent audits: prefer what it just produced, else ctx.html.
  const html =
    (result && (result.html || (typeof result.output === "string" ? result.output : ""))) ||
    ctx?.html ||
    "";

  const findings = [];
  const checks = [];

  if (has("a11y_check")) {
    const issues = a11yCheck(html);
    findings.push(...issues);
    checks.push("a11y_check");
    emit({ type: "agent.status", agentId, doing: `a11y_check: ${issues.length} issue(s)` });
  }
  if (has("contrast_check")) {
    const issues = contrastCheck(html, deps?.brand);
    findings.push(...issues);
    checks.push("contrast_check");
    emit({ type: "agent.status", agentId, doing: `contrast_check: ${issues.length} issue(s)` });
  }
  if (has("copy_lint")) {
    const issues = copyLint(html);
    findings.push(...issues);
    checks.push("copy_lint");
    emit({ type: "agent.status", agentId, doing: `copy_lint: ${issues.length} issue(s)` });
  }

  // Fold issues into the shared run context so the builder/critique sees them.
  if (findings.length && ctx && typeof ctx === "object") {
    ctx.findings = [...(ctx.findings || []), ...findings];
  }

  // Merge with any prior findings on this agent's result (e.g. a critique that
  // also holds a check) so nothing is dropped.
  const priorFindings = (result && Array.isArray(result.findings)) ? result.findings : [];
  return {
    role: agent.role,
    produces: result && result.produces && result.produces !== "text" ? result.produces : "audit",
    output: { checks, issues: findings },
    findings: [...priorFindings, ...findings],
  };
}

// --- a11y_check: real, checkable accessibility issues in the HTML -----------
export function a11yCheck(html) {
  const out = [];
  const h = String(html || "");
  if (!h.trim()) return out;

  // 1) <img> without a non-empty alt attribute.
  const imgs = h.match(/<img\b[^>]*>/gi) || [];
  let imgMissingAlt = 0;
  for (const tag of imgs) {
    const m = tag.match(/\balt\s*=\s*("([^"]*)"|'([^']*)'|[^\s>]+)/i);
    const alt = m ? (m[2] ?? m[3] ?? m[1] ?? "").trim() : "";
    if (!m || !alt) imgMissingAlt++;
  }
  if (imgMissingAlt > 0) {
    out.push(`a11y: ${imgMissingAlt} <img> element(s) missing meaningful alt text.`);
  }

  // 2) Icon-only / empty buttons & links without an accessible name.
  const interactive = h.match(/<(button|a)\b[^>]*>([\s\S]*?)<\/\1>/gi) || [];
  let unnamed = 0;
  for (const el of interactive) {
    const open = el.match(/<(button|a)\b[^>]*>/i)?.[0] || "";
    const inner = el.replace(/<(button|a)\b[^>]*>/i, "").replace(/<\/(button|a)>$/i, "");
    const text = inner.replace(/<[^>]*>/g, "").replace(/&[a-z]+;/gi, " ").trim();
    const hasAria = /\baria-label\s*=\s*("[^"]+"|'[^']+'|[^\s>]+)/i.test(open) ||
                    /\baria-labelledby\s*=/i.test(open) ||
                    /\btitle\s*=\s*("[^"]+"|'[^']+')/i.test(open);
    // an anchor that is purely a wrapper around an <img> with alt is OK
    const wrapsAltImg = /<img\b[^>]*\balt\s*=\s*("[^"]+"|'[^']+')/i.test(inner);
    if (!text && !hasAria && !wrapsAltImg) unnamed++;
  }
  if (unnamed > 0) {
    out.push(`a11y: ${unnamed} button/link(s) have no accessible name (need text or aria-label).`);
  }

  // 3) Document language not declared.
  if (/<html\b/i.test(h) && !/<html\b[^>]*\blang\s*=/i.test(h)) {
    out.push("a11y: <html> is missing a lang attribute.");
  }

  return out;
}

// --- contrast_check: parse inline colors, flag low-contrast text/bg pairs ---
export function contrastCheck(html, brand) {
  const out = [];
  const h = String(html || "");
  if (!h.trim()) return out;

  // Pull inline style="..." blocks and look for color + background pairs.
  const styles = h.match(/style\s*=\s*("([^"]*)"|'([^']*)')/gi) || [];
  let flagged = 0;
  for (const s of styles) {
    const body = (s.match(/style\s*=\s*("([^"]*)"|'([^']*)')/i) || [])[2] ??
                 (s.match(/style\s*=\s*'([^']*)'/i) || [])[1] ?? "";
    const color = parseColor(getDecl(body, "color"));
    const bg = parseColor(getDecl(body, "background-color")) || parseColor(getDecl(body, "background"));
    if (color && bg) {
      const ratio = contrastRatio(color, bg);
      if (ratio < 4.5) {
        flagged++;
        out.push(`contrast: text/bg pair ${hex(color)} on ${hex(bg)} ratio ${ratio.toFixed(2)} is below WCAG AA (4.5:1).`);
      }
    }
  }

  // Brand-specific: accent cyan on white/light is a known low-contrast trap.
  const accent = parseColor(brand?.colors?.accent || "#25F4EE");
  if (accent && flagged === 0) {
    // only a hint, not a hard finding, if the accent text sits on a light bg literal
    const bg = parseColor(brand?.colors?.bg || "#000000");
    if (bg) {
      const ratio = contrastRatio(accent, bg);
      if (ratio < 3) {
        out.push(`contrast: brand accent ${hex(accent)} on bg ${hex(bg)} is only ${ratio.toFixed(2)}:1 — avoid accent text on that background.`);
      }
    }
  }

  return out;
}

// --- copy_lint: flag banned business buzzwords in copy/HTML -----------------
export function copyLint(html) {
  const out = [];
  const lower = String(html || "").toLowerCase();
  if (!lower.trim()) return out;
  for (const word of BANNED_BUZZWORDS) {
    const re = new RegExp(`(^|[^a-z])${escapeRegExp(word.toLowerCase())}([^a-z]|$)`, "i");
    if (re.test(lower)) {
      out.push(`copy_lint: banned buzzword "${word}" — brand voice avoids business jargon.`);
    }
  }
  return out;
}

// ---- color helpers for contrast_check (WCAG relative luminance) ------------
function getDecl(styleBody, prop) {
  const re = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, "i");
  const m = String(styleBody || "").match(re);
  return m ? m[1].trim() : "";
}

function parseColor(v) {
  if (!v) return null;
  const s = String(v).trim();
  let m = s.match(/#([0-9a-f]{6})\b/i);
  if (m) {
    const n = parseInt(m[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  m = s.match(/#([0-9a-f]{3})\b/i);
  if (m) {
    const [a, b, c] = m[1].split("");
    return { r: parseInt(a + a, 16), g: parseInt(b + b, 16), b: parseInt(c + c, 16) };
  }
  m = s.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (m) return { r: +m[1], g: +m[2], b: +m[3] };
  const named = { black: "#000000", white: "#ffffff", red: "#ff0000" };
  if (named[s.toLowerCase()]) return parseColor(named[s.toLowerCase()]);
  return null;
}

function hex(c) {
  if (!c) return "?";
  const h2 = (n) => n.toString(16).padStart(2, "0");
  return `#${h2(c.r)}${h2(c.g)}${h2(c.b)}`;
}

function relLuminance({ r, g, b }) {
  const ch = (v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

function contrastRatio(a, b) {
  const la = relLuminance(a);
  const lb = relLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

// ---- structured language tools (real chatJSON) ----------------------------
// The schema is chosen EXPLICITLY by the registry entry (copywriter→"copy",
// info_architect→"ia", typographer→"type") — no role-name regex routing. Each
// fills a TYPED BUILD-BRIEF slot on ctx.brief so the builder consumes it.
async function runLanguageTool({ agent, deps, ctx, schema }) {
  const role = agent.role;
  const grounded = groundedPrompt(agent, deps, ctx);
  if (ctx && typeof ctx === "object") ctx.brief = ctx.brief || {};

  let sys;
  if (schema === "copy") {
    sys = 'Return ONLY JSON: {"hero":string,"angle":string}. ' +
      "hero = a punchy hero headline (no business jargon/buzzwords); " +
      "angle = a one-line copy direction for the whole page.";
  } else if (schema === "ia") {
    sys = 'Return ONLY JSON: {"sections":[string,...]}. ' +
      "5 section names ordered for conversion.";
  } else if (schema === "type") {
    sys = 'Return ONLY JSON: {"scale":string,"notes":string}. ' +
      "scale = a concise type-scale recommendation; notes = font usage guidance.";
  } else {
    // Defensive default — registry never passes an unknown schema.
    sys = 'Return ONLY JSON: {"notes":string}.';
  }

  const obj = await safeChatJSON(deps, [
    { role: "system", content: `You are the ${role} for a TikTok marketing site team. ${sys}` },
    { role: "user", content: grounded },
  ]);

  // Normalize each schema into a stable {output, ...threaded} shape AND fill the
  // typed BUILD BRIEF slot it owns (so no agent output is dropped — Phase 2.3).
  if (schema === "copy") {
    const hero = String(obj?.hero || "").trim();
    const angle = String(obj?.angle || "").trim();
    const parts = [];
    if (hero) parts.push(`Hero headline tone: "${hero}"`);
    if (angle) parts.push(angle);
    const copyHint = parts.join(". ");
    if (ctx?.brief) ctx.brief.copy = { hero, angle };
    return { role, produces: "copy", output: { hero, angle }, copyHint };
  }
  if (schema === "ia") {
    const sections = asLines(obj?.sections).slice(0, 5);
    if (ctx?.brief && sections.length) ctx.brief.sectionOrder = sections;
    return { role, produces: "ia", output: { sections }, sections };
  }
  // schema === "type"
  const scale = String(obj?.scale || "");
  const notes = String(obj?.notes || "");
  if (ctx?.brief) {
    const ts = [scale, notes].filter(Boolean).join(" — ");
    if (ts) ctx.brief.typeScale = ts;
  }
  return { role, produces: "type", output: { scale, notes } };
}

// ---- skill: critique (ALWAYS-RUN, both pages; all-LLM vision when available) -
// The neutral quality capability the spine depends on (C4). Prefers the all-LLM
// vision critique (deps.codexCritique → [{flaw, brandRuleCited, severity}]);
// severity comes from that STRUCTURED field — the ONLY severity source (no
// regex). Falls back to the structured-JSON language critique when codexCritique
// is unavailable (tests / compile-safety). Findings flow into BOTH the trace set
// (result.critiqueFindings, consumed by cognee_trace) AND the build brief's
// mustFix[] so same-turn findings reach the same-turn build (1.7). NEVER throws
// out of runAgent (a critique miss != a dead run) — the orchestrator owns the
// loud failure path for the vision critique it drives at turn-loop level.
async function runCritique({ agent, agentId, page, ctx, deps, emit, result }) {
  if (ctx && typeof ctx === "object") ctx.brief = ctx.brief || {};

  // The HTML this critique audits: prefer the agent's own fresh build, else ctx.html.
  const html =
    (result && (result.html || (typeof result.output === "string" ? result.output : ""))) ||
    ctx?.html ||
    "";

  let structured = [];

  // 1) Prefer the all-LLM vision critique. The orchestrator renders the pre-revise
  //    PNG and passes screenshotPath; if absent, codexCritique renders from html.
  if (typeof deps?.codexCritique === "function") {
    try {
      const out = await deps.codexCritique({
        brand: deps.brand,
        goal: deps.goal,
        screenshotPath: ctx?.critiqueShot || "",
        html,
      });
      // codexCritique now returns {findings, upgrade, strengths}; accept a bare array too (back-compat).
      const arr = Array.isArray(out?.findings) ? out.findings : (Array.isArray(out) ? out : []);
      structured = arr.filter((f) => f && (f.flaw || f.finding));
    } catch {
      // codexCritique THROWS on Codex failure (no silent fallback at its layer);
      // we catch HERE so a critique miss doesn't kill the run, then degrade to the
      // language critique below.
      structured = [];
    }
  }

  // 2) Fallback: structured-JSON language critique (no vision). Still all-LLM, no
  //    regex; severity defaults to "med" since this path has no structured field.
  if (!structured.length) {
    const grounded = groundedPrompt(agent, deps, ctx);
    const obj = await safeChatJSON(deps, [
      { role: "system", content:
        `You are the critique auditor for a TikTok marketing site team. ` +
        `Return ONLY JSON: {"findings":[string,...]} — 1-4 concrete, actionable ` +
        `brand/design problems (cite the brand DON'Ts where relevant).` },
      { role: "user", content: grounded },
    ]);
    let findings = asLines(obj?.findings);
    if (findings.length === 0) findings = ["Strengthen visual hierarchy; emphasize the primary CTA."];
    structured = findings.map((flaw) => ({ flaw, brandRuleCited: "", severity: "med" }));
  }

  // Plain finding strings for the UI / downstream string consumers.
  const findingStrings = structured.map((f) => String(f.flaw ?? f.finding ?? "")).filter(Boolean);

  // Feed THIS turn's findings into the build brief's mustFix so the same-turn
  // build (if it runs after critique) and the orchestrator's revise see them.
  if (ctx?.brief && findingStrings.length) {
    ctx.brief.mustFix = dedupeRules([...(asLines(ctx.brief.mustFix)), ...findingStrings]);
  }
  // Also fold into ctx.findings so the orchestrator's critique.made / trace paths
  // (and any same-agent cognee_trace) see them.
  if (ctx && typeof ctx === "object" && findingStrings.length) {
    ctx.findings = [...(ctx.findings || []), ...findingStrings];
  }

  emit({ type: "critique.made", findings: findingStrings });

  return {
    role: agent.role,
    produces: "critique",
    output: { findings: findingStrings },
    findings: findingStrings,
    // structured findings (with severity) for cognee_trace — severity preserved.
    critiqueFindings: structured,
  };
}

// ---- tool: cognee_trace (write findings to memory) ------------------------
// Uses the threaded sessionId (H4). NO severity regex (0.5): severity comes from
// the structured `codexCritique` finding ({flaw, brandRuleCited, severity}); a
// plain-string finding (e.g. an a11y/contrast check) defaults to "med". The
// node_set write-tag carries [role, severity] so later recall can scope on them.
async function runTrace({ agent, agentId, page, ctx, deps, emit, result }) {
  // VERIFIED-TRACING (memory fix): the orchestrator is now the SOLE tracer and writes a
  // trace ONLY after the resolved-proof confirms the revise actually FIXED a flaw (the
  // admission gate — store proven fixes, not raw complaints). This skill no longer writes
  // raw, un-verified critique flaws to memory — that polluted recall with un-actionable
  // observations that never compounded. Kept as a registered no-op so the roster + the
  // memory-only allow-listing still resolve; the threaded-sessionId invariant is enforced.
  void agent; void agentId; void deps; void emit; void result;
  sessionIdFrom(ctx, page);
}

// Normalize findings (structured critique objects OR plain strings) into trace
// records { finding, severity }. Severity is taken from the structured field
// (the ONLY severity source — no regex). Strings default to "med".
function toFindingRecords(findings) {
  const out = [];
  for (const f of Array.isArray(findings) ? findings : [findings]) {
    if (f == null) continue;
    if (typeof f === "object") {
      const finding = String(f.flaw ?? f.finding ?? "").trim();
      if (!finding) continue;
      const sev = String(f.severity || "med").toLowerCase();
      out.push({ finding, severity: SEVERITIES.has(sev) ? sev : "med" });
    } else {
      const finding = String(f).trim();
      if (finding) out.push({ finding, severity: "med" });
    }
  }
  return out;
}

const SEVERITIES = Object.freeze(new Set(["high", "med", "low"]));

// The first recalled rule to lead the build's "lesson" slot. The recall is
// feedback-ranked (improve() reweights proven fixes higher), so the first hit is
// the proven one — NO regex selection (0.5 removed the gradient/buzzword/accent
// keyword selector). Accepts {statement} objects or plain strings.
function firstRule(lessons) {
  if (!Array.isArray(lessons) || lessons.length === 0) return null;
  const txt = (l) => (l && (l.statement || l)) || "";
  return String(txt(lessons[0])).trim() || null;
}

// Render the typed BUILD BRIEF into a compact directive for the build's copyHint
// channel (codexBuildSite reads copyHint). Only emits slots that are filled, so
// the no-memory page (no recalled mustFix) and partial briefs both build cleanly.
function renderBriefBlock(brief) {
  if (!brief || typeof brief !== "object") return "";
  const parts = [];
  const copy = brief.copy;
  if (copy) {
    if (typeof copy === "string" && copy.trim()) parts.push(`COPY: ${copy.trim()}`);
    else if (typeof copy === "object" && (copy.hero || copy.angle)) {
      const c = [copy.hero && `hero "${copy.hero}"`, copy.angle].filter(Boolean).join(" — ");
      if (c) parts.push(`COPY: ${c}`);
    }
  }
  if (Array.isArray(brief.sectionOrder) && brief.sectionOrder.length) {
    parts.push(`SECTION ORDER: ${brief.sectionOrder.join(", ")}`);
  }
  if (brief.layoutDirection) parts.push(`LAYOUT: ${String(brief.layoutDirection).trim()}`);
  if (brief.typeScale) parts.push(`TYPE SCALE: ${String(brief.typeScale).trim()}`);
  const fixes = asLines(brief.mustFix).map((s) => s.trim()).filter(Boolean);
  if (fixes.length) parts.push(`MUST FIX (this turn): ${fixes.join(" | ")}`);
  return parts.length ? `BUILD BRIEF — ${parts.join(". ")}.` : "";
}

// De-dupe a list of fix-rule strings, trimming + case-insensitively de-duping.
function dedupeRules(list) {
  const out = [];
  const seen = new Set();
  for (const r of Array.isArray(list) ? list : [list]) {
    const s = String(r == null ? "" : r).trim();
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
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
    const calls = { chat: 0, chatJSON: 0, codexBuild: 0, codexRun: 0, recallInRun: 0, writeTrace: 0, genImage: 0, critique: 0 };
    let lastBuildCopyHint = "";
    let lastBuildRules = null;
    let lastBuildPriorHtml = null;
    let lastRecallArgs = null;
    let lastTraceArgs = null;

    const brand = {
      colors: { primary: "#FE2C55", accent: "#25F4EE", bg: "#000000", fg: "#FFFFFF" },
      fonts: { heading: "Inter", body: "Inter" },
      tone: ["bold", "direct"],
      audience: "brands & marketers",
      dont: ["Do not use gradients", "avoid business jargon"],
      sections: ["hero", "problem", "how-it-works", "proof", "cta"],
      // Rich design system (mirrors deconstructBrand()'s additive shape) so we can
      // assert the build is grounded in the real token roles + system rules.
      tokens: {
        color: { roles: { bg: "#000000", surface: "#161616", fg: "#FFFFFF", muted: "#8A8A8A", primary: "#FE2C55", secondary: "#25F4EE", emphasis: "#FE2C55" } },
        type: { scale: [{ name: "body", px: 16, weight: 400 }, { name: "h2", px: 48, weight: 700 }, { name: "h1", px: 72, weight: 700 }] },
        space: [0, 4, 8, 12, 16, 24, 32, 48, 64, 96, 128],
        radius: { named: { sm: "8px", md: "16px", pill: "9999px" } },
      },
      designSystemCss: "/* Hard brand rules baked in here:\n - NO gradients.\n - Splash (#25F4EE) NEVER highlights text; on Splash, text is black.\n*/\n:root{--color-razzmatazz:#FE2C55}\n.ds-btn-primary{}",
      designSystemPath: "run/design-system.css",
    };

    // memory stub mirrors the v3.1 contract: recallInRun returns { hits, qa_id }
    // (NOT a bare array; recallLessons is GONE). writeTrace records the threaded
    // sessionId + nodeSet so we can assert the real sessionId reaches the bridge.
    const memory = {
      async recallInRun(sessionId, q, opts = {}) {
        calls.recallInRun++;
        lastRecallArgs = { sessionId, q, opts };
        return { hits: [{ snippet: "hero had a gradient last run", role: "memory" }], qa_id: "qa_123" };
      },
      async writeTrace(sessionId, rec) { calls.writeTrace++; lastTraceArgs = { sessionId, rec }; allTraceRecs.push({ sessionId, rec }); },
    };
    const allTraceRecs = [];

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
      // all-LLM vision critique stub (the always-run critique uses this when
      // present, so its severity comes from the STRUCTURED field — no regex, and
      // it does NOT consume a chatJSON call).
      async codexCritique() {
        calls.critique++;
        return {
          findings: [
            { flaw: "Hero uses a gradient; brand forbids gradients.", brandRuleCited: "Do not use gradients", severity: "high" },
            { flaw: "Primary CTA lacks the #25F4EE accent.", brandRuleCited: "Do not use gradients", severity: "med" },
          ],
          upgrade: "Make the hero headline oversized and bracket it with two-color emphasis marks for a bolder first impression.",
          strengths: [],
        };
      },
      async codexBuildSite({ copyHint, rules, priorHtml } = {}) {
        calls.codexBuild++;
        lastBuildCopyHint = String(copyHint || "");
        lastBuildRules = Array.isArray(rules) ? rules.slice() : (rules === undefined ? null : rules);
        lastBuildPriorHtml = priorHtml == null ? null : String(priorHtml);
        // Echo any embedded hero image so we can assert the builder used it.
        const imgMatch = lastBuildCopyHint.match(/<img[^>]*src="([^"]+)"[^>]*>/i);
        const img = imgMatch ? imgMatch[0] : "";
        // In REVISE MODE (priorHtml present) emit a CORRECTED doc that visibly
        // applies the rules: drop any gradient + add the accent so the stub
        // mirrors what real codexBuildSite is contracted to do.
        if (priorHtml != null) {
          return `<!doctype html><html lang="en"><head></head><body data-revised="1"><a style='background:#25F4EE;color:#000000'>Get started free</a><h1>Go viral. Get customers.</h1></body></html>`;
        }
        return `<!doctype html><html lang="en"><head></head><body>${img}<a style='background:#25F4EE;color:#000000'>CTA</a></body></html>`;
      },
      async codexRun() { calls.codexRun++; return "<svg viewBox='0 0 10 10'><rect width='10' height='10' fill='#FE2C55'/></svg>"; },
      // Stub for image_gen (image.mjs is built in parallel; frozen {path,dataUri}).
      async generateImage(args) { calls.genImage++; lastImageArgs = args || {}; return { path: "/tmp/hero.png", dataUri: "data:image/png;base64,STUBHEROIMAGE==" }; },
    };
    let lastImageArgs = {};

    // Every runAgent ctx MUST carry the threaded sessionId (CONTRACTS §8 / H4);
    // skills.mjs READS it and refuses to reconstruct the legacy `${page}-run`.
    const sid = (page) => `sess_run_test_${page}`;
    const baseCtx = (page = "memory") => ({ copyHint: "", seq: 0, sessionId: sid(page) });

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
    log(calls.chatJSON === 1, "copywriter: made exactly one real chatJSON call (critique uses codexCritique, not chatJSON)");
    // ALWAYS-RUN critique fires on every agent (both pages, C4) via codexCritique.
    log(calls.critique === 1 && events.some((e) => e.type === "critique.made"), "always-run critique: fires on the copywriter agent");

    // ---- 2) info-architect ----
    calls.chatJSON = 0; calls.critique = 0;
    r = await runAgent({
      agent: { role: "info-architect", version: 1, instructions: "Order 5 sections for conversion.", tools: ["info_architect"] },
      gen: 0, page: "memory", ctx: baseCtx(), deps, emit,
    });
    log(r.produces === "ia" && Array.isArray(r.sections) && r.sections.length === 5, "info-architect: returns 5 sections threaded");

    // ---- 3) critique (explicit grant) returns structured findings + severity ----
    calls.critique = 0;
    const critCtx = baseCtx();
    r = await runAgent({
      agent: { role: "critique", version: 1, instructions: "Audit the page against brand DON'Ts.", tools: ["critique"] },
      gen: 0, page: "memory", ctx: critCtx, deps, emit,
    });
    log(r.produces === "critique" && Array.isArray(r.findings) && r.findings.length >= 1, "critique: returns findings");
    log(Array.isArray(r.critiqueFindings) && r.critiqueFindings[0].severity === "high", "critique: severity comes from the structured field (no regex)");
    log(Array.isArray(critCtx.brief.mustFix) && critCtx.brief.mustFix.length >= 1, "critique: findings flow into ctx.brief.mustFix (same-turn build)");
    log(calls.critique === 1, "critique: explicit grant runs codexCritique exactly once (not double-run)");

    // ---- 4) cognee_recall ----
    events.length = 0;
    const recallCtx = baseCtx();
    r = await runAgent({
      agent: { role: "memory-recaller", version: 1, instructions: "Recall traces before the build.", tools: ["cognee_recall"] },
      gen: 1, page: "memory", ctx: recallCtx, deps, emit,
    });
    log(events.some((e) => e.type === "memory.recalled" && Array.isArray(e.hits) && e.hits.length >= 1), "recall: emits memory.recalled with hits");
    log(Array.isArray(r.output.inRun) && r.output.inRun.length >= 1, "recall: threads verbatim in-run snippets");
    log(calls.recallInRun === 1, "recall: made exactly one real recallInRun call (no cross-run recallLessons)");
    log(lastRecallArgs && lastRecallArgs.sessionId === sid("memory"), "recall: passes the THREADED sessionId (not `${page}-run`)");
    log(r.output.qa_id === "qa_123" && recallCtx.qa_id === "qa_123", "recall: threads qa_id onto ctx (C2)");

    // ---- 5) html_build (writes a snapshot, returns htmlRef) ----
    events.length = 0;
    const buildCtx = { copyHint: "Go viral.", seq: 0, sessionId: sid("memory"), lessons: [{ statement: "Never use gradients." }] };
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
    // the build is grounded in the REAL design system (token roles + system rules)
    log(/DESIGN SYSTEM/i.test(lastBuildCopyHint), "html_build: copyHint carries the design-system directive");
    log(/secondary\/accent #25F4EE/.test(lastBuildCopyHint), "html_build: copyHint names the token color roles");
    log(/DESIGN-SYSTEM RULES/.test(lastBuildCopyHint) && /NO gradients/i.test(lastBuildCopyHint), "html_build: copyHint carries design-system hard rules");
    log(/run\/design-system\.css/.test(lastBuildCopyHint), "html_build: copyHint points at design-system.css");
    log(lastBuildRules == null, "html_build: no ctx.rules -> codexBuildSite gets no rules");

    // ---- 5b) html_build threads ctx.rules (raw trace fix-rules) into the build ----
    // NOTE: the always-run critique also folds its findings into brief.mustFix,
    // which html_build merges WITH ctx.rules — so we assert the explicit rules are
    // passed verbatim (a superset, blanks dropped), not an exact count.
    lastBuildRules = null; calls.codexBuild = 0;
    const rulesCtx = {
      copyHint: "Go viral.", seq: 0, sessionId: sid("memory"),
      rules: ["Add the #25F4EE accent to the primary CTA.", "Remove the hero gradient.", "  ", ""],
    };
    r = await runAgent({
      agent: { role: "frontend-implementer", version: 1, instructions: "Build the page.", tools: ["html_build"] },
      gen: 0, page: "memory", ctx: rulesCtx, deps, emit,
    });
    log(Array.isArray(lastBuildRules) && lastBuildRules.some((x) => /#25F4EE accent/i.test(x)) && lastBuildRules.some((x) => /Remove the hero gradient/i.test(x)), "html_build: passes the concrete ctx.rules fix-rules verbatim (blank rules dropped)");
    log(!lastBuildRules.some((x) => x.trim() === ""), "html_build: never passes a blank rule");

    // ---- 5f) CREDIT: agent.spawned EMITS grantProvenance + credit (§2.4) ----
    // When the master-authored agent carries grantProvenance/credit, runAgent
    // passes them straight through onto agent.spawned (the producers app.js needs).
    events.length = 0;
    const creditAgent = {
      role: "frontend-implementer", version: 1, instructions: "Build the page; fix last turn's miss.",
      tools: ["html_build"],
      grantProvenance: [{ skill: "html_build", fromLesson: "hero had a gradient last run" }],
      credit: { flaw: "text is hard to read", attributedTo: "frontend-implementer" },
    };
    await runAgent({ agent: creditAgent, gen: 1, page: "memory", ctx: baseCtx(), deps, emit });
    const credSpawn = events.find((e) => e.type === "agent.spawned");
    log(credSpawn && Array.isArray(credSpawn.grantProvenance) && credSpawn.grantProvenance[0].skill === "html_build" && credSpawn.grantProvenance[0].fromLesson === "hero had a gradient last run", "credit: agent.spawned emits grantProvenance straight through ([{skill,fromLesson}])");
    log(credSpawn && credSpawn.credit && credSpawn.credit.flaw === "text is hard to read" && credSpawn.credit.attributedTo === "frontend-implementer", "credit: agent.spawned emits credit straight through ({flaw,attributedTo})");

    // ---- 5g) CREDIT: agent.spawned OMITS the fields when absent (fairness) ----
    events.length = 0;
    await runAgent({
      agent: { role: "frontend-implementer", version: 1, instructions: "Build the page.", tools: ["html_build"] },
      gen: 0, page: "no-memory", ctx: baseCtx("no-memory"), deps, emit,
    });
    const plainSpawn = events.find((e) => e.type === "agent.spawned");
    log(plainSpawn && !("grantProvenance" in plainSpawn) && !("credit" in plainSpawn), "credit: agent.spawned OMITS grantProvenance/credit when the agent has none (no-memory carries neither — fairness)");
    // empty/garbage shapes are also omitted (never an empty array / flaw-less object)
    events.length = 0;
    await runAgent({
      agent: { role: "frontend-implementer", version: 1, instructions: "Build.", tools: ["html_build"], grantProvenance: [], credit: { attributedTo: "x" } },
      gen: 0, page: "memory", ctx: baseCtx(), deps, emit,
    });
    const edgeSpawn = events.find((e) => e.type === "agent.spawned");
    log(edgeSpawn && !("grantProvenance" in edgeSpawn) && !("credit" in edgeSpawn), "credit: agent.spawned omits an empty grantProvenance array and a flaw-less credit object");

    // ---- 6) svg_image (wires the inline SVG into ctx.brief.imageDirective) ----
    const svgCtx = baseCtx();
    r = await runAgent({
      agent: { role: "image-sourcer", version: 1, instructions: "Make a flat brand SVG.", tools: ["svg_image"] },
      gen: 0, page: "memory", ctx: svgCtx, deps, emit,
    });
    log(r.produces === "svg" && typeof r.output === "string" && r.output.startsWith("<svg"), "svg_image: returns <svg> output");
    log(calls.codexRun === 1, "svg_image: made real codexRun call");
    log(typeof svgCtx.brief.imageDirective === "string" && /<svg/.test(svgCtx.brief.imageDirective), "svg_image: wires the SVG into ctx.brief.imageDirective (no dropped output)");

    // ---- 7) cognee_trace (write) — critique + trace combined ----
    events.length = 0;
    calls.writeTrace = 0;
    const traceCtx = baseCtx();
    r = await runAgent({
      agent: { role: "critique", version: 1, instructions: "Audit then remember the findings.", tools: ["critique", "cognee_trace"] },
      gen: 0, page: "memory", ctx: traceCtx, deps, emit,
    });
    log(calls.writeTrace === 0, "cognee_trace: agent path makes NO raw writeTrace call (verified-tracing is orchestrator-side, admission-gated)");
    log(!events.some((e) => e.type === "trace.written"), "cognee_trace: agent path emits no trace.written (orchestrator writes only resolved-verified traces)");
    log(Array.isArray(r.findings) && r.findings.length > 0, "critique still produces findings that feed the orchestrator's verified trace step");
    void lastTraceArgs; void allTraceRecs;

    // ---- 7b) image_gen: threads a data URI; builder embeds it ----
    events.length = 0;
    calls.genImage = 0; calls.codexBuild = 0;
    const imgCtx = { copyHint: "Go viral.", seq: 0, sessionId: sid("memory") };
    r = await runAgent({
      agent: { role: "image-sourcer", version: 1, instructions: "Make an on-brand hero image.", tools: ["image_gen"] },
      gen: 0, page: "memory", ctx: imgCtx, deps, emit,
    });
    log(calls.genImage === 1, "image_gen: made real generateImage call");
    log(r.produces === "image" && r.output && r.output.dataUri.startsWith("data:image/"), "image_gen: returns {dataUri}");
    log(imgCtx.heroImage === "data:image/png;base64,STUBHEROIMAGE==", "image_gen: threads ctx.heroImage");
    log(events.some((e) => e.type === "agent.status" && /hero image/i.test(e.doing)), "image_gen: emits status naming the skill");
    // frozen image.mjs signature requires a non-empty `name` — we must pass one.
    log(typeof lastImageArgs.name === "string" && lastImageArgs.name.length > 0, "image_gen: passes a non-empty name to generateImage (frozen sig)");

    // ---- 7b-i) image_gen with NO OPENAI_API_KEY => SKIP (no placeholder hero) ----
    // Build-quality: without a key we do NOT inject a synthetic colored-block hero
    // (it read as amateur junk). The skill no-ops cleanly — no throw, no ctx.heroImage,
    // a skipped flag — and the builder ships a TYPE-LED hero. Symmetric on both pages.
    events.length = 0;
    const savedKey = process.env.OPENAI_API_KEY;
    const savedGen = deps.generateImage;
    delete process.env.OPENAI_API_KEY;
    delete deps.generateImage; // force the REAL (key-gated) path -> no-key skip
    const keylessCtx = { copyHint: "Go viral.", seq: 0, sessionId: sid("no-memory") };
    let keylessOk = true;
    try {
      r = await runAgent({
        agent: { role: "image-sourcer", version: 1, instructions: "Make a hero image.", tools: ["image_gen"] },
        gen: 0, page: "no-memory", ctx: keylessCtx, deps, emit,
      });
    } catch { keylessOk = false; }
    log(keylessOk, "image_gen (no key): did NOT throw — run continues");
    log(r && r.produces === "image" && r.output && r.output.skipped === "no_api_key" && r.output.dataUri === "", "image_gen (no key): skips cleanly (no placeholder hero)");
    log(keylessCtx.heroImage === undefined, "image_gen (no key): does NOT thread a placeholder onto ctx.heroImage");
    log(events.some((e) => e.type === "agent.status" && /no hero image/i.test(e.doing)), "image_gen (no key): emits the skip status");
    // restore env + injected stub for the rest of the suite
    if (savedKey !== undefined) process.env.OPENAI_API_KEY = savedKey;
    deps.generateImage = savedGen;
    calls.genImage = 0;
    // a builder that runs AFTER image_gen embeds the threaded image
    r = await runAgent({
      agent: { role: "frontend-implementer", version: 1, instructions: "Build the page.", tools: ["html_build"] },
      gen: 0, page: "memory", ctx: imgCtx, deps, emit,
    });
    log(/STUBHEROIMAGE/.test(lastBuildCopyHint), "image_gen->html_build: hero image passed to builder copyHint");
    log(typeof r.output === "string" && /STUBHEROIMAGE/.test(r.output), "image_gen->html_build: produced HTML embeds the image");

    // ---- 7c) image_gen + html_build on the SAME agent ----
    const oneCtx = { copyHint: "", seq: 0, sessionId: sid("memory") };
    r = await runAgent({
      agent: { role: "frontend-implementer", version: 1, instructions: "Make a hero image then build the page.", tools: ["image_gen", "html_build"] },
      gen: 1, page: "memory", ctx: oneCtx, deps, emit,
    });
    log(r.produces === "html" && /STUBHEROIMAGE/.test(r.output), "image_gen+html_build (one agent): build embeds its own image");

    // ---- 7d) a11y_check: real issues on bad HTML, clean on good ----
    const badA11y = "<html><body><img src='x.png'><button></button></body></html>";
    const a11yIssues = a11yCheck(badA11y);
    log(a11yIssues.some((i) => /alt/i.test(i)), "a11y_check: flags missing alt");
    log(a11yIssues.some((i) => /accessible name/i.test(i)), "a11y_check: flags unnamed button");
    log(a11yIssues.some((i) => /lang/i.test(i)), "a11y_check: flags missing lang");
    const goodA11y = "<html lang='en'><body><img src='x.png' alt='hero'><button aria-label='Start'>x</button><a href='#'>Start free</a></body></html>";
    log(a11yCheck(goodA11y).length === 0, "a11y_check: clean HTML -> []");

    // ---- 7e) contrast_check: flags low-contrast inline pair ----
    const lowC = "<html><body><p style='color:#777777;background-color:#888888'>hi</p></body></html>";
    log(contrastCheck(lowC, brand).some((i) => /contrast/i.test(i)), "contrast_check: flags low-contrast pair");
    const goodC = "<html><body><p style='color:#000000;background-color:#FFFFFF'>hi</p></body></html>";
    log(contrastCheck(goodC, brand).length === 0, "contrast_check: black on white -> []");

    // ---- 7f) copy_lint: flags banned buzzwords ----
    const buzzHtml = "<html><body><h1>Our revolutionary, best-in-class platform</h1></body></html>";
    const lintIssues = copyLint(buzzHtml);
    log(lintIssues.some((i) => /revolutionary/i.test(i)), "copy_lint: flags 'revolutionary'");
    log(copyLint("<h1>Go viral. Get customers.</h1>").length === 0, "copy_lint: clean copy -> []");

    // ---- 7g) a check skill EXECUTES inside runAgent + folds into findings ----
    events.length = 0;
    const checkCtx = { copyHint: "", seq: 0, html: "<html><body><img src='x.png'><h1>revolutionary tool</h1></body></html>" };
    r = await runAgent({
      agent: { role: "critique", version: 1, instructions: "Audit a11y, contrast and copy on the built page.", tools: ["a11y_check", "copy_lint"] },
      gen: 0, page: "memory", ctx: checkCtx, deps, emit,
    });
    log(Array.isArray(r.findings) && r.findings.some((f) => /a11y/i.test(f)) && r.findings.some((f) => /copy_lint/i.test(f)), "runAgent: granted checks execute + return findings");
    log(Array.isArray(checkCtx.findings) && checkCtx.findings.length >= 1, "runAgent: check findings folded into ctx.findings");
    log(events.some((e) => e.type === "agent.status" && /a11y_check/i.test(e.doing)), "runAgent: emits status naming a11y_check");
    log(events.some((e) => e.type === "agent.status" && /copy_lint/i.test(e.doing)), "runAgent: emits status naming copy_lint");

    // ---- 7h) reviseHtml: in-run "recall traces -> revise THIS page" loop ----
    events.length = 0;
    calls.codexBuild = 0; lastBuildRules = null; lastBuildPriorHtml = null;
    const priorBad = "<!doctype html><html lang='en'><head></head><body><div style='background:linear-gradient(#FE2C55,#25F4EE)'>hero</div><a style='background:#FE2C55'>cta</a></body></html>";
    const reviseRules = ["Add the #25F4EE accent to the primary CTA.", "Remove the hero gradient (flat color blocks only).", "  "];
    const rev = await reviseHtml({
      brand, goal: deps.goal, priorHtml: priorBad, rules: reviseRules,
      page: "memory", gen: 1, seq: 4, deps, emit, snapDir: snapDir(),
    });
    log(rev && typeof rev.html === "string" && rev.html.includes("<html"), "reviseHtml: returns corrected html");
    log(typeof rev.htmlRef === "string" && /^snapshots\/memory-g1-revise-s4\.html$/.test(rev.htmlRef), "reviseHtml: writes <page>-g<gen>-revise-s<seq>.html");
    log(calls.codexBuild === 1 && lastBuildPriorHtml === priorBad, "reviseHtml: calls codexBuildSite WITH priorHtml (revise mode)");
    log(Array.isArray(lastBuildRules) && lastBuildRules.length === 2 && lastBuildRules.every((x) => x.trim().length), "reviseHtml: passes cleaned non-empty rules");
    log(events.some((e) => e.type === "agent.status" && /revising the page from recalled traces/i.test(e.doing)), "reviseHtml: emits agent.status('revising the page from recalled traces')");
    log(events.some((e) => e.type === "design.rendered" && e.htmlRef === rev.htmlRef), "reviseHtml: emits design.rendered{htmlRef}");
    // the corrected page visibly improves: gradient gone, accent present
    log(!/gradient/i.test(rev.html), "reviseHtml: corrected page has NO gradient");
    log(/#25F4EE/i.test(rev.html), "reviseHtml: corrected page CONTAINS the accent");
    log(brandRuleViolations(rev.html, brand).length === 0, "reviseHtml: corrected page passes brandRuleViolations");
    // snapshot actually landed on disk
    let wroteRev = true;
    try { await access(path.join(snapDir(), path.basename(rev.htmlRef))); } catch { wroteRev = false; }
    log(wroteRev, "reviseHtml: revise snapshot written to disk");

    // ---- 7h-i) reviseHtml THROWS without priorHtml (no fallback) ----
    let threwNoPrior = false;
    try {
      await reviseHtml({ brand, goal: deps.goal, priorHtml: "", rules: reviseRules, page: "memory", gen: 1, seq: 5, deps, emit, snapDir: snapDir() });
    } catch { threwNoPrior = true; }
    log(threwNoPrior, "reviseHtml: throws when priorHtml is empty (no fallback)");

    // ---- 7h-ii) reviseHtml PROPAGATES a codexBuildSite failure (no fallback) ----
    let threwBuild = false;
    const failingDeps = { ...deps, async codexBuildSite() { throw new Error("codex revise boom"); } };
    try {
      await reviseHtml({ brand, goal: deps.goal, priorHtml: priorBad, rules: reviseRules, page: "memory", gen: 1, seq: 6, deps: failingDeps, emit, snapDir: snapDir() });
    } catch (err) { threwBuild = /codex revise boom/.test(err?.message || ""); }
    log(threwBuild, "reviseHtml: propagates codexBuildSite failure (no fallback)");

    // ---- 8) tool-less agent still makes a real call (not cosmetic) ----
    // v3.1: a tool-less agent now ALWAYS gets the critique pass (C4), so it makes
    // a real call (codexCritique) and returns the critique result — never cosmetic.
    calls.chat = 0; calls.critique = 0;
    r = await runAgent({
      agent: { role: "brand-deconstruct", version: 1, instructions: "Summarize the brand.", tools: [] },
      gen: 0, page: "no-memory", ctx: baseCtx("no-memory"), deps, emit,
    });
    log(calls.critique === 1, "tool-less agent: still made a real call (always-run critique — none cosmetic)");
    log(r.produces === "critique", "tool-less agent: returns the critique result as its primary produces");

    // ---- 9) agentId derivation + spawn for no-memory ----
    events.length = 0;
    await runAgent({
      agent: { role: "copywriter", version: 1, instructions: "x", tools: ["copywriter"] },
      gen: 2, page: "no-memory", ctx: baseCtx("no-memory"), deps, emit,
    });
    const sp = events.find((e) => e.type === "agent.spawned");
    log(sp && sp.agentId === "no-memory-copywriter-v1-g2", `agentId derived correctly (got ${sp && sp.agentId})`);

    // ===================== A.1 REGISTRY + ALLOW-LISTING (v3.1) =====================
    // registry/palette parity: every palette name is a registry key with run+status,
    // and the prose TOOL_PALETTE map matches the registry exactly (no theater chip).
    log(SKILL_PALETTE.length === Object.keys(SKILL_REGISTRY).length, "registry: SKILL_PALETTE generated from SKILL_REGISTRY (same length)");
    log(SKILL_PALETTE.every((n) => SKILL_REGISTRY[n] && typeof SKILL_REGISTRY[n].run === "function" && typeof SKILL_REGISTRY[n].status === "function"), "registry: every palette skill has run()+status()");
    log(Object.keys(TOOL_PALETTE).sort().join(",") === SKILL_PALETTE.slice().sort().join(","), "registry: TOOL_PALETTE prose matches the registry keys exactly");
    log(!SKILL_PALETTE.includes("brand_tokens") && !("brand_tokens" in TOOL_PALETTE), "registry: brand_tokens is DELETED (not in registry or palette)");
    // the exact frozen skill list (CONTRACTS §7)
    const FROZEN = ["html_build","svg_image","image_gen","a11y_check","contrast_check","copy_lint","copywriter","info_architect","typographer","critique","cognee_recall","cognee_trace"];
    log(FROZEN.every((n) => SKILL_PALETTE.includes(n)) && SKILL_PALETTE.length === FROZEN.length, "registry: palette == the frozen 12-skill list");

    // ALLOW-LISTING: cognee_recall on a NON-memory page THROWS (structural A/B).
    let threwRecallNoMem = false;
    try {
      await runAgent({
        agent: { role: "memory-recaller", version: 1, instructions: "x", tools: ["cognee_recall"] },
        gen: 0, page: "no-memory", ctx: { copyHint: "", seq: 0, sessionId: sid("no-memory") }, deps, emit,
      });
    } catch (err) { threwRecallNoMem = /memory-only/i.test(err?.message || ""); }
    log(threwRecallNoMem, "allow-list: cognee_recall on no-memory page THROWS (memory-only)");

    let threwTraceNoMem = false;
    try {
      await runAgent({
        agent: { role: "tracer", version: 1, instructions: "x", tools: ["cognee_trace"] },
        gen: 0, page: "no-memory", ctx: { copyHint: "", seq: 0, sessionId: sid("no-memory") }, deps, emit,
      });
    } catch (err) { threwTraceNoMem = /memory-only/i.test(err?.message || ""); }
    log(threwTraceNoMem, "allow-list: cognee_trace on no-memory page THROWS (memory-only)");

    // symmetric skills run fine on BOTH pages (no throw on no-memory).
    let symOk = true;
    try {
      await runAgent({
        agent: { role: "auditor", version: 1, instructions: "x", tools: ["a11y_check"] },
        gen: 0, page: "no-memory", ctx: { copyHint: "", seq: 0, sessionId: sid("no-memory"), html: "<html><body><img src='x'></body></html>" }, deps, emit,
      });
    } catch { symOk = false; }
    log(symOk, "allow-list: symmetric skills (a11y_check) run on the no-memory page");

    // CRITIQUE RUNS ON BOTH PAGES (C4) — even with NO explicit grant.
    events.length = 0; calls.critique = 0;
    await runAgent({
      agent: { role: "frontend-implementer", version: 1, instructions: "Build the page.", tools: ["html_build"] },
      gen: 0, page: "no-memory", ctx: { copyHint: "Go viral.", seq: 0, sessionId: sid("no-memory") }, deps, emit,
    });
    log(calls.critique === 1 && events.some((e) => e.type === "critique.made"), "critique: ALWAYS runs on the no-memory page (C4) — even without an explicit grant");

    // sessionId is REQUIRED — a recall agent without ctx.sessionId throws (no `${page}-run` reconstruct).
    let threwNoSid = false;
    try {
      await runAgent({
        agent: { role: "memory-recaller", version: 1, instructions: "x", tools: ["cognee_recall"] },
        gen: 0, page: "memory", ctx: { copyHint: "", seq: 0 }, deps, emit,
      });
    } catch (err) { threwNoSid = /ctx\.sessionId is required/i.test(err?.message || ""); }
    log(threwNoSid, "sessionId: recall WITHOUT ctx.sessionId throws (no `${page}-run` reconstruction)");

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
