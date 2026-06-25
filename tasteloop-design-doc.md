# TasteLoop — Design Doc (current architecture)

> **Status:** living doc, rewritten 2026-06-25 to match the code as it actually is.
> Everything earlier in this file's history is superseded. If something here disagrees
> with an older doc (`tasteloop-improvement-plan.md`, `CONTRACTS.md`, `tasteloop-review.md`,
> `tasteloop-demo-plan.md`, `tasteloop-design-doc.original.md`), **this file wins** — those are historical.

---

## 1. What TasteLoop is

A local demo that proves **in-run memory makes an AI build better**. Two "studios" build the
**same** TikTok-for-Business marketing homepage **side by side**, turn by turn:

- **Page A — no-memory:** builds + iterates with no memory between turns.
- **Page B — memory (Cognee):** same everything, but it **recalls what it learned on earlier turns**
  and folds it into the next build.

The thesis: over a run, the **memory page should improve more / mature faster** than the no-memory page.

**Key framing (locked decisions):**
- The demo is **IN-RUN, turn-by-turn self-improvement — NOT cross-run.** A *run* starts from empty
  memory; a *turn* (= one "generation") improves on the prior turn. **Memory resets every run.**
- Both pages use the **same model, same tools, same design system.** The **only** difference is that
  the memory page can **recall its own prior-turn traces**. (That's the independent variable.)
- All critique/grading is **LLM vision** (no regex brand rules).
- **Keyless:** no `OPENAI_API_KEY`, so **no images** — the page is type-led (type is the artwork).

---

## 2. Models & infrastructure

| Role | What | How |
|---|---|---|
| **Builder + Critique** | **Codex `gpt-5.4`, `medium` effort** | `codex exec` CLI, **keyless** (your ChatGPT login). `web/src/codex.mjs` (`codexRun`, env `CODEX_MODEL`/`CODEX_EFFORT`). Builds BOTH pages. |
| **Cognee memory LLM** | Local **Ollama `glm-4.7-flash:latest`** | graph extraction + distill. `cognee.env`. |
| **Embeddings** | Local **fastembed `BAAI/bge-small`** (384-dim) | Cognee retrieval. |
| **Render** | Headless Google Chrome | `web/src/render.mjs` `renderShot(html, png)` — every page/critique grades the *rendered* PNG, not the HTML. |

There is **no API key** in play; the build is free via the Codex CLI. Cognee runs from a venv
(`/tmp/cognee_smoke/venv`, cognee 1.2.1); persistence is redirected with `TASTELOOP_COGNEE_HOME`.

---

## 3. The run (`web/run.mjs`)

```
GENS=12 MEM=cognee node web/run.mjs
```
- `GENS` = generations (turns). Default **4**, floor 2.
- `MEM` = `shim` (in-process fake, default) or `cognee` (real bridge).
- `ABLATE=1` / `--ablate-memory` = memory page recalls but the recalled rules are **stripped** before
  the build (the counterfactual control).
- Runs `runPage("no-memory")` and `runPage("memory")` **in parallel** (`Promise.all`).
- Streams events to `web/run/events.json` (`{runId, turnBudget, live, events:[...]}`), which the UI replays.
- Writes page snapshots + before/after PNGs to `web/run/snapshots/`.

---

## 4. The per-turn spine (`web/src/orchestrator.mjs` → `runPage`)

Each generation (turn) runs these steps. **There is NO judge anymore** (removed 2026-06-25 — see §6).

```
1) RECALL   [memory only]  recall prior-turn traces from Cognee → fix-rules for this turn
2) BUILD    [both]         make / carry-forward the page (see turn structure below)
3) CRITIQUE [both]         Codex vision audits the rendered page → {flaws, upgrade}
4) TRACE    [memory only]  write VERIFIED traces (only flaws the revise actually fixed)
5) REVISE   [both]         apply the fix-rules to the page
   └ RESOLVED-PROOF [both] re-critique the after-shot: "was each flaw actually removed?"
                           → this is the "did it improve?" SIGNAL (replaces the judge)
   (no judge / no score)
7) FEEDBACK [memory only]  Cognee feedback, scored from the resolved-proof (fixes stuck? 5 : 3)
8) IMPROVE  [memory only]  Cognee improve() — reweight recall
9) DISTILL  [memory only]  Cognee distill_session → "lessons" counter
   → carry the page forward to the next turn
```

### Turn structure (the carry-forward + lean/surgical model)

The page is **carried forward** — turn 0 builds it from scratch; **every later turn improves the
SAME page** (in-run self-improvement). Both pages carry their own page.

- **Turn 0 (`gen 0`) — FULL BUILD.** The master (`planTeam`) authors a roster; agents build the page
  fresh (`codexBuildSite` fresh branch). Only turn that builds from zero.
- **Turn 1 (`gen 1`) — LEAN whole-page refine.** `isLeanTurn` = true: **skip the roster**, carry the
  page, and improve the *whole* page via critique → revise. No rebuild.
- **Turn 2+ (`gen ≥ 2`) — LEAN + SURGICAL token-gap fix.** `surgicalTurn` = true: the critique runs a
  **token-gap audit** (the page vs the design-system inventory `designInventory()`) and returns the
  single biggest gap; the revise applies **only that targeted fix + this turn's flaws + recalled
  traces**, keeping unrelated sections stable (`codexBuildSite` revise branch with `surgical: true`).

> **Why lean turns exist:** turn 0 spinning up the whole roster every turn was slow *and* churned the
> page (re-rolling copy each turn). Lean turns make later turns fast and stable (the page *matures*).

### What's MEMORY-only vs BOTH

- **Both pages:** build, critique, revise, resolved-proof. (The resolved-proof runs on both because it
  drives the **Improve** counter for both.)
- **Memory only:** recall, trace-writing, feedback, improve, distill. The no-memory page does none of
  these — it has no memory between turns.

---

## 5. The design system + the builder prompt

- **`web/run/design-system.css`** — the real CSS, **inlined into every build**. Defines `--color-*`,
  `--font-*`, `--space-*` tokens and the `.ds-*` classes (hero, display, grid-asym, statement, quote,
  bignum, stat-band, steps, cta-band, feature-grid, card, chip, emphasis marks, patterns, bubbles, …).
  The builder composes the page from these — it does NOT inline its own CSS.
- **`web/run/tokens.json`** — palette, type scale, spacing, radius, shapes (summarized into the prompt by
  `summarizeTokens()`).
- **`web/run/brandspec.json`** — voice, tagline (`Don't Make Ads. Make ___.`), copy pattern, personality,
  brand DON'Ts, copy examples (fed into the prompt as `brandVoice`).

**The builder prompt** (`codexBuildSite`, rewritten 2026-06-25 from a 2-agent prompt-engineering pass):
- **Fresh build:** ONE prioritized creative move → section-by-section JOBs (each carried by a named
  `.ds-*` component) → the brand **copy engine drives the hero** → a single **9-item RULES checklist**
  (every rule stated **once** — no more 3-4× repetition) → **"WHEN IN DOUBT, OMIT"** (kills stray marks
  / dead voids) → fix-rules (if any) in a **verify-gated** block right before the output.
- **Revise build:** the fix-rules **lead** (the whole reason for the turn) and sit just before the HTML,
  verify-gated ("make each defect DISAPPEAR"); fresh-build craft is stripped so it doesn't invite a
  rebuild; lean guardrails + tokens keep it on-system.
- Fix-rules are **capped to the newest ~12** (backstop against the recalled-rules "wall").

---

## 6. Why there's no judge anymore

There used to be a per-turn **two-axis vision judge** (`judge.mjs`, `judgeSite`) producing a 0-100 score.
It was **removed** because:
- the score was a near-binary, noisy coin-flip (brand axis swung ±40 on the same page) — it couldn't
  measure improvement; and
- the demo's proof is the **mechanism** (the memory graph, traces, lessons), not a number.

**What replaced it:** the **RESOLVED-PROOF** — a vision check that already existed ("was this flaw
actually removed in the after-shot?"). It now runs on **both** pages and is the per-turn
"did-it-improve?" signal. It drives:
- **Improve** counter = turns that verifiably fixed ≥1 flaw,
- **Cognee feedback** (`feedbackScore` from the resolved count),
- the **verified traces** (memory-only).

`score.updated` is still emitted but is now just a `{gen, page}` **marker** so the UI's Turns tile
advances. `judge.mjs` + `codexJudgeTwoAxis` remain in the tree as **dead code** (unused) in case the
judge is ever wanted back.

> **`keep-better`** (a "only adopt a revise if it scored higher, else revert" rule) was prototyped and
> then **reverted** — it is NOT in the code. With no judge and no keep-better, **nothing catches a
> regression** except the next turn's critique; the page can wobble down before recovering. Accepted
> trade-off.

---

## 7. The memory mechanism (Cognee)

- **`web/src/memory.mjs`** — JS wrapper: `recallInRun`, `writeTrace(s)`, `feedback`, `improve`, `distill`,
  `stats`. `MEM=shim` is an in-process fake; `MEM=cognee` shells to the Python bridge.
- **`web/src/cognee_bridge.py`** — the real Cognee 1.2.1 v1 session API (remember/recall/add_feedback/
  improve/distill_session). Recall uses CHUNKS_LEXICAL (verbatim). Recall is **NOT node_name-filtered**
  (that filter starved it).
- **Traces** are **verified**: a finding becomes a trace only after the resolved-proof confirms the
  revise removed it, stored as a forward `"Do not reintroduce X"` rule, deduped per run.
- **The memory advantage** = those recalled traces are folded into the memory page's build/revise
  (capped to ~8 in the orchestrator). The no-memory page never gets them.

Known weakness (from the audit): distilled "lessons" are largely duplicates of raw traces, and
`feedback/improve` only do real work under `MEM=cognee` (qa_id present).

---

## 8. The UI (`web/index.html` + `web/app.js`)

- Two columns (Page A / Page B). Title + **HUD metrics on one line** (score was **removed**):
  - **Agents** = agents spawned.
  - **Turns** = **generations completed** (the real turn-by-turn axis; NOT agent-turns — that was a bug).
  - **Traces** = verified traces written (memory).
  - **Improve** = turns that verifiably fixed ≥1 flaw (resolved-proof).
  - **Lessons** = distilled lessons (memory).
- **Live iframe** of each page (updates on `design.rendered`).
- **Memory graph** panel — brand-token nodes with lesson/trace edges (bigger/clearer after the rewrite).
- **Resolved-proof panel** — before/after screenshots of a fixed flaw (path-fixed so the PNGs load).
- **Agent lane** — rolling list of spawned agents.
- The app **polls `events.json` every 600 ms** and applies new events (it does NOT re-run anything).
  Refreshing the browser replays from turn 0 — that is not a re-run, just the UI animating forward.

---

## 9. File map

| File | Role |
|---|---|
| `web/run.mjs` | entry point — parallel `runPage` for both pages, env (`GENS`/`MEM`/`ABLATE`) |
| `web/src/orchestrator.mjs` | **the spine** — `runPage`, the per-turn loop, carry-forward, lean/surgical turns, resolved-proof, memory steps |
| `web/src/codex.mjs` | all Codex calls — `codexRun` (codex exec), `codexBuildSite` (builder prompts), `codexCritique` (audit + token-gap), `summarizeTokens`, `designInventory` |
| `web/src/skills.mjs` | roster skills (`runHtmlBuild`, `runCritique`, `runRecall`, `runTrace`, …), `reviseHtml`, `designSystemBrief` |
| `web/src/team.mjs` | the master — `planTeam` (memory-aware roster authoring) |
| `web/src/memory.mjs` | Cognee JS wrapper (shim + bridge) |
| `web/src/cognee_bridge.py` | Python bridge to Cognee 1.2.1 |
| `web/src/brand.mjs` | `deconstructBrand` (reads brandspec.json/tokens.json) |
| `web/src/render.mjs` | headless-Chrome `renderShot` |
| `web/src/judge.mjs` | **DEAD CODE** — the old two-axis judge, no longer called |
| `web/run/design-system.css` | the `.ds-*` design system, inlined into every build |
| `web/run/tokens.json`, `web/run/brandspec.json` | brand/design data |
| `web/index.html`, `web/app.js` | the Mission-Control UI |
| `web/run/events.json` | the streamed event log the UI replays |

---

## 10. Current state (2026-06-25) & open issues

**Recently landed (committed to `main`):**
- Audit fixes 1-4 (`64cc118`): unblocked memory on surgical turns; stopped the prompt re-commanding
  the stray-mark/pattern glitches; un-froze the surgical revise (recurring flaws now removed, not
  preserved); fixed the `Personality: [object Object]` bug.
- Judge removed (`d9e0f71`): resolved-proof is the new signal; Improve/feedback/traces re-pointed.
- Builder prompt rewrite (`9c337d3`): slim, rules-once, section-jobs, copy-engine hero, fix-rules prominent.

**How we got here (the debugging arc, so it isn't re-litigated):**
- The in-run loop was a **no-op** for a long time — the revise step threw `snapDir is not a function`
  every turn (a param shadow), so memory never touched the page. Fixed.
- Pages were **rebuilt from scratch** every turn (ctx reset in the loop) — fixed with carry-forward.
- An 8-agent root-cause audit found the real top causes of bad output: memory was **severed** on
  surgical turns, the prompt **re-commanded** the exact glitches, surgical **froze** flaws, the
  `[object Object]` bug, and a coin-flip judge. Fixes 1-4 + judge removal + the prompt rewrite address
  these.

**Known limitations / next levers:**
- **Imagery ceiling.** Keyless = no photos → text-only pages cap around ~80 ("strong editorial" at best).
  The single biggest quality unlock would be real imagery (an API key for `gpt-image-1`, or stock/asset
  images) — deliberately deferred.
- **Prompt size.** The fresh prompt is ~9k chars; `tokenSummary` (~2.5k) still dominates — slimming it
  is a clean follow-up.
- **No regression safety-net.** No judge + no keep-better → a bad turn can stick until the next critique.
- **Memory A/B not yet cleanly demonstrated.** The mechanism works (traces accumulate, recall compounds),
  but a clear, repeatable "memory beats no-memory" result over a full run is still the open goal.

**In flight at handoff:** a `GENS=12 MEM=cognee` run (`run_1782382754192`) testing all of the above —
results were not yet reviewed. The model is still **gpt-5.4 medium** (a requested change to gpt-5.4 HIGH
+ "fast" was interrupted and **not applied**).

---

## 11. Locked design decisions (do not silently reverse)

1. **In-run, turn-by-turn — not cross-run.** Reset memory every run. No durable cross-run lessons.
2. **Both pages share model + tools + design system.** The only memory-page-exclusive capability is
   **recall** (and the memory-side trace/feedback/distill). Don't strip quality tools from no-memory.
3. **All-LLM critique** (vision) — no regex brand rules.
4. **Keyless** (no images) unless a key is added. No invented placeholder imagery.
5. **Master authors the roster per page** (not a fixed identical roster) — "let the agent decide what it
   needs." The independent variable is access-to-recalled-memory.
6. **Cognee's LLM is local Ollama `glm-4.7-flash`**; Codex cannot be Cognee's LLM (Codex is a CLI actor,
   not an API endpoint). Build/critique stay on Codex gpt-5.4.
