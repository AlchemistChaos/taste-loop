// team.mjs — THE MASTER. A real model call that AUTHORS the whole team.
//
// planTeam() is a REAL ollama.chatJSON call (qwen2.5:7b-instruct, temp ~0.5) that
// acts as the studio director. From goal + brand (+ recalled lessons for the
// memory studio) it DECIDES:
//   - how many agents (3-7),
//   - each agent's ROLE,
//   - each agent's INSTRUCTIONS (the actual brand-voiced prompt that agent runs on),
//   - each agent's SKILLS/TOOLS (drawn from SKILL_PALETTE).
//
// MEMORY-AWARE MASTER (Invariant 2): on the memory studio the master is handed the
// traces/lessons recalled from EARLIER TURNS IN THIS RUN and decides the roster +
// per-agent tools FROM them — so the *team* improves turn-over-turn, not just the
// page. The lesson->capability reasoning lives in the master PROMPT (not a regex
// ladder): a contrast lesson makes the master field contrast_check, a voice lesson
// makes it field copy_lint, etc. repairTeam is only a thin invariant guard.
//
// This is the authoring brain. It is NOT cosmetic: the orchestrator spawns exactly
// these agents and every one runs its master-authored instructions with its granted
// tools to produce REAL output.
//
// Frozen exports (other modules import this exact shape):
//   export const ROLE_PALETTE   : string[]
//   export const SKILL_PALETTE  : string[]   // DERIVED from skills.mjs TOOL_PALETTE
//                                             // (the single registry source of truth) — NO
//                                             // brand_tokens, NO web_search.
//   export async function planTeam({brand, goal, isMemory, lessons, credit}) -> {
//     strategy: string,
//     agents: [{ id, role, instructions, tools:string[], produces:string,
//                briefV1:string, briefV2:string,
//                credit?:{flaw,attributedTo}, grantProvenance?:[{skill,fromLesson}] }]
//   }
//   - briefV1 = the agent's brief WITHOUT any recalled lesson woven in (the "before").
//   - briefV2 = the agent's brief AS AUTHORED/woven (the "after"; === instructions).
//     Stored at author time so the orchestrator reads the prompt-diff directly
//     (no regex reconstruction). On the no-memory studio briefV1 === briefV2.
//   - credit (2.4) = { flaw, attributedTo } — the highest-severity flaw this role was
//     blamed for LAST turn, seeded verbatim into briefV2 so the role must fix it this
//     turn. Memory studio only (credit is {} on the no-memory studio -> never set).
//   - grantProvenance (2.3) = [{ skill, fromLesson }] — which recalled lesson motivated
//     granting which tool. Master-authored (validated) or deterministically derived.
//     Memory studio only; undefined on no-memory and under ablation.
//
// Guarantees enforced by validate/repair (so the orchestrator never has to
// defend against a bad master output):
//   - at least one agent with produces === "html"   (granted html_build)
//   - at least one agent with produces === "critique"
//   - every tool is from SKILL_PALETTE (unknown tools dropped)
//   - roster capped at 7 agents, deduped ids
//   - FAIRNESS: the ONLY memory-exclusive tools are {cognee_recall, cognee_trace};
//     they appear ONLY on the memory studio. Every other capability is symmetric.
//
// Plain ESM, Node 18+, no npm deps. Uses ollama.chatJSON (frozen) and derives the
// skill palette from skills.mjs TOOL_PALETTE (frozen).

import { chatJSON } from "./ollama.mjs";
import { TOOL_PALETTE } from "./skills.mjs";

// ---------------------------------------------------------------------------
// Palettes
// ---------------------------------------------------------------------------

// The roles the master may field. brand-deconstruct, copywriter, visual-designer,
// frontend-implementer and critique are the workhorses; the rest are specialists
// the director can add when they sharpen the build.
export const ROLE_PALETTE = [
  "brand-deconstruct",   // load + interpret the BrandSpec (colors, fonts, dos/donts)
  "copywriter",          // bold, on-voice marketing copy + headlines
  "info-architect",      // section order + conversion flow
  "typographer",         // type scale / pairing within approved fonts
  "visual-designer",     // art-directs the on-brand layout (flat color blocks)
  "frontend-implementer",// builds the real, self-contained HTML page (produces html)
  "critique",            // brutal brand-rule audit (produces critique)
  "brand-guardian",      // memory studio: enforces recalled, checkable brand rules
];

// The tools the master may grant. DERIVED from the skills.mjs SKILL_REGISTRY source
// of truth (the live TOOL_PALETTE export) so the master can never grant a chip that
// the executor can't actually run, and so no parallel literal palette drifts. There
// is deliberately NO web_search and NO brand_tokens (brand grounding flows via the
// build channel, not a tool).
export const SKILL_PALETTE = Object.freeze(Object.keys(TOOL_PALETTE));

// Short, master-facing description for every grantable skill — sourced from the
// SAME registry so the prompt text can never claim a capability the executor lacks.
const SKILL_DESCRIPTIONS = TOOL_PALETTE;

const SKILL_SET = new Set(SKILL_PALETTE);
const ROLE_SET = new Set(ROLE_PALETTE);

const MAX_AGENTS = 7;
const MIN_AGENTS = 3;

// Roles that are memory-only — the master should only field these on the memory
// studio, and they must be dropped from a no-memory roster during repair.
const MEMORY_ONLY_ROLES = new Set(["brand-guardian"]);

