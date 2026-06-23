# CONTRACTS.md — FROZEN shared interfaces for TasteLoop v3.1

> **Authority:** This file is the single source of truth for every interface that
> crosses a file boundary. The 10 implementers MUST code to these exact shapes.
> It is reconciled against the **live** `web/src/*`, `web/run.mjs`, `web/app.js`,
> `web/index.html` (read 2026-06-20) and the v3.1 BINDING CORRECTIONS.
>
> **Precedence:** v3.1 BINDING CORRECTIONS (C1–C4, H1–H7, MED/LOW) OVERRIDE any
> conflicting phase text. This file pins what those corrections IMPLY for the
> shared surface. If a phase text and this file disagree, **this file wins** for
> interface shape; the implementer records any needed deviation in
> `crossFileNotes` (do NOT edit a file you don't own).
>
> **Re-anchor rule:** Every `file:line` in this doc was anchored against the live
> file. They may still drift as siblings edit; re-grep before you edit. **Live
> source wins over any line number.**
>
> **Golden invariants this contract enforces** (so the demo is honest):
> 1. In-run, turn-by-turn only. **Reset all stores per run. No cross-run carry.**
> 2. `plan-"turn" == code-"generation"` (the `gen` loop). `GENS >= 4`.
> 3. Verbatim recall on every build-feeding path (`only_context=True` /
>    `SearchType.CHUNKS_LEXICAL`) — Cognee's LLM can never rewrite what reaches a build.
> 4. Two-axis judge is the **immutable anchor**; weights/cap LOCKED below; no post-hoc tuning.
> 5. The ONLY memory-exclusive bundle is `{cognee_recall, cognee_trace}`. Critique +
>    same-turn revise run on BOTH pages.
> 6. `sessionId === "sess_" + runId + "_" + page`.

---

## 0. TERMINOLOGY (locked)

| Term | Meaning | Code symbol |
|---|---|---|
| **run** | one full execution from scratch (empty memory) | `runId` (minted in `run.mjs`) |
| **turn** (plan) | one improvement iteration | `gen` (the `for (let gen…)` loop in `orchestrator.mjs`) |
| **agent.turn** / `TURN_CAP` / turnBudget | the per-page agent activity cap (UI "Turns /20") | `turns`, `TURN_CAP=20` — UNRELATED to `gen` |
| **page** | `"memory"` or `"no-memory"` | `page` |
| **session** | the per-run, per-page Cognee dataset | `sessionId` → `sess_<runId>_<page>` |
| `qa_id` | Cognee interaction id from `recall()`/`get_session()` used by `add_feedback` | threaded `recall → feedback` |

---

## 1. `cognee_bridge.py` — COMMAND SURFACE (Cognee v1)

**Owner:** `web/src/cognee_bridge.py` implementer (Cognee/bridge).
**Invocation:** `python3 cognee_bridge.py <cmd> '<json-args>'`.
**Stdout contract (UNCHANGED, frozen):** EXACTLY one JSON object on real stdout;
all chatter on stderr; on failure print `{"error": "..."}` and exit non-zero
(callers fall back gracefully). Keep the `_REAL_STDOUT` swap + `_emit()`.
**Config:** read from `cognee.env` (`LLM_MODEL=glm-4.7-flash:latest`). The hardcoded
`qwen2.5:7b-instruct` defaults at the live `os.environ.setdefault(...)` block
(currently `:56`) and inside `_ensure_setup()` (currently `cognee.config.set_llm_model("qwen2.5:7b-instruct")`, `:184`)
**MUST** be changed to read the env / set `glm-4.7-flash:latest`. Do NOT hardcode qwen.

### Timeouts (H7)
Wrap **every** command handler at the `_COMMANDS` **dispatch layer** in `_main()`
(around `result = await _COMMANDS[cmd](args)`) with `asyncio.wait_for(..., timeout=T)`
where `T = float(os.environ.get("COGNEE_CMD_TIMEOUT", "120"))`. On timeout: `_emit({"error": "<cmd> timed out"}, code=1)`.
Do NOT wrap individual legacy awaits.

### Commands (name → JSON args → JSON return)

> NOTE: keys are **exact**. Implementers MUST NOT rename. `node_set` = write tag
> (`remember`), `node_name` = read filter (`recall`). Both v1 primitives import on
> the live pin `cognee 1.2.0.dev1`.

#### `reset` — wipe ALL stores for a run (C1, H4)
```
args:   { "sessionId": "sess_<runId>_<page>" }
return: { "ok": true, "reset": ["sess_<...>"], "dataset": "sess_<...>" }
```
- Calls `forget(dataset=_session_dataset(sessionId))` (the run's session dataset).
- **MUST NOT** write to / depend on `LONG_TERM_DATASET="tasteloop_lessons"`. Stop
  writing there entirely (C1c). Optionally also `forget(dataset=LONG_TERM_DATASET)`
  defensively, but never create/populate it.
- `forget()` signature on the pin: `forget(data_id|dataset|dataset_id|everything|memory_only|user)`.
  There is **NO** `scope='session'`. Reset = `forget(dataset=...)`.
- Errors are non-fatal to the caller: emit `{"error": ...}` and the JS side treats reset as best-effort.

#### `remember-trace` — write ONE critique finding into the session (spine step 3)
```
args:   {
          "sessionId": "sess_<runId>_<page>",
          "role":       "critique",            // agent role
          "finding":    "<concrete flaw text>",
          "severity":   "high"|"med"|"low",
          "node_set":   ["<token>", "<role>", "<severity>"]   // write tags
        }
return: { "ok": true, "added": 1, "dataset": "sess_<...>" }
```
- Implemented via `remember(finding, session_id=sessionId, node_set=[...])` (writes to
  the **session cache**, not the permanent graph — correct for reset-per-run).
- A batch variant `remember-traces-batch` MAY exist for the per-trace-cognify cost
  fix; same per-record shape under `"traces":[ {role,finding,severity,node_set} ]`,
  returns `{ "ok": true, "added": N }`. (memory.mjs `writeTraces` maps to it.)
- **Negative exemplars (1.5):** a failed/penalized decision is a normal `remember-trace`
  with `node_set=[token, "failed"]`; no separate command.

#### `recall` — verbatim in-run recall + qa_id (C2, H5; spine step 1)
```
args:   {
          "sessionId": "sess_<runId>_<page>",
          "query":     "<recall query>",
          "node_name": ["<token>", "<role>"]   // OPTIONAL read filter (OR-joined)
        }
return: { "hits": [ { "snippet": "<verbatim stored string>", "role": "memory" } ],
          "qa_id": "<id-or-null>" }
```
- **VERBATIM, non-negotiable (H5):** call
  `recall(query, session_id=sessionId, node_name=[...], only_context=True, query_type=SearchType.CHUNKS_LEXICAL)`.
  `CHUNKS_LEXICAL` (BM25, exact-term — ideal for `#25F4EE`) MUST be pinned explicitly
  (auto_route may not pick lexical). NO `GRAPH_COMPLETION` on this path (no LLM rewrite).
- `qa_id` MUST be returned (from the `recall()` result and/or `get_session(sessionId)`).
  If it cannot be resolved, return `"qa_id": null` (callers handle null — feedback skipped).
- `hits[].snippet` is the **byte-unchanged** stored finding string. Smoke-test:
  store a string, recall it, assert byte-identical.
- The legacy `recall_in_run` name MAY be kept as an alias dispatch key for back-compat,
  but its body MUST become the verbatim path above (no `GRAPH_COMPLETION`).

#### `cmd_feedback` — record the judged delta as feedback (spine step 5; C2)
```
args:   {
          "sessionId":    "sess_<runId>_<page>",
          "qa_id":        "<id>"|null,
          "feedbackText": "<the named flaw>",
          "feedbackScore": 5 | 3 | 1            // improved=5, neutral=3, regressed=1 (1–5 documented)
        }
return: { "ok": true, "applied": true|false }   // applied:false when qa_id is null/unresolved
```
- Resolve `qa_id`: if absent, call `session.get_session(sessionId)` to obtain it.
- Then `session.add_feedback(qa_id, feedback_text=feedbackText, feedback_score=feedbackScore)`.
- Smoke-test a real `qa_id` is obtainable BEFORE wiring this (C2).
- The install does NOT validate `feedback_score`; we standardize on **1–5**.

#### `cmd_improve` — reweight the session by feedback (spine step 6)
```
args:   {
          "sessionIds":    ["sess_<runId>_<page>"],
          "feedbackAlpha":  <number > 0>          // e.g. 0.5
        }
return: { "ok": true, "improved": true }
```
- Call `improve(session_ids=sessionIds, feedback_alpha=feedbackAlpha)` — `feedback_alpha`
  rides in `**kwargs` (do NOT introspect it as a named param).
- `improve` has **NO** `llm_config` (global `LLM_MODEL` only) — this is the only op
  allowed to run `GRAPH_COMPLETION`-class work (it is NOT build-feeding).
- With `session_ids` it persists session Q&A into the graph + applies feedback weights
  so the NEXT turn's `recall` ranks proven fixes higher.

#### `cmd_ingest_brand` — typed brand tokens → graph (Phase 3)
```
args:   {
          "sessionId":  "sess_<runId>_<page>",     // OR a brand-scoped dataset name
          "tokens":     { ...brand.tokens... },    // the LOADED tokens.json object (NOT emitted by brand.mjs)
          "dont":       ["Do not use gradients", ...]
        }
return: { "ok": true, "ingested": <int>, "nodes": ["#25F4EE", "no-gradient", "hero", ...] }
```
- Emits typed `DataPoint`s (Color/Font/Spacing/Rule) via `remember()` with a brand
  ontology so tokens become canonical nodes (`#25F4EE`, `no-gradient`, `hero`).
- Reads tokens from args (brand.mjs `deconstructBrand` LOADS tokens.json; the bridge
  does NOT re-load the PDF). Smoke-tested in isolation.
- Lessons/traces later anchor onto these token nodes via `node_set=[token]`.

### REMOVED / FORBIDDEN
- **No** writes to `LONG_TERM_DATASET` anywhere (C1c). The `cmd_distill` long-term
  publish loop (live `:300-305`, `:329-333`) MUST be deleted.
- **No** `cmd_recall_lessons` cross-run read path (C1d). Remove the command and its
  `_COMMANDS` entry; `recallLessons` on the JS side becomes a no-op/empty (see §2).
- **No** `SearchType.FEEDBACK`, no `used_graph_element_to_answer` (blog naming — don't exist).
- `cmd_distill` MAY remain **session-scoped only** (writes nothing durable); it feeds the
  Lessons counter via `distill_session` on `glm-4.7-flash`. If GLM yields 0 valid
  `WrittenLesson`s the counter degrades gracefully (Traces-only) — never silently show Lessons=0 as success.

---

## 2. `memory.mjs` — JS API (mirrors the bridge)

**Owner:** `web/src/memory.mjs` implementer.
**Factory (frozen):** `export function makeMemory(kind)`, `kind ∈ {"none","shim","cognee"}`.
**Per-run re-instantiation (C1a):** the orchestrator/run layer calls `makeMemory(kind)`
**fresh for every run** so the shim closure (`lessons[]`, `sessions` Map) is wiped.
`memory.mjs` MUST NOT hold module-level mutable run state.

### The object every backend returns (frozen method set)
```js
{
  async reset(sessionId) -> { ok:boolean },                        // NEW (C1). bridge `reset`.
  async openSession(sessionId) -> { id } | null,
  async writeTrace(sessionId, {role, finding, severity, nodeSet?}) -> void,
  async writeTraces(sessionId, [{role, finding, severity, nodeSet?}]) -> { added:number },  // batched
  // VERBATIM recall. Returns hits + the qa_id for this interaction (C2).
  async recallInRun(sessionId, query, { nodeName? } = {}) -> { hits:[{snippet, role}], qa_id:(string|null) },
  async feedback(sessionId, { qa_id, feedbackText, feedbackScore }) -> { applied:boolean },  // NEW. bridge cmd_feedback.
  async improve(sessionIds, feedbackAlpha) -> { improved:boolean },                          // NEW. bridge cmd_improve.
  async ingestBrand(sessionId, { tokens, dont }) -> { ingested:number, nodes:string[] },     // NEW. bridge cmd_ingest_brand.
  async distill(sessionId) -> { lessonsAccepted:[{statement}] },   // session-only; quality-filtered
  stats() -> { traces:number, lessons:number },
}
```

### BINDING change to the current shape
- **`recallInRun` return shape CHANGES** from the live `[{snippet, role}]` (array) to
  `{ hits:[{snippet, role}], qa_id }` (object) to thread `qa_id` (C2). Every caller
  (`orchestrator.mjs`, `skills.mjs runRecall`) MUST read `.hits`. Re-anchor the live
  call sites: `orchestrator.mjs` (`memory.recallInRun(...)` at `:585`, `:756`),
  `skills.mjs runRecall` (`memory.recallInRun(\`${page}-run\`, q)` at `:311`).
- **`recallLessons` is REMOVED** (C1d, no cross-run). Delete the method and all calls:
  `orchestrator.mjs:485` (`memory.recallLessons(...)`), `skills.mjs:310` (`memory.recallLessons(q)`).
  In-run signal comes only from `recallInRun`. (If a no-op stub is kept temporarily for
  compile-safety it MUST return `{hits:[], qa_id:null}`-free empties and be unused.)
- `kind:"none"` returns empty/no-op for ALL methods (counters stay 0); `recallInRun` →
  `{ hits:[], qa_id:null }`.
- `kind:"cognee"` mirrors writes into the in-process shim for `stats()`/recall fallback;
  on ANY bridge error it returns the shim result. It **never throws**.
- `sessionId` passed to every method is the literal `sess_<runId>_<page>` (§8). The shim
  keys its `sessions` Map by that string. **Do NOT** reconstruct `${page}-run` internally
  (H4) — the live `runTrace`/`runRecall` hardcodes (`${page}-run`) MUST be replaced with
  the threaded `sessionId`.

---

## 3. `codexCritique` — all-LLM vision critique (Phase A.2)

**Owner:** `web/src/codex.mjs` implementer (new export, mirrors `codexJudge` at live `:595`).
```js
export async function codexCritique({ brand, screenshotPath, goal })
  -> Array<{ flaw:string, brandRuleCited:string, severity:"high"|"med"|"low" }>
```
- **Renders its OWN pre-revise PNG via `renderShot`** (frozen sig:
  `renderShot(html, outPng, { width=1280 }={}) -> outPng`, `render.mjs:133`). The caller
  passes `screenshotPath` already rendered, OR `codexCritique` renders from a passed
  `html` — **CONTRACT: caller renders, passes `screenshotPath`** (orchestrator owns the
  render so the same shot can be reused). If `screenshotPath` is empty it MUST render.
- One Codex vision call (attach via `codex exec -i <FILE>`); temperature 0 / structured output.
- `brandRuleCited` is an **enum drawn from `brand.dont[]`** (the live brand DON'Ts). If no
  specific rule applies, use the closest `brand.dont` entry verbatim; do NOT invent rules.
- `severity` is the structured field — this is the ONLY severity source (kills the
  severity regex at `skills.mjs:912`, `orchestrator.mjs:726`).
- Findings feed BOTH: (a) the trace set (replacing `brandRuleViolations` at
  `orchestrator.mjs:688`) and (b) the build brief `mustFix[]` (§6) so same-turn findings
  reach same-turn builds.
- **NO regex** anywhere in this path. THROWS on Codex failure (no silent fallback), but
  the orchestrator catches so a critique miss != a dead run.
- Runs on **BOTH** pages every turn (C4).

---

## 4. Two-axis JUDGE — the immutable anchor (Phase A.3)

**Owner:** `web/src/judge.mjs` implementer.
```js
export async function judgeSite({ brand, html, goal })
  -> {
       quality:number,         // 0-100, design quality (LLM vision)
       brandAdherence:number,  // 0-100, brand fit (LLM vision)
       reasoning:string,
       findings:string[],
       score:number,           // the LOCKED blend (below)
       category:string,        // categoryFor(score)
       shot:string             // PNG path (unchanged from live)
     }
```

### LOCKED blend (Invariant 5 — commit BEFORE the first scored run; NO post-hoc tuning)
```
score = round( 0.6 * quality + 0.4 * brandAdherence )
if (brandAdherence < 50)  score = min(score, 69)      // hard cap
score = clamp(score, 0, 100)
```
- Single LLM-vision call (Codex gpt-5.4, vision via `-i` on the `renderShot` PNG)
  returning `{quality, brandAdherence, reasoning, findings}`. The blend is computed
  in JS, deterministically.
- **REMOVED:** the `brandRuleViolations` import (`judge.mjs:47`) and the
  `-PENALTY_PER`/violation penalty (`judge.mjs:181-186`) and `violations` from the return.
  `codexJudge`'s legacy `{score, category, reasoning}` return is superseded — the judge
  now asks Codex for the two axes directly (rewrite the `codexJudge` prompt/return OR add
  a `codexJudgeTwoAxis`; either way `judgeSite` returns the shape above).
- **Calibration:** port evo few-shot worked vision examples, **brand-generic** (NOT
  enumerating the specific flaws memory fixes), so the anchor can't be gamed toward the win.
- Identical for both pages. Never `_ablate`-gated. Never touched by any other change.
- The doc-header at `judge.mjs:1-40` (regex/penalty narrative) is **editable** — rewrite
  it to describe the two-axis design. Update the smoke-test (`judge.mjs:209-262`) assertions
  to the new blend/cap (no penalty math).

---

## 5. EVENT PAYLOADS (the stream contract; consumed by `app.js` + `run.mjs`)

**Owner of emission:** `orchestrator.mjs` + `skills.mjs` (emitters). **Owner of consumption:**
`app.js`. `run.mjs makeEmitter` wraps every event with `{ t, page, gen, ...ev }` — emitters
MUST NOT set `t`/`page`/`gen` themselves (the harness adds them). Every event has a `type`.

> Implementers adding fields: ADD, never rename/remove existing keys other modules read.
> `app.js applyEvent` (live `:405-511`) is the consumer switch — keep it working.

### `trace.written` (memory page only)
```
{ type:"trace.written", agentId:string, summary:string }
```
(`summary` = the finding text. app.js increments Traces. KEEP this shape.)

### `trace.resolved` (NEW, Phase A.4 — memory page only)
```
{ type:"trace.resolved",
  flaw:string, brandRuleCited:string,
  beforeShot:string,   // PNG path/ref
  afterShot:string,    // PNG path/ref
  agentId:string,
  resolved:boolean }   // present-in-before AND absent-in-after (2nd vision call)
```
Emitted after `reviseHtml` (~`orchestrator.mjs:799`). UI shows before/after side-by-side.

### `score.updated` (CHANGED — H2; per-gen, NOT bestScore)
```
{ type:"score.updated",
  gen:number, page:string,           // page/gen also injected by run.mjs; emit gen explicitly for the chart x-axis
  quality:number, brandAdherence:number,
  score:number }                     // THIS GEN's judged score (per-gen), NOT bestScore
```
- **BINDING:** the live emit `gatedEmit({ type:"score.updated", score:bestScore })`
  (`orchestrator.mjs:842`) MUST change to emit the **per-gen** `score` (the value from this
  gen's `judgeSite`), plus `quality`, `brandAdherence`, and `gen`. `bestScore` is used ONLY
  for the `run.finished.totals.score` headline (and `app.js` score divergence display).
- `app.js` chart (Phase 4.1) plots `x=gen`, `y=score` per page. The current
  `case "score.updated"` sets `st.score = ev.score` — it MUST switch to feeding the chart
  the per-gen point (headline number comes from `run.finished.totals.score`). Implementer
  of app.js owns reconciling the headline vs the chart.

### `critique.made`
```
{ type:"critique.made", findings:string[] }
```
(Unchanged; emitted on BOTH pages now since critique runs on both — C4.)

### `agent.spawned` (EXTENDED — grant-provenance + credit; Phase 4.2 / 2.4)
```
{ type:"agent.spawned",
  agentId:string, role:string, version:number,
  prompt:string,            // instructions.slice(0,200) — LIVE shape, keep
  skills:string[],          // == agent.tools — LIVE shape, keep
  // NEW (additive, optional — app.js must tolerate absence):
  grantProvenance?: [ { skill:string, fromLesson:string } ],   // why each memory-driven tool was granted
  credit?: { flaw:string, attributedTo:string }                // 2.4 credit assignment for this agent
}
```
(app.js `getOrCreateAgent` reads `prompt` + `skills`; new fields are optional.)

### `improvement` (page-symmetric definition — MED/LOW)
The existing `member.upskilled` event (rich prompt-diff panel, `app.js:437-451`) is KEPT.
"Improvements" is defined **page-symmetrically**: a turn where **this page's** score rose
vs **its own** prior turn. The `improvements` counter (`run.finished.totals.improvements`)
MUST be computed that way for BOTH pages (memory will rise, no-memory generally won't).
`member.upskilled` rich shape (UNCHANGED, keep for app.js):
```
{ type:"member.upskilled", role, version, lessonId, lessonText,
  instructionDiff:{ before, after }, scoreBefore, scoreAfter }
```

### Other live events kept verbatim (do not break app.js)
`run.started`, `run.finished{ totals:{agentsSpawned,turns,traces,improvements,lessons,score} }`,
`master.planned{ roster:string[], strategy }`, `agent.status{ agentId, doing, draft? }`,
`agent.turn{ agentId }` (gated by `TURN_CAP`), `design.rendered{ htmlRef, draft? }`,
`memory.recalled{ agentId, hits:[{snippet}] }`, `memory.distilled{ lessonsAccepted }`,
`team.judged{ ... }` (now carries `quality`/`brandAdherence` too).

---

## 6. `ctx` SHAPE — the threaded run context

**Owner:** `orchestrator.mjs` constructs it; `skills.mjs`/`team.mjs` read it. Frozen keys:

```js
ctx = {
  // ---- typed BUILD BRIEF (Phase 2.3 — NO dropped agent output) ----
  brief: {
    copy:            string|{hero,angle},   // from copywriter
    sectionOrder:    string[],              // from info-architect
    layoutDirection: string,                // from visual-designer
    typeScale:       string,                // from typographer
    imageDirective:  string,                // from image-sourcer / image_gen
    mustFix:         string[],              // critique findings (this turn) -> the builder
  },
  // ---- memory / lessons ----
  lessons:     [{statement}]|null,   // recalled in-run traces-as-rules (memory, non-ablate). live :550
  lessonForBuild: string|null,       // the one enforceable rule (kept; live :497)
  lesson:      string|null,          // mirror of lessonForBuild (skills.runHtmlBuild fallback; live :555)
  rules:       string[],             // RAW recalled trace snippets -> builder verbatim (live :562)
  // ---- image ----
  heroImage:   string|undefined,     // data URI; builder embeds (live :245,:675; skills :626)
  // ---- artifacts ----
  copyHint:    string,
  sections:    string[]|null,
  findings:    string[],
  html:        string,
  htmlRef:     string,
  seq:         number,
  // ---- control flags ----
  _ablate:     boolean,              // ablation: recall runs but lessons stripped (live :569)
  qa_id:       string|null,          // NEW (C2): from recallInRun, threaded to feedback
}
```

- **`brief` is NEW (2.3).** Until 2.3 lands, the legacy `copyHint`/`sections`/`rules`/
  `findings` keys remain the threading channel; `brief` is layered additively so the
  builder can consume the whole brief and any role whose slot the builder can't consume
  is cut or wired. **No implementer may remove a legacy key other modules still read.**
- **`mustFix[]`** carries THIS turn's `codexCritique` findings into THIS turn's build (1.7).
- **`_ablate` semantics (C3):** under ablation, recall STILL runs and emits hits, but
  `lessons`/`rules`/`mustFix-from-prior-turns` are dropped (ablate revise uses EMPTY
  recalled rules — see §9). `threadResult` honors `_ablate` (live `:353,:365`).
- **`qa_id`** is set from the memory-page recall and read by the feedback step. `null` on
  the no-memory page and whenever recall couldn't resolve one.

---

## 7. `SKILL_REGISTRY` — entry shape + the skill list (Phase A.1)

**Owner:** `web/src/skills.mjs` implementer (replaces the `has()` if/else ladder at live
`:213-302` and `statusFor` at `:284-302`).

### Entry shape
```js
SKILL_REGISTRY = {
  "<name>": {
    name:   "<name>",
    params: { /* documented arg shape the run() consumes from {agent,ctx,deps,...} */ },
    run:    async ({ agent, agentId, gen, page, ctx, deps, emit, result }) => result,
    status: ({ role, ctx }) => "<status line>",   // generates the agent.status doing-line
  },
}
```
- **Generic dispatch:** `runAgent` iterates the agent's granted tools and invokes
  `SKILL_REGISTRY[name].run(...)`, merging returns into `result` — no priority if/else.
- **`SKILL_PALETTE` prompt text is GENERATED from this registry** (no chip can be theater).
- **Call-time allow-listing (structural A/B enforcement):** before running a skill, assert
  it is in the agent's granted set; for `name ∈ {cognee_recall, cognee_trace}` assert
  `page === "memory"` else THROW. This makes the independent variable structurally enforced.

### The skill list (frozen names — exact strings in `agent.tools` / `skills`)
```
html_build, svg_image, image_gen, a11y_check, contrast_check, copy_lint,
copywriter, info_architect, typographer, critique,
cognee_recall, cognee_trace
```
- **`critique` is an ALWAYS-RUN registry entry on BOTH pages** (fixes the else-if
  critique-kill at live `skills.mjs:239/251-257`). It is a neutral quality capability, NOT
  memory-only (C4). Implemented by `codexCritique` (§3).
- **Memory-only bundle = `{cognee_recall, cognee_trace}` ONLY** (Invariant 4). Every other
  skill is symmetric (available to BOTH pages).
- **`brand_tokens` is DELETED** (theater, 5 grant sites: `team.mjs:62,109,422-423,476`).
  It is NOT in the registry and NOT in `SKILL_PALETTE`. Phase 0.4 removes all 5 sites
  before the parity assertion. (Brand grounding flows via the build channel, not a tool.)
- `image_gen, a11y_check, contrast_check, copy_lint` are neutral capabilities on BOTH
  pages (Invariant 4 / Phase 2.1).

---

## 8. `sessionId` CONVENTION (H4 — frozen)

```
sessionId === "sess_" + runId + "_" + page
```
- `runId` is minted in **`run.mjs`** (replace the literal `runId:"demo"` written to
  events.json at `run.mjs:37` and `:63`, and pass a real runId into both `runPage` calls
  at `:74-75`). Suggested: `run_${Date.now()}_${rand}`.
- Threaded into `runPage` params (add `runId` to the destructure at `orchestrator.mjs:429`);
  `runPage` builds `sessionId = \`sess_${runId}_${page}\`` (replaces `const sessionId = \`${page}-run\`` at live `:434`).
- **Every** session-keyed call uses this `sessionId`: replace the two hardcoded `${page}-run`
  strings at `skills.mjs:311` (`runRecall`) and `skills.mjs:903` (`runTrace`) — thread the
  `sessionId` down via `ctx.sessionId` or a `runAgent` param (the orchestrator owns wiring it
  in; `skills.mjs` reads it, does NOT reconstruct it).
- **Accept (H4):** a trace written in run N is unrecoverable after run N+1's `reset` (the
  dataset name differs because `runId` differs). Run twice in one process → turn-0 recall on
  run 2 returns empty (C1 accept).
- `cognee_bridge._session_dataset(sessionId)` already sanitizes to `sess_<safe>`; passing
  `sess_<runId>_<page>` yields a unique per-run dataset.

---

## 9. TURN-LOOP ORDER (the spine — per `gen`, both pages; GENS >= 4)

> One ordering for BOTH pages. `[mem]` = memory-page-only step. `[BOTH]` = runs on both.
> No-Memory gets none of: cross-turn RECALL, TRACE-write, FEEDBACK, IMPROVE, cross-turn-
> recalled revise — **but it DOES get critique + its own same-turn revise** (C3, C4).

```
PRE-RUN (once per run, BOTH pages):
  reset[mem-store]   makeMemory(kind) re-instantiated; memory.reset(sessionId) -> forget(dataset=sess_<runId>_<page>)

PER gen (0..GENS-1):
  1. recall[mem]        memory.recallInRun(sessionId, q, {nodeName})  // verbatim; sets ctx.qa_id, ctx.rules/lessons (cross-turn)
                        // (gen 0 returns empty; no-memory SKIPS this step)
  2. build[BOTH]        master plans roster -> runAgent(...) -> ctx.html
                        // memory build is conditioned on recalled prior-turn rules + mustFix; no-memory on mustFix(this-turn) only
  3. critique[BOTH]     codexCritique({brand, screenshotPath, goal}) -> findings  // renders pre-revise PNG; findings -> ctx.brief.mustFix
  4. trace[mem]         remember-trace each finding (node_set=[token,role,severity]); emit trace.written
  5. revise[BOTH]       reviseHtml(... rules ...) on THIS page's findings, re-render
                          - no-memory: rules = THIS turn's own critique findings (same-turn revise)
                          - memory:    rules = THIS turn's findings + recalled PRIOR-turn traces
                          - ABLATE:    revise STILL runs but with EMPTY recalled rules (only same-turn findings)
                        emit trace.resolved {flaw, beforeShot, afterShot, resolved}   // memory page
  6. judge[BOTH]        judgeSite({brand, html, goal}) -> {quality, brandAdherence, score, ...}
                        emit score.updated { gen, page, quality, brandAdherence, score }   // PER-GEN score
  7. feedback[mem]      map delta->1|3|5 ; memory.feedback(sessionId, {qa_id, feedbackText:flaw, feedbackScore})
  8. improve[mem]       memory.improve([sessionId], feedbackAlpha>0)   // next turn's recall ranks proven fixes higher
  9. distill[mem]       memory.distill(sessionId)  // session-only Lessons counter (graceful if GLM yields 0)
```

- **Symmetry guarantee (C3):** the ONLY memory delta in the revise is that memory's revise
  ALSO incorporates recalled prior-turn traces. Both pages get critique + a same-turn revise
  from their own findings, so the win is NOT "two attempts."
- **`GENS >= 4`** (H3): raise the default in `run.mjs` (live `const GENS = ... || "2"` at
  `:21`) so the chart shows a trend. `run.mjs` owner makes the change.
- Build-feeding recall (step 1, and any recall inside step 5's memory path) is **verbatim**
  (H5). Only `improve` (step 8) does graph-completion-class work.
- Steps 7–8 are what make this self-improvement (not logging): the archive promotes only
  verified wins, so next turn's recall is feedback-weighted.

---

## FILE OWNERSHIP MAP (disjoint owners)

| # | File (owner edits ONLY this) | Owns | Key contracts | NOTES |
|---|---|---|---|---|
| 1 | `web/src/cognee_bridge.py` | bridge v1 commands | §1 | reads `cognee.env`; emits single-JSON; timeouts at dispatch |
| 2 | `web/src/memory.mjs` | JS memory API | §2 | per-run re-instantiation; `recallInRun` returns `{hits,qa_id}`; remove `recallLessons` |
| 3 | `web/src/codex.mjs` | Codex actors | §3 (codexCritique), §4 (judge half) | add `codexCritique`; two-axis judge prompt; neutralize gradient hard-fail (`:474-479`) + revise default `rulesBlock` (`:407-409`) |
| 4 | `web/src/judge.mjs` | the immutable judge | §4 | two-axis blend+cap LOCKED; drop `brandRuleViolations` import (`:47`) + penalty (`:181-186`) |
| 5 | `web/src/skills.mjs` | SKILL_REGISTRY + executor | §7, §3-consumer | replace if/else ladder; `critique` always-run; thread `sessionId`; drop `brand_tokens` usage; remove `recallLessons` calls; remove severity regex (`:912`) |
| 6 | `web/src/team.mjs` | the master | §7 (palette), §6 (lessons in prompt) | delete `brand_tokens` (5 sites), `LESSON_SKILL_RULES` ladder (`:271-313`); rewrite "prior runs" -> "earlier turns in this run" (`:107,:130,:137,:164`); memory-aware master |
| 7 | `web/src/orchestrator.mjs` | the conductor + turn-loop | §5 (emit), §6 (ctx), §8, §9 | mint-thread `runId`/`sessionId`; per-gen `score.updated`; symmetric revise; `mustFix`; remove prompt-diff regex (`:85-164`), keyword recall (`:483`), severity regex (`:726`), `brandRuleViolations` trace src (`:688`) |
| 8 | `web/run.mjs` | run entry + event stream | §8 (runId mint), §9 (GENS) | real `runId` (not "demo", `:37,:63`); `GENS>=4` (`:21`); pass `runId` into both `runPage` (`:74-75`) |
| 9 | `web/app.js` | UI replay engine | §5 (consume) | per-gen score chart; per-agent recall-hits/traces cols; grant-provenance/credit; before/after panel; tolerate new optional fields |
| 10 | `web/index.html` | UI DOM | §4/§5 (DOM hooks) | add quality/brandAdherence sub-scores near `.js-score` (`:313-316`); chart container; per-agent columns; before/after panel; graph-viz mount |
| — | `web/src/brand.mjs` | brand load (Phase 3 emits typed tokens) | §1 (`cmd_ingest_brand` consumer) | `deconstructBrand` LOADS tokens.json; Phase 3 routes typed DataPoints via bridge `cmd_ingest_brand`; legacy public shape preserved |
| — | `web/src/image.mjs` | keyless image gen (Phase 2.5) | `generateImage({prompt,brand,name}) -> {path,dataUri}` | frozen sig; pure-JS SVG fallback when no `OPENAI_API_KEY` |
| — | `web/src/render.mjs` | HTML->PNG | `renderShot(html, outPng, {width}={}) -> outPng` | FROZEN; used by judge + codexCritique |
| — | `web/src/ollama.mjs` | `chat`/`chatJSON` | frozen | used by team master + lang tools |

### Genuinely SHARED interfaces needing a single source-of-truth (no two owners)
- **Event payload schemas (§5):** EMITTED by `orchestrator.mjs` (+ a few in `skills.mjs`),
  CONSUMED by `app.js`. **Single owner of the schema = this CONTRACTS.md.** Emitters and
  consumer both code to §5; neither redefines a field. Cross-edits go in `crossFileNotes`.
- **`ctx` shape (§6):** CONSTRUCTED by `orchestrator.mjs`, READ by `skills.mjs`/`team.mjs`.
  Constructor (orchestrator) is the de-facto owner; readers code to §6 and never mutate a
  key another reader depends on without recording it.
- **`sessionId` string (§8):** MINTED by `run.mjs`/`orchestrator.mjs`, USED by
  `memory.mjs`/`skills.mjs`/`cognee_bridge.py`. The format is frozen here; producers and
  consumers MUST NOT reconstruct a variant (kills the `${page}-run` hardcodes).
- **`SKILL_PALETTE` / skill names (§7):** the registry in `skills.mjs` is the source; the
  master (`team.mjs`) GENERATES its allowed-tools prompt from the SAME list. `team.mjs`
  imports/derives — it does not maintain a parallel literal palette (the live `SKILL_PALETTE`
  at `team.mjs:57-69` MUST be sourced from / kept identical to the registry; `brand_tokens`
  dropped from both).
- **`brandRuleViolations` (live `skills.mjs:952`):** currently imported by BOTH
  `orchestrator.mjs:37` and `judge.mjs:47`. Under v3.1 (no-regex, two-axis) it is REMOVED
  from the scoring/trace paths. The `skills.mjs` owner removes the export's consumers in
  coordination; `judge.mjs` + `orchestrator.mjs` owners drop their imports. If a transitional
  keep is needed, it stays UNUSED — never on a learnable/scoring path (Guardrail 5).

### Smoke-test ownership (each owner adds the plan-specified test in their file)
- `cognee_bridge.py`: per-command isolation tests (reset empties; recall byte-verbatim;
  real `qa_id` before feedback; `cmd_ingest_brand` returns nodes; GLM emits >=1 `WrittenLesson`).
- `memory.mjs`: per-run reset wipes shim; `recallInRun` returns `{hits,qa_id}`; `kind:"none"` empty.
- `codex.mjs`: `codexCritique` returns `[{flaw,brandRuleCited,severity}]` (stubbed Codex).
- `judge.mjs`: blend `0.6q+0.4b`, `brandAdherence<50 => cap 69`, clamp, category-from-final.
- `skills.mjs`: registry dispatch; allow-list throws on `cognee_*` for `page!=="memory"`;
  critique runs on both pages.
- `orchestrator.mjs`: per-gen `score.updated`; symmetric revise (both pages revise; ablate uses empty rules); run-twice-in-process turn-0 recall empty.
- `team.mjs`: no `brand_tokens`; memory tools only on memory roster; "earlier turns in this run" wording.
- `run.mjs`: mints non-"demo" runId; `GENS>=4`.
