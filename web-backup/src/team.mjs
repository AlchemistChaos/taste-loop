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
// This is the authoring brain. It is NOT cosmetic: the orchestrator spawns exactly
// these agents and every one runs its master-authored instructions with its granted
// tools to produce REAL output.
//
// Frozen exports (other modules import this exact shape):
//   export const ROLE_PALETTE   : string[]
//   export const SKILL_PALETTE  : string[]   // ["html_build","svg_image","cognee_recall","cognee_trace","brand_tokens"] — NO web_search
//   export async function planTeam({brand, goal, isMemory, lessons}) -> {
//     strategy: string,
//     agents: [{ id, role, instructions, tools:string[], produces:string }]
//   }
//
// Guarantees enforced by validate/repair (so the orchestrator never has to
// defend against a bad master output):
//   - at least one agent with produces === "html"   (granted html_build)
//   - at least one agent with produces === "critique"
//   - every tool is from SKILL_PALETTE (unknown tools dropped)
//   - roster capped at 7 agents, deduped ids
//   - MEMORY studio: recalled lessons woven into the relevant agents'
//     instructions, and cognee_recall/cognee_trace granted where they fit
//
// Plain ESM, Node 18+, no npm deps. Uses ollama.chatJSON (frozen).

import { chatJSON } from "./ollama.mjs";

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
  "image-sourcer",       // on-brand imagery / inline SVG (no generic AI stock)
  "critique",            // brutal brand-rule audit (produces critique)
  "brand-guardian",      // memory studio: enforces recalled, checkable brand rules
];

// The tools the master may grant. NO web_search by design — the studio works from
// the brand book + memory, not the open web.
export const SKILL_PALETTE = [
  "html_build",     // build the real HTML page (Codex gpt-5.4)
  "svg_image",      // author inline SVG / source on-brand imagery
  "cognee_recall",  // recall prior-run lessons / in-run traces from memory
  "cognee_trace",   // write findings back into memory as traces
  "brand_tokens",   // read the BrandSpec tokens (colors/fonts/dos/donts)
  // Real, grantable capabilities the executor will ACTUALLY run. A recalled
  // lesson that implies one of these MUST cause the master to grant it.
  "image_gen",      // generate an on-brand hero image (returns a data URI to embed)
  "a11y_check",     // run a real accessibility check on the built page
  "contrast_check", // parse colors and flag low-contrast text/bg pairs
  "copy_lint",      // flag banned business buzzwords in the copy
];

const SKILL_SET = new Set(SKILL_PALETTE);
const ROLE_SET = new Set(ROLE_PALETTE);

const MAX_AGENTS = 7;
const MIN_AGENTS = 3;

// Roles that are memory-only — the master should only field these on the memory
// studio, and they must be dropped from a no-memory roster during repair.
const MEMORY_ONLY_ROLES = new Set(["brand-guardian"]);