// Memory tools — the ONLY memory-exclusive bundle (Invariant 4). Valid ONLY on the
// memory studio; the fairness guard strips them from any no-memory roster. Every
// OTHER skill in SKILL_PALETTE is a neutral capability available to BOTH studios.
const MEMORY_TOOLS = new Set(["cognee_recall", "cognee_trace"]);

// ---------------------------------------------------------------------------
// The MASTER system prompt — authored with real effort.
// ---------------------------------------------------------------------------

function masterSystemPrompt({ isMemory }) {
  return [
    "You are the MASTER AGENT — the studio director of an elite TikTok-brand marketing-site studio.",
    "Your single job RIGHT NOW is to AUTHOR the team that will build one landing page: decide how many",
    "agents to field (between 3 and 7), what ROLE each one plays, the exact INSTRUCTIONS each agent will",
    "run on (this is the real prompt that agent executes — write it as if you are briefing that specialist),",
    "and which TOOLS each agent is granted.",
    "",
    "You are NOT writing the website. You are designing the org chart and the briefs. Every agent you create",
    "WILL be spawned and WILL run the instructions you give it, so the instructions must be concrete, specific,",
    "and brand-voiced — not generic boilerplate. A weak brief produces a weak page; you own the outcome.",
    "",
    "ALLOWED ROLES (use ONLY these names):",
    JSON.stringify(ROLE_PALETTE),
    "",
    "ALLOWED TOOLS (grant ONLY these; there is deliberately NO web search and NO brand-token tool — work from",
    "the brand book in this brief and, on the memory studio, from the recalled in-run traces):",
    ...SKILL_PALETTE.map((name) => `  - ${name}: ${SKILL_DESCRIPTIONS[name]}`),
    "",
    "TOOLS ARE REAL CAPABILITIES, NOT LABELS. Read the recalled lessons (memory studio) and the brief, then",
    "GRANT the matching tool to the agent who can act on it — do not merely mention it in prose. Reason it",
    "through yourself; there is no automatic backstop that will add tools for you. Examples:",
    "  - a contrast / legibility / accent-on-CTA lesson -> GRANT contrast_check (and a11y_check) to the auditor;",
    "  - an accessibility / alt-text / aria / focus-state lesson -> GRANT a11y_check to the auditor or builder;",
    "  - a voice / jargon / buzzword lesson -> GRANT copy_lint to the copywriter or critique;",
    "If a recalled lesson implies a capability and you do NOT field an agent holding the matching tool, the page",
    "will repeat the mistake — so let the recalled memory reshape BOTH the roster and the per-agent toolsets.",
    "",
    "HARD REQUIREMENTS for the roster you return:",
    '  1. EXACTLY ONE agent must have produces == "html" and be granted the "html_build" tool. This is the',
    "     agent that emits the actual page. Give it the richest, most precise brief of all.",
    '  2. AT LEAST ONE agent must have produces == "critique" — a brutal brand-rule auditor.',
    "  3. 3 to 7 agents total. More is not better; field only agents that materially improve the page.",
    "  4. Each agent's instructions must be 2-5 sentences of SPECIFIC direction in the brand voice,",
    "     referencing the real brand tokens (colors, fonts, tone, dos/donts) where relevant.",
    "",
    isMemory
      ? [
          "THIS STUDIO HAS MEMORY. You will be given LESSONS recalled from EARLIER TURNS IN THIS RUN. You MUST",
          "weave each recalled lesson, verbatim and non-negotiable, into the instructions of the agents who can",
          "act on it (typically the builder, the visual-designer, and a brand-guardian/critique), AND grant the",
          "tool each lesson implies (above). Grant cognee_recall to agents that should consult the run's memory",
          "and cognee_trace to agents that should record findings. Consider fielding a \"brand-guardian\" whose",
          "entire brief is to enforce the recalled, checkable brand rules. Let the recalled memory visibly shape",
          "WHO you field and WHAT they hold — that is this studio's advantage over the no-memory studio.",
          "PROVENANCE: for each tool you grant BECAUSE of a recalled lesson, add a grantProvenance entry on that",
          "agent naming the tool (skill) and quoting that lesson VERBATIM (fromLesson). Only include entries whose",
          "skill you actually granted and whose lesson is one of the recalled lessons above.",
        ].join(" ")
      : [
          "THIS STUDIO HAS NO MEMORY. It carries nothing between turns and has no recalled traces to learn from.",
          "Do NOT grant cognee_recall or cognee_trace, and do NOT field a \"brand-guardian\". Plan a strong team",
          "from first principles for this turn.",
        ].join(" "),
    "",
    "Return ONLY valid JSON, no prose, no markdown fences, in EXACTLY this shape:",
    "{",
    '  "strategy": "<one concrete sentence describing the build approach for this page' +
      (isMemory ? " AND how the recalled memory shaped this team" : "") + '>",',
    '  "agents": [',
    "    {",
    '      "role": "<one of the allowed roles>",',
    '      "instructions": "<the real, specific, brand-voiced prompt this agent runs on>",',
    '      "tools": ["<allowed tool>", ...],',
    '      "produces": "<short noun for the artifact this agent yields, e.g. brandspec|copy|layout|html|critique|ia|typescale>"' +
      (isMemory
        ? ','
        : ''),
    ...(isMemory
      ? [
          '      "grantProvenance": [{ "skill": "<one granted tool>", "fromLesson": "<the recalled lesson, verbatim, that made you grant it>" }]',
        ]
      : []),
    "    }",
    "    // ...3 to 7 agents",
    "  ]",
    "}",
  ].join("\n");
}

