# TasteLoop — Implementation Plan v3.1 (execution-ready)

> Supersedes v1/v2. Built from: three code+research audits, a 6-agent plan review (caught real contradictions in v2), an evo-repo mining pass, a GitHub self-evolving survey, and a Cognee specialist verified against the **live install** (`cognee 1.2.0.dev1` at `/tmp/cognee_smoke/venv`). Every file:line below is verified. Maintainer decisions are LOCKED (see "Invariants").

## ⚠️ v3.1 BINDING CORRECTIONS — verified against the live install; these OVERRIDE any conflicting phase text below
> A 3-agent verification (incl. live `cognee 1.2.0.dev1` introspection) found v3 NOT execution-ready. All 8 Cognee API claims (below) are CONFIRMED. These corrections are mandatory. **Executors: re-anchor every `file:line` against the live `web/src/` before editing — citations below may be off by 1–40 lines; the live source wins.** Source is `web/src/`, NOT `web-backup/`.

**CRITICAL**
- **C1 — Reset ALL FOUR memory stores per run (not one).** Phase 1.4 must wipe: (a) the shim `lessons[]` closure (re-instantiate `makeMemory` per run); (b) `forget(dataset=sess_<runId>)`; (c) the durable `LONG_TERM_DATASET="tasteloop_lessons"` — **stop writing to it entirely** (reset-per-run has no durable lessons store; distill writes session-only); (d) disable the `recall_lessons` cross-run read path (no "legacy fallback"). *Accept: run twice in one process → turn-0 recall on run 2 returns empty.*
- **C2 — Define the `qa_id` contract end-to-end** (the self-improvement spine is unbuildable without it). `cmd_recall_in_run` must return `{hits, qa_id}` (from `recall()`/`get_session()`); thread `qa_id` through `memory.mjs` → `cmd_feedback`. *Smoke-test a real qa_id returns BEFORE wiring `add_feedback`.*
- **C3 — Make the revise pass symmetric (fairness).** Today only the memory page revises (`orchestrator.mjs:707 if(isMemory)`, `:753`), and ablation skips it → the win is attributable to "two attempts," not memory. Fix: **both pages run critique→revise on their own same-turn findings; the ONLY memory delta is that memory's revise also incorporates recalled prior-turn traces.** (Or: ABLATE still runs revise with EMPTY recalled rules.) Reconcile spine steps accordingly.
- **C4 — `CRITIQUE runs on BOTH pages every turn** (it's a neutral quality capability, not a memory tool). Only TRACE-write, cross-turn RECALL, FEEDBACK, IMPROVE, and the recalled-trace revise are memory-only. Rewrite spine "No-Memory gets none of 1/3/5/6" → "none of: RECALL, TRACE-write, FEEDBACK, IMPROVE, cross-turn-recalled revise — but it DOES get critique + its own same-turn revise."

**HIGH**
- **H1 — Scrub all "prior runs" cross-run framing** from the master prompt (`team.mjs:107,130,137,164` + weave tails) → "recalled from **EARLIER TURNS IN THIS RUN**." Add to Phase 2.2 as explicit edit targets.
- **H2 — Chart signal:** emit the **per-gen judged score** on `score.updated` (`orchestrator.mjs` `score`/`lastGenScore`), **NOT** `bestScore` (a monotonic max → "rising vs flat" is impossible). Keep `bestScore` only for the headline number. x = gen index, y = that gen's score.
- **H3 — Terminology + run length:** plan-**"turn" == code-"generation"** (the gen loop), distinct from `agent.turn`/`TURN_CAP`/`turnBudget`. Raise **`GENS` ≥ 4** (`run.mjs`) so the chart has a trend.
- **H4 — `runId` plumbing (1.4):** add `runId` to `runPage` params (`orchestrator.mjs` ~`:429`), pass from `run.mjs`; `sessionId = sess_${runId}_${page}`; **replace the two more hardcoded `${page}-run` at `skills.mjs:311 (runRecall)` + `:903 (runTrace)`.** *Accept: a trace from run N is unrecoverable after run N+1's reset.*
- **H5 — Verbatim recall invariant (resolves the model-split contradiction):** **ALL build-feeding recall MUST use `only_context=True` / `query_type=SearchType.CHUNKS_LEXICAL`** (no LLM synthesis) so the bigger global Cognee model provably can't rewrite what reaches the build. Convert every `GRAPH_COMPLETION` recall on a build-feeding path (`cmd_recall_in_run`, `recall_lessons`, distill fallback summary); leave `GRAPH_COMPLETION` only on distill/improve. *Smoke-test: recall returns stored strings byte-unchanged.* (Tighten wording: only **`improve`** has no `llm_config`; `recall/remember` do — but we don't use it on build-feeding recall.)
- **H6 — Drop "EVOLVE-BLOCK" (vaporware — zero grep hits).** The real symmetric brand channel is plain string interpolation (`skills.mjs` dsContract, `codex.mjs` `summarizeTokens`). Guardrail becomes: brand rules inject via the same `codexBuildSite` brand/dsContract/donts channel on both pages, with a **test asserting the injected brand block is byte-identical** memory vs no-memory for the same brand+goal.
- **H7 — Phase 0.3 timeouts** go at the `_COMMANDS` dispatch layer of `cognee_bridge.py` (survives the v1 rewrite), NOT around specific legacy awaits Phase 1.1 deletes.

**MED/LOW (fix while editing):** gradient hard-fail is at **`codex.mjs:474-479`** (not :470-471); also neutralize the revise-mode default anti-gradient `rulesBlock` (`codex.mjs:407-409`) — memory-only static enforcement. `brandRuleViolations` import is at **`judge.mjs:37`**; rewrite the stale penalty doc-header (`judge.mjs:14-40`) + smoke-test assertions. `ctx._ablate` is at **`orchestrator.mjs:569`**, `ctx.lessons` at `:353-365`. `brand_tokens` has **5 grant sites** (`team.mjs:62,109,422-423,476`) — A.1's registry must exclude it and 0.4 deletes all 5 before the parity assertion. **LOCK judge weights/cap/calibration as part of Invariant 5 BEFORE the first scored run** (commit, no post-hoc tuning; calibration examples brand-generic, not enumerating the specific flaws memory fixes). Define **Improvements page-symmetrically** ("turns where this page's score rose vs its own prior turn"). `deconstructBrand` LOADS tokens.json (doesn't emit it); `cmd_ingest_brand` reads loaded tokens. Drop "few-shot exemplars" from the `codex.mjs:438` citation (it's numbered fix-rules) unless adding the block.

**Cognee wording nits:** pin `query_type=SearchType.CHUNKS_LEXICAL` explicitly on verbatim recall (default `auto_route` may not pick lexical); `feedback_alpha` rides in `**kwargs` (don't introspect named params).

## North star — what we are actually building
**In-run, turn-by-turn self-improvement.** A **run** starts from scratch (empty memory). A **turn** improves what we already have. The Cognee page accumulates session memory **across turns within the run** and measurably rises turn-over-turn; the **No-Memory** page carries nothing between turns and stays flat. There is **no cross-run learning** — every run resets. The win is *honest and falsifiable*: same fixed judge, same tools, same brand; the only difference is access to in-run session memory.

## The self-improvement loop (the spine) — per turn, on Cognee v1, session-scoped
Cognee primitives in **bold**; the cross-system pattern each step embodies in *italics*.

0. **PRE-RUN reset (both pages):** `forget(dataset=sess_<runId>)` — wipe the run's session dataset. (No durable cross-run store; the session *is* the memory.)
1. **RECALL (memory page only)** before each turn's build: `recall(query, session_id=sid, node_name=[token/role], only_context=True)` — `session_id` logs the interaction (creates a `qa_id` for feedback); `node_name` scopes to the relevant token; `only_context`/`SearchType.CHUNKS_LEXICAL` returns **verbatim** hex/rules (no qwen re-LLM). *Memory-conditioned generation; recall-best-as-few-shot.*
2. **BUILD** conditioned on recalled lessons woven as **numbered fix-rules + few-shot exemplars** (`codex.mjs:438`). *DSPy bootstrap-demos.*
3. **CRITIQUE → TRACE (anchored):** vision-LLM auditor (`codexCritique`) emits findings → `remember(finding, session_id=sid, node_set=[token, role, severity])` — one tagged enrichment per finding. *Agent-as-a-Judge inspects intermediate artifacts.*
4. **REVISE + MEASURE:** apply fix-rules, re-render, **judge** (Codex gpt-5.4 HIGH vision — the *fixed, immutable utility anchor*). Before→after score delta on the **named flaw** is ground truth. *Self-Refine + Reflexion (evaluator separate from reflector).*
5. **FEEDBACK (the missing core):** map delta→score (improved=5, neutral=3, regressed=1) → `session.get_session(sid)`→`qa_id` → `session.add_feedback(qa_id, feedback_text=flaw, feedback_score)`. *Verify-before-store / admission gating (DGM keep_better, Voyager self-verify).*
6. **IMPROVE (learn which memory helps):** `improve(session_ids=[sid], feedback_alpha=>0)` reweights the session graph by feedback so **the NEXT turn's recall ranks proven fixes higher**. *The archive promotes only verified wins.*
7. **NEXT TURN** recalls feedback-proven, token-anchored fixes → better build → repeat until the turn budget is spent.

**Why it's genuine self-improvement, not logging:** steps 5–6 make the system learn *which* memories help (feedback-weighted recall), `codexCritique`+distill dedup so memory compounds not bloats, and the No-Memory page gets none of 1/3/5/6 → its turn-over-turn score is flat while the memory page rises. **Measurable signals:** (i) judge score per turn, (ii) distinct lessons, (iii) named-flaw resolution rate, (iv) feedback-weighted recall rank.

## Invariants (LOCKED — maintainer decisions)
1. **In-run turn-by-turn only.** Reset every memory store per run. No cross-run carry-forward.
2. **Memory-aware master.** The master recalls the run's accumulated traces/lessons and uses them to spawn **better/more-relevant agents** — the *team* improves turn-over-turn, not just the page.
3. **Per-page master-authored roster** ("let the agent decide what it needs") — NOT a locked identical roster. Independent variable = access to recalled in-run memory.
4. **Same tools on both pages.** `image_gen, a11y_check, contrast_check, copy_lint` are neutral capabilities on BOTH. The ONLY memory-exclusive bundle is `{cognee_recall, cognee_trace}`.
5. **All-LLM vision judging, no regex** in any learnable/scoring path. Score = two-axis (design **quality** + **brand-adherence**). Resolved-proof = LLM-vision before/after screenshots (visually evidenced).
6. **Scope ceiling = memory/archive-conditioned, NOT runtime self-modification.** TasteLoop is AlphaEvolve/Voyager/Reflexion-class (recall-conditioned generation + roster/brief evolution), explicitly **not** Gödel/DGM-class self-rewriting — for A/B reproducibility and local-model reliability.

## Guardrails (every phase)
- **A/B fairness is paramount.** The judge is the **immutable anchor** — identical for both pages, never touched by any change. Every tool/capability is symmetric except the `{cognee_recall, cognee_trace}` bundle. Static brand rules flow **identically** to both pages (enforce via EVOLVE-BLOCK immutability: only the editable design region is mutable; injected brand rules are held constant).
- **Cognee model split (fair, RESOLVED):** build + judge = Codex gpt-5.4 (identical both pages). Cognee's own LLM (cognify/distill/improve) = **`glm-4.7-flash:latest`** — already pulled locally (19GB), keyless, far stronger than qwen2.5:7b at the strict JSON these ops need. Set in `cognee.env` (`LLM_MODEL`). Fair because Cognee only runs on the memory page and *is* "having memory." (No per-call `llm_config` on cognify/distill/improve — it's the global `LLM_MODEL`; `search/recall` use the same local model. Fallback if GLM struggles: `gemma3:27b`.) **Why a local model at all:** Cognee makes its own OpenAI-compatible API calls (graph extraction + embeddings) — Codex is a CLI actor, not an API endpoint, so it can't be Cognee's LLM.
- **Every new bridge command is smoke-tested in isolation** before wiring. **Prototype-and-verify** any qwen-dependent structured op (distill/feedback-extraction) returns non-empty results before a counter depends on it.
- **Authoring and review are separate passes** — execution agents build; a verifier pass confirms.

## Cognee API ground truth (verified on the live pin `1.2.0.dev1`)
- **v1 is PRIMARY:** `remember / recall / improve / forget` + `session.{add_feedback, get_session, distill_session}` all import. Legacy `add/cognify/search` is fallback only. **Migrate the bridge NOW** (not "Phase 3 risky surface").
- `forget(data_id|dataset|dataset_id|everything|memory_only|user)` — **no `scope='session'`**. Reset via `forget(dataset=sess_<runId>)`.
- `improve(dataset, *, run_in_background, node_name, session_ids, build_global_context_index, **kwargs[feedback_alpha])` — **no `llm_config`** (global model only). With `session_ids` it persists session Q&A into the graph + applies feedback weights.
- `remember(session_id=…)` writes to the **session cache**, not the permanent graph — that's exactly right for in-run; no `improve`-to-durable needed for our reset-per-run model.
- **No `SearchType.FEEDBACK`** and no `used_graph_element_to_answer` (blog naming). The real loop is `recall(session_id)→add_feedback(qa_id)→improve(feedback_alpha)`.
- `node_set=[…]` (write tag) + `node_name=[…]` (read filter, `node_name_filter_operator='OR'`) are **complementary** — do NOT "avoid node_type".
- `CHUNKS_LEXICAL` (BM25 exact-term, ideal for `#25F4EE`), `only_context=True`, `TEMPORAL` (cheap "lessons over turns" timeline) all present.
- `distill_session` present but **fails-open on qwen2.5:7b** (strict `WrittenLesson` JSON → silently ≈0) → needs the bigger structured-ops model.
- `feedback_score`: install doesn't validate; **use 1–5, documented.**
- **Pin reconcile:** `cognee.env.example:20` pins `c505f326` ≠ #3107 merge `ba35b2fd`; the live venv `1.2.0.dev1` *does* carry the session API. Standardize the documented pin on a version provably containing #3107.

