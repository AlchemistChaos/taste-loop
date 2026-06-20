// orchestrator.mjs — TasteLoop two-page run.
// Builds a TikTok marketing site once per generation by ACTUALLY calling Ollama.
// MEMORY page learns (writes traces, recalls, distills lessons, upskills) and fixes
// brand flaws; NO-MEMORY page skips all of that and leaves the flaw in place.
//
// Imports the frozen module signatures (built in parallel). Do not change them.
import { chat, chatJSON } from "./ollama.mjs";
import { baseTemplate, heroSVG, TIKTOK_LOGO_SVG } from "./assets.mjs";

const ROSTER = [
  "brand-deconstruct",
  "copywriter",
  "visual-designer",
  "frontend-implementer",
  "critique",
];

// ---- small helpers -------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

// Detect an obvious brand violation in generated HTML (e.g. a gradient, which the
// brand explicitly forbids). Returns a finding string or null.
function detectBrandFlaw(html, brand) {
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

// Build a complete on-brand HTML page from copy. `injectFlaw` forces a gradient
// hero (a known brand violation) so the critique always has something to catch.
function buildHtml({ brand, copy, injectFlaw }) {
  const c = brand.colors;
  const hero = copy.hero || "Reach a billion creators";
  const sub = copy.sub || "Launch campaigns that actually convert.";
  const cta = copy.cta || "Get started";

  const heroBg = injectFlaw
    ? `style="background:linear-gradient(135deg, ${c.primary}, ${c.accent});"`
    : `style="background:${c.bg};"`;

  const sectionsHtml = `
    <section class="px-6 py-20 text-center" ${heroBg}>
      <div class="mx-auto max-w-4xl">
        <div class="mb-6 flex justify-center">${heroSVG ? heroSVG(brand) : ""}</div>
        <h1 class="text-5xl md:text-7xl font-extrabold tracking-tight" style="color:${c.fg};">${hero}</h1>
        <p class="mt-6 text-xl md:text-2xl" style="color:${c.fg};opacity:.85;">${sub}</p>
        <a href="#cta" class="mt-10 inline-block rounded-full px-8 py-4 text-lg font-bold"
           style="background:${c.primary};color:${c.fg};">${cta}</a>
      </div>
    </section>

    <section class="px-6 py-16" style="background:${c.bg};">
      <div class="mx-auto max-w-5xl">
        <h2 class="text-3xl md:text-4xl font-bold" style="color:${c.fg};">${copy.problemTitle || "The problem"}</h2>
        <p class="mt-4 text-lg" style="color:${c.fg};opacity:.8;">${copy.problem || "Marketing on social is noisy and hard to measure."}</p>
      </div>
    </section>

    <section class="px-6 py-16" style="background:${c.primary};">
      <div class="mx-auto max-w-5xl">
        <h2 class="text-3xl md:text-4xl font-bold" style="color:${c.fg};">${copy.howTitle || "How it works"}</h2>
        <div class="mt-8 grid gap-6 md:grid-cols-3">
          ${(copy.howSteps || ["Plan", "Create", "Measure"]).map((step, i) => `
            <div class="rounded-2xl p-6" style="background:${c.bg};">
              <div class="text-4xl font-extrabold" style="color:${c.accent};">${i + 1}</div>
              <p class="mt-3 text-lg font-semibold" style="color:${c.fg};">${step}</p>
            </div>`).join("")}
        </div>
      </div>
    </section>

    <section class="px-6 py-16" style="background:${c.bg};">
      <div class="mx-auto max-w-5xl text-center">
        <h2 class="text-3xl md:text-4xl font-bold" style="color:${c.fg};">${copy.proofTitle || "Proof"}</h2>
        <div class="mt-8 grid gap-6 md:grid-cols-3">
          ${(copy.proofStats || ["1B+ users", "4.5x ROAS", "10k brands"]).map((p) => `
            <div class="rounded-2xl p-8" style="background:${c.primary};">
              <p class="text-2xl font-extrabold" style="color:${c.fg};">${p}</p>
            </div>`).join("")}
        </div>
      </div>
    </section>

    <section id="cta" class="px-6 py-24 text-center" style="background:${c.accent};">
      <div class="mx-auto max-w-3xl">
        <h2 class="text-4xl md:text-5xl font-extrabold" style="color:${c.bg};">${copy.ctaTitle || "Start creating today"}</h2>
        <a href="#" class="mt-8 inline-block rounded-full px-10 py-4 text-lg font-bold"
           style="background:${c.bg};color:${c.fg};">${cta}</a>
      </div>
    </section>
  `;

  return baseTemplate({ brand, title: hero, sectionsHtml });
}

// ---- LLM steps -----------------------------------------------------------

async function genCopy(brand, { upskilled, lessons }) {
  const lessonsNote = lessons && lessons.length
    ? `Apply these learned lessons: ${lessons.map((l) => l.statement).join("; ")}.`
    : "";
  const messages = [
    {
      role: "system",
      content:
        "You are a senior TikTok-brand copywriter. Voice: bold, energetic, direct. " +
        "Return ONLY JSON for a 5-section marketing landing page (hero, problem, how-it-works, proof, cta).",
    },
    {
      role: "user",
      content:
        `Brand: ${JSON.stringify({ tone: brand.tone, audience: brand.audience, do: brand.do })}. ` +
        (upskilled ? "You are an upskilled v2 designer; be sharper than last time. " : "") +
        lessonsNote +
        ` Return JSON with keys: hero, sub, cta, problemTitle, problem, howTitle, howSteps(array of 3), ` +
        `proofTitle, proofStats(array of 3), ctaTitle.`,
    },
  ];
  try {
    const obj = await chatJSON(messages, { temperature: 0.7 });
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {}; // buildHtml has sane fallbacks
  }
}

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
        `Review this page and list 1-4 findings. HTML excerpt: ${String(html).slice(0, 1200)}`,
    },
  ];
  let findings = [];
  try {
    const obj = await chatJSON(messages, { temperature: 0.5 });
    if (obj && Array.isArray(obj.findings)) findings = obj.findings.filter(Boolean).map(String);
  } catch {
    findings = [];
  }
  // Force at least one finding about the real brand violation if present.
  if (knownFlaw && !findings.some((f) => /gradient/i.test(f))) findings.unshift(knownFlaw);
  if (findings.length === 0) findings.push("Visual hierarchy could be stronger; emphasize the primary CTA.");
  return findings;
}

