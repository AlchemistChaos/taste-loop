// memory.mjs — pluggable memory backend for TasteLoop.
// Frozen signature:
//   export function makeMemory(kind)  // kind "none"|"shim"|"cognee"
//   returns {
//     async openSession(id),
//     async writeTrace(id, {role, finding, severity}),
//     async writeTraces(id, [{role, finding, severity}]) -> { added }  // batched, optional
//     async recallInRun(id, query) -> [{snippet, role}],
//     async distill(id) -> { lessonsAccepted: [{statement}] },  // quality-filtered
//     async recallLessons(query) -> [{statement}],
//     stats() -> { traces, lessons }
//   }
//
// "none"   = all no-ops / empty (counters stay 0).
// "shim"   = in-memory keyword store (real, working).
// "cognee" = try a python bridge; on ANY error fall back to shim. Never throws.
//
// No npm deps. Uses node:child_process only for the cognee bridge attempt.

import { spawn } from "node:child_process";

// ---------- tokenization / similarity helpers ----------

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "is", "are", "was", "were", "be", "to",
  "of", "in", "on", "for", "with", "as", "at", "by", "it", "this", "that", "no",
  "not", "has", "have", "had", "too", "very", "more", "less", "should", "could",
  "would", "use", "using", "make", "made",
]);

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

function tokenSet(text) {
  return new Set(tokenize(text));
}

function overlapScore(querySet, finding) {
  if (querySet.size === 0) return 1; // empty query -> match everything
  const fset = tokenSet(finding);
  let hits = 0;
  for (const w of querySet) if (fset.has(w)) hits++;
  return hits;
}

// Jaccard similarity over token sets, used to dedupe findings during distill.
function jaccard(aSet, bSet) {
  if (aSet.size === 0 && bSet.size === 0) return 1;
  let inter = 0;
  for (const w of aSet) if (bSet.has(w)) inter++;
  const union = aSet.size + bSet.size - inter;
  return union === 0 ? 0 : inter / union;
}

// ---------- the in-memory shim implementation ----------

function makeShim() {
  // sessionId -> [{ role, finding, severity }]
  const sessions = new Map();
  // cross-run distilled lessons: [{ statement, tokens:Set }]
  const lessons = [];

  function ensure(id) {
    if (!sessions.has(id)) sessions.set(id, []);
    return sessions.get(id);
  }

  return {
    async openSession(id) {
      ensure(id);
      return { id };
    },

    async writeTrace(id, { role, finding, severity } = {}) {
      const arr = ensure(id);
      arr.push({
        role: role || "unknown",
        finding: String(finding == null ? "" : finding),
        severity: severity || "info",
      });
    },

    // Batch many traces in one call (the shim has no per-trace cost, but this
    // keeps the API parallel with the cognee bridge's batched cognify).
    async writeTraces(id, traces = []) {
      const arr = ensure(id);
      let added = 0;
      for (const t of traces || []) {
        const { role, finding, severity } = t || {};
        if (finding == null || String(finding).trim() === "") continue;
        arr.push({
          role: role || "unknown",
          finding: String(finding),
          severity: severity || "info",
        });
        added += 1;
      }
      return { added };
    },

    async recallInRun(id, query) {
      const arr = sessions.get(id) || [];
      if (arr.length === 0) return [];

      const qset = tokenSet(query);
      // Score each trace by query-token overlap; keep those with a hit.
      const scored = arr.map((t) => ({ t, score: overlapScore(qset, t.finding) }));
      let matches = scored.filter((s) => s.score > 0);

      // If the query matched nothing (or query was empty) and the run is small,
      // return everything so recall is still useful early on.
      if (matches.length === 0) {
        if (arr.length <= 5) matches = scored;
        else return [];
      }

      matches.sort((a, b) => b.score - a.score);
      return matches.map(({ t }) => ({ snippet: t.finding, role: t.role }));
    },

    async distill(id) {
      const arr = sessions.get(id) || [];
      if (arr.length === 0) return { lessonsAccepted: [] };

      // Dedupe findings within the session by token-set similarity.
      const clusters = [];
      for (const t of arr) {
        const tk = tokenSet(t.finding);
        if (tk.size === 0) continue;
        const existing = clusters.find((c) => jaccard(c.tokens, tk) >= 0.5);
        if (existing) {
          existing.count++;
        } else {
          clusters.push({ finding: t.finding.trim(), tokens: tk, count: 1, role: t.role });
        }
      }

      // Prefer the most-repeated clusters; cap at 2 lessons per distill.
      clusters.sort((a, b) => b.count - a.count);
      const top = clusters.slice(0, 2);

      const accepted = [];
      for (const c of top) {
        const statement = toLesson(c.finding);
        // Quality gate: drop degenerate/meta-fluff lessons with no concrete rule.
        // Better to return zero lessons than pollute recall with garbage.
        if (!isQualityLesson(statement)) continue;
        // Skip if a near-identical cross-run lesson already exists.
        const stTokens = tokenSet(statement);
        const dup = lessons.find((l) => jaccard(l.tokens, stTokens) >= 0.7);
        if (dup) continue;
        const lesson = { statement, tokens: stTokens };
        lessons.push(lesson);
        accepted.push({ statement });
      }

      return { lessonsAccepted: accepted };
    },

    async recallLessons(query) {
      if (lessons.length === 0) return [];
      const qset = tokenSet(query);
      if (qset.size === 0) return lessons.map((l) => ({ statement: l.statement }));
      const scored = lessons
        .map((l) => ({ l, score: overlapScore(qset, l.statement) }))
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score);
      // Fall back to all lessons if nothing matched (small lesson sets stay useful).
      const picked = scored.length ? scored.map((s) => s.l) : lessons;
      return picked.map((l) => ({ statement: l.statement }));
    },

    stats() {
      let traces = 0;
      for (const arr of sessions.values()) traces += arr.length;
      return { traces, lessons: lessons.length };
    },
  };
}

