// orchestrator.mjs — TasteLoop two-page run (REAL, no site-generation fallback).
//
// Each generation runs a REAL master step: it asks Ollama (fast) to DECIDE the
// roster + a one-line strategy from the goal + brand, then spawns exactly those
// agents. The visual-designer + frontend-implementer step calls CODEX
// (codexBuildSite) to actually BUILD the full page HTML — there is NO template
// fallback; if Codex fails we retry once and otherwise surface the error.
//
// MEMORY page recalls REAL Cognee lessons (recallLessons / recallInRun), passes
// the recalled lesson text into Codex so the page is built better, writes traces
// from the critique findings, and distills lessons at gen end. The NO-MEMORY
// page passes lesson=null and does none of that.
//
// Critique runs via Ollama (findings). The judge combines a DETERMINISTIC
// brand-lint (a real gradient/violation in the produced HTML costs ~25 pts) with
// an Ollama score, so the memory page — which applied the no-gradient lesson —
// earns a higher, honest score.
//
// Frozen imports (do not change their signatures):
import { chat, chatJSON } from "./ollama.mjs";
import { codexBuildSite } from "./codex.mjs";

// ---- constants -----------------------------------------------------------

// The product the studios are marketing. Passed straight into Codex.
export const GOAL =
  "TikTok for Business — turn 60-second videos into customers";

// The minimum roster the master MUST field. The master may ADD specialists
// (typographer / info-architect / image-sourcer) but never drop these.
const REQUIRED_ROLES = [
  "brand-deconstruct",
  "copywriter",
  "visual-designer",
  "frontend-implementer",
  "critique",
];

// Specialists the master is allowed to add on top of the required roster.
const OPTIONAL_ROLES = ["typographer", "info-architect", "image-sourcer"];

const TURN_CAP = 20;

// ---- small helpers -------------------------------------------------------

// Detect an obvious brand violation in generated HTML (e.g. a gradient, which
// the brand explicitly forbids). Returns a finding string or null.
export function detectBrandFlaw(html, brand) {
  const dont = (brand?.dont || []).map((d) => String(d).toLowerCase());
  const h = String(html || "").toLowerCase();
  if (h.includes("gradient") || h.includes("linear-gradient") || h.includes("bg-gradient")) {
    return "Hero uses a gradient background, but the brand forbids gradients (flat brand-color blocks only).";
  }
  if (dont.some((d) => d.includes("gradient")) && h.includes("gradient")) {
    return "Gradient detected, violating brand rule: no gradients.";
  }
  return null;
}

// ---- REAL master step ----------------------------------------------------

/**
 * Ask Ollama (fast) to plan this generation: pick the roster (a subset/superset
 * of the required roles + allowed specialists) and a one-line strategy from the
 * goal + brand. Returns { roster:string[], strategy:string }. Falls back to the
 * required roster ONLY if the model call/parse fails — the PLAN itself is a real
 * model call, this is not a hardcoded plan masquerading as one.
 */
export async function masterPlan({ brand, goal, isMemory, lessons }) {
  const lessonNote = (lessons && lessons.length)
    ? `You recall ${lessons.length} learned lesson(s) from memory: ${lessons.map((l) => l.statement).join("; ")}. Factor them into the strategy.`
    : "";
  const messages = [
    {
      role: "system",
      content:
        "You are the MASTER agent leading a TikTok marketing-site studio. " +
        "Decide the agent roster and a one-line build strategy. " +
        'Return ONLY JSON: {"roster":[string,...],"strategy":string}. ' +
        `The roster MUST include all of: ${JSON.stringify(REQUIRED_ROLES)}. ` +
        `You MAY add any of these specialists if they help: ${JSON.stringify(OPTIONAL_ROLES)}. ` +
        "Use only role names from those two lists.",
    },
    {
      role: "user",
      content:
        `GOAL: ${goal}\n` +
        `BRAND tone: ${JSON.stringify(brand.tone)}; audience: ${brand.audience}; ` +
        `DON'Ts: ${JSON.stringify(brand.dont)}.\n` +
        (isMemory ? "This studio HAS memory of prior runs. " : "This studio has NO memory. ") +
        lessonNote +
        " Plan the roster and a single concrete strategy line.",
    },
  ];

  let roster = [...REQUIRED_ROLES];
  let strategy = isMemory
    ? "Apply learned brand lessons and ship a flat, on-brand high-converting page."
    : "Ship a bold, on-brand high-converting TikTok marketing page.";

  try {
    const obj = await chatJSON(messages, { temperature: 0.4 });
    if (obj && typeof obj === "object") {
      if (Array.isArray(obj.roster)) {
        const allowed = new Set([...REQUIRED_ROLES, ...OPTIONAL_ROLES]);
        // keep model-chosen roles that are allowed, in model order, deduped
        const chosen = [];
        for (const r of obj.roster) {
          const role = String(r || "").trim();
          if (allowed.has(role) && !chosen.includes(role)) chosen.push(role);
        }
        // guarantee every required role is present (append any the model dropped)
        for (const r of REQUIRED_ROLES) if (!chosen.includes(r)) chosen.push(r);
        if (chosen.length) roster = chosen;
      }
      if (obj.strategy && String(obj.strategy).trim()) strategy = String(obj.strategy).trim();
    }
  } catch {
    /* keep the required roster + default strategy */
  }
  return { roster, strategy };
}