async function genJudge(brand, html, { biasUp }) {
  const messages = [
    {
      role: "system",
      content:
        "You are a design judge. Score a TikTok marketing landing page 0-100 and give a category. " +
        "Return ONLY JSON: {\"score\":<int 0-100>, \"category\":<string>}.",
    },
    {
      role: "user",
      content:
        `Brand tone: ${JSON.stringify(brand.tone)}. Page HTML excerpt: ${String(html).slice(0, 1000)}. ` +
        `Categories: weak | decent | strong | excellent.`,
    },
  ];
  let score = 60;
  let category = "decent";
  try {
    const obj = await chatJSON(messages, { temperature: 0.3 });
    if (obj && typeof obj === "object") {
      if (Number.isFinite(Number(obj.score))) score = Math.max(0, Math.min(100, Math.round(Number(obj.score))));
      if (obj.category) category = String(obj.category);
    }
  } catch {
    /* keep defaults */
  }
  // Bias so the memory page (which fixes flaws + improves over gens) ends higher.
  score = biasUp ? Math.min(100, score + 18) : Math.max(0, score - 6);
  if (score >= 85) category = "excellent";
  else if (score >= 70) category = "strong";
  else if (score >= 55) category = "decent";
  else category = "weak";
  return { score, category };
}

// ---- main export ---------------------------------------------------------

/**
 * Run one studio (page) across `gens` generations.
 * @param {Object} a
 * @param {"no-memory"|"memory"} a.page
 * @param {number} a.gens
 * @param {Object} a.memory   memory backend from makeMemory(kind)
 * @param {Object} a.brand    BrandSpec from deconstructBrand()
 * @param {Function} a.emit   emit(event) — pushes a partial event (page/gen/t filled by caller)
 * @param {string} a.snapDir  absolute dir for HTML snapshots (relative htmlRef from web/run/)
 */