// ---------- lesson quality gate ----------
// Distillation can emit degenerate filler ("Got it.", "Focus on how...") with
// no enforceable rule. A garbage lesson is worse than none: it pollutes recall
// and gets re-injected into builds. Keep ONLY concrete, actionable brand/design
// rules; if none qualify, return zero lessons.

const DEGENERATE_PREFIX = /^(got it|understood|okay|ok|sure|noted|focus on how)\b/i;

// A real lesson should name a concrete brand/design lever (color, spacing, a
// forbidden element, a rule verb, etc).
const CONCRETE_HINT =
  /(gradient|colou?r|contrast|accent|cta|button|font|type|typograph|spacing|padding|margin|radius|shadow|border|hero|headline|buzzword|jargon|brand|token|palette|hex|#[0-9a-f]{3,8}|layout|align|whitespace|forbid|avoid|never|always|ensure|prefer|require|must|don'?t|do not|use\b|keep\b|remove)/i;

function isQualityLesson(statement) {
  if (!statement) return false;
  const s = String(statement).trim();
  if (s.length < 20) return false;
  if (DEGENERATE_PREFIX.test(s)) return false;
  if (!CONCRETE_HINT.test(s)) return false; // reject meta-fluff with no concrete rule
  return true;
}

// Filter a list of {statement} (or bare strings) to deduped quality lessons.
function filterLessons(lessons) {
  const out = [];
  const seen = new Set();
  for (const lsn of lessons || []) {
    const stmt = String((lsn && (lsn.statement ?? lsn)) || "").trim();
    if (!isQualityLesson(stmt)) continue;
    const key = stmt.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ statement: stmt });
  }
  return out;
}