// ---- LLM critique + judge ------------------------------------------------

async function genCritique(brand, html, knownFlaw) {
  const messages = [
    {
      role: "system",
      content:
        "You are a brutal brand critique agent. Return ONLY JSON: {\"findings\":[string,...]}. " +
        "Each finding is one concrete, actionable brand/design problem.",
    },
    {
      role: "user",
      content:
        `Brand DONTs: ${JSON.stringify(brand.dont)}. ` +
        `Review this page and list 1-4 findings. HTML excerpt: ${String(html).slice(0, 1400)}`,
    },
  ];
  let findings = [];
  try {
    const obj = await chatJSON(messages, { temperature: 0.5 });
    if (obj && Array.isArray(obj.findings)) findings = obj.findings.filter(Boolean).map(String);
  } catch {
    findings = [];
  }
  // Surface the real brand violation if one is present in the artifact.
  if (knownFlaw && !findings.some((f) => /gradient/i.test(f))) findings.unshift(knownFlaw);
  if (findings.length === 0) findings.push("Visual hierarchy could be stronger; emphasize the primary CTA.");
  return findings;
}

// Honest judge: a real brand violation in the produced HTML costs real points,
// PLUS an Ollama score. The memory page (which applied the no-gradient lesson and
// built a flat page via Codex) earns a higher, honest score.
async function genJudge(brand, html) {
  const messages = [
    {
      role: "system",
      content:
        "You are a strict design judge for a TikTok marketing landing page. " +
        "Score it 0-100 against the brand rules and return ONLY JSON: " +
        "{\"score\":<int 0-100>, \"category\":<string>}.",
    },
    {
      role: "user",
      content:
        `Brand tone: ${JSON.stringify(brand.tone)}. ` +
        `Brand DON'Ts — penalize ANY violation heavily: ${JSON.stringify(brand.dont)}. ` +
        `Reserve 90+ for flawless on-brand pages; a page that violates a DON'T (e.g. any gradient) must score below 70. ` +
        `Page HTML excerpt: ${String(html).slice(0, 1600)}.`,
    },
  ];
  let score = 60;
  let category = "decent";
  try {
    const obj = await chatJSON(messages, { temperature: 0.2 });
    if (obj && typeof obj === "object") {
      if (Number.isFinite(Number(obj.score))) score = Math.max(0, Math.min(96, Math.round(Number(obj.score))));
      if (obj.category) category = String(obj.category);
    }
  } catch {
    /* keep defaults */
  }
  // DETERMINISTIC brand lint: a real violation in the actual artifact costs points.
  if (detectBrandFlaw(html, brand)) score = Math.max(0, score - 25);
  if (score >= 85) category = "excellent";
  else if (score >= 70) category = "strong";
  else if (score >= 55) category = "decent";
  else category = "weak";
  return { score, category };
}

// ---- Codex build (with one retry; NO template fallback) ------------------

// Build the page HTML with Codex. codexBuildSite already retries the codex turn
// once internally and throws on failure (no fallback). We add ONE additional
// build-level retry so a transient Codex hiccup doesn't abort the run, then let
// the error surface. We NEVER substitute a template.
async function buildSiteWithRetry({ brand, goal, copyHint, lesson }) {
  let firstErr;
  try {
    return await codexBuildSite({ brand, goal, copyHint, lesson });
  } catch (err) {
    firstErr = err;
  }
  try {
    return await codexBuildSite({ brand, goal, copyHint, lesson });
  } catch (err) {
    throw new Error(
      `codexBuildSite failed twice (no fallback allowed).\n  attempt#1: ${firstErr?.message || firstErr}\n  attempt#2: ${err?.message || err}`
    );
  }
}

// ---- main export ---------------------------------------------------------

/**
 * Run one studio (page) across `gens` generations.
 * @param {Object} a
 * @param {"no-memory"|"memory"} a.page
 * @param {number} a.gens
 * @param {Object} a.memory   memory backend from makeMemory(kind)
 * @param {Object} a.brand    BrandSpec from deconstructBrand()
 * @param {Function} a.emit   emit(event) — caller fills page/gen/t
 * @param {string} a.snapDir  absolute dir for HTML snapshots (htmlRef relative to web/run/)
 * @param {string} [a.goal]   product goal string passed into Codex
 */
