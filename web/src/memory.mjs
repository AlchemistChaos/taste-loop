// memory.mjs — pluggable memory backend for TasteLoop (Cognee v1, in-run only).
// Frozen signature (CONTRACTS.md §2):
//   export function makeMemory(kind)  // kind "none"|"shim"|"cognee"
//   returns {
//     async reset(sessionId) -> { ok },                                   // bridge `reset` (forget dataset)
//     async openSession(id) -> { id } | null,
//     async writeTrace(id, {role, finding, severity, nodeSet?}) -> void,
//     async writeTraces(id, [{role, finding, severity, nodeSet?}]) -> { added },  // batched
//     // VERBATIM recall. Returns hits + the qa_id for this interaction (C2).
//     async recallInRun(id, query, { nodeName? } = {}) -> { hits:[{snippet, role}], qa_id:(string|null) },
//     async feedback(id, { qa_id, feedbackText, feedbackScore }) -> { applied },  // bridge cmd_feedback
//     async improve(sessionIds, feedbackAlpha) -> { improved },                   // bridge cmd_improve
//     async distill(id) -> { lessonsAccepted: [{statement}] },  // SESSION-ONLY, quality-filtered
//     stats() -> { traces, lessons }
//   }
//
// In-run, turn-by-turn ONLY (Invariant 1). There is NO cross-run carry:
//   - `makeMemory(kind)` is re-instantiated fresh per RUN by the orchestrator, so the
//     shim's per-run state (the `sessions` Map) starts empty every run (C1a).
//   - There is NO durable `lessons[]` closure and NO `recallLessons` cross-run read path
//     (C1c/C1d). `distill` is session-scoped and feeds only the in-run Lessons counter.
//
// "none"   = all no-ops / empty (counters stay 0).
// "shim"   = in-memory keyword store (real, working) — per-run state, no durable closure.
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
  //
  // PER-RUN ONLY: this Map is the entire mutable state. There is NO durable
  // `lessons[]` closure — that would carry across runs and break Invariant 1.
  // The orchestrator re-instantiates makeMemory() per run, so this starts empty
  // every run (C1a). `lessonsAccepted` returned by distill is per-call/session.
  const sessions = new Map();
  // Per-run count of distinct in-run lessons distilled (for stats().lessons).
  // Lives in the per-run closure, so it resets with the run — NOT cross-run.
  let lessonCount = 0;

  function ensure(id) {
    if (!sessions.has(id)) sessions.set(id, []);
    return sessions.get(id);
  }

  return {
    // Reset wipes this run's session store (C1). With no durable closure there
    // is nothing else to clear; clearing the keyed session is the shim's reset.
    async reset(sessionId) {
      if (sessionId == null) {
        sessions.clear();
        lessonCount = 0;
      } else {
        sessions.delete(sessionId);
      }
      return { ok: true };
    },

    async openSession(id) {
      ensure(id);
      return { id };
    },

    async writeTrace(id, { role, finding, severity, nodeSet } = {}) {
      const arr = ensure(id);
      arr.push({
        role: role || "unknown",
        finding: String(finding == null ? "" : finding),
        severity: severity || "info",
        nodeSet: Array.isArray(nodeSet) ? nodeSet : undefined,
      });
    },

    // Batch many traces in one call (the shim has no per-trace cost, but this
    // keeps the API parallel with the cognee bridge's batched cognify).
    async writeTraces(id, traces = []) {
      const arr = ensure(id);
      let added = 0;
      for (const t of traces || []) {
        const { role, finding, severity, nodeSet } = t || {};
        if (finding == null || String(finding).trim() === "") continue;
        arr.push({
          role: role || "unknown",
          finding: String(finding),
          severity: severity || "info",
          nodeSet: Array.isArray(nodeSet) ? nodeSet : undefined,
        });
        added += 1;
      }
      return { added };
    },

    // VERBATIM recall (CONTRACTS §2): hits[].snippet is the byte-unchanged stored
    // finding string. `nodeName` is an OPTIONAL read filter (OR-joined tokens) —
    // the shim biases recall toward traces whose stored nodeSet intersects it, but
    // never rewrites the snippet. Returns { hits, qa_id } (qa_id null in the shim).
    async recallInRun(id, query, { nodeName } = {}) {
      const arr = sessions.get(id) || [];
      if (arr.length === 0) return { hits: [], qa_id: null };

      const filter = Array.isArray(nodeName) && nodeName.length
        ? new Set(nodeName.map((n) => String(n).toLowerCase()))
        : null;

      const qset = tokenSet(query);
      // Score each trace by query token-overlap (+ a node_name filter bonus); keep hits.
      const scored = arr.map((t) => {
        let score = overlapScore(qset, t.finding);
        if (filter && Array.isArray(t.nodeSet)) {
          for (const n of t.nodeSet) {
            if (filter.has(String(n).toLowerCase())) { score += 1; break; }
          }
        }
        return { t, score };
      });
      let matches = scored.filter((s) => s.score > 0);

      // If the query matched nothing (or query was empty) and the run is small,
      // return everything so recall is still useful early on.
      if (matches.length === 0) {
        if (arr.length <= 5) matches = scored;
        else return { hits: [], qa_id: null };
      }

      matches.sort((a, b) => b.score - a.score);
      const hits = matches.map(({ t }) => ({ snippet: t.finding, role: t.role }));
      return { hits, qa_id: null };
    },

    // No-op in the shim (no graph to feed back into); keeps the API parallel.
    // The shim has no qa_id to apply against, so feedback is never "applied".
    async feedback(_id, _opts = {}) {
      return { applied: false };
    },

    // No-op in the shim (no graph to reweight); keeps the API parallel.
    async improve(_sessionIds, _feedbackAlpha) {
      return { improved: false };
    },

    // SESSION-ONLY distill (C1c): produces in-run lessons from THIS session's
    // traces. No durable cross-run store is read or written — dedup is within
    // the session only. The accepted lessons feed the in-run Lessons counter.
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
        accepted.push({ statement });
      }

      lessonCount += accepted.length;
      return { lessonsAccepted: accepted };
    },

    stats() {
      let traces = 0;
      for (const arr of sessions.values()) traces += arr.length;
      return { traces, lessons: lessonCount };
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
    async reset() { return { ok: true }; },
    async openSession() { return null; },
    async writeTrace() { /* no-op */ },
    async writeTraces() { return { added: 0 }; },
    async recallInRun() { return { hits: [], qa_id: null }; },
    async feedback() { return { applied: false }; },
    async improve() { return { improved: false }; },
    async distill() { return { lessonsAccepted: [] }; },
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

  // Build the node_set write tags for a trace: [token..., role, severity].
  // Caller may pass an explicit nodeSet; otherwise derive [role, severity].
  function traceNodeSet({ role, severity, nodeSet }) {
    if (Array.isArray(nodeSet) && nodeSet.length) return nodeSet;
    const tags = [];
    if (role) tags.push(role);
    if (severity) tags.push(severity);
    return tags;
  }

  return {
    // Reset the run's session dataset (C1): bridge `reset` -> forget(dataset=...).
    // Best-effort: reset is non-fatal. Always wipe the mirrored shim too.
    async reset(sessionId) {
      await execBridge("reset", { sessionId });
      return shim.reset(sessionId);
    },
    async openSession(id) {
      // No dedicated open command on the v1 bridge; the session is created on
      // first write/recall. Keep the shim session in sync.
      return shim.openSession(id);
    },
    async writeTrace(id, { role, finding, severity, nodeSet } = {}) {
      await execBridge("remember-trace", {
        sessionId: id,
        role: role || "critique",
        finding,
        severity: severity || "info",
        node_set: traceNodeSet({ role, severity, nodeSet }),
      });
      return shim.writeTrace(id, { role, finding, severity, nodeSet });
    },
    // Fast path: add MANY traces, cognify ONCE via the bridge (the per-trace
    // cognify is the memory-page slowness). On any batch failure, fall back to
    // per-trace bridge writes so nothing is lost. The shim is always mirrored.
    async writeTraces(id, traces = []) {
      const list = Array.isArray(traces) ? traces : [];
      const records = list.map((t) => {
        const { role, finding, severity, nodeSet } = t || {};
        return {
          role: role || "critique",
          finding,
          severity: severity || "info",
          node_set: traceNodeSet({ role, severity, nodeSet }),
        };
      });
      const b = await execBridge("remember-traces-batch", { sessionId: id, traces: records });
      if (!b || b.ok !== true) {
        // Batch unavailable/failed — degrade to one bridge call per trace.
        for (const r of records) {
          await execBridge("remember-trace", { sessionId: id, ...r });
        }
      }
      return shim.writeTraces(id, list); // keep shim stats/recall in sync
    },
    // VERBATIM recall + qa_id (C2/H5). Threads the OPTIONAL node_name read filter.
    // Returns { hits:[{snippet, role}], qa_id }. On any bridge miss/error falls
    // back to the shim (which returns the same shape with qa_id:null).
    async recallInRun(id, query, { nodeName } = {}) {
      const args = { sessionId: id, query };
      if (Array.isArray(nodeName) && nodeName.length) args.node_name = nodeName;
      const b = await execBridge("recall", args);
      if (b && Array.isArray(b.hits)) {
        return {
          hits: b.hits.map((h) => ({ snippet: h.snippet, role: h.role || "memory" })),
          qa_id: (b.qa_id == null ? null : b.qa_id),
        };
      }
      return shim.recallInRun(id, query, { nodeName });
    },
    // Record the judged delta as feedback (spine step 5). applied:false when the
    // qa_id is null/unresolved or the bridge is unavailable.
    async feedback(id, { qa_id, feedbackText, feedbackScore } = {}) {
      const b = await execBridge("cmd_feedback", {
        sessionId: id,
        qa_id: qa_id == null ? null : qa_id,
        feedbackText,
        feedbackScore,
      });
      if (b && typeof b.applied === "boolean") return { applied: b.applied };
      return { applied: false };
    },
    // Reweight the session(s) by feedback (spine step 6) so the next turn's
    // recall ranks proven fixes higher. improved:false on bridge miss/error.
    async improve(sessionIds, feedbackAlpha) {
      const ids = Array.isArray(sessionIds) ? sessionIds : [sessionIds].filter(Boolean);
      const b = await execBridge("cmd_improve", { sessionIds: ids, feedbackAlpha });
      if (b && b.improved === true) return { improved: true };
      return { improved: false };
    },
    // SESSION-ONLY distill (writes nothing durable). Feeds the in-run Lessons
    // counter. Degrades gracefully (Traces-only) if GLM yields 0 lessons.
    async distill(id) {
      const b = await execBridge("distill", { sessionId: id });
      if (b && Array.isArray(b.lessonsAccepted)) {
        await shim.distill(id); // keep shim stats in sync (per-run lesson count)
        // Defensive quality gate (the bridge filters too; this protects against
        // an older/looser bridge slipping degenerate lessons through).
        return { lessonsAccepted: filterLessons(b.lessonsAccepted) };
      }
      return shim.distill(id);
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

    // none — every method empty/no-op; recallInRun returns {hits,qa_id}.
    const none = makeMemory("none");
    await none.openSession("r1");
    await none.writeTrace("r1", { role: "critique", finding: "low contrast text", severity: "high" });
    const noneRec = await none.recallInRun("r1", "contrast");
    log(Array.isArray(noneRec.hits) && noneRec.hits.length === 0 && noneRec.qa_id === null, "none: recallInRun {hits:[],qa_id:null}");
    log((await none.reset("r1")).ok === true, "none: reset ok");
    log((await none.feedback("r1", { qa_id: "x", feedbackText: "f", feedbackScore: 5 })).applied === false, "none: feedback applied=false");
    log((await none.improve(["r1"], 0.5)).improved === false, "none: improve improved=false");
    log(none.stats().traces === 0 && none.stats().lessons === 0, "none: stats all zero");

    // shim
    const m = makeMemory("shim");
    await m.openSession("run-a");
    await m.writeTrace("run-a", { role: "critique", finding: "Text contrast is too low on hero", severity: "high" });
    await m.writeTrace("run-a", { role: "critique", finding: "hero text low contrast hard to read", severity: "high" });
    await m.writeTrace("run-a", { role: "visual", finding: "CTA button needs stronger brand color", severity: "med" });

    // recallInRun NOW returns { hits, qa_id } (C2).
    const rec = await m.recallInRun("run-a", "contrast hero");
    log(Array.isArray(rec.hits) && "qa_id" in rec, "shim: recallInRun returns {hits,qa_id}");
    log(rec.qa_id === null, "shim: recallInRun qa_id null (no bridge)");
    log(rec.hits.length >= 1 && rec.hits[0].snippet.toLowerCase().includes("contrast"), "shim: recallInRun matches contrast");
    log(rec.hits.every((r) => "snippet" in r && "role" in r), "shim: recall hit shape {snippet,role}");

    // VERBATIM: a stored finding comes back byte-identical.
    const verbatim = "Hero CTA must use accent #25F4EE, never a gradient.";
    await m.writeTrace("run-a", { role: "critique", finding: verbatim, severity: "high", nodeSet: ["#25F4EE", "critique"] });
    const vrec = await m.recallInRun("run-a", "#25F4EE", { nodeName: ["#25F4EE"] });
    log(vrec.hits.some((h) => h.snippet === verbatim), "verbatim: stored finding recalled byte-identical");

    const d = await m.distill("run-a");
    log(Array.isArray(d.lessonsAccepted) && d.lessonsAccepted.length >= 1, "shim: distill produced lessons");
    log(d.lessonsAccepted.length <= 2, "shim: distill capped at 2");

    const st = m.stats();
    log(st.traces === 4, `shim: stats.traces==4 (got ${st.traces})`);
    log(st.lessons >= 1, `shim: stats.lessons>=1 (got ${st.lessons})`);

    // distilling again should not blow up.
    const d2 = await m.distill("run-a");
    log(Array.isArray(d2.lessonsAccepted), "shim: second distill returns array");

    // RESET wipes this run's session store (C1).
    await m.reset("run-a");
    const after = await m.recallInRun("run-a", "contrast");
    log(after.hits.length === 0, "shim: reset empties the session store");
    log(m.stats().traces === 0, "shim: reset drops trace count to 0");

    // NO CROSS-RUN CARRY (C1a): a FRESH makeMemory has no lessons/traces from a
    // prior instance. Re-instantiation per run is what guarantees the reset.
    const run1 = makeMemory("shim");
    await run1.writeTrace("sess_run1_memory", { role: "critique", finding: "Never use gradients on the hero; flat color only", severity: "high" });
    await run1.distill("sess_run1_memory");
    log(run1.stats().lessons >= 1, "cross-run: run1 distilled a lesson");
    const run2 = makeMemory("shim"); // simulates per-run re-instantiation
    log(run2.stats().traces === 0 && run2.stats().lessons === 0, "cross-run: run2 fresh instance has zero traces/lessons");
    const run2Recall = await run2.recallInRun("sess_run2_memory", "gradient");
    log(run2Recall.hits.length === 0, "cross-run: run2 turn-0 recall is empty (no carry)");

    // shim feedback/improve are inert no-ops (parallel API).
    log((await run2.feedback("s", { qa_id: null })).applied === false, "shim: feedback no-op applied=false");
    log((await run2.improve(["s"], 0.5)).improved === false, "shim: improve no-op improved=false");

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

    // FILTER GATE: filterLessons only operates on the LESSON path (statements),
    // never on verbatim recall hits — distill output is filtered, recall is not.
    const filtered = filterLessons([
      { statement: "Always use the accent color on the primary CTA button." },
      { statement: "Got it" },                 // degenerate -> dropped
      { statement: "Always use the accent color on the primary CTA button." }, // dup -> dropped
    ]);
    log(filtered.length === 1, "filter: filterLessons dedupes + drops degenerate on the lesson path");

    // BATCH: writeTraces adds many, mirrors shim stats, carries node_set.
    const mb = makeMemory("shim");
    await mb.openSession("run-b");
    const res = await mb.writeTraces("run-b", [
      { role: "critique", finding: "CTA button must use the accent color", severity: "high", nodeSet: ["accent", "critique"] },
      { role: "visual", finding: "increase hero spacing for whitespace balance", severity: "med" },
      { role: "noise", finding: "" }, // blank skipped
    ]);
    log(res.added === 2, `batch: writeTraces added 2 (got ${res.added})`);
    log(mb.stats().traces === 2, "batch: stats reflects batched traces");
    log((await mb.recallInRun("run-b", "accent")).hits.length >= 1, "batch: batched traces are recallable");

    // cognee falls back to shim (no bridge present); shapes match.
    const c = makeMemory("cognee");
    await c.openSession("run-c");
    await c.writeTrace("run-c", { role: "critique", finding: "spacing inconsistent between sections", severity: "low" });
    const crec = await c.recallInRun("run-c", "spacing");
    log(Array.isArray(crec.hits) && crec.hits.length >= 1 && crec.qa_id === null, "cognee: recallInRun falls back to shim {hits,qa_id:null}");
    log(c.stats().traces === 1, "cognee: shim-backed stats works");
    log((await c.reset("run-c")).ok === true, "cognee: reset falls back to shim ok");
    // re-seed after reset for the batch assertion below
    await c.writeTrace("run-c", { role: "critique", finding: "spacing inconsistent between sections", severity: "low" });

    // cognee feedback/improve degrade gracefully with no bridge.
    log((await c.feedback("run-c", { qa_id: null, feedbackText: "f", feedbackScore: 3 })).applied === false, "cognee: feedback applied=false (no bridge)");
    log((await c.improve(["run-c"], 0.5)).improved === false, "cognee: improve improved=false (no bridge)");

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