function masterUserPrompt({ brand, goal, isMemory, lessons }) {
  const tone = Array.isArray(brand?.tone) ? brand.tone.join(", ") : String(brand?.tone || "");
  const c = brand?.colors || {};
  const fonts = brand?.fonts || {};
  const lessonBlock = (isMemory && lessons && lessons.length)
    ? [
        "",
        `RECALLED LESSONS from EARLIER TURNS IN THIS RUN (${lessons.length}) — these were learned this run and`,
        "MUST be woven verbatim into the instructions of the agents who can enforce them, AND must drive which",
        "tools you grant (a contrast lesson -> contrast_check on the auditor, a voice lesson -> copy_lint on",
        "the copywriter, etc.):",
        ...lessons.map((l, i) => `  ${i + 1}. ${typeof l === "string" ? l : (l.statement || "")}`),
      ].join("\n")
    : (isMemory
        ? "\nRECALLED LESSONS from EARLIER TURNS IN THIS RUN: (none yet — this is the first turn of the run). Plan a strong first-pass team."
        : "");

  return [
    `GOAL: ${goal}`,
    "",
    "BRAND TOKENS (the real BrandSpec — brief your agents against these exact values):",
    `  colors: primary ${c.primary}, accent ${c.accent}, bg ${c.bg}, text ${c.fg}`,
    `  fonts: heading "${fonts.heading}", body "${fonts.body}"`,
    `  tone: ${tone}`,
    `  audience: ${brand?.audience || "general"}`,
    `  DO: ${JSON.stringify(brand?.do || [])}`,
    `  DON'T (penalized hard — bake these into the briefs): ${JSON.stringify(brand?.dont || [])}`,
    `  page sections: ${JSON.stringify(brand?.sections || [])}`,
    lessonBlock,
    "",
    isMemory
      ? "Author the MEMORY studio's team now. Make memory its visible advantage: weave the recalled lessons into the right briefs, GRANT the tool each lesson implies, and wire up cognee_recall/cognee_trace. Name in `strategy` how the recalled memory reshaped this team."
      : "Author the NO-MEMORY studio's team now. Strong first-principles briefs only — no memory tools.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Validation / repair — guarantee the contract regardless of model output.
// ---------------------------------------------------------------------------

function asString(v) {
  return typeof v === "string" ? v.trim() : (v == null ? "" : String(v).trim());
}

// Coerce a tools value into a clean array of allowed tools (memory tools stripped
// for no-memory studios — the fairness invariant).
function cleanTools(raw, { isMemory }) {
  let arr = [];
  if (Array.isArray(raw)) arr = raw;
  else if (typeof raw === "string") arr = raw.split(/[,\s]+/);
  const out = [];
  for (const t of arr) {
    const tool = asString(t);
    if (!SKILL_SET.has(tool)) continue;            // unknown / dropped (e.g. brand_tokens)
    if (!isMemory && MEMORY_TOOLS.has(tool)) continue; // fairness: no memory tool on no-memory
    if (!out.includes(tool)) out.push(tool);
  }
  return out;
}

// Default instructions for a role, used only when the model omits/blanks one
// during repair. Brand-voiced so even repaired agents carry real direction.
// IMPORTANT: this returns the LESSON-FREE brief (the canonical briefV1). Lesson
// weaving is the single responsibility of weaveLessons() in repair step 5/7, which
// produces briefV2 — so the stored v1->v2 prompt-diff is always honest.
function defaultInstructions(role, { brand, goal }) {
  const c = brand?.colors || {};
  const tone = Array.isArray(brand?.tone) ? brand.tone.join(", ") : String(brand?.tone || "");
  const donts = JSON.stringify(brand?.dont || []);
  switch (role) {
    case "brand-deconstruct":
      return `Load and interpret the TikTok BrandSpec. Surface the exact palette (${c.primary}/${c.accent} on ${c.bg}), the approved fonts, the ${tone} tone, and the hard DON'Ts ${donts} so every downstream agent works from the real tokens.`;
    case "copywriter":
      return `Write bold, ${tone} marketing copy for "${goal}". Punchy hero headline, scannable section copy, real CTAs — no lorem, no jargon. Speak directly to ${brand?.audience || "the audience"}.`;
    case "info-architect":
      return `Order the page sections ${JSON.stringify(brand?.sections || [])} for maximum conversion: hook fast, prove value, drive to one primary CTA. Justify the flow in one line per section.`;
    case "typographer":
      return `Set a confident type scale using only the approved fonts (heading "${brand?.fonts?.heading}", body "${brand?.fonts?.body}"). Big, dominant headlines; comfortable body; clear hierarchy. Respect the DON'Ts ${donts}.`;
    case "visual-designer":
      return `Art-direct an on-brand layout using FLAT brand-color blocks only (${c.primary}/${c.accent} on ${c.bg}/${c.fg}). Strong hierarchy, generous whitespace, the primary CTA visually dominant. Obey the DON'Ts ${donts} exactly.`;
    case "frontend-implementer":
      return `Build a single self-contained, responsive HTML5 page with exactly 5 sections (${JSON.stringify(brand?.sections || [])}) for "${goal}". Use the real brand tokens (colors ${c.primary}/${c.accent}, fonts ${brand?.fonts?.heading}), flat color blocks only, real on-brand copy, strong hierarchy, and prominent CTAs. Obey every DON'T: ${donts}.`;
    case "critique":
      return `Brutally audit the built page against the brand rules. List concrete, actionable violations — especially any breach of the DON'Ts ${donts}. Be specific and unforgiving; flag anything off-brand.`;
    case "brand-guardian":
      return `Enforce the checkable brand rules on the built page. Verify each rule is satisfied and reject the page if any is broken.`;
    default:
      return `Contribute on-brand work toward "${goal}" using the brand tokens (${c.primary}/${c.accent}, ${tone}) and obeying the DON'Ts ${donts}.`;
  }
}

// Weave recalled lessons into an instruction string if they aren't already
// referenced. Used for the memory studio's actionable agents. Returns the woven
// instruction (the "v2"/after brief).
function weaveLessons(instructions, lessons) {
  if (!lessons || !lessons.length) return instructions;
  const statements = lessonStatements(lessons);
  if (!statements.length) return instructions;
  const lower = String(instructions || "").toLowerCase();
  const missing = statements.filter((s) => !lower.includes(s.toLowerCase().slice(0, Math.min(24, s.length))));
  if (!missing.length) return instructions;
  const tail = ` LEARNED RULES (from earlier turns this run — apply verbatim, non-negotiable): ${missing.join("; ")}.`;
  return `${asString(instructions)}${tail}`;
}

// Collect recalled lesson statements as clean, non-empty strings (verbatim). Used by
// weaveLessons() and the grantProvenance derivation so they agree on what a "lesson" is.
function lessonStatements(lessons) {
  if (!Array.isArray(lessons)) return [];
  return lessons
    .map((l) => (typeof l === "string" ? l : (l && l.statement) || ""))
    .map((s) => asString(s))
    .filter(Boolean);
}

// Seed the responsible agent's brief with its OWN prior miss (2.2). Appends a verbatim
// miss clause to the instruction string (mirrors weaveLessons) when not already present,
// so briefV2 grows and the prompt-diff naturally reflects the credit seeding. Returns
// the seeded instruction (the new "v2"/after brief).
function seedCredit(instructions, miss) {
  const flaw = asString(miss && miss.flaw);
  if (!flaw) return instructions;
  const lower = String(instructions || "").toLowerCase();
  if (lower.includes(flaw.toLowerCase())) return instructions; // idempotent
  const sev = asString(miss.severity) || "med";
  const tail =
    ` LAST TURN this role was attributed the flaw: "${flaw}" (severity ${sev})` +
    ` — you MUST fix it this turn.`;
  return `${asString(instructions)}${tail}`;
}

// Apply the credit seed for one agent (2.2): if this agent's role was blamed last
// turn, grow its briefV2/instructions with the verbatim miss clause and attach the
// per-agent credit = {flaw, attributedTo}. Idempotent + memory-only (credit is {} on
// the no-memory/ablate path, so nothing happens there). Keeps briefDiff honest: when
// seeding grows the brief it (re)sets before=briefV1, after=current instructions.
function seedAgentCredit(a, credit, isMemory) {
  if (!isMemory) return;                                // fairness belt-and-suspenders
  const miss = credit && typeof credit === "object" ? credit[a.role] : null;
  if (!miss || !asString(miss.flaw)) return;
  const seeded = seedCredit(a.instructions, miss);
  if (seeded !== a.instructions) {
    a.instructions = seeded;
    a.briefV2 = seeded;
    // The prompt-diff reflects credit seeding too (before is the lesson-free v1).
    a.briefDiff = { before: a.briefV1, after: seeded };
  }
  a.credit = { flaw: asString(miss.flaw), attributedTo: a.role };
}

// Roles whose briefs should carry the recalled lessons on the memory studio.
const LESSON_BEARING_ROLES = new Set([
  "frontend-implementer",
  "visual-designer",
  "critique",
  "brand-guardian",
  "copywriter",
]);

// Validate / derive an agent's grantProvenance (2.3). Memory studio + non-empty lessons
// only — returns undefined otherwise (so the field stays absent on no-memory/ablate).
//   grantProvenance = [{ skill, fromLesson }] — "this recalled lesson motivated this tool".
// Primary: accept the master's OWN rawProv entries whose skill is in the agent's final
//   tools AND whose fromLesson matches (case-insensitive substring) a recalled lesson
//   statement — dropping any fabricated entry. NO regex over flaw text, NO rule table.
// Fallback: when the master returned none but the agent holds a memory-implied
//   (non-html_build) tool, synthesize ONE entry pairing that first tool with the FIRST
//   recalled lesson statement (improve() feedback-ranks lessons so [0] is the proven one).
function deriveGrantProvenance(agent, lessons) {
  const statements = lessonStatements(lessons);
  if (!statements.length) return undefined;
  const tools = Array.isArray(agent.tools) ? agent.tools : [];
  const toolSet = new Set(tools);
  const lowerStatements = statements.map((s) => s.toLowerCase());

  // Primary: validate the master-authored entries.
  const validated = [];
  if (Array.isArray(agent.rawProv)) {
    for (const g of agent.rawProv) {
      if (!g || typeof g !== "object") continue;
      const skill = asString(g.skill);
      const fromLesson = asString(g.fromLesson);
      if (!skill || !fromLesson) continue;
      if (!toolSet.has(skill)) continue;                    // must be a tool we granted
      const fl = fromLesson.toLowerCase();
      // fromLesson must match a recalled lesson (either direction of substring) so the
      // master cannot quote a lesson that was never recalled.
      const matched = lowerStatements.find((s) => s.includes(fl) || fl.includes(s));
      if (!matched) continue;
      // Store the recalled statement VERBATIM (canonical text), not the model's echo.
      const canonical = statements[lowerStatements.indexOf(matched)];
      if (!validated.some((v) => v.skill === skill && v.fromLesson === canonical)) {
        validated.push({ skill, fromLesson: canonical });
      }
    }
  }
  if (validated.length) return validated;

  // Fallback: pair the first non-html_build granted tool with the first lesson.
  const firstTool = tools.find((t) => t !== "html_build");
  if (firstTool) {
    return [{ skill: firstTool, fromLesson: statements[0] }];
  }
  return undefined;
}

// Validate + repair the master's raw JSON into the guaranteed contract shape. This
// is now a THIN INVARIANT GUARD only (Phase 2.2): it ensures >=1 html producer,
// >=1 critique producer, valid tool names, the roster bounds, unique ids, and the
// FAIRNESS invariant (memory tools only on the memory studio). It does NOT do
// lesson->skill keyword matching — that reasoning lives in the master prompt.
function repairTeam(raw, ctx) {
  const { isMemory, lessons, credit } = ctx;
  const strategy = asString(raw && raw.strategy) ||
    (isMemory
      ? "Apply the lessons recalled from earlier turns this run and ship a flat, on-brand, high-converting TikTok page."
      : "Ship a bold, flat, on-brand high-converting TikTok marketing page from first principles.");

  let agents = Array.isArray(raw && raw.agents) ? raw.agents : [];

  // 1) Coerce each agent; drop ones with an unknown role. Capture briefV1 (the
  //    master-authored brief BEFORE any lesson weaving) and briefV2 (after weaving)
  //    at author time so the orchestrator reads the prompt-diff directly.
  const cleaned = [];
  const seenRoles = new Set();
  for (const a of agents) {
    if (!a || typeof a !== "object") continue;
    let role = asString(a.role);
    if (!ROLE_SET.has(role)) continue;
    // memory-only roles cannot appear on a no-memory roster
    if (!isMemory && MEMORY_ONLY_ROLES.has(role)) continue;

    let instructions = asString(a.instructions);
    if (instructions.length < 20) instructions = defaultInstructions(role, ctx);

    let tools = cleanTools(a.tools, { isMemory });
    let produces = asString(a.produces).toLowerCase();

    // Stash the master's RAW grantProvenance (2.3 primary) for validation in step 5b,
    // once tools are final. Only the array shape is carried here; validation is later.
    const rawProv = Array.isArray(a.grantProvenance) ? a.grantProvenance : null;

    // briefV1 = the authored brief as-is (no lessons woven yet); briefV2 filled in
    // step 5 once weaving has run. On the no-memory studio they stay identical.
    cleaned.push({ role, instructions, tools, produces, briefV1: instructions, briefV2: instructions, rawProv });
    seenRoles.add(role);
  }

  // 2) Ensure an html agent exists (frontend-implementer is the canonical builder).
  let htmlAgent = cleaned.find((a) => a.produces === "html" || a.tools.includes("html_build"));
  if (!htmlAgent) {
    // promote an existing frontend-implementer, else add one
    htmlAgent = cleaned.find((a) => a.role === "frontend-implementer");
    if (!htmlAgent) {
      const instr = defaultInstructions("frontend-implementer", ctx);
      htmlAgent = {
        role: "frontend-implementer",
        instructions: instr,
        tools: [],
        produces: "html",
        briefV1: instr,
        briefV2: instr,
      };
      cleaned.push(htmlAgent);
      seenRoles.add("frontend-implementer");
    }
  }
  htmlAgent.produces = "html";
  if (!htmlAgent.tools.includes("html_build")) htmlAgent.tools.push("html_build");

  // 3) Ensure a critique agent exists.
  let critAgent = cleaned.find((a) => a.produces === "critique" || a.role === "critique");
  if (!critAgent) {
    const instr = defaultInstructions("critique", ctx);
    critAgent = {
      role: "critique",
      instructions: instr,
      tools: [],
      produces: "critique",
      briefV1: instr,
      briefV2: instr,
    };
    cleaned.push(critAgent);
    seenRoles.add("critique");
  }
  critAgent.produces = critAgent.produces || "critique";
  if (critAgent.role === "critique" && critAgent.produces !== "critique") critAgent.produces = "critique";
  // make sure at least one agent literally produces "critique"
  if (!cleaned.some((a) => a.produces === "critique")) critAgent.produces = "critique";

  // 4) Backfill produces nouns that came back blank.
  const PRODUCES_BY_ROLE = {
    "brand-deconstruct": "brandspec",
    copywriter: "copy",
    "info-architect": "ia",
    typographer: "typescale",
    "visual-designer": "layout",
    "frontend-implementer": "html",
    critique: "critique",
    "brand-guardian": "guard",
  };
  for (const a of cleaned) {
    if (!a.produces) a.produces = PRODUCES_BY_ROLE[a.role] || "work";
  }

  // 5) Memory studio: weave lessons into lesson-bearing briefs (briefV1 stays the
  //    pre-weave authored brief; briefV2/instructions carry the woven lesson). Grant
  //    cognee_recall/cognee_trace where they fit. The lesson->capability TOOL
  //    reasoning is the master's job (in the prompt); repair no longer infers it.
  //    No-memory studio: strip any memory-tool leakage (fairness invariant).
  for (const a of cleaned) {
    if (isMemory) {
      if (LESSON_BEARING_ROLES.has(a.role)) {
        const woven = weaveLessons(a.instructions, lessons);
        a.instructions = woven;
        a.briefV2 = woven;
        // Expose the v1->v2 prompt diff for the upskill panel; orchestrator backfills lessonId/lessonText.
        a.briefDiff = { before: a.briefV1, after: woven };
      }
      // 2.2 CREDIT SEED: if this role was blamed for a flaw last turn, append its OWN
      //     miss to the brief (verbatim) so it must fix it this turn, and attach the
      //     per-agent credit object app.js renderCredit consumes. credit is {} on the
      //     no-memory/ablate/gen-0 path so this is inert there.
      seedAgentCredit(a, credit, isMemory);
      // the auditor/guardian should be able to consult this run's memory
      if ((a.role === "critique" || a.role === "brand-guardian") && lessons && lessons.length) {
        if (!a.tools.includes("cognee_recall")) a.tools.push("cognee_recall");
        if (!a.tools.includes("cognee_trace")) a.tools.push("cognee_trace");
      }
      // the builder should recall what was learned earlier this run before building
      if (a.role === "frontend-implementer" && lessons && lessons.length) {
        if (!a.tools.includes("cognee_recall")) a.tools.push("cognee_recall");
      }
    } else {
      a.tools = a.tools.filter((t) => !MEMORY_TOOLS.has(t));
    }
  }

  // 6) Cap at MAX_AGENTS — but never drop the html or critique agent.
  let roster = cleaned;
  if (roster.length > MAX_AGENTS) {
    const mustKeep = new Set([htmlAgent, critAgent]);
    const kept = [];
    // keep mandatory first (in original order), then fill the rest by order.
    for (const a of roster) if (mustKeep.has(a)) kept.push(a);
    for (const a of roster) {
      if (kept.length >= MAX_AGENTS) break;
      if (!mustKeep.has(a)) kept.push(a);
    }
    roster = kept;
  }

  // 7) Floor at MIN_AGENTS: add high-value specialists the team is missing.
  if (roster.length < MIN_AGENTS) {
    const fillOrder = isMemory
      ? ["brand-deconstruct", "copywriter", "visual-designer", "brand-guardian", "info-architect"]
      : ["brand-deconstruct", "copywriter", "visual-designer", "info-architect", "typographer"];
    for (const role of fillOrder) {
      if (roster.length >= MIN_AGENTS) break;
      if (seenRoles.has(role)) continue;
      const instr = defaultInstructions(role, ctx);
      const a = {
        role,
        instructions: instr,
        tools: [],
        produces: PRODUCES_BY_ROLE[role] || "work",
        briefV1: instr,
        briefV2: instr,
      };
      if (isMemory && LESSON_BEARING_ROLES.has(role)) {
        const woven = weaveLessons(a.instructions, lessons);
        a.instructions = woven;
        a.briefV2 = woven;
        // Expose the v1->v2 prompt diff for the upskill panel; orchestrator backfills lessonId/lessonText.
        a.briefDiff = { before: a.briefV1, after: woven };
      }
      // 2.2: a credited role added by backfill is still seeded with its prior miss.
      seedAgentCredit(a, credit, isMemory);
      roster.push(a);
      seenRoles.add(role);
    }
  }

  // 8) FAIRNESS ASSERTION (the structural A/B guard): the ONLY memory-exclusive
  //    tools are {cognee_recall, cognee_trace}; they may appear ONLY on the memory
  //    studio. On a no-memory roster NO agent may hold one. Every other tool is
  //    symmetric. This belt-and-suspenders pass catches any leak from steps above.
  if (!isMemory) {
    for (const a of roster) {
      a.tools = a.tools.filter((t) => !MEMORY_TOOLS.has(t));
    }
  }

  // 8b) GRANT PROVENANCE (2.3): now that each agent's tools are FINAL, derive/validate
  //     grantProvenance = [{skill, fromLesson}]. Memory studio + non-empty lessons only;
  //     undefined on no-memory and under ablation (lessons is [] there). Then drop the
  //     temporary rawProv scratch field so the returned agent shape stays clean.
  for (const a of roster) {
    if (isMemory && lessons && lessons.length) {
      const prov = deriveGrantProvenance(a, lessons);
      if (prov && prov.length) a.grantProvenance = prov;
    }
    if ("rawProv" in a) delete a.rawProv;
  }

  // 9) Assign stable, unique ids (role + ordinal for duplicate roles).
  const roleCounts = new Map();
  for (const a of roster) {
    const n = (roleCounts.get(a.role) || 0) + 1;
    roleCounts.set(a.role, n);
    a.id = n === 1 ? a.role : `${a.role}-${n}`;
  }

  return { strategy, agents: roster };
}

// ---------------------------------------------------------------------------
// Public API — the REAL master call.
// ---------------------------------------------------------------------------

/**
 * Author the team for one studio via a REAL ollama.chatJSON master call.
 * @param {Object} a
 * @param {Object} a.brand    BrandSpec from deconstructBrand()
 * @param {string} a.goal     product goal string
 * @param {boolean} a.isMemory whether this studio has memory
 * @param {Array<{statement:string}|string>} [a.lessons] traces/lessons recalled
 *        from EARLIER TURNS IN THIS RUN (memory studio only)
 * @param {Object<string,{flaw:string,attributedTo:string,severity:string}>} [a.credit]
 *        per-role highest-severity flaw attributed LAST turn (memory studio only; {}
 *        on no-memory / ablate / gen-0). Seeds the responsible agent's next-turn brief.
 * @returns {Promise<{strategy:string, agents:Array<{id:string,role:string,instructions:string,tools:string[],produces:string,briefV1:string,briefV2:string,credit?:{flaw:string,attributedTo:string},grantProvenance?:Array<{skill:string,fromLesson:string}>}>}>}
 */
export async function planTeam({ brand, goal, isMemory, lessons = [], credit = {} } = {}) {
  if (!brand || !brand.colors) throw new Error("planTeam: missing brand/colors");
  if (!goal) throw new Error("planTeam: missing goal");

  const ctx = {
    brand,
    goal,
    isMemory: !!isMemory,
    lessons: Array.isArray(lessons) ? lessons : [],
    // 2.4: each role's highest-severity flaw attributed last turn. Already {} for
    // no-memory / ablate / gen-0 (orchestrator gates it), so seeding is inert there.
    credit: (credit && typeof credit === "object") ? credit : {},
  };

  const messages = [
    { role: "system", content: masterSystemPrompt(ctx) },
    { role: "user", content: masterUserPrompt(ctx) },
  ];

  // REAL master call. On parse/transport failure we still repair from {} so the
  // orchestrator always gets a valid, contract-satisfying team (built from the
  // brand-voiced defaults) — never a crash.
  let raw = {};
  try {
    raw = await chatJSON(messages, { temperature: 0.5 });
  } catch {
    raw = {};
  }

  return repairTeam(raw, ctx);
}

// ---------------------------------------------------------------------------
// Smoke test: print a sample team for isMemory true & false.
//   node web/src/team.mjs
// Requires a local Ollama (qwen2.5:7b-instruct). If Ollama is down, the repair
// path still yields a valid team from defaults so the contract checks pass.
// ---------------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    let ok = true;
    const log = (cond, msg) => { if (!cond) ok = false; console.log(cond ? "PASS" : "FAIL", msg); };

    // A realistic brand (matches deconstructBrand()'s public shape).
    const brand = {
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
    };
    const goal = "TikTok for Business — turn 60-second videos into customers";
    const lessons = [
      { statement: "Never use gradients; use only flat brand-color blocks." },
      { statement: "The accent #25F4EE must appear on the primary CTA." },
    ];

    function checkTeam(team, { isMemory }) {
      const tag = isMemory ? "[memory]" : "[no-memory]";
      log(team && typeof team.strategy === "string" && team.strategy.length > 0, `${tag} has strategy`);
      log(Array.isArray(team.agents), `${tag} agents is array`);
      log(team.agents.length >= MIN_AGENTS && team.agents.length <= MAX_AGENTS,
          `${tag} agent count in [${MIN_AGENTS},${MAX_AGENTS}] (got ${team.agents.length})`);

      const htmlAgents = team.agents.filter((a) => a.produces === "html");
      log(htmlAgents.length >= 1, `${tag} has an html producer`);
      log(htmlAgents.every((a) => a.tools.includes("html_build")), `${tag} html producer has html_build tool`);
      log(team.agents.some((a) => a.produces === "critique"), `${tag} has a critique producer`);

      // every role from palette, every tool from palette
      log(team.agents.every((a) => ROLE_SET.has(a.role)), `${tag} all roles from ROLE_PALETTE`);
      log(team.agents.every((a) => a.tools.every((t) => SKILL_SET.has(t))), `${tag} all tools from SKILL_PALETTE`);
      log(team.agents.every((a) => typeof a.instructions === "string" && a.instructions.length >= 20),
          `${tag} every agent has real instructions (>=20 chars)`);

      // brand_tokens is DELETED — it may never be granted (palette guard).
      log(!SKILL_SET.has("brand_tokens"), `${tag} brand_tokens not in SKILL_PALETTE`);
      log(team.agents.every((a) => !a.tools.includes("brand_tokens")), `${tag} no agent granted brand_tokens`);

      // v1/v2 briefs stored at author time
      log(team.agents.every((a) =>
            typeof a.briefV1 === "string" && a.briefV1.length > 0 &&
            typeof a.briefV2 === "string" && a.briefV2.length > 0),
          `${tag} every agent has briefV1 + briefV2`);
      // v2 (instructions) is the authored/woven brief
      log(team.agents.every((a) => a.briefV2 === a.instructions),
          `${tag} briefV2 === instructions (woven/authored)`);

      // unique ids
      const ids = team.agents.map((a) => a.id);
      log(new Set(ids).size === ids.length, `${tag} agent ids unique`);
      log(team.agents.every((a) => typeof a.id === "string" && a.id.length > 0), `${tag} every agent has an id`);

      if (isMemory) {
        // lessons must be woven into at least one lesson-bearing brief
        const woven = team.agents.some((a) =>
          LESSON_BEARING_ROLES.has(a.role) &&
          /gradient/i.test(a.instructions));
        log(woven, `${tag} recalled lessons woven into a brief`);

        // the prompt-diff is stored at author time: at least one lesson-bearing
        // agent's briefV2 grew vs its briefV1 (the lesson was woven in).
        const grew = team.agents.some((a) =>
          LESSON_BEARING_ROLES.has(a.role) && a.briefV2.length > a.briefV1.length);
        log(grew, `${tag} a lesson-bearing brief grew briefV1 -> briefV2 (prompt-diff stored)`);

        // memory tools ARE present on the memory studio (auditor/builder consult memory)
        const hasMemTool = team.agents.some((a) =>
          a.tools.includes("cognee_recall") || a.tools.includes("cognee_trace"));
        log(hasMemTool, `${tag} memory tools granted to at least one agent`);
      } else {
        // FAIRNESS: no memory tools may leak onto a no-memory roster
        log(team.agents.every((a) => !a.tools.includes("cognee_recall") && !a.tools.includes("cognee_trace")),
            `${tag} no memory tools granted (fairness)`);
        log(team.agents.every((a) => a.role !== "brand-guardian"), `${tag} no memory-only roles`);
        // briefV1 === briefV2 on the no-memory studio (no weaving)
        log(team.agents.every((a) => a.briefV1 === a.briefV2),
            `${tag} briefV1 === briefV2 (no lessons woven)`);
      }
    }

    function printTeam(team, label) {
      console.log(`\n===== SAMPLE TEAM ${label} =====`);
      console.log("strategy:", team.strategy);
      for (const a of team.agents) {
        console.log(`\n  • [${a.id}] role=${a.role} produces=${a.produces} tools=${JSON.stringify(a.tools)}`);
        console.log(`    instructions: ${a.instructions}`);
      }
    }

    const noMem = await planTeam({ brand, goal, isMemory: false, lessons: [] });
    printTeam(noMem, "(no-memory)");
    checkTeam(noMem, { isMemory: false });

    const mem = await planTeam({ brand, goal, isMemory: true, lessons });
    printTeam(mem, "(memory, with 2 recalled lessons from earlier turns)");
    checkTeam(mem, { isMemory: true });

    // ---- CREDIT (2.5) -----------------------------------------------------
    // Memory team with a flaw attributed to frontend-implementer last turn + 1 lesson.
    const flawText = "text is hard to read";
    const credit = {
      "frontend-implementer": { flaw: flawText, attributedTo: "frontend-implementer", severity: "high" },
    };
    const memCredit = await planTeam({
      brand, goal, isMemory: true,
      lessons: [{ statement: "Never use gradients; use only flat brand-color blocks." }],
      credit,
    });
    const builder = memCredit.agents.find((a) => a.role === "frontend-implementer");
    // (a) credit seeded the builder's briefV2 verbatim, and briefV1 does NOT carry it.
    log(!!builder, "[credit] memory team has a frontend-implementer builder");
    log(!!builder && builder.briefV2.includes(flawText),
        "[credit] builder briefV2 contains the verbatim attributed flaw (seeded)");
    log(!!builder && !builder.briefV1.includes(flawText),
        "[credit] builder briefV1 does NOT contain the flaw (prompt-diff grew)");
    // (b) agent.credit equals the exact app.js renderCredit shape.
    log(!!builder && builder.credit &&
        builder.credit.flaw === flawText &&
        builder.credit.attributedTo === "frontend-implementer",
        "[credit] builder.credit === {flaw, attributedTo}");
    // (c) at least one agent carries a validated grantProvenance entry whose skill is in
    //     its tools and whose fromLesson matches the recalled lesson.
    const provAgent = memCredit.agents.find((a) =>
      Array.isArray(a.grantProvenance) && a.grantProvenance.length);
    log(!!provAgent, "[credit] at least one agent has grantProvenance");
    log(!!provAgent && provAgent.grantProvenance.every((g) =>
          g && typeof g.skill === "string" && provAgent.tools.includes(g.skill) &&
          typeof g.fromLesson === "string" && g.fromLesson.length > 0),
        "[credit] grantProvenance skill in agent tools + non-empty fromLesson");
    // (d) the NO-MEMORY team (credit {}) carries NO credit and NO grantProvenance.
    const noMemCredit = await planTeam({ brand, goal, isMemory: false, lessons: [], credit: {} });
    log(noMemCredit.agents.every((a) => a.credit === undefined),
        "[credit] no-memory team has NO agent.credit (fairness)");
    log(noMemCredit.agents.every((a) => a.grantProvenance === undefined),
        "[credit] no-memory team has NO grantProvenance (fairness)");
    // belt-and-suspenders: no rawProv scratch field leaks into the returned shape.
    log(memCredit.agents.every((a) => !("rawProv" in a)) &&
        noMemCredit.agents.every((a) => !("rawProv" in a)),
        "[credit] rawProv scratch field stripped from returned agents");

    console.log(`\n${ok ? "team.mjs smoke: ALL PASS" : "team.mjs smoke: FAILURES"}`);
    process.exit(ok ? 0 : 1);
  })().catch((err) => {
    console.error("team.mjs smoke FAILED:", err && err.stack ? err.stack : err);
    process.exit(1);
  });
}