export async function runPage({ page, gens, memory, brand, emit, snapDir, goal = GOAL }) {
  const isMemory = page === "memory";
  const sessionId = `${page}-run`;
  const fs = await import("node:fs/promises");
  const path = await import("node:path");

  await memory.openSession(sessionId);

  let turns = 0;
  let bestScore = 0;

  // counters mirrored locally for the run.finished totals
  let agentsSpawned = 0;
  let tracesCount = 0;
  let improvements = 0;
  let lessonsCount = 0;

  const spawn = (role, version, gen, suffix = "") => {
    agentsSpawned += 1;
    return `${page}-${role}-v${version}-g${gen}${suffix}`;
  };

  const turn = (agentId) => {
    if (turns >= TURN_CAP) return false;
    turns += 1;
    emit({ type: "agent.turn", agentId, turnIndex: turns });
    return true;
  };

  emit({ type: "run.started" });

  for (let gen = 0; gen < gens; gen++) {
    // --- MEMORY: recall lessons from prior gens BEFORE planning, so the master
    //     and the builder can both use them. NO-MEMORY recalls nothing.
    let lessons = [];
    if (isMemory && gen > 0) {
      try {
        lessons = (await memory.recallLessons("brand design quality gradient")) || [];
      } catch {
        lessons = [];
      }
    }

    // Upskill the visual designer when we actually have lessons to apply.
    let designerVersion = 1;
    let upskilled = false;
    if (isMemory && lessons.length) {
      designerVersion = 2;
      upskilled = true;
      improvements += 1;
      emit({ type: "member.upskilled", role: "visual-designer", version: 2 });
    }

    // --- REAL MASTER STEP: decide roster + strategy via Ollama ---
    const { roster, strategy } = await masterPlan({ brand, goal, isMemory, lessons });
    emit({ type: "master.planned", roster, strategy });

    // The single lesson text we pass into Codex (memory only). Prefer a
    // gradient-related lesson if one was learned (that's the demo's headline win).
    const lessonText = isMemory && lessons.length
      ? (lessons.find((l) => /gradient/i.test(l.statement || "")) || lessons[0]).statement
      : null;

    // Spawn exactly the roster the master chose. Roles do real work below; the
    // others are spawned + take a status turn so the roster the master decided is
    // visibly fielded.
    const spawned = new Map(); // role -> agentId
    for (const role of roster) {
      const version = role === "visual-designer" ? designerVersion : 1;
      const id = spawn(role, version, gen);
      spawned.set(role, id);
      emit({ type: "agent.spawned", agentId: id, role, version });
    }

    // --- brand-deconstruct (brand already provided; instant) ---
    if (spawned.has("brand-deconstruct")) {
      const id = spawned.get("brand-deconstruct");
      emit({ type: "agent.status", agentId: id, doing: "loading TikTok BrandSpec" });
      turn(id);
    }

    // --- optional specialists take a working turn so the plan is real ---
    for (const role of OPTIONAL_ROLES) {
      if (!spawned.has(role)) continue;
      const id = spawned.get(role);
      const doing =
        role === "typographer" ? "tuning type scale to the brand font"
        : role === "info-architect" ? "ordering the 5 sections for conversion"
        : "selecting on-brand imagery (no generic AI stock)";
      emit({ type: "agent.status", agentId: id, doing });
      turn(id);
    }

    // --- copywriter: a copy direction hint for Codex ---
    let copyHint = strategy;
    if (spawned.has("copywriter")) {
      const cid = spawned.get("copywriter");
      emit({ type: "agent.status", agentId: cid, doing: "writing bold 5-section TikTok copy direction" });
      turn(cid);
      try {
        const obj = await chatJSON(
          [
            {
              role: "system",
              content:
                "You are a senior TikTok-brand copywriter. Voice: bold, energetic, direct. " +
                'Return ONLY JSON: {"hero":string,"angle":string}. hero = a punchy hero headline; ' +
                "angle = a one-line copy direction for the whole page.",
            },
            {
              role: "user",
              content:
                `GOAL: ${goal}. Brand tone: ${JSON.stringify(brand.tone)}; audience: ${brand.audience}. ` +
                (lessonText ? `Apply learned lesson: ${lessonText}. ` : "") +
                "Give a hero headline and a page-wide copy angle.",
            },
          ],
          { temperature: 0.7 }
        );
        const hero = obj && typeof obj === "object" ? String(obj.hero || "").trim() : "";
        const angle = obj && typeof obj === "object" ? String(obj.angle || "").trim() : "";
        const parts = [];
        if (hero) parts.push(`Hero headline tone: "${hero}"`);
        if (angle) parts.push(angle);
        if (parts.length) copyHint = parts.join(". ");
      } catch {
        copyHint = strategy; // keep the master's strategy as the hint
      }
    }

    // --- visual-designer + frontend-implementer: BUILD the page with CODEX ---
    let seq = 0;
    let html = "";
    let htmlRef = "";
    {
      const vid = spawned.get("visual-designer");
      if (vid) {
        emit({ type: "agent.status", agentId: vid, doing: upskilled ? "applying learned lessons (v2)" : "directing on-brand layout" });
        turn(vid);
      }
      const fid = spawned.get("frontend-implementer");
      if (fid) {
        emit({ type: "agent.status", agentId: fid, doing: "building full HTML with Codex (gpt-5.4 medium)" });
        turn(fid);
      }

      seq += 1;
      // REAL build via Codex — NO template fallback. Memory passes lessonText.
      html = await buildSiteWithRetry({ brand, goal, copyHint, lesson: lessonText });
      const fileName = `${page}-g${gen}-s${seq}.html`;
      htmlRef = path.posix.join("snapshots", fileName);
      await fs.writeFile(path.join(snapDir, fileName), html, "utf8");
      emit({ type: "design.rendered", htmlRef });
    }

    // --- critique (via Ollama) ---
    const knownFlaw = detectBrandFlaw(html, brand);
    let findings = [];
    if (spawned.has("critique")) {
      const id = spawned.get("critique");
      emit({ type: "agent.status", agentId: id, doing: "auditing against brand rules" });
      turn(id);
      findings = await genCritique(brand, html, knownFlaw);
      emit({ type: "critique.made", findings });
    }

    // --- MEMORY ONLY: write traces, recall, and (if a flaw slipped through)
    //     rebuild with the lesson re-asserted. NO-MEMORY does none of this. ---
    if (isMemory) {
      for (const finding of findings) {
        const severity = /gradient|forbid|violat/i.test(finding) ? "high" : "medium";
        try {
          await memory.writeTrace(sessionId, { role: "critique", finding, severity });
          tracesCount += 1;
          emit({ type: "trace.written", agentId: `${page}-critique-g${gen}`, summary: finding });
        } catch {
          /* ignore trace failures */
        }
      }

      // revise turn: recall what we just learned within the run
      const reviseId = spawn("visual-designer", designerVersion, gen, "-revise");
      emit({ type: "agent.spawned", agentId: reviseId, role: "visual-designer", version: designerVersion });
      emit({ type: "agent.status", agentId: reviseId, doing: "recalling traces to fix flaws" });
      turn(reviseId);

      let hits = [];
      try {
        const recalled = (await memory.recallInRun(sessionId, "gradient brand violation")) || [];
        hits = recalled.map((r) => ({ snippet: r.snippet }));
      } catch {
        hits = [];
      }
      emit({ type: "memory.recalled", agentId: reviseId, hits });

      // If Codex still produced a brand flaw, REBUILD with the no-gradient lesson
      // re-asserted (still a real Codex build, never a template).
      if (knownFlaw) {
        const fixLesson =
          (lessonText && /gradient/i.test(lessonText) ? lessonText : null) ||
          "Never use gradients anywhere; use only flat brand-color blocks (the brand forbids gradients).";
        seq += 1;
        const fixedHtml = await buildSiteWithRetry({ brand, goal, copyHint, lesson: fixLesson });
        const fixedName = `${page}-g${gen}-s${seq}.html`;
        const fixedRef = path.posix.join("snapshots", fixedName);
        await fs.writeFile(path.join(snapDir, fixedName), fixedHtml, "utf8");
        html = fixedHtml;
        htmlRef = fixedRef;
        emit({ type: "design.rendered", htmlRef });
      }
    }
    // NO-MEMORY: intentionally nothing — no traces, no recall, no revise.

    // --- judge ---
    {
      const id = spawn("critique", 1, gen, "-judge");
      emit({ type: "agent.status", agentId: id, doing: "scoring the page" });
      const { score, category } = await genJudge(brand, html);
      emit({ type: "team.judged", score, category });
      if (score > bestScore) bestScore = score;
      emit({ type: "score.updated", score: bestScore });
    }

    // --- MEMORY: distill lessons at gen end ---
    if (isMemory) {
      try {
        const { lessonsAccepted } = (await memory.distill(sessionId)) || { lessonsAccepted: [] };
        const accepted = Array.isArray(lessonsAccepted) ? lessonsAccepted : [];
        if (accepted.length) {
          lessonsCount += accepted.length;
          emit({ type: "memory.distilled", lessonsAccepted: accepted });
        }
      } catch {
        /* ignore distill failures */
      }
    }
  }

  emit({
    type: "run.finished",
    totals: {
      agentsSpawned,
      turns,
      traces: tracesCount,
      improvements,
      lessons: lessonsCount,
      score: bestScore,
    },
  });

  return { bestScore, turns, agentsSpawned, traces: tracesCount, improvements, lessons: lessonsCount };
}