// Turn a raw finding into a reusable, imperative lesson statement.
function toLesson(finding) {
  const f = String(finding || "").trim().replace(/\s+/g, " ");
  if (!f) return "Apply prior learnings.";
  // If it already reads like guidance, keep it.
  if (/^(always|never|avoid|prefer|use|ensure|do not|don't|make|keep)\b/i.test(f)) {
    return capitalize(f);
  }
  return `Going forward: ${decapitalize(f)}`;
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function decapitalize(s) {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

// ---------- the "none" no-op implementation ----------

function makeNone() {
  return {
    async openSession() { return null; },
    async writeTrace() { /* no-op */ },
    async writeTraces() { return { added: 0 }; },
    async recallInRun() { return []; },
    async distill() { return { lessonsAccepted: [] }; },
    async recallLessons() { return []; },
    stats() { return { traces: 0, lessons: 0 }; },
  };
}

// ---------- the "cognee" implementation (with shim fallback) ----------

function makeCognee() {
  // The shim mirrors every write so stats/recall still work if the bridge fails.
  const shim = makeShim();
  // Bridge lives next to this module; cognee is installed in the smoke venv.
  const here = new URL(".", import.meta.url).pathname; // .../web/src/
  const BRIDGE = here + "cognee_bridge.py";
  const PY = process.env.COGNEE_PY || "/tmp/cognee_smoke/venv/bin/python3";
  const TIMEOUT = Number(process.env.COGNEE_TIMEOUT || 90_000);

  // ASYNC bridge call — must not block the event loop (keeps the live stream
  // flushing while cognee/qwen works). Resolves parsed JSON, or null on any error.
  function execBridge(cmd, payload) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      let child;
      try {
        child = spawn(PY, [BRIDGE, cmd, JSON.stringify(payload)]);
      } catch {
        return finish(null);
      }
      let out = "";
      const killer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} finish(null); }, TIMEOUT);
      child.stdout.on("data", (d) => (out += d));
      child.on("error", () => { clearTimeout(killer); finish(null); });
      child.on("close", (code) => {
        clearTimeout(killer);
        if (code !== 0) return finish(null);
        try { finish(JSON.parse(out.trim())); } catch { finish(null); }
      });
    });
  }

  return {
    async openSession(id) {
      await execBridge("open_session", { sessionId: id });
      return shim.openSession(id);
    },
    async writeTrace(id, { role, finding, severity } = {}) {
      await execBridge("write_trace", { sessionId: id, role, finding, severity });
      return shim.writeTrace(id, { role, finding, severity });
    },
    // Fast path: add MANY traces, cognify ONCE via the bridge (the per-trace
    // cognify is the memory-page slowness). On any batch failure, fall back to
    // per-trace bridge writes so nothing is lost. The shim is always mirrored.
    async writeTraces(id, traces = []) {
      const list = Array.isArray(traces) ? traces : [];
      const b = await execBridge("write_traces_batch", { sessionId: id, traces: list });
      if (!b || b.ok !== true) {
        // Batch unavailable/failed — degrade to one bridge call per trace.
        for (const t of list) {
          const { role, finding, severity } = t || {};
          await execBridge("write_trace", { sessionId: id, role, finding, severity });
        }
      }
      return shim.writeTraces(id, list); // keep shim stats/recall in sync
    },
    async recallInRun(id, query) {
      const b = await execBridge("recall_in_run", { sessionId: id, query });
      if (b && Array.isArray(b.hits)) return b.hits.map((h) => ({ snippet: h.snippet, role: "memory" }));
      return shim.recallInRun(id, query);
    },
    async distill(id) {
      const b = await execBridge("distill", { sessionId: id });
      if (b && Array.isArray(b.lessonsAccepted)) {
        await shim.distill(id); // keep shim in sync
        // Defensive quality gate (the bridge filters too; this protects against
        // an older/looser bridge slipping degenerate lessons through).
        return { lessonsAccepted: filterLessons(b.lessonsAccepted) };
      }
      return shim.distill(id);
    },
    async recallLessons(query) {
      const b = await execBridge("recall_lessons", { query });
      if (b && Array.isArray(b.lessons)) return b.lessons.map((l) => ({ statement: l.statement }));
      return shim.recallLessons(query);
    },
    stats() {
      return shim.stats(); // bridge has no stats cmd; orchestrator counts events itself
    },
  };
}

// ---------- factory ----------

/**
 * @param {"none"|"shim"|"cognee"} kind
 */
export function makeMemory(kind) {
  switch (kind) {
    case "none": return makeNone();
    case "shim": return makeShim();
    case "cognee": return makeCognee();
    default:
      // Unknown kind -> safest useful default is the working shim.
      return makeShim();
  }
}

