# TasteLoop — Critical Design & Demo Review

*Synthesized from a 6-lens expert panel (demo director, product strategist, systems architect, Cognee integration lead, design/brand director, red-team) + a first-hand read of the design doc and the `agent_evo` source + first-hand verification of the Cognee API.*

## Executive summary

**Stop selling "evolution beats a single agent."** It's the boring, indefensible half, and the doc's own A/B never even runs a single-agent arm — so the headline claim (doc line 16) has zero experimental support. Sell the one thing nobody else at the hackathon will have: **a multi-agent design studio that remembers its own mistakes across runs and gets visibly smarter — same model, same budget, only memory differs.** Cognee cross-run memory is the moat; the rendered webpage is just the legible substrate that makes "got better" obvious to the eye.

Be blunt about what this is. **As a shippable product it is weak** — v0/Lovable/Bolt produce a homepage in 20 seconds for a fraction of the cost, and nobody runs an evolutionary loop locally to make one page. Its defensible thesis is a **method/capability demo**: evidence that cross-run graph memory makes a stateless multi-agent system improve. Position it as a Cognee capability showcase and research artifact, not a design tool. If it has a future user, it's teams building self-improving agent systems — and the durable artifact is the cross-run brand-memory graph (a studio that has designed for your brand 20 times isn't replaceable by a one-shot generator; the homepage is just the probe).

**The three highest-leverage changes:**
1. **Render to a screenshot and judge that.** A score floating next to raw `.tsx` is the most fake-looking thing in the doc. Reverse the "out of scope" decision; make the rendered page the hero artifact.
2. **Kill the live A/B race.** Run ONE live "warm-memory" run against a pre-recorded "cold-memory" run from earlier — disclosed as cached on stage — so memory is the single isolated variable and there's no dead-air parallel-spinner problem.
3. **Make the judge defensible.** Split the rubric into truly-deterministic linters and a small subjective vision lane on screenshots only; rank by round-robin paired comparison at temp 0; and prove memory's contribution with a `lesson_id → prompt_diff → targeted-category delta` chain, backed by a multi-seed ablation.

Do these and a smart audience has nothing to see through, because you're showing the *mechanism*, not two end numbers.

---

## 1. Strongest product framing

TasteLoop is **a self-improving design studio: a population of AI design teams that competes, critiques itself, and — using Cognee memory — gets visibly smarter every run.** The honest unit of comparison is **memory vs. no-memory**, not **evolution vs. single agent**.

Why drop "evolution beats a single agent": it's the boring half and the hardest to defend. Best-of-4 beating best-of-1 only proves "more compute helps," and the doc's A/B never runs a single-agent arm (both arms are evolutionary), so the line-16 claim is unsupported. A skeptic instantly reads "you reinvented temperature sampling with extra steps."

What is actually novel and defensible: a multi-agent system that **persists a knowledge graph across runs** and **upskills its members from stored critique** gets measurably better over time without changing the model. That's the Cognee story, and the only part structurally impossible for a stateless baseline to replicate.

Title-slide one-liner: **"Two AI design studios. Same brief, same model, same budget. One remembers. Watch the one that remembers pull ahead."** The load-bearing words are *one remembers*.

