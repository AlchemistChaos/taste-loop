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

  // -------- Upskill focus panel (the demo climax) --------
  // On a rich member.upskilled event we pop a centered panel showing the
  // v1 -> v2 prompt diff and the lesson that caused it. Gracefully no-ops on
  // the old/thin event shape (no instructionDiff) so the live engine never breaks.
  const upskill = {};
  let upskillWired = false;
  let upskillTimer = null;

  function upskillRefs() {
    if (upskill._ready) return upskill;
    upskill.scrim = $("#upskillScrim");
    upskill.panel = $("#upskillPanel");
    upskill.close = $("#upskillClose");
    upskill.role = $("#upskillRole");
    upskill.vfrom = $("#upskillVfrom");
    upskill.vto = $("#upskillVto");
    upskill.vfrom2 = $("#upskillVfrom2");
    upskill.vto2 = $("#upskillVto2");
    upskill.deltaPill = $("#upskillDelta");
    upskill.scoreBefore = $("#upskillScoreBefore");
    upskill.scoreAfter = $("#upskillScoreAfter");
    upskill.scoreDelta = $("#upskillScoreDelta");
    upskill.lessonCard = $("#upskillLessonCard");
    upskill.lessonText = $("#upskillLessonText");
    upskill.before = $("#upskillBefore");
    upskill.after = $("#upskillAfter");
    upskill.provenance = $("#upskillProvenance");
    upskill.provId = $("#upskillProvId");
    upskill.provDelta = $("#upskillProvDelta");
    upskill.provRole = $("#upskillProvRole");
    upskill._ready = !!upskill.panel;
    return upskill;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // Word-level diff: render `before` verbatim and `after` with the words that are
  // new (relative to before) wrapped in a green .diff-add span. Token-based so it
  // survives reordering reasonably and never throws on odd input.
  function diffAdditionsHtml(before, after) {
    const beforeText = before == null ? "" : String(before);
    const afterText = after == null ? "" : String(after);
    // Tokenize keeping whitespace so we can faithfully re-emit `after`.
    const tokens = afterText.split(/(\s+)/);
    // Multiset of before words (normalized) so repeated words match correctly.
    const pool = new Map();
    beforeText.split(/\s+/).forEach((w) => {
      const k = w.toLowerCase();
      if (!k) return;
      pool.set(k, (pool.get(k) || 0) + 1);
    });
    let html = "";
    for (const tok of tokens) {
      if (!tok) continue;
      if (/^\s+$/.test(tok)) { html += escapeHtml(tok); continue; }
      const k = tok.toLowerCase();
      const have = pool.get(k) || 0;
      if (have > 0) {
        pool.set(k, have - 1);
        html += escapeHtml(tok);
      } else {
        html += '<span class="diff-add">' + escapeHtml(tok) + "</span>";
      }
    }
    return html;
  }

  function closeUpskill() {
    const u = upskillRefs();
    if (!u._ready) return;
    u.scrim.classList.remove("show");
    u.panel.style.display = "none";
    if (upskillTimer) { clearTimeout(upskillTimer); upskillTimer = null; }
  }

  function wireUpskill() {
    if (upskillWired) return;
    const u = upskillRefs();
    if (!u._ready) return;
    upskillWired = true;
    u.close.addEventListener("click", closeUpskill);
    u.scrim.addEventListener("click", closeUpskill);
    // Click inside the panel (other than the close X) keeps it open, except the
    // explicit "click anywhere to dismiss" affordance — make the whole panel a
    // dismiss target too, for a frictionless demo.
    u.panel.addEventListener("click", (e) => { if (e.target !== u.close) closeUpskill(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeUpskill(); });
  }

  // Returns true if it rendered a rich panel; false if the event lacked the
  // rich fields (caller then leaves the legacy behavior untouched).
  function showUpskillPanel(ev) {
    const diff = ev && ev.instructionDiff;
    const hasRich = diff && typeof diff === "object" &&
      (typeof diff.before === "string" || typeof diff.after === "string");
    if (!hasRich) return false; // old/thin shape -> ignore gracefully

    const u = upskillRefs();
    if (!u._ready) return false;
    wireUpskill();

    const role = ev.role || "agent";
    const vTo = ev.version != null ? ev.version : "";
    const vFrom = (typeof ev.version === "number" && ev.version > 1) ? ev.version - 1 : "";

    u.role.textContent = role;
    u.vfrom.textContent = vFrom !== "" ? "v" + vFrom : "v?";
    u.vto.textContent = vTo !== "" ? "v" + vTo : "v?";
    u.vfrom2.textContent = vFrom !== "" ? vFrom : "?";
    u.vto2.textContent = vTo !== "" ? vTo : "?";

    // Lesson
    const lessonText = typeof ev.lessonText === "string" ? ev.lessonText.trim() : "";
    if (lessonText) {
      u.lessonText.textContent = lessonText;
      u.lessonCard.style.display = "";
    } else {
      u.lessonCard.style.display = "none";
    }

    // Diff
    u.before.textContent = diff.before == null ? "" : String(diff.before);
    u.after.innerHTML = diffAdditionsHtml(diff.before, diff.after);

    // Score delta
    const sb = ev.scoreBefore, sa = ev.scoreAfter;
    let delta = null;
    if (typeof sb === "number" && typeof sa === "number") {
      delta = sa - sb;
      u.scoreBefore.textContent = sb;
      u.scoreAfter.textContent = sa;
      u.scoreDelta.textContent = (delta >= 0 ? "+" : "") + delta;
      u.deltaPill.classList.toggle("neg", delta < 0);
      u.deltaPill.style.display = "";
    } else {
      u.deltaPill.style.display = "none";
    }

    // Provenance: "lesson <id> -> +<delta> on <role>"
    const lessonId = ev.lessonId != null ? String(ev.lessonId) : "";
    if (lessonId || delta != null) {
      u.provId.textContent = lessonId || "?";
      const provDelta = delta != null ? (delta >= 0 ? "+" : "") + delta : "+?";
      u.provDelta.textContent = provDelta;
      u.provRole.textContent = role;
      u.provenance.style.display = "";
    } else {
      u.provenance.style.display = "none";
    }

    // Show
    u.scrim.classList.add("show");
    u.panel.style.display = "";
    // re-trigger entrance animation
    u.panel.style.animation = "none";
    void u.panel.offsetWidth;
    u.panel.style.animation = "";

    // Auto-dismiss after a beat so the replay keeps flowing, but long enough to read.
    if (upskillTimer) clearTimeout(upskillTimer);
    upskillTimer = setTimeout(closeUpskill, 9000);
    return true;
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
        // THE CLIMAX: if the rich shape is present, pop the prompt-diff focus
        // panel. No-ops (returns false) on the old thin shape -> graceful.
        showUpskillPanel(ev);
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
    closeUpskill();
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