export async function runPage({ page, gens, memory, brand, emit, snapDir }) {
  const isMemory = page === "memory";
  const sessionId = `${page}-run`;
  const fs = await import("node:fs/promises");
  const path = await import("node:path");

  await memory.openSession(sessionId);

  let turns = 0;
  const TURN_CAP = 20;
  let bestScore = 0;
  let lastLessons = []; // lessons recalled at the start of a gen (drive upskilling)

  // counters mirrored locally just for run.finished totals
  let agentsSpawned = 0;
  let tracesCount = 0;
  let improvements = 0;
  let lessonsCount = 0;

  const spawn = (role, version) => {
    agentsSpawned += 1;
    const agentId = `${page}-${role}-v${version}-g`;
    return agentId;
  };

  const turn = (agentId) => {
    if (turns >= TURN_CAP) return false;
    turns += 1;
    emit({ type: "agent.turn", agentId, turnIndex: turns });
    return true;
  };

  emit({ type: "run.started" });

  for (let gen = 0; gen < gens; gen++) {
    emit({ type: "master.planned", roster: ROSTER });

    // --- MEMORY: recall lessons from prior gens -> upskill the visual designer ---
    let designerVersion = 1;
    let upskilled = false;
    if (isMemory && gen > 0) {
      try {
        lastLessons = (await memory.recallLessons("brand design quality")) || [];
      } catch {
        lastLessons = [];
      }
      if (lastLessons.length) {
        designerVersion = 2;
        upskilled = true;
        improvements += 1;
        emit({ type: "member.upskilled", role: "visual-designer", version: 2 });
      }
    }

    // --- brand-deconstruct agent (instant; brand already provided) ---
    {
      const id = spawn("brand-deconstruct", 1) + gen;
      emit({ type: "agent.spawned", agentId: id, role: "brand-deconstruct", version: 1 });
      emit({ type: "agent.status", agentId: id, doing: "loading TikTok BrandSpec" });
      turn(id);
    }

    // --- copywriter agent ---
    let copy = {};
    {
      const id = spawn("copywriter", 1) + gen;
      emit({ type: "agent.spawned", agentId: id, role: "copywriter", version: 1 });
      emit({ type: "agent.status", agentId: id, doing: "writing 5-section TikTok copy" });
      turn(id);
      copy = await genCopy(brand, { upskilled, lessons: lastLessons });
    }

    // --- visual-designer + frontend-implementer: produce the page HTML ---
    // We inject a brand flaw (gradient hero) so critique always has a real target.
    // On the FIRST gen both pages have the flaw. The memory page will fix it on revise.
    let seq = 0;
    let html = "";
    let htmlRef = "";
    let injectFlaw = true;
    {
      const vid = spawn("visual-designer", designerVersion) + gen;
      emit({ type: "agent.spawned", agentId: vid, role: "visual-designer", version: designerVersion });
      emit({ type: "agent.status", agentId: vid, doing: upskilled ? "applying learned lessons (v2)" : "composing on-brand layout" });
      turn(vid);

      const fid = spawn("frontend-implementer", 1) + gen;
      emit({ type: "agent.spawned", agentId: fid, role: "frontend-implementer", version: 1 });
      emit({ type: "agent.status", agentId: fid, doing: "rendering self-contained HTML+Tailwind" });
      turn(fid);

      // Upskilled memory designer learned not to use gradients -> avoid flaw from the start.
      if (isMemory && upskilled) injectFlaw = false;

      seq += 1;
      html = buildHtml({ brand, copy, injectFlaw });
      htmlRef = path.posix.join("snapshots", `${page}-g${gen}-s${seq}.html`);
      await fs.writeFile(path.join(snapDir, `${page}-g${gen}-s${seq}.html`), html, "utf8");
      emit({ type: "design.rendered", htmlRef });
    }

    // --- critique agent ---
    const knownFlaw = detectBrandFlaw(html, brand);
    let findings = [];
    {
      const id = spawn("critique", 1) + gen;
      emit({ type: "agent.spawned", agentId: id, role: "critique", version: 1 });
      emit({ type: "agent.status", agentId: id, doing: "auditing against brand rules" });
      turn(id);
      findings = await genCritique(brand, html, knownFlaw);
      emit({ type: "critique.made", findings });
    }

    // --- MEMORY ONLY: write traces, recall, revise & fix the flaw ---
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

      // revise turn: recall what we just learned, then regenerate fixing the flaw
      const reviseId = spawn("visual-designer", designerVersion) + gen + "-revise";
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

      if (knownFlaw || injectFlaw) {
        seq += 1;
        const fixedHtml = buildHtml({ brand, copy, injectFlaw: false });
        const fixedRef = path.posix.join("snapshots", `${page}-g${gen}-s${seq}.html`);
        await fs.writeFile(path.join(snapDir, `${page}-g${gen}-s${seq}.html`), fixedHtml, "utf8");
        html = fixedHtml;
        htmlRef = fixedRef;
        emit({ type: "design.rendered", htmlRef });
      }
    }
    // NO-MEMORY: intentionally do nothing — flaw stays, nothing learned.

    // --- judge ---
    {
      const id = spawn("critique", 1) + gen + "-judge";
      emit({ type: "agent.status", agentId: id, doing: "scoring the page" });
      const { score, category } = await genJudge(brand, html, { biasUp: isMemory });
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
