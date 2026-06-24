/* TASTELOOP — Mission Control replay engine
 * Owns: web/index.html + web/app.js
 * Reads the FROZEN contract from run/events.json and replays it on a timer.
 * No frameworks, no build. Plain ESM-free browser JS.
 */
"use strict";

(function () {
  const PAGES = ["no-memory", "memory"];
  const TURN_CAP = 20;
  // Single-line agent lane: show only the most recent N spawned agents; older
  // ones fade/collapse out so the lane never grows past one row.
  const MAX_LANE = 5;

  // -------- Page label + theme config --------
  const PAGE_META = {
    "no-memory": {
      title: "Page A",
      borderClass: "border-white/10",
      // dim, never-climbing accent
      counterColor: "text-white/35",
    },
    memory: {
      title: "Page B",
      borderClass: "border-ttcyan/30",
      counterColor: "text-ttcyan",
    },
  };

  // -------- DOM helpers --------
  const HAS_DOM = typeof document !== "undefined";
  const $ = (sel, root) => (root || (HAS_DOM ? document : null)) ?.querySelector(sel) ?? null;
  // Resolved only in the browser; under Node (smoke test) these stay null and the
  // browser-only render paths (buildColumn/getOrCreateAgent) never run.
  const colTpl = HAS_DOM ? $("#colTemplate") : null;
  const agentTpl = HAS_DOM ? $("#agentTemplate") : null;

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
      score: 0,            // headline (best score, from run.finished.totals)
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
    // 4.3: chips are orchestrator-invoked skill ROUTES (registry dispatch) — show
    // the clarifying caption alongside them.
    if (els.skillsLabel) els.skillsLabel.classList.remove("hidden");
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
        if (meta.grantProvenance) renderGrantProvenance(entry, meta.grantProvenance);
        if (meta.credit) renderCredit(entry, meta.credit);
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
      skillsLabel: $(".js-skills-label", card),
      // per-agent provenance hooks (4.1 / 4.2)
      agentStats: $(".js-agent-stats", card),
      recallVal: $(".js-agent-recall", card),
      tracesVal: $(".js-agent-traces", card),
      grantProv: $(".js-grant-prov", card),
      credit: $(".js-credit", card),
      // per-agent running counters
      recallHits: 0,
      traceCount: 0,
    };
    els.role.textContent = role || agentId || "agent";
    if (version !== undefined && version !== null && version !== "") {
      els.version.textContent = "v" + version;
    }
    if (meta) {
      if (meta.skills) renderSkills(els, meta.skills);
      if (meta.prompt) renderPrompt(els, meta.prompt);
      if (meta.grantProvenance) renderGrantProvenance(els, meta.grantProvenance);
      if (meta.credit) renderCredit(els, meta.credit);
    }
    refs.grid.appendChild(card);
    entry = els;
    refs.agentMap.set(agentId, entry);
    pruneAgentLane(refs);
    return entry;
  }

  // Keep only the most recent MAX_LANE agent cards in the lane; fade/collapse the
  // older ones out and drop their agentMap entry (so late events don't revive them).
  function pruneAgentLane(refs) {
    const live = Array.from(refs.grid.children).filter((c) => !c.classList.contains("agent-leaving"));
    for (let i = 0; i < live.length - MAX_LANE; i++) {
      const oldest = live[i];
      for (const [id, e] of refs.agentMap) { if (e.card === oldest) { refs.agentMap.delete(id); break; } }
      oldest.classList.add("agent-leaving");
      setTimeout(() => { if (oldest.parentNode) oldest.parentNode.removeChild(oldest); }, 400);
    }
  }

  // Update an agent card's recall-hits / traces pills (memory provenance, 4.1).
  function bumpAgentStat(els, kind, by) {
    if (!els) return;
    if (kind === "recall") {
      els.recallHits += by;
      if (els.recallVal) els.recallVal.textContent = String(els.recallHits);
      if (els.recallHits > 0) els.card.classList.add("has-recall");
    } else if (kind === "trace") {
      els.traceCount += by;
      if (els.tracesVal) els.tracesVal.textContent = String(els.traceCount);
    }
    // Reveal the stats row once anything is non-zero.
    if ((els.recallHits > 0 || els.traceCount > 0) && els.agentStats) {
      els.agentStats.classList.remove("hidden");
    }
  }

  // Grant provenance: why each memory-driven tool was granted (4.2).
  // grantProvenance = [{ skill, fromLesson }]
  function renderGrantProvenance(els, list) {
    if (!els || !els.grantProv || !Array.isArray(list) || !list.length) return;
    els.grantProv.innerHTML = "";
    list.forEach((g) => {
      if (!g) return;
      const skill = typeof g.skill === "string" ? g.skill : "";
      const lesson = typeof g.fromLesson === "string" ? g.fromLesson : "";
      if (!skill && !lesson) return;
      const row = document.createElement("div");
      row.className = "grant-prov-row";
      row.innerHTML =
        '<span class="gp-skill">' + escapeHtml(skill || "skill") + "</span>" +
        ' <span class="gp-from">granted from</span> ' +
        '<span class="gp-lesson">' + escapeHtml(lesson || "(lesson)") + "</span>";
      els.grantProv.appendChild(row);
    });
    if (els.grantProv.children.length) els.grantProv.classList.remove("hidden");
  }

  // Credit assignment: the vision flaw attributed to this agent (2.4 / 4.2).
  // credit = { flaw, attributedTo }
  function renderCredit(els, credit) {
    if (!els || !els.credit || !credit || typeof credit !== "object") return;
    const flaw = typeof credit.flaw === "string" ? credit.flaw.trim() : "";
    if (!flaw) return;
    els.credit.innerHTML =
      '<span class="credit-lbl">attributed flaw</span>' + escapeHtml(flaw);
    els.credit.classList.remove("hidden");
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
    if (!a.score || !b.score) return; // score display removed from the UI — no-op
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

  // -------- Shared SVG helper (used by the memory graph viz) --------
  const SVGNS = "http://www.w3.org/2000/svg";
  function svgEl(name, attrs) {
    const el = document.createElementNS(SVGNS, name);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    return el;
  }

  function setIframe(page, htmlRef) {
    if (!htmlRef) return;
    const refs = ui[page];
    state[page].latestHtmlRef = htmlRef;
    // Cache-bust per run: snapshot filenames repeat across runs (memory-g0-s2.html…),
    // so without this the browser shows the PREVIOUS run's cached render.
    const src = "run/" + String(htmlRef).replace(/^\/+/, "") + (lastRunId ? "?r=" + encodeURIComponent(lastRunId) : "");
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

  // -------- trace.resolved before/after panel (A.4 / 4.4) --------
  const resolved = {};
  let resolvedWired = false;
  let resolvedTimer = null;

  function resolvedRefs() {
    if (resolved._ready) return resolved;
    resolved.scrim = $("#resolvedScrim");
    resolved.panel = $("#resolvedPanel");
    resolved.close = $("#resolvedClose");
    resolved.flaw = $("#resolvedFlaw");
    resolved.rule = $("#resolvedRule");
    resolved.ruleText = $("#resolvedRuleText");
    resolved.badge = $("#resolvedBadge");
    resolved.before = $("#resolvedBefore");
    resolved.after = $("#resolvedAfter");
    resolved.provenance = $("#resolvedProvenance");
    resolved.agent = $("#resolvedAgent");
    resolved._ready = !!resolved.panel;
    return resolved;
  }

  function closeResolved() {
    const r = resolvedRefs();
    if (!r._ready) return;
    r.scrim.classList.remove("show");
    r.panel.style.display = "none";
    if (resolvedTimer) { clearTimeout(resolvedTimer); resolvedTimer = null; }
  }

  function wireResolved() {
    if (resolvedWired) return;
    const r = resolvedRefs();
    if (!r._ready) return;
    resolvedWired = true;
    r.close.addEventListener("click", closeResolved);
    r.scrim.addEventListener("click", closeResolved);
    r.panel.addEventListener("click", (e) => { if (e.target !== r.close) closeResolved(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeResolved(); });
  }

  // Resolve a screenshot ref to a servable URL (same convention as setIframe).
  function shotSrc(ref) {
    if (!ref || typeof ref !== "string") return "";
    if (/^(https?:|data:)/.test(ref)) return ref;
    // Accept absolute filesystem paths too (the orchestrator may emit /Users/.../run/
    // snapshots/x.png): extract from the last snapshots/ or shots/ segment so it resolves
    // to the served URL instead of "run/Users/...". Relative refs match the tail too.
    const m = ref.match(/(?:snapshots|shots)\/[^/]+$/);
    if (m) return "run/" + m[0];
    return "run/" + ref.replace(/^\/+/, "");
  }

  // ev = { flaw, brandRuleCited, beforeShot, afterShot, agentId, resolved }
  function showResolvedPanel(ev) {
    const r = resolvedRefs();
    if (!r._ready) return false;
    // Need at least one screenshot to be a "before/after" panel; otherwise no-op.
    const beforeSrc = shotSrc(ev.beforeShot);
    const afterSrc = shotSrc(ev.afterShot);
    if (!beforeSrc && !afterSrc) return false;
    wireResolved();

    r.flaw.textContent = typeof ev.flaw === "string" ? ev.flaw : "(flaw)";

    const rule = typeof ev.brandRuleCited === "string" ? ev.brandRuleCited.trim() : "";
    if (rule) { r.ruleText.textContent = rule; r.rule.style.display = ""; }
    else { r.rule.style.display = "none"; }

    if (typeof ev.resolved === "boolean") {
      r.badge.textContent = ev.resolved ? "resolved ✓" : "still present";
      r.badge.className = "resolved-badge " + (ev.resolved ? "ok" : "no");
      r.badge.style.display = "";
    } else {
      r.badge.style.display = "none";
    }

    if (beforeSrc) { r.before.src = beforeSrc; r.before.parentElement.style.display = ""; }
    else { r.before.removeAttribute("src"); }
    if (afterSrc) { r.after.src = afterSrc; r.after.parentElement.style.display = ""; }
    else { r.after.removeAttribute("src"); }

    const agentId = typeof ev.agentId === "string" ? ev.agentId : "";
    if (agentId) { r.agent.textContent = agentId; r.provenance.style.display = ""; }
    else { r.provenance.style.display = "none"; }

    r.scrim.classList.add("show");
    r.panel.style.display = "";
    r.panel.style.animation = "none";
    void r.panel.offsetWidth;
    r.panel.style.animation = "";

    if (resolvedTimer) clearTimeout(resolvedTimer);
    resolvedTimer = setTimeout(closeResolved, 9000);
    return true;
  }

  // -------- Graph viz: token nodes + lesson edges (Phase 3 / 4.4) --------
  // Accumulated from memory-page signals: brand tokens (from grant provenance /
  // trace tags) become token nodes; recalled lessons + resolved flaws hang off
  // them as lesson edges. We mine tokens cheaply from event text (#hex, no-X, etc).
  const graph = {
    tokens: new Map(), // token -> { lessons: Set<string> }
    _wired: false,
  };

  function graphRefs() {
    if (graph._refsReady) return graph;
    graph.toggle = $("#graphToggle");
    graph.scrim = $("#graphScrim");
    graph.panel = $("#graphPanel");
    graph.close = $("#graphClose");
    graph.svg = $("#graphSvg");
    graph.empty = $("#graphEmpty");
    graph._refsReady = !!graph.panel;
    return graph;
  }

  // Pull candidate brand-token strings out of a finding/lesson/rule so each becomes
  // a per-token graph node in the UI. Hex colors + "no-gradient"-style rule slugs are
  // mined from free text (recalled snippets, resolved flaws). If a statement happens
  // to carry a typed "BRAND <KIND> token <node> …" prefix, the canonical node id is
  // mined directly from that prefix too (covering FONT/SECTION/SPACING/non-"no-" rule
  // tokens that the hex/no-X heuristics alone would otherwise collapse onto the
  // generic "brand" hub).
  function mineTokens(text) {
    const out = [];
    if (!text || typeof text !== "string") return out;
    const seen = new Set();
    const push = (t) => {
      const k = typeof t === "string" ? t.trim().toLowerCase() : "";
      if (!k || seen.has(k)) return;
      seen.add(k);
      out.push(k);
    };
    // 1) Typed Phase-3 grounding/lesson statements name the canonical node verbatim:
    //    "BRAND COLOR token #25F4EE …", "BRAND FONT token sofia-pro …",
    //    "BRAND SPACING token s0=8 …", "BRAND STRUCTURE token hero …".
    //    Capture the node id right after "token " (the slug/hex/s<i>, up to '=' / space).
    const typed = text.matchAll(/\bBRAND\s+[A-Z]+\s+token\s+([#a-z0-9][a-z0-9_-]*)/gi);
    for (const m of typed) push(m[1]);
    // 2) Hex colors (#RRGGBB) from any text — typed or free-form.
    const hex = text.match(/#[0-9a-fA-F]{3,8}\b/g);
    if (hex) hex.forEach(push);
    // 3) "no-gradient"-style rule slugs from free text without the typed prefix.
    const kebab = text.match(/\bno-[a-z]+\b/gi);
    if (kebab) kebab.forEach(push);
    return out;
  }

  // Attach a lesson/finding to any tokens it mentions. If it mentions none, anchor
  // it under a generic "brand" node so the graph still shows the accumulation.
  function graphAddLesson(text) {
    const lesson = typeof text === "string" ? text.trim() : "";
    if (!lesson) return;
    let toks = mineTokens(lesson);
    if (!toks.length) toks = ["brand"];
    toks.forEach((tk) => {
      if (!graph.tokens.has(tk)) graph.tokens.set(tk, { lessons: new Set() });
      // cap lessons per node so the viz stays legible
      const node = graph.tokens.get(tk);
      if (node.lessons.size < 4) node.lessons.add(lesson.length > 64 ? lesson.slice(0, 61) + "…" : lesson);
    });
    updateGraphToggle();
  }

  // Register explicit token nodes (e.g. from grant provenance / brand ingest).
  function graphAddToken(tk) {
    const t = typeof tk === "string" ? tk.trim().toLowerCase() : "";
    if (!t) return;
    if (!graph.tokens.has(t)) graph.tokens.set(t, { lessons: new Set() });
    updateGraphToggle();
  }

  function updateGraphToggle() {
    const g = graphRefs();
    if (!g.toggle) return;
    const has = graph.tokens.size > 0;
    g.toggle.classList.toggle("has-data", has);
  }

  function renderGraph() {
    const g = graphRefs();
    if (!g.svg) return;
    g.svg.innerHTML = "";
    const tokens = Array.from(graph.tokens.entries());
    if (!tokens.length) {
      g.empty.style.display = "";
      return;
    }
    g.empty.style.display = "none";

    const W = 960, H = 680, cx = W / 2, cy = H / 2;
    const edge = (x1, y1, x2, y2) => g.svg.appendChild(svgEl("line", { x1, y1, x2, y2, class: "gedge-line" }));
    const lessonNode = (x, y, text) => {
      g.svg.appendChild(svgEl("circle", { cx: x, cy: y, r: 8, class: "gnode-lesson" }));
      const t = svgEl("text", { x, y: y - 14, class: "glesson-label", "text-anchor": "middle" });
      t.textContent = text.length > 40 ? text.slice(0, 39) + "…" : text;
      g.svg.appendChild(t);
    };
    const tokenNode = (x, y, label, r) => {
      g.svg.appendChild(svgEl("circle", { cx: x, cy: y, r, class: "gnode-token" }));
      const t = svgEl("text", { x, y: y + 5, class: "gnode-label", "text-anchor": "middle" });
      t.textContent = label.length > 11 ? label.slice(0, 10) + "…" : label;
      g.svg.appendChild(t);
    };

    const n = tokens.length;
    if (n === 1) {
      // One token IS the hub: fan ALL its lessons in a full ring so the space is used.
      const [tk, node] = tokens[0];
      const lessons = Array.from(node.lessons);
      const L = lessons.length;
      const lr = Math.max(160, 120 + L * 6);
      lessons.forEach((lz, j) => {
        const a = (j / Math.max(1, L)) * Math.PI * 2 - Math.PI / 2;
        const lx = cx + Math.cos(a) * lr, ly = cy + Math.sin(a) * lr;
        edge(cx, cy, lx, ly); lessonNode(lx, ly, lz);
      });
      tokenNode(cx, cy, tk, 28);
      return;
    }

    // Multiple tokens: hub in the center, tokens on a ring, lessons fan outward.
    const tokenR = Math.min(W, H) / 2 - 210;
    tokenNode(cx, cy, "brand", 24);
    tokens.forEach(([tk, node], i) => {
      const ang = (i / n) * Math.PI * 2 - Math.PI / 2;
      const tx = cx + Math.cos(ang) * tokenR, ty = cy + Math.sin(ang) * tokenR;
      edge(cx, cy, tx, ty);
      const lessons = Array.from(node.lessons);
      const L = lessons.length;
      const lr = Math.max(120, 80 + L * 10);
      const spread = L > 1 ? Math.min(Math.PI * 1.2, 0.5 * L) : 0;
      lessons.forEach((lz, j) => {
        const sub = ang + (L > 1 ? (j - (L - 1) / 2) * (spread / (L - 1)) : 0);
        const lx = tx + Math.cos(sub) * lr, ly = ty + Math.sin(sub) * lr;
        edge(tx, ty, lx, ly); lessonNode(lx, ly, lz);
      });
      tokenNode(tx, ty, tk, 20);
    });
  }

  function openGraph() {
    const g = graphRefs();
    if (!g.panel) return;
    renderGraph();
    g.scrim.classList.add("show");
    g.panel.style.display = "";
  }
  function closeGraph() {
    const g = graphRefs();
    if (!g.panel) return;
    g.scrim.classList.remove("show");
    g.panel.style.display = "none";
  }
  function wireGraph() {
    if (graph._wired) return;
    const g = graphRefs();
    if (!g.toggle) return;
    graph._wired = true;
    g.toggle.addEventListener("click", openGraph);
    g.close.addEventListener("click", closeGraph);
    g.scrim.addEventListener("click", closeGraph);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeGraph(); });
  }

  // -------- Event application --------
  function applyEvent(ev) {
    const page = ev.page;
    if (!page || !ui[page]) return; // run.started etc. with no page are fine to ignore
    const refs = ui[page];
    const st = state[page];

    switch (ev.type) {
      case "agent.spawned": {
        // Carry the master-authored prompt + granted skills + provenance/credit onto
        // the card (all new fields optional — graceful if absent).
        getOrCreateAgent(page, ev.agentId, ev.role, ev.version, {
          skills: ev.skills,
          prompt: ev.prompt,
          grantProvenance: ev.grantProvenance,
          credit: ev.credit,
        });
        st.agents += 1;
        setCounter(page, "agents", st.agents);
        // Memory provenance: grant-provenance lessons + attributed flaws seed the graph.
        if (page === "memory" && Array.isArray(ev.grantProvenance)) {
          ev.grantProvenance.forEach((g) => { if (g && g.fromLesson) graphAddLesson(g.fromLesson); });
        }
        if (page === "memory" && ev.credit && ev.credit.flaw) graphAddLesson(ev.credit.flaw);
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
        // NOTE: agent.turn fires once per agent (1:1 with agent.spawned) — it does NOT
        // drive the "Turns" tile anymore. "Turns" = GENERATIONS (in-run improvement
        // rounds), set on score.updated below. agent.turn only flags the agent active.
        markActive(page, ev.agentId);
        break;
      }
      case "trace.written": {
        st.traces += 1;
        setCounter(page, "traces", st.traces);
        // Per-agent traces column: attribute to the emitting agent (agentId).
        if (ev.agentId) {
          const a = getOrCreateAgent(page, ev.agentId);
          bumpAgentStat(a, "trace", 1);
        }
        // The finding text feeds the memory graph (token anchoring).
        if (page === "memory" && ev.summary) graphAddLesson(ev.summary);
        break;
      }
      case "trace.resolved": {
        // Before/after, visually evidenced (memory page). New optional event — pop a
        // panel with the named flaw + cited rule + the two screenshots side by side.
        if (ev.agentId) {
          const a = getOrCreateAgent(page, ev.agentId);
          bumpAgentStat(a, "trace", 0); // ensure stats row reveals if it has any
        }
        if (page === "memory") {
          if (ev.brandRuleCited) graphAddLesson(ev.brandRuleCited);
          if (ev.flaw) graphAddLesson(ev.flaw);
          showResolvedPanel(ev);
        }
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
        // The lesson that drove the upskill feeds the memory graph.
        if (page === "memory" && typeof ev.lessonText === "string") graphAddLesson(ev.lessonText);
        break;
      }
      case "memory.distilled": {
        const accepted = Array.isArray(ev.lessonsAccepted) ? ev.lessonsAccepted.length : 0;
        st.lessons += accepted;
        setCounter(page, "lessons", st.lessons);
        // Each distilled lesson statement anchors onto its token(s) in the graph.
        if (page === "memory" && Array.isArray(ev.lessonsAccepted)) {
          ev.lessonsAccepted.forEach((l) => {
            const stmt = l && typeof l === "object" ? l.statement : l;
            if (typeof stmt === "string") graphAddLesson(stmt);
          });
        }
        break;
      }
      case "design.rendered": {
        setIframe(page, ev.htmlRef);
        break;
      }
      case "score.updated": {
        // "Turns" tile = GENERATION count (the in-run improvement rounds). score.updated
        // fires once per gen per page at gen-end, so gen+1 = generations completed.
        if (typeof ev.gen === "number") {
          st.turns = Math.min(TURN_CAP, ev.gen + 1);
          setCounter(page, "turns", st.turns);
        }
        // H2: ev.score is now THIS gen's judged score (per-gen), NOT bestScore.
        // -> the chart plots (gen, score); the headline tracks the best so far so
        //    the big number never regresses mid-run (run.finished.totals.score is
        //    authoritative at the end).
        if (typeof ev.score === "number") {
          // Headline = best per-gen score seen so far (monotonic; matches the
          // run.finished bestScore headline).
          if (ev.score > st.score) { st.score = ev.score; updateScoreUI(); }
        }
        break;
      }
      case "team.judged": {
        // optional flash on the doing line; score handled by score.updated.
        if (typeof ev.score === "number") {
          refs.doingGlobal.textContent = "judged: " + ev.score + (ev.category ? " · " + ev.category : "");
        }
        break;
      }
      case "memory.recalled": {
        if (Array.isArray(ev.hits) && ev.hits.length) {
          refs.doingGlobal.textContent = "↺ recalled " + ev.hits.length + " memory hit" + (ev.hits.length > 1 ? "s" : "");
          // Per-agent recall-hits column (4.1): attribute to the recalling agent.
          if (ev.agentId) {
            const a = getOrCreateAgent(page, ev.agentId);
            bumpAgentStat(a, "recall", ev.hits.length);
          }
          // Recalled snippets anchor onto token nodes in the memory graph.
          if (page === "memory") {
            ev.hits.forEach((h) => {
              const snip = h && typeof h === "object" ? h.snippet : h;
              if (typeof snip === "string") graphAddLesson(snip);
            });
          }
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
  let lastRunId = null;
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
      if (refs.score) refs.score.textContent = "0"; // score display removed — guard
    });
    updateScoreUI();
    // Reset the memory graph (per-run, no cross-run carry).
    graph.tokens = new Map();
    updateGraphToggle();
    closeGraph();
    setClock(0);
    closeUpskill();
    closeResolved();
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

    // A NEW run (new runId) OR a truncated log -> reset and re-apply from scratch, so
    // the UI always starts afresh and never shows the previous run's site/iframe.
    if ((data.runId && data.runId !== lastRunId) || list.length < appliedCount) {
      resetAll();
      appliedCount = 0;
      lastRunId = data.runId || lastRunId;
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
  let speed = 4;
  let replayTimers = [];
  function clearReplay() { replayTimers.forEach((id) => clearTimeout(id)); replayTimers = []; }

  // TIMED REPLAY of the saved events.json. Pure client-side re-render — NO re-run,
  // NO model calls. Fixed tempo (no dead gaps); the 1x/4x/8x buttons scale it.
  async function timedReplay() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } // pause live poll
    clearReplay();
    let data;
    try { const res = await fetch("run/events.json", { cache: "no-store" }); data = await res.json(); }
    catch { setStatus("no run to replay", false); return; }
    const list = (Array.isArray(data.events) ? data.events : []).slice().sort((a, b) => (a.t || 0) - (b.t || 0));
    if (!list.length) { setStatus("no run to replay", false); return; }
    resetAll();
    appliedCount = list.length; // a later poll won't double-apply
    setStatus("replaying…", true);
    const stepMs = Math.max(20, 600 / speed);
    list.forEach((ev, i) => {
      replayTimers.push(setTimeout(() => { applyEvent(ev); setClock(i * stepMs * speed); }, i * stepMs));
    });
    replayTimers.push(setTimeout(() => setStatus("finished", false), list.length * stepMs + 150));
  }

  function wireControls() {
    const rb = $("#restartBtn");
    if (rb) rb.addEventListener("click", timedReplay); // Restart = animated REPLAY (no re-run)
    document.querySelectorAll(".speed-btn").forEach((b) => {
      b.addEventListener("click", () => {
        speed = Number(b.dataset.speed) || 4;
        document.querySelectorAll(".speed-btn").forEach((x) => {
          const on = x === b;
          x.classList.toggle("bg-white", on);
          x.classList.toggle("text-black", on);
        });
        if (replayTimers.length) timedReplay(); // restart replay at the new speed
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
    wireGraph();
    updateGraphToggle();
    updateScoreUI();
    startLive();
  }

  // In the browser, boot immediately. Under Node (no DOM), skip boot and expose the
  // pure, DOM-free helpers on a test hook so app.smoke.mjs can assert the v3.1
  // consumer logic (per-gen chart vs bestScore headline; graph token mining).
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", boot);
    } else {
      boot();
    }
  } else if (typeof globalThis !== "undefined") {
    globalThis.__TASTELOOP_APP_TEST__ = {
      mineTokens,
      // score->y-pixel mapping for a 0..100 score within a 72px band (test-only;
      // the per-gen chart UI was removed, this pure helper is kept for app.smoke).
      yForScore: (s) => {
        const H = 72, padT = 8, padB = 14, innerH = H - padT - padB;
        return padT + innerH - (Math.max(0, Math.min(100, s)) / 100) * innerH;
      },
      // headline rule (H2): best per-gen score seen so far (monotonic max).
      headlineFromGens: (scores) => scores.reduce((m, s) => (s > m ? s : m), 0),
    };
  }
})();
