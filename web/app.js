/* TASTELOOP — Mission Control replay engine
 * Owns: web/index.html + web/app.js
 * Reads the FROZEN contract from run/events.json and replays it on a timer.
 * No frameworks, no build. Plain ESM-free browser JS.
 */
"use strict";

(function () {
  const PAGES = ["no-memory", "memory"];
  const TURN_CAP = 20;

  // -------- Page label + theme config --------
  const PAGE_META = {
    "no-memory": {
      title: "PAGE 1 — NO MEMORY",
      badge: "STATELESS",
      badgeClass: "bg-white/10 text-white/60",
      borderClass: "border-white/10",
      // dim, never-climbing accent
      counterColor: "text-white/35",
    },
    memory: {
      title: "PAGE 2 — COGNEE MEMORY",
      badge: "LEARNING",
      badgeClass: "bg-ttcyan/15 text-ttcyan",
      borderClass: "border-ttcyan/30",
      counterColor: "text-ttcyan",
    },
  };

  // -------- DOM helpers --------
  const $ = (sel, root = document) => root.querySelector(sel);
  const colTpl = $("#colTemplate");
  const agentTpl = $("#agentTemplate");

  // Per-page UI references + state
  const ui = {};       // ui[page] = { els..., agents: Map(agentId -> {card, els}) }
  const state = {};    // state[page] = counters

  function freshState() {
    return {
      agents: 0,
      turns: 0,
      traces: 0,
      improvements: 0,
      lessons: 0,
      score: 0,
      latestHtmlRef: null,
    };
  }

  function buildColumn(page) {
    const meta = PAGE_META[page];
    const node = colTpl.content.firstElementChild.cloneNode(true);
    node.classList.add(meta.borderClass);

    const titleEl = $(".js-title", node);
    titleEl.textContent = meta.title;
    titleEl.classList.add(page === "memory" ? "text-ttcyan" : "text-white");

    const badge = $(".js-badge", node);
    badge.textContent = meta.badge;
    badge.className = "js-badge text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full " + meta.badgeClass;

    const refs = {
      root: node,
      score: $(".js-score", node),
      agents: $(".js-agents", node),
      turns: $(".js-turns", node),
      traces: $(".js-traces", node),
      improvements: $(".js-improvements", node),
      lessons: $(".js-lessons", node),
      grid: $(".js-grid", node),
      doingGlobal: $(".js-doing-global", node),
      strategy: $(".js-strategy", node),
      strategyText: $(".js-strategy-text", node),
      iframe: $(".js-iframe", node),
      iframeEmpty: $(".js-iframe-empty", node),
      agentMap: new Map(),
    };

    // Color the climbing counters per page (memory pops, no-memory stays muted)
    [refs.agents, refs.turns, refs.traces, refs.improvements, refs.lessons].forEach((el) => {
      // base color applied dynamically in setCounter
    });

    // Mount
    const host = page === "no-memory" ? $("#col-no-memory") : $("#col-memory");
    host.appendChild(node);
    ui[page] = refs;
  }

  function setCounter(page, key, value) {
    const refs = ui[page];
    const el = refs[key];
    if (!el) return;
    const prev = el.textContent;
    const next = String(value);
    if (prev === next) return;
    el.textContent = next;

    // Color rule: anything > 0 on the memory page glows cyan; no-memory stays dim.
    const meta = PAGE_META[page];
    el.classList.remove("text-ttcyan", "text-white/35", "text-white");
    if (value > 0) {
      el.classList.add(meta.counterColor);
    } else {
      el.classList.add("text-white/35");
    }

    // bump animation
    el.classList.remove("bump");
    void el.offsetWidth; // reflow to restart anim
    el.classList.add("bump");
  }

  // Render the granted skills/tools as chips. Tools (palette items that look like
  // tools/MCP) get a pink chip; skills get a cyan chip. Tolerant of strings or
  // {name,kind} objects so we work with whatever the master authored.
  function renderSkills(els, skills) {
    if (!Array.isArray(skills) || !skills.length) return;
    const grid = els.skills;
    grid.innerHTML = "";
    skills.forEach((s) => {
      const name = typeof s === "string" ? s : (s && (s.name || s.id)) || "";
      if (!name) return;
      const kind = typeof s === "object" && s ? (s.kind || s.type || "") : "";
      const isTool = /tool|mcp/i.test(kind) || /^(read|write|edit|bash|fetch|search|browse)\b/i.test(name);
      const chip = document.createElement("span");
      chip.className = "skill-chip" + (isTool ? " tool" : "");
      chip.textContent = name;
      grid.appendChild(chip);
    });
    grid.classList.remove("hidden");
  }

  // Wire/show the master-authored prompt. Clicking the card toggles it open.
  function renderPrompt(els, prompt) {
    const text = typeof prompt === "string" ? prompt.trim() : "";
    if (!text) return;
    els.prompt.textContent = text;
    els.promptToggle.classList.remove("hidden");
    els.card.classList.add("has-prompt");
    if (!els._promptWired) {
      els._promptWired = true;
      els.card.addEventListener("click", () => {
        const open = els.card.classList.toggle("prompt-open");
        els.promptToggle.textContent = open ? "PROMPT ▾" : "PROMPT ▸";
      });
    }
  }

  function getOrCreateAgent(page, agentId, role, version, meta) {
    const refs = ui[page];
    let entry = refs.agentMap.get(agentId);
    if (entry) {
      // Backfill master-authored metadata if it arrives after the card exists.
      if (meta) {
        if (role) entry.role.textContent = role;
        if (meta.skills && entry.skills.classList.contains("hidden")) renderSkills(entry, meta.skills);
        if (meta.prompt && !entry.card.classList.contains("has-prompt")) renderPrompt(entry, meta.prompt);
      }
      return entry;
    }

    const card = agentTpl.content.firstElementChild.cloneNode(true);
    const els = {
      card,
      dot: $(".js-dot", card),
      role: $(".js-role", card),
      version: $(".js-version", card),
      doing: $(".js-doing", card),
      skills: $(".js-skills", card),
      prompt: $(".js-prompt", card),
      promptToggle: $(".js-prompt-toggle", card),
    };
    els.role.textContent = role || agentId || "agent";
    if (version !== undefined && version !== null && version !== "") {
      els.version.textContent = "v" + version;
    }
    if (meta) {
      if (meta.skills) renderSkills(els, meta.skills);
      if (meta.prompt) renderPrompt(els, meta.prompt);
    }
    refs.grid.appendChild(card);
    entry = els;
    refs.agentMap.set(agentId, entry);
    return entry;
  }

  function markActive(page, agentId) {
    const refs = ui[page];
    refs.agentMap.forEach((els, id) => {
      const on = id === agentId;
      els.card.classList.toggle("agent-active", on);
      els.dot.classList.toggle("dot-on", on);
    });
  }

  function updateScoreUI() {
    const a = ui["no-memory"], b = ui["memory"];
    if (!a || !b) return;
    a.score.textContent = String(state["no-memory"].score);
    b.score.textContent = String(state["memory"].score);

    // Divergence: highlight the leader.
    const sNo = state["no-memory"].score;
    const sMem = state["memory"].score;

    a.score.classList.remove("text-ttpink", "text-ttcyan", "text-white", "score-winning");
    b.score.classList.remove("text-ttpink", "text-ttcyan", "text-white", "score-winning");

    if (sMem > sNo) {
      b.score.classList.add("text-ttcyan", "score-winning");
      a.score.classList.add("text-white/60");
    } else if (sNo > sMem) {
      a.score.classList.add("text-ttpink", "score-winning");
      b.score.classList.add("text-white/60");
    } else {
      a.score.classList.add("text-white");
      b.score.classList.add("text-white");
    }
  }

  function setIframe(page, htmlRef) {
    if (!htmlRef) return;
    const refs = ui[page];
    state[page].latestHtmlRef = htmlRef;
    const src = "run/" + String(htmlRef).replace(/^\/+/, "");
    if (refs.iframe.getAttribute("src") !== src) {
      refs.iframe.setAttribute("src", src);
    }
    refs.iframeEmpty.classList.add("hidden");
  }

  // -------- Event application --------
  function applyEvent(ev) {
    const page = ev.page;
    if (!page || !ui[page]) return; // run.started etc. with no page are fine to ignore
    const refs = ui[page];
    const st = state[page];

    switch (ev.type) {
      case "agent.spawned": {
        // Carry the master-authored prompt + granted skills onto the card (graceful if absent).
        getOrCreateAgent(page, ev.agentId, ev.role, ev.version, { skills: ev.skills, prompt: ev.prompt });
        st.agents += 1;
        setCounter(page, "agents", st.agents);
        break;
      }
      case "agent.status": {
        const a = getOrCreateAgent(page, ev.agentId);
        if (a) a.doing.textContent = ev.doing || "";
        markActive(page, ev.agentId);
        refs.doingGlobal.textContent = ev.doing ? "▸ " + ev.doing : "";
        break;
      }
      case "agent.turn": {
        st.turns = Math.min(TURN_CAP, st.turns + 1);
        setCounter(page, "turns", st.turns);
        markActive(page, ev.agentId);
        break;
      }
      case "trace.written": {
        st.traces += 1;
        setCounter(page, "traces", st.traces);
        break;
      }
      case "member.upskilled": {
        st.improvements += 1;
        setCounter(page, "improvements", st.improvements);
        // reflect version bump on the matching role card if present
        if (ev.role) {
          refs.agentMap.forEach((els) => {
            if (els.role.textContent === ev.role && ev.version != null) {
              els.version.textContent = "v" + ev.version;
            }
          });
        }
        break;
      }
      case "memory.distilled": {
        const accepted = Array.isArray(ev.lessonsAccepted) ? ev.lessonsAccepted.length : 0;
        st.lessons += accepted;
        setCounter(page, "lessons", st.lessons);
        break;
      }
      case "design.rendered": {
        setIframe(page, ev.htmlRef);
        break;
      }
      case "score.updated": {
        if (typeof ev.score === "number") {
          st.score = ev.score;
          updateScoreUI();
        }
        break;
      }
      case "team.judged": {
        // optional flash on the doing line; score handled by score.updated
        if (typeof ev.score === "number") {
          refs.doingGlobal.textContent = "judged: " + ev.score + (ev.category ? " · " + ev.category : "");
        }
        break;
      }
      case "memory.recalled": {
        if (Array.isArray(ev.hits) && ev.hits.length) {
          refs.doingGlobal.textContent = "↺ recalled " + ev.hits.length + " memory hit" + (ev.hits.length > 1 ? "s" : "");
        }
        break;
      }
      case "run.finished": {
        // Trust authoritative totals if present (keeps UI exact even if an event was missed)
        const tot = ev.totals;
        if (tot && typeof tot === "object") {
          if (typeof tot.agentsSpawned === "number") { st.agents = tot.agentsSpawned; setCounter(page, "agents", st.agents); }
          if (typeof tot.turns === "number") { st.turns = Math.min(TURN_CAP, tot.turns); setCounter(page, "turns", st.turns); }
          if (typeof tot.traces === "number") { st.traces = tot.traces; setCounter(page, "traces", st.traces); }
          if (typeof tot.improvements === "number") { st.improvements = tot.improvements; setCounter(page, "improvements", st.improvements); }
          if (typeof tot.lessons === "number") { st.lessons = tot.lessons; setCounter(page, "lessons", st.lessons); }
          if (typeof tot.score === "number") { st.score = tot.score; updateScoreUI(); }
        }
        // clear active pulses at end
        markActive(page, null);
        break;
      }
      case "master.planned": {
        // Surface the master's one-line strategy as a per-page banner.
        const strat = typeof ev.strategy === "string" ? ev.strategy.trim() : "";
        if (strat) {
          refs.strategyText.textContent = strat;
          refs.strategy.classList.remove("hidden");
        }
        break;
      }
      // run.started, critique.made -> no counter impact
      default:
        break;
    }
  }

  // -------- Live polling engine --------
  // The orchestrator streams events into run/events.json as the build happens.
  // We poll it and apply only the NEW events, so the UI renders in real time.
  let appliedCount = 0;
  let pollTimer = null;

  function setStatus(text, on) {
    $("#statusText").textContent = text;
    $("#statusDot").classList.toggle("dot-on", !!on);
  }

  function setClock(ms) {
    $("#clock").textContent = (ms / 1000).toFixed(1) + "s";
  }

  function resetAll() {
    PAGES.forEach((p) => {
      state[p] = freshState();
      const refs = ui[p];
      refs.grid.innerHTML = "";
      refs.agentMap = new Map();
      refs.doingGlobal.textContent = "";
      if (refs.strategy) {
        refs.strategyText.textContent = "";
        refs.strategy.classList.add("hidden");
      }
      refs.iframe.removeAttribute("src");
      refs.iframeEmpty.classList.remove("hidden");
      ["agents", "turns", "traces", "improvements", "lessons"].forEach((k) => setCounter(p, k, 0));
      refs.score.textContent = "0";
    });
    updateScoreUI();
    setClock(0);
  }

  async function pollOnce() {
    let data;
    try {
      const res = await fetch("run/events.json", { cache: "no-store" });
      if (!res.ok) return;
      data = await res.json();
    } catch (err) {
      return; // transient (file mid-write) — try again next tick
    }
    const list = Array.isArray(data.events) ? data.events : [];

    // A new run truncated the log -> reset and re-apply from scratch.
    if (list.length < appliedCount) {
      resetAll();
      appliedCount = 0;
    }
    if (list.length > appliedCount) {
      for (let i = appliedCount; i < list.length; i++) applyEvent(list[i]);
      appliedCount = list.length;
      const last = list[list.length - 1];
      setClock(last && typeof last.t === "number" ? last.t : 0);
    }

    const finished = list.filter((e) => e.type === "run.finished").length >= PAGES.length;
    if (!list.length) setStatus("waiting for run…", false);
    else setStatus(finished ? "finished" : "building live…", !finished);
  }

  function startLive() {
    resetAll();
    appliedCount = 0;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(pollOnce, 600);
    pollOnce();
  }

  // -------- Controls wiring --------
  function wireControls() {
    const rb = $("#restartBtn");
    if (rb) rb.addEventListener("click", () => { resetAll(); appliedCount = 0; pollOnce(); });
    // Speed buttons are not used in live mode (events arrive at real pace); keep harmless.
    document.querySelectorAll(".speed-btn").forEach((b) => {
      b.addEventListener("click", () => {
        document.querySelectorAll(".speed-btn").forEach((x) => {
          const on = x === b;
          x.classList.toggle("bg-white", on);
          x.classList.toggle("text-black", on);
        });
      });
    });
  }

  // -------- Boot --------
  function boot() {
    PAGES.forEach((p) => {
      buildColumn(p);
      state[p] = freshState();
    });
    wireControls();
    updateScoreUI();
    startLive();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