---

# PHASES

> Each phase is a self-contained work-order: files, contracts, acceptance, fairness/verify notes. Doc-comments that still teach the old regex/penalty design (`orchestrator.mjs:29-33/64-67/685/832-833`, `judge.mjs:14-47`, `team.mjs:17`) are **editable, not frozen** — update them in the phase that changes their subject.

## Phase A — Critique/scoring spine (all-LLM). Runs FIRST; Phase 1 depends on it.
- **A.1 Skill registry (replaces the if/else ladder).** Replace `runAgent`'s `has()` priority chain + `statusFor` ladder (`skills.mjs:213-302`) with `SKILL_REGISTRY = { name: {params, run, status} }` + generic dispatch (port evo `ToolDefinition`/`ToolExecutor`, `default_tools.py:20-28`, `agent_runner.py:110-148`). **Critique is its own always-run entry** (fixes the else-if critique-kill at `skills.mjs:239/251-257`). Generate the `SKILL_PALETTE` prompt text from the same registry (no chip can be theater). Add **call-time allow-listing**: assert the skill is in the agent's granted set; for `{cognee_recall,cognee_trace}` assert `page===memory`; else throw — makes the A/B variable *structurally* enforced. *(Absorbs old Phase 0.6.)*
- **A.2 `codexCritique`** (new, mirrors `codexJudge` `codex.mjs:595`): `codexCritique({brand, screenshotPath, goal}) → [{flaw, brandRuleCited(enum from brand.dont), severity(enum: high|med|low)}]`. Renders its **own pre-revise PNG** (the orchestrator has no pre-judge render today). Findings feed **both** the trace set (replacing `realViolations` at `orchestrator.mjs:714`) **and** the revise fallback (`orchestrator.mjs:769-771`). Severity comes from this structured field (kills the severity regex).
- **A.3 Two-axis judge.** Rewrite `judgeSite` (`judge.mjs:141-202`) → single LLM-vision call returning `{quality:0-100, brandAdherence:0-100, reasoning, findings[]}`. **Drop** the `brandRuleViolations` import + the −20/violation penalty (`judge.mjs:150,181`). Blend: `final = 0.6*quality + 0.4*brandAdherence` (confirm weights), with `brandAdherence < 50 ⇒ final capped at 69`. Port evo's few-shot **judge calibration** structure (`judge.py:1-129`) — worked vision examples, not regex scraping. New event fields `{quality, brandAdherence}`; add the two sub-scores to `index.html:314`/`app.js:203`.
- **A.4 Resolved-proof (LLM-vision, visually evidenced).** `trace.resolved` payload `{flaw, brandRuleCited, beforeShot, afterShot, agentId, resolved:bool}`; emit after `reviseHtml` (~`orchestrator.mjs:799`); add the pre-revise render; second vision call "is this flaw still present?"; predicate = present-in-before AND absent-in-after; temp 0 + structured output (optional 2-vote). UI before/after side-by-side, memory page only. *(All-LLM is DECIDED; "visually evidenced," not deterministic.)*