**The blunt product verdict.** The npm-package productization is a distraction and a liability. Reframe the CLI honestly as a **demo harness** (the doc's own line 5 already says this; the rest inflates it). Cut the dual CLI+API surface, the programmatic `generateDesign()`, multi-framework targeting, and the "one autonomous system" abstraction — hiding the machinery works against a demo whose entire point is to make that machinery maximally visible. The one forward-looking line to keep in your pocket if a judge asks "why build it": *the cross-run brand-memory graph is the moat; the homepage is just the probe that proves the memory compounds.*

---

## 2. Recommended hackathon demo narrative

**One live run, contrasted against a pre-recorded cold-memory run from "earlier today." Total ~4 minutes. Do NOT race two live evolutions in parallel** — they're slow, look identical for the first ~90 seconds, and the audience can't attribute any gap to memory vs. model variance (a fatal "lucky seed" objection).

The framing is **"memory has a history," not "a race."** This is *more* honest than a parallel A/B: the controlled variable (memory) is the headline, and you show the causal mechanism rather than two noisy end numbers.

> **Live-vs-replay status (state once so the build is unambiguous):** the cold run is **cached replay**, badged on screen. The seeding → loop-close → payoff beats are **live**, because they're the cheap part. If wall-clock or API risk forces it, the warm run may also be pre-recorded and badged `REPLAY` — in that case the only live element is the upskill-diff trigger, and you lean the show's credibility entirely on it. Default `--mode replay`; live elements are explicitly opted in.

> **All scores below are ILLUSTRATIVE PLACEHOLDERS.** Fill them with real measured values during rehearsal. If the real total-score delta lands inside the judge noise floor, **do not invent a hero number** — pivot to the targeted-category delta (Beat 4) plus the multi-seed distribution (Beat 5). Never manufacture the winning result.

- **Beat 0 — Cold (cached replay, ~25s).** Presenter says, explicitly: *"This is a cached run from an earlier session — same code, you can re-run it yourself."* UI badges it `REPLAY (cached <timestamp>)`. "TasteLoop saw this brand for the first time. Empty memory. Here's how it did." Lands at **[X]/100**. Freeze on the winner and **pin its #1 failure mode**: *"Visual Designer keeps shipping generic AI gradients — the brand book explicitly forbids them."*
- **Beat 1 — Warm setup (live).** "Today: same goal, same brand, same model, same budget. The only thing that changed: it remembers yesterday." Show the **RunConfig diff** (not raw hashes).
- **Beat 2 — Seeding (live, ~20s).** Before any team runs, a `recall`/`search` pulls yesterday's distilled lessons into Gen-0 team construction. Gen-0 teams are *born already knowing* "no AI gradients."
- **Beat 3 — The loop closes (live, THE WOW).** Gen-0 runs, judge scores. The prompt-diff panel snaps open: member-instruction v1 → v2, the triggering gradient critique highlighted red on the left, the new "load brand tokens / verify palette before layout" rule glowing green on the right, with the **memory lesson node literally wired between them**.
- **Beat 4 — Payoff.** Final score lands at **[Y]/100**; animated delta with one-line attribution: *"gradient failure mode: eliminated — Brand Fidelity moved, unrelated categories flat."* The winning design renders full-bleed. **The targeted-category isolation is the credible claim, not the total.**
- **Beat 5 — Close (~15s).** "Selection alone gets you a winner. Memory gets you a winner that doesn't repeat yesterday's mistakes." Flash the credibility backstop: the **multi-seed distribution** ("across N seeds, warm beat cold in M, mean delta Δ" — real measured values).

The wow beat is the **visible feedback loop closing**: a named failure → a graph lesson → a prompt diff → the same failure not recurring → a score move. If a judge walked in at minute 3 and saw only the prompt-diff panel (red critique → memory node → green fix → delta), they'd already get it. Engineer the whole show around that 30-second sequence.

**Pre-stage everything slow or noisy; live = only the headline action.** Caching the cold run and pre-building Gen-0 is directing, not cheating — *provided the cold run is disclosed as cached* and the multi-seed aggregate (shown, not hidden) defuses the cherry-pick accusation.

---

## 3. Proposed visual demo storyboard

Single full-screen layout, **three fixed zones** so the audience never re-orients. The discipline that wins: **one focus panel, one thing moving at a time.**

```
+-----------------------------------------------------------+
|  GOAL + BRAND TOKENS  (thin top strip, always visible)    |
+----------------------+------------------------------------+
|  EVOLUTION TREE      |   FOCUS PANEL  (this is the show)  |
|  (left third)        |   - team cards / rendered design   |
|  nodes appear,       |   - PROMPT DIFF (the wow beat)     |
|  fired ones dim,     |   - score delta meter              |
|  lineage edges draw  |                                    |
+----------------------+------------------------------------+
|  MEMORY GRAPH (bottom strip) — causal edges only          |
+-----------------------------------------------------------+
```

| Time | Top strip | Left (tree) | Focus panel | Bottom (memory) |
|---|---|---|---|---|
| 0:00–0:25 | Goal + ~5 brand tokens fade in | — | Cold run replays (badged `REPLAY`); lands **[X]**; **failure mode pins** | grey/empty |
| 0:25–0:45 | held | — | **RunConfig diff**: every line green/identical except `memoryEnabled: false → true`; matching config hash as the seal beneath | Memory graph populates with cold run's lesson nodes (zero forward edges) |
| 0:45–1:30 | held | Gen-0: team cards drop in, each tagged with an inherited lesson | Teams render **screenshots** live (not code) | nodes read during seeding |
| 1:30–2:15 | held | Judge scores fill cards; weakest **greys + shrinks (fired)**, pinned with *why it died* | Round-robin win-count board sorts; green/red deterministic-lint badges | new run evidence written |
| 2:15–3:00 | held | lineage edge draws survivor → upskilled child version node | **PROMPT DIFF opens — THE WOW**: red critique left, green fix right, lesson node wired between | the triggering lesson node draws a single edge into the v2 prompt line |
| 3:00–3:30 | held | child version scores, pulses gold | **Delta meter** + the ONE category that moved (Brand Fidelity, animating); unrelated categories flat | — |
| 3:30–4:00 | held | winner crowned | Winning design renders full-bleed; "lesson applied ✓"; multi-seed distribution flashes | "closed learning loops: warm N / cold 0" |

**Ship exactly three visualizations:**

1. **Evolution tree (left, the spatial spine).** Nodes = teams/versions, appearing top-down by generation. Fired teams **desaturate and shrink ~30% but stay in place** — keep the graveyard visible so selection pressure is *felt*; pin *why each died*. This MVP shows **upskill-lineage** (v1 → v2 version nodes), not merge edges (see §7).
2. **Prompt-diff panel (focus, the wow).** Side-by-side member instructions v1 vs v2; the triggering critique slides in red, the new instruction types out green, with a connecting line to the lesson node. The single most important pixel on screen.
3. **Memory graph (bottom) — causal edges ONLY.** A static glowing knowledge graph is the #1 fake-looking element in AI demos. **Ban free-floating pulses, "ignite," and "shoot data into cards" decoration.** The only animation that earns screen time is the literal edge drawn from a named Lesson node into the specific MemberVersion prompt line, synchronized with the prompt-diff. **Fallback if you can't render the causal edge in time:** demote to plain text — "closed `DISTILLED_INTO → SEEDED → RESOLVED` loops: warm N, cold 0." Plain text beats a generic node-graph cliché.

**Kill or demote:** the dual-live A/B (replaced by cold-vs-warm); a separate score-delta panel (fold into tree + one payoff meter); the tournament bracket (it implies pairwise elimination you don't do — it would *misrepresent* the algorithm); brand-deconstruction (demote to the top strip, ~5 tokens — except the BrandSpec reveal at t=0); the final gallery (~16 near-identical thumbnails — render the ONE winner full-bleed, optionally 2-up cold-winner vs warm-winner); JSON trace dumps (nobody reads JSON on stage).

---

## 4. Recommended architecture changes

The component *set* is mostly right; the **control logic** (selection, merge, fairness, scoring) is the weak part — described as prose, not as a locked, logged, deterministic protocol. Five structural changes:

**4.1 Render before judging (highest product leverage).** You cannot credibly judge `visualHierarchy`/`layoutQuality`/`originality` from `.tsx` source — the model pattern-matches class names, not a page. Add a headless **Playwright render to a single 1280px screenshot** before any taste judgment. This is the hero artifact, not an out-of-scope nicety.

**4.2 Rank by round-robin paired comparison at temp 0 (highest correctness leverage).** The reference judge runs at temp 0.3 and regex-parses a scalar; run-to-run jitter of ±1–2 will swamp a small A/B gap. Fix, in priority order: (a) **round-robin paired comparison** within the generation ("A better than B, here's why"), **ranked by win-count** with order-swap handling — relative judgments are far more stable than absolute, and win-count is exactly the "A beat B beat C" the audience understands. *(Skip Elo/Bradley-Terry — with ~4–7 candidates that's statistical machinery you can't back with confidence intervals, and it invites a stats-savvy judge to poke holes.)* (b) **temp 0 + fixed seed** for judge and builder, pinned and identical across runs; (c) **order-swap de-biasing** (judge each pair both ways; flip = tie); (d) **structured JSON output**, not regex; (e) the absolute rubric is **median-of-3**, used only for human-readable critique and to tell the upskiller which category each candidate won — **never to drive selection directly.**

**4.3 Feed scores + critiques INTO the merger — spec only for MVP, not on the demo critical path.** `agent_evo`'s `merge_teams` receives only the two team configs — never scores or critiques (confirmed: `random.sample` at `orchestration.py:600`, `merge_teams` call at `623–629`) — so a merged child literally cannot improve on what made a parent good. If you ever ship merging, don't inherit this: the merger must take `MergeInput { parents: Array<{ team; score }> }` so `score.categories`, `failureModes`, and `improvementSuggestions` structurally reach the prompt; the child inherits, per rubric category, the role/instruction from whichever parent scored higher, and emits `patchedFailures: string[]`; parent selection is deterministic and diversity-aware (Parent 1 = current best by win-count; Parent 2 = highest-ranked team most behaviorally different from Parent 1). **But for the MVP, merging is spec-only and post-demo** — the demo leads exclusively with member upskilling (§7).

**4.4 Make the orchestrator ENFORCE fairness across time, not promise it.** The two "arms" are **cold (cached)** and **warm (live)** — not two concurrent runs. Construct **one frozen `RunConfig`**; the cold run's config hash is stored in its cached trace, the warm run's is computed live. On start, assert `sha256(canonicalJSON(RunConfig minus memory flag))` of the live warm config equals the cold config's stored hash, and **refuse to run otherwise.** On screen, **don't show two hex blobs** — show the canonical RunConfig as a short human-readable diff where every line is green/identical except `memoryEnabled: false → true`, with the matching hash beneath as the notarization seal. **Blind the judge**: candidates passed shuffled and anonymized with neutral IDs; de-anonymize only after scoring. Log a per-call cost ledger (`tokensIn/out`, `costUSD`, `latencyMs`, `seed`); assert both runs used identical model/population/generation budgets. Use **cold/warm** terminology throughout so nobody builds for two concurrent runs.

**4.5 Pre-compute and replay; simplify the runner.** With population 4 × team-size 5 × generations 3 plus paired judging, you're at ~100+ LLM calls per run — minutes of serial wall-clock, too slow and jittery for a live slot. Run the full sweep beforehand, persist traces, animate the replay live (`--mode replay|live`, default replay), live-triggering only the cheap upskill-diff moment. Add `--seed`, `--budget`, `--concurrency` (fan out teams within a generation via `Promise.all`; the reference runs serially). Replace the team **DAG/edges/entryPoint** with a **fixed linear pipeline** (`pipeline: string[]`: brand → IA → visual → implementer → reviewer) — the graph machinery buys nothing here and adds ordering nondeterminism and cycle-guard complexity. Add an aggressive cache keyed on `(configHash, role, promptHash, seed)` so re-demos are instant and identical inputs provably produce identical cached outputs.

**Data-model fixes that unblock the above:** add `judgeModel`, `samples`, `variance`, `weightedTotal` to `DesignScore`; add a `PairwiseResult { winnerId; loserId; orderSwapAgreed; reasoning }` type that selection consumes; replace `learnedFrom?: string[]` with structured `upskilledFrom { parentMemberId; evidenceRefs; failureModesAddressed; instructionDiff }` plus `version`; add `parentTeamIds`, `generation` to `DesignTeam` for lineage rendering; add cost/latency/seed to `DesignRunResult`; make `mergeDecisions`/`upskillDecisions` typed (not bare strings); add `runConfigHash` and `arm: "cold" | "warm"` to `EvolutionResult`.

---

## 5. How Cognee should be used (verified first-hand, June 2026)

I verified the API directly from three doc surfaces (Self-Improvement Quickstart, GitHub repo overview, Python API page). **The doc's Cognee usage is correct and current.** `remember` / `recall` / `improve` / `forget` are the **current "v1.0" core API**; `add` / `cognify` / `search` / `memify` are the **legacy pipeline**. (An earlier panel pass had this backwards — flagging `remember`/`improve` as "unverified" — but they're the headline functions on the GitHub overview and the Quickstart's verbatim code.) Working, verbatim:

```python
await cognee.forget(everything=True)                                         # clean cold-run reset
await cognee.remember(text, dataset_name=DS, self_improvement=False)         # permanent graph
await cognee.remember(text, dataset_name=DS, session_id=S, self_improvement=False)  # session memory
ans = await cognee.recall(query, datasets=[DS])
await cognee.improve(dataset=DS, session_ids=[S])   # bridge session→permanent (Memify-style enrichment)
```

Two parameters are quietly perfect for the demo: `self_improvement=False` **defers** enrichment until you explicitly call `improve()` — so the Quickstart's own `recall(before) → improve → recall(after)` shape *is* your self-improvement visualization; and `forget(everything=True)` gives a clean cold-run reset.

**The one real API caveat:** do **not** assume `improve()`/`memify()` auto-reweights edges by recurrence — the docs describe it as enrichment, not recurrence-scoring. So compute "require repeated evidence" (doc line 525) **in your own code**: count failure-mode occurrences across trace records, store `observed_count` on the Lesson, and gate seeding on a threshold *you* compute (e.g., observed in ≥2 runs or ≥3 teams). Treat Cognee as storage + retrieval + enrichment, not as the counter. The v1.0 and legacy surfaces coexist and the API is moving — **pin the cognee version in package.json and smoke-test the exact calls the night before.**

**Run it keyless and local (decided separately):** point Cognee at Ollama — `LLM_PROVIDER=ollama`, `EMBEDDING_PROVIDER=ollama`, `EMBEDDING_MODEL=nomic-embed-text`, `EMBEDDING_DIMENSIONS=768` — no API key, fully offline, reproducible on stage. Cognee's enrichment model is *part of the memory treatment*, so it can differ from the design/judge model without hurting A/B fairness (what's held equal is the design-generation + judging model/budget). Codex/ChatGPT subscription OAuth is **not** a usable API key for Cognee; run Cognee as its own local harness (in-process lib, or the Docker server on `:8000` called over HTTP from TS).

**The concrete memory loop.** The unit of memory is a **`Lesson`**, not a "team strategy" — Lessons transfer across runs and you can show one changing a prompt:
- **Write (per run):** for every judge `failureMode`, emit `Lesson { id, scope, role, brand_tags, goal_tags, failure_mode, evidence_run_ids, proposed_patch, observed_count }`; `remember()` it (tag with role + brand via `node_set`, which is documented/verified); write raw traces to a session dataset so the permanent graph stays clean — only distilled Lessons get promoted.
- **Distil (end of run, in YOUR code):** compute `observed_count` across trace records; promote only Lessons over threshold. (This replaces any reliance on memify "reweighting.")
- **Read (before next generation):** `recall(query)` / `search(GRAPH_COMPLETION)` with current goal+brand tags; inject each retrieved lesson into the relevant prompt as a tagged block `[MEMORY:lsn_7f3a confidence=0.82 from_runs=…]` — the tag makes provenance grep-able.
- **Reinforce (after a seeded lesson raises a score):** bump `confidence`/`observed_count` on the Lesson and re-`improve()`; show confidence climbing run-over-run. (If you want Cognee's built-in feedback reinforcement, smoke-test it first — the doc surfaces disagree on `save_interaction`/`FEEDBACK`; keep an app-code fallback.)

**Graph schema: make Lessons hubs, not a linear chain.** The doc's `goal→brand→…→lesson` is the right *narrative* but a boring *graph* (a path). Restructure so Lessons **fan-in from many runs and fan-out to many future members.** Edges that matter: `Output --EXHIBITS--> FailureMode`; `FailureMode --DISTILLED_INTO--> Lesson`; `Lesson --SEEDED--> MemberVersion`; `MemberVersion --RESOLVED--> FailureMode` (the proof edge); `Lesson --APPLIES_TO--> BrandToken` (brand-conditioned retrieval). **The cross-run edges ARE the demo:** in the cold graph, Lesson nodes have zero forward edges; in the warm graph, they reach into the next run's MemberVersion nodes. Headline metric: count of closed `DISTILLED_INTO → SEEDED → RESOLVED` triangles ("warm closed N learning loops, cold closed 0").

**Prove causation, not correlation.** First objection: "that's just RAG / prompt-stuffing." Pre-empt it: (a) the **provenance triple** `lesson_id → exact prompt_diff → score_delta`, shown with the lesson id in the diff gutter; (b) **targeted delta** — claim "this lesson targeted brandFidelity, which moved while unrelated categories stayed flat," not "warm scored higher overall"; (c) **counterfactual ablation** — `tasteloop evolve --ablate-memory` re-runs the seeded team with `[MEMORY:…]` blocks stripped. **Honest framing of (c):** a single ablated run *demonstrates the lessons are load-bearing*; it does **not** establish causation from one noisy draw. For a causal claim, run the ablation across the same multi-seed set and report mean delta with vs. without memory. **The strongest honest evidence is the targeted-category-delta-with-unrelated-categories-flat** — anchor the causal story there.

Honest differentiators vs. prompt-stuffing: cross-run (not in-run) lessons; distillation (many FailureModes → one thresholded Lesson, not verbatim transcripts); selective brand-conditioned retrieval; updating confidence over time. Enforce that **every Lesson cites `evidence_run_ids` that resolve to real trace records** — fail the run on any orphan lesson.

---

## 5a. Leveraging Cognee PR #3107 + cross-agent trace sharing

PR #3107 (`session: session semantic retrieval distillation`, **OPEN**, core-team/lxobr, base branch `dev`) is almost purpose-built for TasteLoop. It adds the two primitives §5 told you to hand-roll:

1. **Session memory with semantic recall (the in-run shared blackboard).** A Cognee *session* holds the run's turns; `recall(query_text, query_type=GRAPH_COMPLETION, datasets=[DS], session_id=SESSION, user=user)` returns recent turns **plus vector-recalled older turns from the same session** — a later agent retrieves *relevant* earlier findings by similarity, not a full dump. `search_session_qa_ids(...)` queries session turns directly.
2. **`session_agent_trace` (the per-agent trace).** Wraps one agent method call into `{origin_function, status, method_return_value, error_message, session_feedback}` (one-line LLM summary, deterministic fallback). Native "agent makes a trace."
3. **`distill_session(SESSION_ID, dataset=DS, user=user)` (the cross-run promotion).** Curator → writer: the curator keeps only durable facts/practices, rejects session-local trivia, and **dedupes aggressively (repeated evidence → consolidated into ONE lesson)**; the writer emits `WrittenLesson { accept, reason(already_known|not_durable|unsupported), statement (standalone, entity-anchored), entities[], why_learned }`; returns `DistillationResult { session_id, status, documents[] }`. Reference: `examples/demos/session_distillation_demo.py`.

**(a) "Traces should share information between agents."** Model **one Cognee session per team-run.** Every member action emits a `session_agent_trace`; member outputs and judge/reviewer critiques are written as session turns. Each downstream member opens with `recall(query_text=<its role concern>, session_id=SESSION)` — so the Accessibility Reviewer flags "hero uses a forbidden gradient" → that becomes a session trace → the Visual Designer's revise step recalls it and adapts. **Semantic, role-scoped retrieval is the honest difference from a shared scratchpad** — B pulls the relevant lesson, not the whole log. This replaces `agent_evo`'s naive "concatenate full chat_history forward" (`team_runner.py`).

**(b) "Leverage PR #3107."** Use `distill_session` as the **native** end-of-run promotion into the long-term graph — it does the curation/dedup/novelty-gating §5 hand-rolled. **Drop the bespoke `observed_count` threshold as the core mechanism**: the curator's "consolidate repeated evidence + reject `already_known`" *is* "require repeated evidence," done natively and honestly. (This refines §5's "cross-run not in-run" framing: in-run semantic sharing is now a **base feature**; cross-run persistence is still **the treatment**. Keep an app-side counter only to animate a numeric confidence.)

**Revised memory model — two axes; keep them straight for fairness:**

| Axis | Scope | Mechanism (PR #3107) | On in cold? | On in warm? |
|---|---|---|---|---|
| **Horizontal** — teammates learn from each other | within one run | session memory + `session_agent_trace` + session `recall` | **yes** | **yes** |
| **Vertical** — system learns across runs | across runs | `distill_session` → durable Lessons → next-run `recall(datasets=[LONG_TERM])` seeding | **no** (long-term graph pruned each run) | **yes** |

The independent variable stays clean: **horizontal sharing is base-system (identical in both arms); only vertical cross-run persistence is the treatment.** Cold still runs in-run sessions — it just `prune`s the long-term dataset between runs, so `memoryEnabled` now precisely means *cross-run distillation + seeding*. Distillation's curator/writer calls are part of the memory treatment's cost, not the design/judge budget.

**Demo gift — a second, faster "wow" at a different scale.** Horizontal sharing is self-contained, needs no "yesterday" setup, and lands in seconds:
> Reviewer flags gradient → trace pops into the session panel → Visual Designer's revise step recalls it → re-render shows the gradient gone — live, in one run.

Use it as the **opening hook** (micro proof: "the system learns"), then cold→warm as the **headline** (macro proof: "and it remembers across runs"). Two independent demonstrations beat one. This requires one **bounded feedback loopback** in the pipeline (reviewer → designer-revise) — amend §4.5's "fixed linear pipeline" to *linear + exactly one review→revise loop*.

**Leverage/risk:** the PR is OPEN on `dev` (API may shift before merge). Pin to head commit `c505f32…`, **wrap all Cognee calls behind a thin `MemoryStore` adapter** (one file to swap if the API moves), and smoke-test `recall(session_id=…)`, `distill_session`, `session.get_session`, `search_session_qa_ids` against that commit. Since the maintainer pointed you here, ask him which commit/tag to pin and whether the session API is demo-stable. This extends doc-edit #8 (§10).

---

## 6. How brand-book deconstruction should work

The doc's biggest unaddressed gap: the brand book is an opaque markdown string handed only to the builder and **never connected to the judge** — so `brandFidelity` is scored from a string the judge may not even see. Both builder and judge must consume the **same compiled spec**, or the comparison is unfalsifiable.

Add a **`BrandCompiler`** step that runs **once per run, before Gen 0** (one LLM call + deterministic post-validation), producing a locked `BrandSpec` shown on screen at t=0. This also makes the per-team `Brand Interpreter` role redundant — teams should differ in what they *do* with the brand, not in what they think the brand *is* (which would make the A/B unfair).

```ts
export interface BrandSpec {
  tokens: {
    color: {
      palette: Record<string, string>;
      roles: { bg: string; fg: string; accent: string; muted: string };
      allowedHexes: string[];
      maxAccentCoverage: number;
    };
    type: {
      families: { heading: string; body: string; mono?: string };
      scale: number[]; weights: number[];
      minBodyPx: number; maxHeadingFamilies: number;
    };
    spacing: { base: number; scale: number[] };
    radius: number[];
  };
  hardConstraints: Array<{
    id: string; rule: string;
    check: "tokenLint" | "contrastLint" | "a11yLint" | "regex";
    severity: "block" | "penalize";
  }>;
  negativeConstraints: Array<{
    id: string; rule: string;
    evalHook: "cssLint" | "vision"; cue?: string;          // "no AI gradient" etc.
  }>;
  tasteRules: Array<{ id: string; rule: string; weight: number }>; // subjective, vision-judged
  voice: {
    audience: string; tone: string[];
    bannedCopyPatterns: string[]; contentProofExpectations: string[];
  };
  evalCriteria: Array<{                                       // the bridge
    category: string;
    type: "objective" | "subjective";
    checks: string[]; weight: number;
  }>;
}
```

The key innovation: **`evalCriteria` is generated FROM the brand book in the same pass as the constraints.** One source of truth emits "use electric-blue sparingly" (to builder) AND "penalize if accent covers >15% of viewport" (to judge). No drift.

**Split the rubric into objective and subjective — and split *objective* further into truly-deterministic vs. measured-from-render** (pixel-ratio/overflow checks depend on render/viewport/font-load timing and can flake):

| Category | Lane | How scored | Weight |
|---|---|---|---:|
| Token compliance | objective (deterministic) | off-palette/off-scale color, type, spacing → fail (CSS-AST) | 10 |
| Frontend code quality | objective (deterministic) | tsc + eslint + builds clean | 7 |
| Accessibility | objective (deterministic) | axe-core / pa11y on rendered DOM | 10 |
| Anti-generic linters | objective (deterministic) | CSS-AST scan for hero `linear-gradient`, `backdrop-filter: blur`, indigo→violet ramp | gates originality |
| Brand fidelity | split | token/contrast lint (deterministic) + vision "feels on-brand" | 15 |
| Responsiveness | objective (measured-from-render) | render 375/768/1280, detect overflow / tap targets — *pin viewport + wait-for-fonts + device-scale-factor; admit minor variance* | 8 |
| Accent coverage | objective (measured-from-render) | screenshot pixel ratio vs `maxAccentCoverage` | folds into brand fidelity |
| Visual hierarchy | subjective | vision model on screenshot, given `tasteRules` | 12 |
| Layout quality | subjective | vision model on screenshot | 12 |
| Content fit / voice | split | banned-copy regex (deterministic) + vision audience-fit | 9 |
| Originality (comparative, gated by brand fidelity) | subjective | scored across the generation's screenshots; **0 if any hard constraint fails** | 10 |

Credibility rules: the **truly-deterministic** set (tsc, eslint, axe-core on DOM, CSS-AST regex) is genuinely reproducible — **lock the linter config in the BrandSpec, hash it, show the hashes match across runs.** Don't claim "audience re-runs it live" (won't happen in 4 min) and don't put pixel-ratio/overflow under the "deterministic, hashable" banner — label those **rendered measurements**, pin the render environment, acknowledge minor variance. The vision model **only ever sees a screenshot, never raw code**, and only for subjective categories — this also cuts judge token cost and variance.

**Fix originality.** At weight 5 it's a rounding error that rewards competent-but-bland output — the opposite of "TasteLoop." Bump to 10, score it **comparatively** across the generation's screenshots, and run the deterministic anti-generic linters first (auto-penalize the telltale gradient/glass/indigo-ramp before the vision model looks). Pick a brand with a **strong, violable** rule (the no-gradient rule) so bad teams look obviously bad *in the pixels* — the failure is visible, not just numeric.

---

## 7. What to cut from the MVP

**MVP = 5 modules:** (1) BrandCompiler, (2) the design → Playwright-render → split-judge atom, (3) Cognee Lesson write/distil/read/reinforce, (4) the upskill-diff loop wrapper, (5) the replay UI (tree + prompt-diff + causal memory graph). Everything below is cut.

**Merge vs. upskill — resolved: ship upskilling, cut merging from the MVP.** Member upskilling is cleaner, gives a more legible Cognee story, and merging is `agent_evo`'s weakest part. Propagate this everywhere: the evolution tree shows **upskill-lineage** (v1 → v2), not merge edges; the storyboard's 2:15 row draws survivor → upskilled-child, not two-parent merge; §4.3's merger is spec-only/post-demo. The curve the audience sees is the **cold → warm improvement across RUNS**, not multiple children within a generation.

| Cut | Why |
|---|---|
| npm package boundary / dual CLI+API / `generateDesign()` | No real user; productization distracts from the one screen that wins. Reframe CLI as demo harness. |
| Multi-framework targeting (`next-tailwind` vs `react-tailwind`) | Pick ONE: single static HTML+Tailwind file, iframe-renderable. Multi-framework is config theater. |
| **Team merging** (DesignMerger) | Ship member upskilling only for the MVP. Merger stays spec-only (§4.3). |
| 9-category rubric scored by one LLM from raw code | Indefensible; "originality 5/5" reads as made up. Use the split rubric in §6 (vision sees screenshots only). |
| The team DAG (`edges`/`entryPoint`) | Fixed linear pipeline for MVP; defer the graph. |
| MockModelProvider as a product abstraction | Hardcode one model. Keep a mock only for fast loop-logic tests, not as a product surface. |
| Cognee as "optional extension" (lines 169/171/749) | If Cognee is optional you have no demo. It is the experimental treatment — **mandatory for the warm run**. |
| TraceStore as nested on-disk JSON tree | In-memory event stream the UI consumes (still persist traces for `evidence_run_ids`). JSON dumps are dead air on stage. |
| "Deterministic score aggregation" over an LLM judge | Embrace "the judge is an LLM, here's its reasoning + variance bars" for subjective categories; reserve "deterministic" for the lintable set only. |
| Elo / Bradley-Terry ranking | Population is ~4–7; use round-robin win-count (§4.2). |
| Multi-viewport screenshot matrices (as a judged matrix) | Single 1280px shot drives taste; the 375/768 renders feed only the responsiveness lint. |
| The full 8-class + 5-prompt + 4-test file structure | A 2-week build. The cut MVP is the 5 modules above. |

---

## 8. What to build first (critical path, ordered)

**Build the design → render → judge atom FIRST, and don't start the UI until a single judged design feels earned.** The atom is the project's existential risk; the replay UI is what wins the room. Protect time for both.

1. **The design → render → judge atom (existential risk — verify before anything else).** goal + BrandSpec → one LLM call → HTML/Tailwind → **Playwright screenshot** → judge returns deterministic-linter results + a small subjective vision score (screenshot only) + freeform critique + **one named failure mode.** If a single design+judge isn't legible and the score doesn't feel earned, the demo dies.
2. **The BrandCompiler.** brand-book.md → locked BrandSpec → feed both builder and judge. This is what makes everything downstream fair.
3. **The loop wrapper.** Spawn N candidates, round-robin paired-compare, keep best, upskill the weakest member. Easy once the atom works.
4. **Cognee write/distil/read/reinforce.** After each run, `remember` lessons + `improve`; compute recurrence/`observed_count` in your code and threshold; before next gen, `recall` and inject recalled critique into member instructions (that's the upskill). The diff between instructions-with-recall and instructions-without **is the entire experiment.** Pin the cognee version; smoke-test the exact calls.
5. **The replay UI (what wins the room — do not under-invest).** Evolution tree (upskill-lineage) + prompt-diff panel + causal memory graph, fed from pre-recorded traces.
6. **Seed the warm graph the night before, for real.** Generate it by **actually running TasteLoop end-to-end on this exact brand 1–2 times beforehand**, letting the real judge produce the failure modes and your distillation produce the thresholded Lessons. The seed graph is a genuine prior-run artifact — **show its `evidence_run_ids` resolve to real traces on demand.** Never hand-author lessons (the doc's own #1 unfair item, line 605). Run the multi-seed sweep here too, for the aggregate backstop.

---

## 9. Risks and how to make the demo credible

| Risk | Why it's fatal | Concrete mitigation |
|---|---|---|
| **Judge nondeterminism** (±1–2/category) swamps the gap | Headline can sit inside the noise floor; "run the judge 5× on the same file" demolishes it | Round-robin paired comparison + temp 0 + order-swap + median-of-3; **show variance bars**; deterministic linters carry the objective categories |
| **Circular LLM-judges-LLM** | Same model writes and grades; rewards designs that *talk* like good design | Deterministic programmatic checks (palette present? gradients absent? contrast passes?) carry objective categories; LLM only on subjective, **screenshot only** |
| **"Best-of-N dressed as Darwin"** | Selection with nothing to select from; winner is just best Gen-0 sample | Show improvement across **RUNS** (cold→warm) via upskilling, not within-generation merge magic; feed critiques into the upskiller; rename honestly if needed |
| **Single-run luck / cherry-picked seed** | One run is one draw from a high-variance (builder temp 0.8) distribution | Live = one run; **reveal a real multi-seed aggregate** — measured, shown, not invented |
| **Invented on-stage numbers** | A polished "+14, 4/5 seeds" the audience assumes is real; if the real run gives +3 you lie or scramble | Treat every score as placeholder until rehearsal; if real delta < noise floor, **pivot to targeted-category delta + multi-seed distribution**, never a hero total |
| **Unenforced fairness ("you rigged it")** | The doc lists unfair conditions but provides no mechanism | RunConfig **diff** (one green-highlighted `memoryEnabled` line) sealed by a matching hash; warm hash computed live, cold hash from cached trace, asserted equal; blinded/shuffled judge; cost ledger; linter-config hash match |
| **Cold run read as live (staging deception)** | If the cached cold run is narrated as live and a sharp audience catches it, the demo's honesty collapses | **Disclose it**: presenter says "cached from an earlier session, re-runnable"; UI badge `REPLAY (cached <timestamp>)`; per-beat live/replay status |
| **Hand-written lessons (doc's #1 unfair item, line 605)** | The lesson is the magic; if a human wrote it the demo is fraud | Show the lesson **forming live** from raw judge critiques; warm graph is a genuine prior-run artifact run end-to-end the night before (§8.6); every lesson cites `evidence_run_ids`; fail on orphan lessons |
| **It's RAG, not memory** | "You just pasted last critique into the next prompt" | Lessons come from **prior completed runs' graph** (cross-run, not in-run); distillation (many→one, thresholded) + brand-conditioned selective retrieval + updating confidence — none possible for a stateless baseline |
| **Baseline looks deliberately crippled** | "You gave one arm memory and hobbled the other" | The baseline is **not** crippled: identical code, it can write traces; it simply has no cross-run **recall** because recall *is* the treatment. Within a single run both behave identically. The asymmetry IS the independent variable |
| **Causal over-claim from one ablation** | A single `--ablate-memory` run is one noisy draw, not proof | Downgrade to "demonstrates lessons are load-bearing"; run ablation across the multi-seed set for any causal claim; anchor causation to targeted-category-delta-with-unrelated-flat |
| **Cognee API mismatch / live break** | The v1.0 and legacy surfaces coexist; a missing function aborts the live warm run | Pin cognee version in package.json; smoke-test the exact calls the night before (incl. any feedback reinforcement); keep the warm run **replayable as fallback** |
| **Depending on an unmerged PR (#3107)** | Session/distillation API is on `dev`, OPEN — it can change or fail to merge before demo day | Pin to head commit `c505f32…`; wrap all Cognee calls behind a `MemoryStore` adapter (one file to swap); confirm the pin with the maintainer; keep a no-session fallback |
| **Latency = dead air** | ~100+ serial calls per run = 5–15 min for a 4-min slot | Pre-compute + replay (disclosed); live-trigger only the cheap upskill-diff; concurrency + caching for re-demos |
| **Designs all look mediocre** | Undercuts the premise; "evolution" looks like noise | Curate a brand with a strong violable rule; rehearse until the warm winner is genuinely sharp and the failure is visible in pixels |
| **Decorative memory-graph glow** | A pulsing node-graph is the #1 fake-looking AI-demo cliché | Ban free-floating pulses; the only earned animation is the Lesson-node → MemberVersion-prompt-line edge synced to the prompt-diff; plain-text "closed loops: warm N / cold 0" fallback |

The honest north star: cold and warm call **identical builder/runner/judge code paths, differing only by a `memory: on/off` flag** shown in the CLI invocation and the RunConfig diff. Put that one-line diff on a slide — it's the strongest credibility move and is currently missing from the doc.

---

## 10. Concrete edits recommended for `tasteloop-design-doc.md`

1. **Summary / hackathon claim (lines 14–16).** *Wrong:* "Evolutionary design teams produce stronger frontend designs than a single static design agent…" — the demo never runs a single-agent arm. *Replace with:* "A multi-agent design system that stores its own critiques in Cognee and upskills its members from them produces measurably better designs on each successive run — same model, same budget, getting better purely by remembering. We make this visible by comparing a warm-memory run against a memory-wiped run on the same brief; both run identical code differing only in a `memoryEnabled` flag." Add the blunt product verdict from §1 (method/capability demo, not a standalone product; user = teams building self-improving agent systems; moat = the cross-run brand-memory graph).

2. **Package Boundary + Primary UX (lines 5, 20–81).** *Wrong:* productized npm package with dual CLI+API. *Replace:* reframe consistently as a **demo harness**; cut the programmatic `generateDesign()` block (70–81) and the dual-surface paragraph (36–41).

3. **In/Out of Scope (lines 149, 163, 169, 171, 736–739, 749).** *Wrong:* multi-framework target; screenshot judging out of scope; Cognee optional; full test scaffolding in scope. *Replace:* fix to a single HTML+Tailwind file; **move "headless render to screenshot (Playwright)" INTO scope**; move "cross-browser/multi-viewport matrices" + MockModelProvider/test scaffolding OUT; make **Cognee mandatory for the warm run** (delete "optional extension" at 171 and the non-goal at 749). Add CLI flags `--mode replay|live` (default replay), `--seed`, `--budget`, `--concurrency`, `--ablate-memory`.

4. **New section `### BrandCompiler` before line 173.** *Missing entirely.* *Add:* the `BrandSpec` from §6; state "the same BrandSpec instance feeds the builder's constraints and the judge's criteria — this keeps the loop closed and the A/B fair; both runs compile the brand book identically, only memory differs."

5. **DesignJudge / Scoring Rubric (lines 222–246, 689–701).** *Wrong:* flat 9-category rubric, all LLM-scored, from raw code. *Replace:* three lanes — **truly-deterministic linters (hashable, config-locked)**, **rendered measurements (pinned, minor variance)**, and **subjective (vision on screenshot only)** per §6. Add "Ranking vs scoring": round-robin paired comparison at temp 0 with order-swap, ranked by win-count, drives selection; the absolute rubric is median-of-3 JSON, critique-only; the judge sees candidates anonymized/shuffled. Bump originality 5→10, comparative and gated by brand fidelity.

6. **DesignSelector + DesignMerger (lines 248–286).** *Wrong:* under-specified parent pick; merger lists "judge feedback" it never receives. *Replace:* deterministic selection (best by win-count + most-different second parent); define firing operationally (excluded from parent pool and next-gen population, kept only in trace). Mark the merger **spec-only/post-MVP** (the MVP ships upskilling). If merging is ever built, input type `MergeInput { parents: Array<{ team; score }> }` so per-category scores + critiques reach the prompt; child inherits per-category winners and lists `patchedFailures`. Add: "Do NOT inherit `agent_evo`'s random-parent, config-only merge (`orchestration.py:600` `random.sample`; merge_teams call `623–629`) — confirmed it passes only configs, never scores/critiques."

7. **EvolutionOrchestrator fairness (line 324).** *Wrong:* fairness is an honor-system sentence assuming two concurrent runs. *Replace:* "The two compared runs are **cold (cached)** and **warm (live)**. The orchestrator constructs one frozen `RunConfig`; on start it computes the warm config hash live and asserts it equals the cold config's hash stored in the cached trace (excluding the memory flag), refusing to run otherwise. On screen it shows a human-readable RunConfig **diff** — every line green/identical except `memoryEnabled: false → true` — with the matching hash beneath as the seal. The judge receives candidates anonymized and shuffled. A per-call cost/latency ledger is logged; both runs are asserted to use identical model, population, and generation budgets." Add a "RunConfig & FairnessManifest" subsection. Unify wording on **cold/warm**.

8. **Cognee Self-Improvement (lines 481, 497–503, 510–525).** *Mostly right — the `remember`/`improve`/`recall` calls are the current v1.0 core API (verified).* *Refine:* state plainly that **recurrence ("require repeated evidence", line 525) is computed in TasteLoop's own code via `observed_count` over real trace records, thresholded — NOT by `memify`/`improve`**, which the docs describe only as enrichment. Note that the v1.0 (`remember`/`recall`/`improve`/`forget`) and legacy (`add`/`cognify`/`search`/`memify`) surfaces coexist, the cognee version is pinned, and `node_set` tagging is real/verified. Add the keyless local-Ollama config and the "enrichment model is part of the memory treatment, not the design/judge model" fairness note. State "Cognee is the experimental treatment, not a nice-to-have."

9. **Add subsection "Provenance & Causation" after line 537.** *Missing.* *Add:* every upskill records `{lesson_id, prompt_diff, target_category, score_before, score_after}`; the demo shows retrieved lesson → exact injected diff (lesson id in gutter) → delta **isolated to the lesson's target category** (the primary causal claim); `--ablate-memory` re-runs the seeded team without memory blocks **across the multi-seed set** to **demonstrate the lessons are load-bearing** (no single-run causation claims); never claim improvement from aggregate score alone; the upskilled instruction renders with a visible provenance link `(judge critique trace-id) → (memory lesson node) → (new instruction line)`.

10. **Demo Script (572–595) + What Would Make The Demo Unfair (597–606).** *Wrong:* the script is a parallel live A/B narrated over JSON; the hand-written-lessons trap (line **605**) is buried. *Replace:* the Demo Script with the **cold-vs-warm single-live-run** narrative + storyboard from §2–§3, including a hard note "Do NOT run two full live evolutions in parallel"; the **explicit cold-run REPLAY disclosure** (badge + narration); per-beat live/replay status; and the "all scores are placeholders until rehearsal" rule. In the unfair list, **bold line 605** and add: "B's lessons must originate from prior runs' persisted graph, run end-to-end beforehand on the same brand — same-run critique forwarding is iteration, not memory"; "every Lesson must cite `evidence_run_ids`; clicking any retrieved lesson must jump to the raw judge output that produced it — no orphan lessons."

---

*Line citations verified against the current `tasteloop-design-doc.md` (DesignSelector header = line 248; hand-written-lessons trap = line 605). `agent_evo` merge anti-pattern confirmed at `orchestration.py:600` and `623–629`. Cognee API verified against docs.cognee.ai (Self-Improvement Quickstart, Python API) and the topoteretes/cognee GitHub overview, June 2026.*