// Memory tools — only valid on the memory studio.
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
    "ALLOWED TOOLS (grant ONLY these; there is deliberately NO web search — work from the brand book and memory):",
    JSON.stringify(SKILL_PALETTE),
    "  - html_build: build the real, self-contained HTML page. Grant to your builder.",
    "  - svg_image: author inline SVG or source on-brand imagery.",
    "  - cognee_recall: recall lessons learned in prior runs and traces within this run.",
    "  - cognee_trace: write findings/decisions back into memory.",
    "  - brand_tokens: read the BrandSpec tokens (exact colors, fonts, dos/donts).",
    "  - image_gen: generate an on-brand hero IMAGE (a data URI the builder embeds). Grant when a lesson or the brief calls for stronger/on-brand imagery.",
    "  - a11y_check: run a REAL accessibility check on the built page (alt text, button/aria, lang). Grant to the auditor/builder when a lesson concerns accessibility.",
    "  - contrast_check: parse colors and flag low-contrast text/bg pairs. Grant when a lesson concerns contrast, legibility, or accent-on-CTA.",
    "  - copy_lint: flag banned business buzzwords/jargon in the copy. Grant when a lesson concerns voice/jargon/buzzwords.",
    "",
    "TOOLS ARE REAL CAPABILITIES, NOT LABELS. When a recalled lesson implies a capability, GRANT that agent the",
    "matching tool from the palette, not just mention it in prose. Examples: a contrast/accessibility lesson ->",
    "GRANT a11y_check and/or contrast_check to the auditor; an imagery/visual lesson -> GRANT image_gen to the",
    "builder or image-sourcer; a voice/jargon/buzzword lesson -> GRANT copy_lint to the copywriter or critique.",
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
          "THIS STUDIO HAS MEMORY. You will be given LESSONS recalled from prior runs. You MUST weave each",
          "recalled lesson, verbatim and non-negotiable, into the instructions of the agents who can act on it",
          "(typically the builder, the visual-designer, and a brand-guardian/critique). Grant cognee_recall to",
          "agents that should consult memory and cognee_trace to agents that should record findings. Consider",
          'fielding a "brand-guardian" whose entire brief is to enforce the recalled, checkable brand rules.',
        ].join(" ")
      : [
          "THIS STUDIO HAS NO MEMORY. It has learned nothing from prior runs. Do NOT grant cognee_recall or",
          'cognee_trace, and do NOT field a "brand-guardian". Plan a strong team from first principles only.',
        ].join(" "),
    "",
    "Return ONLY valid JSON, no prose, no markdown fences, in EXACTLY this shape:",
    "{",
    '  "strategy": "<one concrete sentence describing the build approach for this page>",',
    '  "agents": [',
    "    {",
    '      "role": "<one of the allowed roles>",',
    '      "instructions": "<the real, specific, brand-voiced prompt this agent runs on>",',
    '      "tools": ["<allowed tool>", ...],',
    '      "produces": "<short noun for the artifact this agent yields, e.g. brandspec|copy|layout|html|critique|imagery|ia|typescale>"',
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
        `RECALLED LESSONS from memory (${lessons.length}) — these were learned the hard way and MUST be`,
        "woven verbatim into the instructions of the agents who can enforce them:",
        ...lessons.map((l, i) => `  ${i + 1}. ${typeof l === "string" ? l : (l.statement || "")}`),
      ].join("\n")
    : (isMemory
        ? "\nRECALLED LESSONS from memory: (none yet — this is the first generation). Plan a strong first-pass team."
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
      ? "Author the MEMORY studio's team now. Make memory its visible advantage: weave the recalled lessons into the right briefs and wire up cognee_recall/cognee_trace."
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
// for no-memory studios).
function cleanTools(raw, { isMemory }) {
  let arr = [];
  if (Array.isArray(raw)) arr = raw;
  else if (typeof raw === "string") arr = raw.split(/[,\s]+/);
  const out = [];
  for (const t of arr) {
    const tool = asString(t);
    if (!SKILL_SET.has(tool)) continue;
    if (!isMemory && MEMORY_TOOLS.has(tool)) continue;
    if (!out.includes(tool)) out.push(tool);
  }
  return out;
}

// Default instructions for a role, used only when the model omits/blanks one
// during repair. Brand-voiced so even repaired agents carry real direction.
function defaultInstructions(role, { brand, goal, lessons, isMemory }) {
  const c = brand?.colors || {};
  const tone = Array.isArray(brand?.tone) ? brand.tone.join(", ") : String(brand?.tone || "");
  const donts = JSON.stringify(brand?.dont || []);
  const lessonTail = (isMemory && lessons && lessons.length)
    ? ` Apply these learned rules verbatim, non-negotiable: ${lessons.map((l) => (typeof l === "string" ? l : l.statement)).filter(Boolean).join("; ")}.`
    : "";
  switch (role) {
    case "brand-deconstruct":
      return `Load and interpret the TikTok BrandSpec. Surface the exact palette (${c.primary}/${c.accent} on ${c.bg}), the approved fonts, the ${tone} tone, and the hard DON'Ts ${donts} so every downstream agent works from the real tokens.`;
    case "copywriter":
      return `Write bold, ${tone} marketing copy for "${goal}". Punchy hero headline, scannable section copy, real CTAs — no lorem, no jargon. Speak directly to ${brand?.audience || "the audience"}.${lessonTail}`;
    case "info-architect":
      return `Order the page sections ${JSON.stringify(brand?.sections || [])} for maximum conversion: hook fast, prove value, drive to one primary CTA. Justify the flow in one line per section.${lessonTail}`;
    case "typographer":
      return `Set a confident type scale using only the approved fonts (heading "${brand?.fonts?.heading}", body "${brand?.fonts?.body}"). Big, dominant headlines; comfortable body; clear hierarchy. Respect the DON'Ts ${donts}.${lessonTail}`;
    case "visual-designer":
      return `Art-direct an on-brand layout using FLAT brand-color blocks only (${c.primary}/${c.accent} on ${c.bg}/${c.fg}). Strong hierarchy, generous whitespace, the primary CTA visually dominant. Obey the DON'Ts ${donts} exactly.${lessonTail}`;
    case "frontend-implementer":
      return `Build a single self-contained, responsive HTML5 page with exactly 5 sections (${JSON.stringify(brand?.sections || [])}) for "${goal}". Use the real brand tokens (colors ${c.primary}/${c.accent}, fonts ${brand?.fonts?.heading}), flat color blocks only, real on-brand copy, strong hierarchy, and prominent CTAs. Obey every DON'T: ${donts}.${lessonTail}`;
    case "image-sourcer":
      return `Provide on-brand imagery or inline SVG that reinforces the ${tone} voice — no generic AI stock, no off-palette colors. Keep visuals flat and aligned to ${c.primary}/${c.accent}.${lessonTail}`;
    case "critique":
      return `Brutally audit the built page against the brand rules. List concrete, actionable violations — especially any breach of the DON'Ts ${donts}. Be specific and unforgiving; flag anything off-brand.${lessonTail}`;
    case "brand-guardian":
      return `Enforce the recalled, checkable brand rules on the built page. Verify each learned rule is satisfied and reject the page if any is broken.${lessonTail || " Apply the studio's learned brand rules."}`;
    default:
      return `Contribute on-brand work toward "${goal}" using the brand tokens (${c.primary}/${c.accent}, ${tone}) and obeying the DON'Ts ${donts}.${lessonTail}`;
  }
}

// Weave recalled lessons into an instruction string if they aren't already
// referenced. Used for the memory studio's actionable agents.
function weaveLessons(instructions, lessons) {
  if (!lessons || !lessons.length) return instructions;
  const statements = lessons
    .map((l) => (typeof l === "string" ? l : (l && l.statement) || ""))
    .map((s) => asString(s))
    .filter(Boolean);
  if (!statements.length) return instructions;
  const lower = String(instructions || "").toLowerCase();
  const missing = statements.filter((s) => !lower.includes(s.toLowerCase().slice(0, Math.min(24, s.length))));
  if (!missing.length) return instructions;
  const tail = ` LEARNED RULES (from memory — apply verbatim, non-negotiable): ${missing.join("; ")}.`;
  return `${asString(instructions)}${tail}`;
}

// ---------------------------------------------------------------------------
// Lesson -> SKILL GRANT mapping. A recalled lesson must change an agent's
// TOOLSET, not only its prompt. Each rule matches lesson text and yields the
// real capability to grant + the roles that should receive it (in preference
// order). This is the deterministic backbone behind the master prompt's
// "GRANT the matching tool" instruction.
// ---------------------------------------------------------------------------
const LESSON_SKILL_RULES = [
  {
    skill: "contrast_check",
    test: /contrast|legib|low[-\s]?contrast|accent.*(cta|button|link)|(cta|button|link).*accent|#25f4ee|readab/i,
    roles: ["critique", "brand-guardian", "visual-designer", "frontend-implementer"],
  },
  {
    skill: "a11y_check",
    test: /a11y|accessib|alt text|aria|screen reader|wcag|focus state|tab order/i,
    roles: ["critique", "brand-guardian", "frontend-implementer"],
  },
  {
    skill: "copy_lint",
    test: /buzzword|jargon|business[-\s]?speak|voice|revolutionary|cutting[-\s]?edge|game[-\s]?chang|synergy|leverage/i,
    roles: ["copywriter", "critique", "brand-guardian"],
  },
  {
    skill: "image_gen",
    test: /imager|image|hero (visual|image|shot)|photo|illustration|stock|visual.*(weak|generic|off[-\s]?brand)/i,
    roles: ["image-sourcer", "frontend-implementer", "visual-designer"],
  },
];

// Given the recalled lessons, return [{skill, roles}] for every capability they
// imply. De-duped by skill (first matching lesson wins the role preference).
function lessonSkillGrants(lessons) {
  if (!Array.isArray(lessons) || !lessons.length) return [];
  const texts = lessons
    .map((l) => (typeof l === "string" ? l : (l && l.statement) || ""))
    .filter(Boolean);
  const grants = [];
  const seen = new Set();
  for (const text of texts) {
    for (const rule of LESSON_SKILL_RULES) {
      if (seen.has(rule.skill)) continue;
      if (rule.test.test(text)) {
        grants.push({ skill: rule.skill, roles: rule.roles });
        seen.add(rule.skill);
      }
    }
  }
  return grants;
}

// Roles whose briefs should carry the recalled lessons on the memory studio.
const LESSON_BEARING_ROLES = new Set([
  "frontend-implementer",
  "visual-designer",
  "critique",
  "brand-guardian",
  "copywriter",
]);

// Validate + repair the master's raw JSON into the guaranteed contract shape.
function repairTeam(raw, ctx) {
  const { brand, goal, isMemory, lessons } = ctx;
  const strategy = asString(raw && raw.strategy) ||
    (isMemory
      ? "Apply the recalled brand lessons and ship a flat, on-brand, high-converting TikTok page."
      : "Ship a bold, flat, on-brand high-converting TikTok marketing page from first principles.");

  let agents = Array.isArray(raw && raw.agents) ? raw.agents : [];

  // 1) Coerce each agent; drop ones with an unknown role.
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

    cleaned.push({ role, instructions, tools, produces });
    seenRoles.add(role);
  }

  // 2) Ensure an html agent exists (frontend-implementer is the canonical builder).
  let htmlAgent = cleaned.find((a) => a.produces === "html" || a.tools.includes("html_build"));
  if (!htmlAgent) {
    // promote an existing frontend-implementer, else add one
    htmlAgent = cleaned.find((a) => a.role === "frontend-implementer");
    if (!htmlAgent) {
      htmlAgent = {
        role: "frontend-implementer",
        instructions: defaultInstructions("frontend-implementer", ctx),
        tools: [],
        produces: "html",
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
    critAgent = {
      role: "critique",
      instructions: defaultInstructions("critique", ctx),
      tools: [],
      produces: "critique",
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
    "image-sourcer": "imagery",
    critique: "critique",
    "brand-guardian": "guard",
  };
  for (const a of cleaned) {
    if (!a.produces) a.produces = PRODUCES_BY_ROLE[a.role] || "work";
  }

  // 5) Memory studio: weave lessons into lesson-bearing briefs and grant memory
  //    tools where they fit; no-memory studio: strip any memory tool leakage.
  for (const a of cleaned) {
    if (isMemory) {
      if (LESSON_BEARING_ROLES.has(a.role)) {
        a.instructions = weaveLessons(a.instructions, lessons);
      }
      // the auditor/guardian should be able to consult memory
      if ((a.role === "critique" || a.role === "brand-guardian") && lessons && lessons.length) {
        if (!a.tools.includes("cognee_recall")) a.tools.push("cognee_recall");
        if (!a.tools.includes("cognee_trace")) a.tools.push("cognee_trace");
      }
      // the builder should recall what was learned before building
      if (a.role === "frontend-implementer" && lessons && lessons.length) {
        if (!a.tools.includes("cognee_recall")) a.tools.push("cognee_recall");
      }
      if (a.role === "brand-deconstruct" && !a.tools.includes("brand_tokens")) {
        a.tools.push("brand_tokens");
      }
    } else {
      a.tools = a.tools.filter((t) => !MEMORY_TOOLS.has(t));
    }
  }

  // 5b) MEMORY studio: a recalled lesson must change an agent's TOOLSET, not only
  //     its prompt. For every capability the lessons imply, GRANT the matching
  //     skill to the best available agent (preferred role order). If none of the
  //     preferred roles is on the roster, attach it to the critique/builder so
  //     the capability is never silently dropped.
  if (isMemory && lessons && lessons.length) {
    for (const { skill, roles } of lessonSkillGrants(lessons)) {
      // already granted to someone? skip.
      if (cleaned.some((a) => a.tools.includes(skill))) continue;
      let target = null;
      for (const role of roles) {
        target = cleaned.find((a) => a.role === role);
        if (target) break;
      }
      // image_gen falls to the html builder (it threads the data URI to embed);
      // all other checks fall to the critique auditor.
      if (!target) target = (skill === "image_gen") ? htmlAgent : critAgent;
      if (target && !target.tools.includes(skill)) target.tools.push(skill);
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
      const a = {
        role,
        instructions: defaultInstructions(role, ctx),
        tools: role === "brand-deconstruct" ? ["brand_tokens"] : [],
        produces: PRODUCES_BY_ROLE[role] || "work",
      };
      if (isMemory && LESSON_BEARING_ROLES.has(role)) a.instructions = weaveLessons(a.instructions, lessons);
      roster.push(a);
      seenRoles.add(role);
    }
  }

  // 8) Assign stable, unique ids (role + ordinal for duplicate roles).
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
 * @param {Array<{statement:string}|string>} [a.lessons] recalled lessons (memory only)
 * @returns {Promise<{strategy:string, agents:Array<{id:string,role:string,instructions:string,tools:string[],produces:string}>}>}
 */
export async function planTeam({ brand, goal, isMemory, lessons = [] } = {}) {
  if (!brand || !brand.colors) throw new Error("planTeam: missing brand/colors");
  if (!goal) throw new Error("planTeam: missing goal");

  const ctx = { brand, goal, isMemory: !!isMemory, lessons: Array.isArray(lessons) ? lessons : [] };

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

        // a recalled lesson must change an agent's TOOLSET, not only its prompt:
        // the accent/CTA contrast lesson -> the auditor gets contrast_check.
        const granted = team.agents.find((a) => a.tools.includes("contrast_check"));
        log(!!granted, `${tag} accent/CTA contrast lesson GRANTED contrast_check to an agent`);
        if (granted) console.log(`    -> contrast_check granted to [${granted.id}] role=${granted.role}`);
      } else {
        // no memory tools may leak
        log(team.agents.every((a) => !a.tools.includes("cognee_recall") && !a.tools.includes("cognee_trace")),
            `${tag} no memory tools granted`);
        log(team.agents.every((a) => a.role !== "brand-guardian"), `${tag} no memory-only roles`);
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
    printTeam(mem, "(memory, with 2 recalled lessons)");
    checkTeam(mem, { isMemory: true });

    console.log(`\n${ok ? "team.mjs smoke: ALL PASS" : "team.mjs smoke: FAILURES"}`);
    process.exit(ok ? 0 : 1);
  })().catch((err) => {
    console.error("team.mjs smoke FAILED:", err && err.stack ? err.stack : err);
    process.exit(1);
  });
}