## Phase 0 — Kill the hang + honesty deletions + cascade gate
- **0.1** `codexRun` (`codex.mjs:179-197`): add `retries` param (default 1; gen-loop callers `codexBuildSite`/`reviseHtml`/`codexJudge`/`codexCritique`/`runSvgImage` pass **0**) + an outer `Promise.race` holding the child handle that **SIGKILLs the process tree** on timeout (inner `codexExecOnce` timeout doesn't kill the tree). *Accept: a stubbed hanging child is killed within `timeoutMs`+grace.*
- **0.2 Cascade gate (port OpenEvolve):** a cheap render/structural check **before** the costly Codex vision judge (`orchestrator.mjs:835`) — fail fast, fewer Codex calls, helps the hang.
- **0.3** Outer timeout + on-timeout behavior for `judgeSite` and the 6 bridge awaits (`asyncio.wait_for`, `cognee_bridge.py:234,263,272,293,314,340`): on timeout emit `{error}`, run marks `failed, score:0` (port evo per-run failure containment, `orchestration.py:120-265`) — a hung judge never silently zeros the memory win.
- **0.4** Delete `brand_tokens` theater — all **four** sites: `team.mjs:62, :109, :422-423, :476` (the MIN_AGENTS backfill, missed before). Fix stale doc-comments (`team.mjs:17`, `judge.mjs:14-47`).
- **0.5** Regex removal (Guardrail 5) — remove/replace **all**: `brandRuleViolations` (critique `orchestrator.mjs:688` + judge), severity classifier (`skills.mjs:912`, `orchestrator.mjs:726/952`), driving-lesson selectors (`orchestrator.mjs:85/524`, `skills.mjs:926`), keyword-bag recall queries (`orchestrator.mjs:483`), and the `codexBuildSite` gradient hard-fail (`codex.mjs:470-471`, hidden side-specific brand help). Severity now comes from `codexCritique`.

## Phase 1 — Cognee v1 migration + the in-run feedback/improve loop (THE self-improvement core)
- **1.0 SMOKE GATE (do FIRST; blocks the rest of Phase 1).** On the live venv (`/tmp/cognee_smoke/venv` + `cognee.env`): (a) confirm the v1 surface imports (`remember/recall/improve/forget` + `session.{add_feedback,get_session,distill_session}`); (b) **confirm `glm-4.7-flash:latest` actually emits a VALID strict-Pydantic `WrittenLesson` JSON from `distill_session`** on a 2–3 trace fixture — i.e. Lessons > 0, not fail-open. PASS = ≥1 well-formed `WrittenLesson`. **FAIL → switch `cognee.env` LLM_MODEL to `gemma3:27b` and retry; if still failing, the Lessons/feedback counters degrade gracefully (Traces-only) and we flag it — do NOT let the demo silently show Lessons=0.** Nothing downstream (1.2 feedback/improve, the Lessons counter) is wired until this gate passes.
- **1.1 Migrate the bridge to v1.** Rewrite `cognee_bridge.py` ops: `write_trace`/batch → `remember(session_id, node_set=[token,role,severity])`; `recall_in_run` → `recall(session_id, node_name, only_context=True)`. Keep legacy as fallback.
- **1.2 Feedback loop (new bridge cmds, smoke-tested):** `cmd_feedback` (`get_session`→`add_feedback(qa_id, text, score 1-5)`) and `cmd_improve` (`improve(session_ids=[sid], feedback_alpha=>0)`). Wire step 5–6 of the spine: after each turn's judged delta, feedback then improve so the **next turn recalls better**. This makes the **Improvements** counter mean a real `improve()`/feedback application (not a cosmetic int — fixes `orchestrator.mjs:461/519/805`, gated on a measured delta).
- **1.3 Per-token recall (reachable on v1 today):** recall via `only_context=True`/`CHUNKS_LEXICAL` + `node_name` scoping. Verbatim hex/rule recall without qwen re-LLM. *Prototype-and-verify: literal-string return.*
- **1.4 Reset-per-run:** mint a real `runId` in `run.mjs` (replace `runId:"demo"` at `:37,63`), thread into `sessionId` (`orchestrator.mjs:434` → `sess_<runId>`); `forget(dataset=sess_<runId>)` on **both** pages at run start. Enumerate + reset all three stores (in-process shim closure, `sess_*`, any lessons). No cross-run persistence.
- **1.5 Carry failures forward as negative exemplars (in-run):** tag penalized decisions `node_set=[token,'failed']`; next turn's prompt includes "tried X, judge penalized." Cheap, demo-legible ("the studio avoided last turn's mistake").
- **1.6 Cognee LLM = `glm-4.7-flash:latest`** (already done in `cognee.env`; was `qwen2.5:7b-instruct`) so cognify/`distill_session` produce non-empty `WrittenLesson`s instead of failing-open. *Prototype-and-verify: confirm GLM emits valid strict-Pydantic `WrittenLesson` JSON before the Lessons counter depends on it; fallback `gemma3:27b`.* Fair (build/judge held equal on Codex).
- **1.7 ctx wiring:** orchestrator sets `ctx._ablate = ablateMemory` (`orchestrator.mjs:433`) + `ctx.lessons` so `runHtmlBuild` consumes recalled memory; critique findings flow into the build brief's `mustFix[]` so **same-turn findings reach same-turn builds**.

## Phase 2 — Fairness + memory-aware master + no decorative agents
- **2.1 Tool symmetry.** Memory-exclusive bundle = `{cognee_recall, cognee_trace}` ONLY (`cleanTools` `team.mjs:209`). `image_gen/a11y_check/contrast_check/copy_lint` available to BOTH pages; add a parity assertion (no-memory carries no memory tool; both carry identical quality tools).
- **2.2 Memory-aware master.** Move lesson→capability reasoning INTO the master prompt (`team.mjs:115-118`); **delete the `LESSON_SKILL_RULES` regex ladder** (`team.mjs:271-313`). The master **recalls the run's traces/lessons** and decides the roster + per-agent tools from them (visible in `master.planned`). `repairTeam` shrinks to a thin invariant-guard (≥1 html producer; valid tool names; the fairness assertion). Store each agent's v1 (no-lesson) + v2 (lesson-woven) brief at author time → delete the prompt-diff regex reconstruction (`orchestrator.mjs:85-164`).
- **2.3 Typed BUILD BRIEF (no dropped output).** Define `{copy, sectionOrder, layoutDirection, typeScale, imageDirective, mustFix[]}`; every non-builder agent fills a named slot; the builder consumes the whole brief. Any role whose slot the builder can't consume is **cut** (typographer, brand-deconstruct candidates) or wired. Roster size now tracks page quality by construction.
- **2.4 Credit assignment (TextGrad/Agent-as-a-Judge):** attribute each vision flaw to the responsible agent (contrast→typographer, copy→copywriter); store on the spawn event; seed that agent's next-turn brief with its own miss → makes the Phase 4 per-agent rows mean something.

## Phase 2.5 — Image generation (keyless SVG, fairness-locked)
- New `web/src/` capability (NOT `web/scripts/` — doesn't exist; NOT named `runSvgImage` — taken at `skills.mjs:550`): a **pure-JS template SVG** generator (truly keyless) used when `OPENAI_API_KEY` is unset; `generateImage()` (OpenAI `gpt-image-1`) when set. Returns `{path,dataUri}`.
- Wire result to `ctx.heroImage` (already embedded at `orchestrator.mjs:245,:675`); verify the `ctx.image`→`ctx.heroImage` redirect (`runImageGen` already sets `heroImage` at `skills.mjs:626`).
- Optional opt-in: `codexGenerateImage` via `codex exec -s workspace-write` behind `CODEX_IMAGE=1` (parameterize the hardcoded `-s read-only` at `codex.mjs:82`; don't change the default).
- **Fairness:** identical capability + identical brand prompt to BOTH pages, never `_ablate`-gated; parity assertion.

## Phase 3 — PDF→graph token system (typed, v1; the architectural centerpiece)
- **DECIDED — full build.** `brand.mjs deconstructBrand()` (today flat regex → `tokens.json`, never touches Cognee) emits **typed `DataPoint`s** (Color/Font/Spacing/Rule) via `remember()` with a brand **ontology** so tokens are canonical nodes (`#25F4EE`, `no-gradient`, `hero`). New bridge cmd `cmd_ingest_brand` (JSON contract; smoke-tested).
- Lessons/traces anchor onto token nodes (`node_set=[token]`); the build's brand grounding routes through a **graph query** replacing the string interpolation at `skills.mjs:463-520` / `codex.mjs:250-306`. Static brand rules still flow **identically to both pages** (EVOLVE-BLOCK immutable); the graph is the memory page's lesson substrate.
- **Roster-as-learnable-artifact:** the memory master recalls the best-scoring prior roster/brief for the brand and adapts it (ties to 2.2). Elevates the story to "better *team design* turn-over-turn."
- Graph viz (token nodes accumulating lesson edges; `SearchType.TEMPORAL` timeline) is a demo centerpiece. **Prototype-and-verify** node-scoped recall returns the anchored lesson on the stack before claiming it. *This is `node_set`/`node_name` at full scale — the cheap version already lands in Phase 1.3.*

## Phase 4 — UI: turn-by-turn proof
- **4.1** Per-turn **score chart** (memory rising vs no-memory flat) — the headline visual; `score.updated{turn, page, quality, brandAdherence}`. The single agents counter + clickable cards already exist (`app.js:146/415`); add per-agent **recall-hits/traces** columns.
- **4.2** Grant provenance + credit on the `agent.spawned` payload (lesson→skill→role mapping from `team.mjs:447`; the per-agent flaw from 2.4).
- **4.3** Relabel chips as **"orchestrator-invoked skill routes"** (not "the agent chose a tool" — it's registry dispatch).
- **4.4** `trace.resolved` before/after panel (from A.4); graph viz (from Phase 3).

---

## Sequencing
**A → 0 → 1 → 2 → 2.5 → 4 → 3.**
- **A + 0** first: the all-LLM critique/score spine + hang fix + deletions (everything depends on them).
- **1** is the self-improvement core (v1 migration + feedback/improve loop + reset-per-run) — the demo's whole point.
- **2** makes it fair + the master memory-aware + no decorative agents.
- **2.5** image-gen (keyless), **4** the turn-by-turn UI proof.
- **3** the full PDF→graph centerpiece last — built on a fair, working in-run loop (its cheap form already in 1.3).

## Resolved maintainer questions (recommended calls — flag any to change)
1. **Migrate to v1 NOW — YES** (aligns with the self-improvement priority; it's the primary API on the pin). Phase 1.
2. **Feedback signal = judge before/after delta on the named flaw — YES** (consistent with all-LLM judging; ties to the screenshots already shown).
3. **Cognee LLM — RESOLVED: `glm-4.7-flash:latest`** (already pulled, already set in `cognee.env`). No resource ask, no hosted key. qwen2.5:7b was the only reason structured ops failed; GLM fixes it keyless. *(Smoke-test GLM's strict-JSON output before relying on the Lessons counter.)*
4. **Pin reconcile — standardize on a version provably containing #3107** (live venv `1.2.0.dev1` works); I'll update `cognee.env.example:20`.
5. **Scope ceiling — memory/archive-conditioned, NOT runtime self-modification — CONFIRMED** (Invariant 6).