// ---- tiny smoke test (no network / no python required) ----
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    let ok = true;
    const log = (cond, msg) => { if (!cond) ok = false; console.log(cond ? "PASS" : "FAIL", msg); };

    // none
    const none = makeMemory("none");
    await none.openSession("r1");
    await none.writeTrace("r1", { role: "critique", finding: "low contrast text", severity: "high" });
    log((await none.recallInRun("r1", "contrast")).length === 0, "none: recall empty");
    log(none.stats().traces === 0 && none.stats().lessons === 0, "none: stats all zero");

    // shim
    const m = makeMemory("shim");
    await m.openSession("run-a");
    await m.writeTrace("run-a", { role: "critique", finding: "Text contrast is too low on hero", severity: "high" });
    await m.writeTrace("run-a", { role: "critique", finding: "hero text low contrast hard to read", severity: "high" });
    await m.writeTrace("run-a", { role: "visual", finding: "CTA button needs stronger brand color", severity: "med" });

    const rec = await m.recallInRun("run-a", "contrast hero");
    log(rec.length >= 1 && rec[0].snippet.toLowerCase().includes("contrast"), "shim: recallInRun matches contrast");
    log(rec.every((r) => "snippet" in r && "role" in r), "shim: recall shape {snippet,role}");

    const d = await m.distill("run-a");
    log(Array.isArray(d.lessonsAccepted) && d.lessonsAccepted.length >= 1, "shim: distill produced lessons");
    log(d.lessonsAccepted.length <= 2, "shim: distill capped at 2");

    const lessons = await m.recallLessons("contrast");
    log(lessons.length >= 1 && "statement" in lessons[0], "shim: recallLessons shape {statement}");

    const st = m.stats();
    log(st.traces === 3, `shim: stats.traces==3 (got ${st.traces})`);
    log(st.lessons >= 1, `shim: stats.lessons>=1 (got ${st.lessons})`);

    // distilling again should not blow up; duplicate lessons get suppressed
    const d2 = await m.distill("run-a");
    log(Array.isArray(d2.lessonsAccepted), "shim: second distill returns array");

    // QUALITY GATE: degenerate / meta-fluff findings must NOT become lessons.
    const mq = makeMemory("shim");
    await mq.openSession("run-q");
    await mq.writeTrace("run-q", { role: "critique", finding: "Got it", severity: "low" });
    await mq.writeTrace("run-q", { role: "critique", finding: "Focus on how to improve", severity: "low" });
    await mq.writeTrace("run-q", { role: "critique", finding: "noted", severity: "low" });
    const dq = await mq.distill("run-q");
    log(dq.lessonsAccepted.length === 0, "quality: degenerate findings yield zero lessons");

    // QUALITY GATE: a concrete brand rule DOES survive.
    const mr = makeMemory("shim");
    await mr.openSession("run-r");
    await mr.writeTrace("run-r", { role: "critique", finding: "Never use gradients on the hero; flat color only", severity: "high" });
    const dr = await mr.distill("run-r");
    log(dr.lessonsAccepted.length === 1, "quality: concrete brand rule survives");
    log(isQualityLesson("Never use gradients on the hero; flat color only"), "quality: isQualityLesson accepts concrete rule");
    log(!isQualityLesson("Got it, understood."), "quality: isQualityLesson rejects degenerate");
    log(!isQualityLesson("focus on how things look"), "quality: isQualityLesson rejects meta-fluff prefix");
    log(!isQualityLesson("be better"), "quality: isQualityLesson rejects too-short");

    // BATCH: writeTraces adds many, mirrors shim stats.
    const mb = makeMemory("shim");
    await mb.openSession("run-b");
    const res = await mb.writeTraces("run-b", [
      { role: "critique", finding: "CTA button must use the accent color", severity: "high" },
      { role: "visual", finding: "increase hero spacing for whitespace balance", severity: "med" },
      { role: "noise", finding: "" }, // blank skipped
    ]);
    log(res.added === 2, `batch: writeTraces added 2 (got ${res.added})`);
    log(mb.stats().traces === 2, "batch: stats reflects batched traces");
    log((await mb.recallInRun("run-b", "accent")).length >= 1, "batch: batched traces are recallable");

    // cognee falls back to shim (no bridge present)
    const c = makeMemory("cognee");
    await c.openSession("run-c");
    await c.writeTrace("run-c", { role: "critique", finding: "spacing inconsistent between sections", severity: "low" });
    log((await c.recallInRun("run-c", "spacing")).length >= 1, "cognee: falls back to shim recall");
    log(c.stats().traces === 1, "cognee: shim-backed stats works");

    // cognee.writeTraces falls back to shim batching when bridge is absent.
    const cb = await c.writeTraces("run-c", [
      { role: "critique", finding: "remove the drop shadow; brand uses flat borders", severity: "med" },
      { role: "critique", finding: "headline font must match the brand typography token", severity: "high" },
    ]);
    log(cb && cb.added === 2, `cognee: writeTraces batch added 2 (got ${cb && cb.added})`);
    log(c.stats().traces === 3, `cognee: stats after batch == 3 (got ${c.stats().traces})`);

    console.log(ok ? "memory.mjs smoke: ALL PASS" : "memory.mjs smoke: FAILURES");
    process.exit(ok ? 0 : 1);
  })();
}
