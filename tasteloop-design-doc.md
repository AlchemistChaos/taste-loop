# TasteLoop — Design Doc & Implementation Plan

> The **what/why** (concept, architecture, memory, UI) and the **how** (modules, data model, build order). The demo's definition-of-done lives in `tasteloop-demo-plan.md` (source of truth for "is the plan correct?"). Rationale: `tasteloop-review.md`.

---

## 0. Thesis

TasteLoop runs a **swarm of AI agents** that build a frontend from one goal + one uploaded brand book, get **rendered and judged**, and **improve**. We run it **two ways at once, side by side**: **Page 1 — No Memory** and **Page 2 — Cognee Memory**. Same brand, same model, same turn budget, same judge — **only the memory layer differs.** Page 2 stores its critiques as traces, recalls them, distills lessons, and upskills its agents; Page 1 does none of that. The demo makes it unmistakable: Page 2's **Traces / Improvements / Lessons** counters climb and its site scores higher, while Page 1's counters sit at zero.

**What we are proving:** a **Cognee memory layer** makes a multi-agent build visibly learn and produce better output. This is a **Cognee capability demo**, not a shippable design product.

---

## 0.1 Locked build decisions (post red-team — authoritative; supersedes looser phrasing below)

| Topic | Decision |
|---|---|
| **Brand book** | `TikTok_guidelines.pdf` is THE demo brand (both pages). `premium-ai-consultancy` was a placeholder → use `examples/tiktok/`. |
| **Design/vision/judge model** | **Codex — GPT-5.4-Codex, medium reasoning** (run via the Codex CLI), vision-capable; used identically by both pages (the id the fairness check prints). Cognee's model is separate (§3.6). |
| **Goal `[PRODUCT]`** | Filled with ONE concrete TikTok product string, baked into the shared RunConfig so both pages get **byte-identical** goals. Goal prompt has a single source (`examples/tiktok/goal.md`); docs quote it, never diverge. |
| **Canonical role ids** | `brand-deconstruct, copywriter, typographer, image-sourcer, info-architect, visual-designer, frontend-implementer, critique` — used verbatim in the diagram, table, and spawn enum. |
| **Imagery** | **Sourced/curated (incl. SVG), NOT live-generated**, for the demo. Role = `image-sourcer`; `images` toolset = search/crawl. Acceptance = "brand-fit imagery (sourced/curated)". Live image-gen = post-demo. |
| **A "turn"** | One agent **run** (incl. the Master), counted regardless of identity. A batch spawn = the Master's turn; each spawned worker's first run = its own turn. Budget = **20/page** (locked, equal) — a **cap, not a target**; finishing well under 20 is good (e.g. ~12–14/20). |
| **Counters** | **Traces** = stored critiques (`trace.written`); **Improvements** = across-run upskills (`member.upskilled`) ONLY; **Lessons** = distilled lessons (`memory.distilled`). Page 1 stays 0 on all three. The in-run gradient fix ticks **Traces**, not Improvements. |
| **SCORE (the UI number)** | **One 0–100 score from a single vision-judge call on the 1280px screenshot**, + the one category memory improved. The 9-category weighted rubric + paired comparison are **post-MVP** (only if the single score proves unstable in the day-0 smoke test). The old weights summed to 93 — discarded. |
| **Headline beat** | **In-run adaptation is the PRIMARY, must-land wow** (Critique→trace→recall→fix; Page 1 keeps the flaw). **Cross-run** (Lessons climb, `v2`, score pulls ahead over ~2 runs) is the **stretch** beat. Halves recording load (2 runs, not 6). |
| **Fairness** | A **hardcoded shared RunConfig** + a printed **`memory: off | on`** line. No hash-gate, no cost ledger for the demo. |
| **Toolsets** | **Fixed per-role toolset bundles** for the demo; the A/B switch is whether the `memory` bundle is present. The Master's dynamic granting / reference-shelf / mid-run re-spawn (§2.1) is a **post-demo capability**, not built for the recording. |
| **Cognee LLM fallback** | If `glm-4.7-flash` fails the day-0 structured-output smoke test → switch Cognee's LLM to **`gemma3:27b`** (already installed, local → keeps "keyless"). Hosted model only as last resort. |
| **Build step 0** | The Cognee+GLM **structured-output smoke test is the FIRST action** (before the atom). Install the pinned PR commit AND **vendor it locally** (clone the SHA) so an upstream force-push can't break the build. |
| **Ablation** | `--ablate-memory` is an **off-screen** statistical backstop, not a third page in the video. |
| **UI tiers** | **Tier 1 (must):** 5 counters + live iframe + score + simple spawn fly-in. **Tier 2 (polish):** memory graph, divergence chart. **Cut:** in-app playback controller (speed-ramp in the video editor). |
| **Packaging** | **Clone-and-run repo** for the hackathon (`npm install` → `npm run setup` / `doctor` / `evolve`) — **NOT** a published package. Structured package-ready (clean modules, MemoryStore adapter, one CLI entry) so it becomes a `tasteloop` npm bin later with no rewrite (§14). |

---

## 1. Core concept

### 1.1 The deliverable & the build

**Each studio builds a real, single-page marketing WEBSITE from the brand book** — **5 sections about the product**, with **written copy** (brand voice, no placeholder/lorem), **selected fonts**, **generated imagery**, and the brand's **colors / type / spacing** applied — output as one self-contained, responsive HTML+Tailwind page shown live in an iframe (§8). The agents produce **both the copy and the design**, not a wireframe.

**The goal prompt (identical for both studios):**

> *Using the attached brand book (PDF), design and build a single-page marketing website for **[PRODUCT]** with **exactly 5 sections**: (1) hero — value proposition + primary CTA; (2) the problem / why now; (3) how it works / key features; (4) proof — results, testimonials, or customer logos; (5) closing CTA + footer. Write **real copy** in the brand's voice (no placeholder text), select **typography** and create **imagery** that fit the brand, and apply the brand book's **colors, type scale, spacing, and do/don't rules**. Output one self-contained, responsive, accessible HTML+Tailwind page. Honor the brand's **negative constraints** (e.g. no generic AI gradients).*

```
upload goal + brand book (PDF)
  → MASTER AGENT reads the brief, writes a plan, and SPAWNS the agents it decides it needs
       (palette: brand-deconstruct · copywriter · typographer · image-gen · info-architect · visual · frontend · critique)
  → BRAND DECONSTRUCT (vision): PDF → design system / tokens (BrandSpec)
  → COPYWRITER: real copy for all 5 sections in the brand voice
  → TYPOGRAPHER: font pairing that fits the brand     IMAGE-GEN: hero / section imagery
  → INFO ARCHITECT → VISUAL DESIGNER → FRONTEND IMPLEMENTER: assemble the WEBSITE (copy + design + images)
  → CRITIQUE AGENT reviews and feeds back (one revise loop):
        · Memory page  : each critique is written as a COGNEE TRACE → recalled mid-build → distilled into lessons → upskill agents
        · No-memory page: NO Cognee — critique is used inline once, then forgotten (Traces / Improvements / Lessons stay 0)
  → render to screenshot → judge (linters + vision)
  → repeat across a few runs; the site gets better
```

Everything happens within a **shared turn budget** (default **20 turns**, a cap not a target; a "turn" = one agent taking the floor and handing off).

### 1.2 Two pages, one difference

Both pages run the **identical** master agent, roster logic, turn budget, model, and judge. The only difference is the **memory layer**:

- **Page 1 — No Memory** (`NullMemoryStore`): the Critique Agent still reviews, but its feedback is used once and forgotten. Nothing is stored, recalled, distilled, or upskilled. **Traces / Improvements / Lessons stay 0.**
- **Page 2 — Cognee Memory** (`CogneeMemoryStore`): every critique is written as a **trace**, **recalled** by teammates mid-build (so the Visual Designer adapts), **distilled** into durable **Lessons** at run end, and used to **upskill** agents next run (`Visual Designer v2`). The counters climb.

The independent variable is **the presence of the memory layer**. Page 1 is a complete, non-crippled multi-agent build — it simply has no memory. (If a reviewer wants to isolate *cross-run* learning specifically, there's an optional in-run-only ablation — but the headline is memory vs no-memory.)

**Turn budget is equal (20/page) — memory buys quality-per-turn, not more turns.** With the same 20-turn cap (which neither page needs to exhaust), the memory page wastes fewer turns repeating mistakes and lands a better site (and improves further across runs). Memory is never given a bigger budget.

---

## 2. The agents

The Master Agent picks the roster from a fixed **role palette** (constrained for determinism — adapted from `agent_evo`'s OneShotBuilder, which has one LLM call emit the roster + handoff graph; we cap the palette, roster size, and turns).

| Agent | Job | Notes |
|---|---|---|
| **Master / Orchestrator** | Reads goal + brand book; writes a plan; decides + **spawns** the roster; sets handoff order within the turn budget | The entry agent. The spawn is visible in the UI (cards fly in). |
| **Brand Deconstruct** | Brand-book PDF → **design system / tokens** (the `BrandSpec`: colors, type scale, spacing, do/don't, negative constraints) | Vision call on rendered PDF pages. Output shown on screen. |
| **Copywriter** | Writes **real site copy** for all 5 sections in the brand voice (headlines, body, CTAs) — no placeholder text | The "copy" half of the deliverable. |
| **Typographer** | Selects a **font pairing** (heading/body) consistent with the brand; maps to web fonts and wires them in | |
| **Image Generator / Art Director** | Creates **hero / section imagery** that fits the brand | Real wow element; image-gen is a knob (cost/latency) — can be a real image-gen call or curated/SVG assets for the demo (see demo plan). |
| **Information Architect** | Sections, hierarchy, content order across the 5 sections | |
| **Visual Designer** | Layout, type application, spacing, visual language → markup | The role most often **upskilled** (`v2`) on the memory page. |
| **Frontend Implementer** | Assemble copy + design + images into the single self-contained HTML+Tailwind page | |
| **Critique Agent** | Reviews outputs and **gives feedback to the others**; can hand back once (the one revise loop) | **Memory page:** every finding is written as a **Cognee trace** (recalled mid-build + distilled into lessons). **No-memory page:** no Cognee — feedback is inline-only and forgotten. Distinct from the final Judge. |

**Turns & handoffs** — we build our **own `TeamRunner`** (`agent_evo`'s `team_runner` is *reference only*; its hard cycle guard `visited→break` would actually kill our revise loop and it has no runtime spawning, so we do not reuse it). Contract: a **turn = one agent run** (incl. the Master), counted regardless of identity; control passes Master→worker→… along the plan; the Critique Agent may hand **back** to one builder exactly once (a bounded re-visit = the single revise loop, *not* blocked by a visited-set); spawned workers enter the runnable set when the Master spawns them; the run ends when the plan completes or the **20-turn budget** is hit (it usually finishes under the cap — that's expected/good). Each agent run emits `agent.spawned`/`agent.turn`/`agent.status` (§7) so the UI counters + grid update. Exact turn/counter accounting is in §0.1.

### 2.1 Master Agent: prompt, spawn tool & toolset palette (adapted from Hermes)

Patterns borrowed from `hermes-agent` (`tools/delegate_tool.py`, `tools/registry.py`, `agent/prompt_builder.py`):

**Spawn tool** — the Master ("Studio Director") spawns workers with a `delegate_task`-style tool. Each worker gets a *fresh focused prompt* (role + goal + context), only the **toolsets** the Master grants, and no shared memory:

```ts
spawn_agent({
  role: "brand-deconstruct"|"copywriter"|"typographer"|"image-sourcer"|"visual-designer"|"frontend-implementer"|"critique",
  goal: string,        // the focused task for this worker
  context: string,     // BrandSpec excerpt + any reference URLs/snippets the Master found
  toolsets: string[],  // which capability bundles this worker gets (granted per worker)
})  // batch form: spawn_agent({ tasks: [ {role,goal,context,toolsets}, ... ] })  → parallel
```

**Toolset palette** (the Master grants *toolsets*, not individual tools — Hermes registry style):

| Toolset | Tools | For |
|---|---|---|
| `web` | `web_search`, `web_extract` | research the product, **design principles**, competitor patterns |
| `images` | `image_search`, `browser_get_images`, `browser_navigate` | **crawl/source** reference + hero imagery |
| `vision` | `vision_analyze` (read images) | deconstruct the brand PDF, judge screenshots |
| `files` | `read_file`, `write_file`, `patch` | author the site files |
| `render` | `render_html` (Playwright → screenshot) | render the page for review / judge / iframe |
| `memory` | `memory.recall`, `memory.writeTrace`, `memory.distill` | **Page 2 only** — the Critique Agent's Cognee traces |

The `memory` toolset is the A/B switch: granted on the memory page, withheld on the no-memory page.

**Lightweight master system prompt (modular skeleton — only inject guidance for granted tools):**
- *Identity:* "You are the Studio Director. Turn the goal + brand book into a plan and a team of specialist agents that build a 5-section website. You don't build it yourself — you plan, spawn, equip, review, and adapt within the turn budget."
- *Inputs:* the goal prompt + brand-book PDF path + (once deconstructed) the BrandSpec.
- *Capabilities:* "Spawn workers with `spawn_agent`. Give each only the toolsets it needs. A worker that needs facts gets `web`; one sourcing imagery gets `images`; etc."
- *When to delegate / not:* mechanical one-liners → do it yourself; specialist or parallelizable work → spawn.
- *Review & adapt loop:* "After each worker reports, check its output against the BrandSpec + goal. If a worker lacked information or a capability, **spawn a follow-up worker with an expanded `toolsets` and/or new reference URLs/snippets in its `context`** (e.g., hand the Visual Designer specific design-principle articles a `web` worker found). Maintain a running **reference shelf** of useful URLs/snippets and pass the relevant ones into each new worker."
- *Stop* at the turn budget; hand the assembled site to render + judge.

**Dynamic tool/reference granting (the key capability).** Two mechanics, both Hermes-grounded:
1. **At spawn:** the Master picks each worker's `toolsets` and injects references into `context` ("give this agent `web` + these 3 articles").
2. **Mid-run adaptation = re-spawn.** Hermes children take context only at spawn, so when the Master reviews work and decides a worker needs more, it **spawns a fresh worker** with the expanded toolset + new refs (the reference shelf carries discoveries forward).
   - **No-memory page:** this adaptation lives only within the run (re-spawn).
   - **Memory page:** the same, **plus** discoveries/critiques persist as Cognee lessons → next-run workers are seeded automatically (the upskilling). Same Studio Director, same mechanic — memory just makes the adaptation compound across runs.

---

## 3. Memory architecture (Cognee)

### 3.1 Two axes (the memory page's internals)

| Axis | Scope | Mechanism (Cognee PR #3107) |
|---|---|---|
| **Horizontal** — teammates learn from each other | within one run | one **session per build**; `session_agent_trace` per agent action; `recall(session_id=…)` semantic retrieval so the Visual Designer pulls the Critique Agent's relevant finding |
| **Vertical** — system learns across runs | across runs | `distill_session()` → durable Lessons → next-run `recall(datasets=[LONG_TERM])` seeding + agent upskilling |

Page 1 has **neither** (NullMemoryStore). Page 2 has both.

### 3.2 Verified Cognee API (June 2026)

Current **v1.0 core**: `remember`, `recall`, `improve`, `forget`. Legacy pipeline: `add`, `cognify`, `search`, `memify`. **Do not assume `improve`/`memify` auto-reweights by recurrence** — PR #3107's distillation curator handles dedup/consolidation (repeated evidence → one consolidated lesson) and novelty (`already_known`).

### 3.3 PR #3107 (`session: session semantic retrieval distillation`, OPEN, base `dev`, head `c505f32…`)

- **Session recall:** `recall(query_text, query_type=GRAPH_COMPLETION, datasets=[DS], session_id=SESSION, user=user)` → recent turns + vector-recalled older turns. `search_session_qa_ids(...)` queries turns.
- **`session_agent_trace`:** `{origin_function, status, method_return_value, error_message, session_feedback}` — the one-liner the UI shows as "currently doing X."
- **`distill_session(SESSION_ID, dataset=DS, user=user)`:** curator → writer → `WrittenLesson { accept, reason(already_known|not_durable|unsupported), statement (entity-anchored), entities[], why_learned }`; returns `DistillationResult { session_id, status, documents[] }`. Reference: `examples/demos/session_distillation_demo.py`.

### 3.4 `MemoryStore` adapter (isolate Cognee behind one interface)

The PR is OPEN; pin the head commit and route **all** Cognee calls through one adapter so we change one file if the API moves.

```ts
export interface MemoryStore {
  resetLongTerm(): Promise<void>;
  openSession(sessionId: string): Promise<void>;
  writeTrace(sessionId: string, t: AgentTrace): Promise<void>;            // session_agent_trace  (Traces counter)
  recallInRun(sessionId: string, query: string, k?: number): Promise<MemoryHit[]>;  // horizontal
  distill(sessionId: string): Promise<DistillResult>;                    // distill_session       (Lessons counter)
  recallLessons(query: string, tags: string[], k?: number): Promise<Lesson[]>;       // vertical seeding
  stats(): MemoryStats;                                                  // counts the UI shows
}
```

`CogneeMemoryStore` (Page 2) and `NullMemoryStore` (Page 1, all no-ops → counters stay 0).

**How the building agents reach memory.** The agents never call Ollama — or even Cognee — directly. The adapter is exposed to them as **tools**: `memory.recall(query)`, `memory.writeTrace(finding)`, `memory.distill()`. The agent calls a tool → the adapter calls Cognee → Cognee (via its env config) calls Ollama for the LLM + embeddings. **Memory-page agents are given these tools; no-memory-page agents are not** — that wiring *is* the independent variable. Three processes in play: **(1) Ollama** daemon @ `localhost:11434` (serves `glm-4.7-flash` + `nomic-embed-text`); **(2) Cognee** (Python lib in-process, or a local server on `:8000`) reads the §3.6 env and talks to Ollama; **(3) the orchestrator/agents** talk only to the MemoryStore tools.

### 3.5 Keyless & local

Point Cognee at Ollama (full setup in §3.6). Cognee's memory model is part of the memory treatment — separate from the design/judge model, so it doesn't affect fairness (the design+judge model/budget is held equal).

### 3.6 Setup: two model roles, Ollama & Cognee install

**Keep two model roles separate — this is the answer to "how do we make sure Ollama is used for Cognee."**

- **Design / vision / judge model** — builds the websites, *reads the brand-book PDF*, and judges. **Codex — GPT-5.4-Codex, medium reasoning** (run via the Codex CLI); must be **vision-capable** since it reads the rendered PDF pages (confirm Codex 5.4 accepts image input). Used **identically by both pages**.
- **Cognee's memory model** — graph extraction (`cognify`), distillation (`distill_session` curator/writer) — **plus embeddings**. This is your **local Ollama** stack. Used by **Page 2 only**.

"Making Ollama used for Cognee" just means setting Cognee's env vars in the process where Cognee runs; Cognee reads them and routes to Ollama. Nothing in the site-building path touches Ollama.

**Install (pin the PR — #3107 isn't merged):**
```bash
pip install "git+https://github.com/topoteretes/cognee.git@c505f326ddb46d8bcc15f963c29ce5c7ccc2053d"
# or @feature/session-semantic-retrieval-distillation
```

**Pull a chat model AND an embedding model — Cognee needs BOTH, for two different jobs:**
- **Chat model (`glm-4.7-flash`) = the brain.** Does the *reasoning*: extracts entities/relationships to build the graph (`cognify`) and **writes the lessons** during distillation. Without it, the Lessons/Improvements counters never move.
- **Embedding model (`nomic-embed-text`) = the search index.** Turns text into vectors so `recall` finds the *relevant* memory by meaning. It can't reason or write lessons.

They are not interchangeable (an embedding model can't write a lesson; a chat model isn't the vector index). Your GLM is the chat model; it **cannot do embeddings**, which is why nomic is separate:
```bash
# Ollama is a global system service; models live in ~/.ollama (NOT in this repo).
# Already installed on this machine: glm-4.7-flash:latest (LLM) + nomic-embed-text:latest (embeddings).
ollama pull nomic-embed-text        # embeddings (768 dims) — REQUIRED, separate from GLM   ✓ done
ollama list                         # GLM tag = glm-4.7-flash:latest
```

**Cognee `.env` (verified format):**
```
LLM_PROVIDER="ollama"
LLM_MODEL="glm-4.7-flash:latest"         # installed GLM (from `ollama list`); no "ollama/" prefix
LLM_ENDPOINT="http://localhost:11434/v1" # note the /v1
LLM_API_KEY="ollama"                     # dummy, but must be non-empty
EMBEDDING_PROVIDER="ollama"
EMBEDDING_MODEL="nomic-embed-text"
EMBEDDING_ENDPOINT="http://localhost:11434/api/embeddings"
EMBEDDING_DIMENSIONS=768                  # MUST match the embedding model (nomic = 768)
```
(If Cognee runs in Docker, use `http://host.docker.internal:11434` instead of `localhost`.)

**⚠ Structured-output risk — smoke-test GLM on day 1.** `cognify` and `distill_session` need the chat model to emit strict JSON. Community testing found small local models often fail this. Before building, run `add → cognify → search` + one `distill_session` on the demo brand with GLM and confirm you get **valid lessons**. If GLM struggles: use a bigger local model for Cognee's LLM only (doesn't affect A/B fairness), or point Cognee's LLM at a hosted model just for graph work (site-building stays keyless), or wrap with JSON-repair/retry and drop malformed lessons. The demo's **Lessons** counter depends on this.

### 3.7 How a trace is made and shared between agents (worked example)

A **trace** is one agent's finding, written into the build's **shared session**, then **semantically recalled** by whichever later agent needs it. Agents don't message each other directly — they leave traces on a shared blackboard and pull back only what's relevant *by meaning*. Walkthrough on the **memory page** (the gradient example):

1. **Write.** The Critique Agent reviews the Visual Designer's draft and finds the hero uses a forbidden gradient. It calls `memory.writeTrace({ role:"critique", finding:"hero uses a banned gradient; brand forbids gradients", target:"visual-designer", severity:"high" })`. The adapter stores it as a `session_agent_trace` in the build's Cognee session (`session_id = run:build`). → **Traces counter ticks**; the UI shows the trace card ("currently doing…").
2. **Store.** Cognee keeps it as a session turn (text + an embedding via `nomic-embed-text`), retrievable by meaning alongside every other agent's turns.
3. **Recall (the sharing).** The Visual Designer's revise step begins with `memory.recall("brand color / gradient rules for the hero")`. Cognee returns the most relevant turns — recent + vector-recalled older — so the Designer gets *the gradient critique* (and the brand's "no gradients" token), **not the whole transcript**. This semantic, role-scoped pull is the difference from dumping the full chat history forward.
4. **Adapt.** The Visual Designer rewrites the hero without the gradient; the re-render shows it fixed (the in-run adaptation beat the audience sees).
5. **Distill (run end).** `memory.distill()` runs Cognee's curator→writer: the recurring gradient finding becomes a durable `WrittenLesson` ("For <brand>, never use gradients in the hero; use flat brand colors"). → **Lessons counter ticks.**
6. **Seed / upskill (next run).** Before building again, `memory.recallLessons(goal+brand tags)` pulls that lesson; it's injected into the Visual Designer's instructions as `[MEMORY:lsn_x …]` → `Visual Designer v2`. → **Improvements counter ticks**; the mistake doesn't recur.

**No-memory page:** none of 1–6 happen. The Critique Agent's feedback is passed inline to the Designer once (the single revise loop) and then gone — no session, no recall, no lesson, no `v2`. The same flaw can reappear, and **Traces / Improvements / Lessons stay 0.** Adding or removing the memory layer cleanly switches this whole behavior on or off — which is exactly the independent variable.

---

## 4. Brand deconstruction (`BrandSpec`)

The Brand Deconstruct Agent + deterministic validation produce a locked `BrandSpec` consumed by **both** the builder (constraints in) and the judge (criteria out) — one source of truth → fair `brandFidelity`.

**Ingesting the brand book — the agent does it itself (agentic, no fixed pipeline):**

The **Brand Deconstruct Agent is a vision-capable Codex agent given just the PDF path + a shell + vision** — it decides how to deconstruct it. Same agent/capability on both pages. The self-serve flow it will typically run:
1. One **PDF** is provided (UI upload, or CLI `--brand ./brand.pdf`) — same file to both pages.
2. The agent **renders the pages it needs to images itself** (e.g. `pdftoppm -png`), because brand books are **visual** (swatches, type specimens, logos) and text extraction alone misses the design language.
3. It **reads those images with vision** and emits the `BrandSpec` JSON below — real palette hexes, fonts, type scale, tone, do/don'ts, negative constraints.
4. Optionally it samples exact colors from the images (deterministic) so `allowedHexes` are real, not guessed.

We **don't hard-code these steps** — we hand the agent the file and capable tools and let it self-serve. This runs on the **design/vision model** (Codex), identically on both pages — separate from Cognee's local model (§3.6). (Smoke-test Probe B verifies this on the real TikTok PDF.)

```ts
export interface BrandSpec {
  tokens: {
    color: { palette: Record<string,string>; roles: {bg:string;fg:string;accent:string;muted:string};
             allowedHexes: string[]; maxAccentCoverage: number };
    type:  { families: {heading:string;body:string;mono?:string}; scale: number[]; weights: number[];
             minBodyPx: number; maxHeadingFamilies: number };
    spacing: { base: number; scale: number[] }; radius: number[];
  };
  hardConstraints: Array<{ id:string; rule:string; check:"tokenLint"|"contrastLint"|"a11yLint"|"regex"; severity:"block"|"penalize" }>;
  negativeConstraints: Array<{ id:string; rule:string; evalHook:"cssLint"|"vision"; cue?:string }>; // "no AI gradient"
  tasteRules: Array<{ id:string; rule:string; weight:number }>;
  voice: { audience:string; tone:string[]; bannedCopyPatterns:string[]; contentProofExpectations:string[] };
  evalCriteria: Array<{ category:string; type:"objective"|"subjective"; checks:string[]; weight:number }>; // the bridge
}
```

---

## 5. Scoring & judging

- **Render first:** Playwright → one 1280px screenshot (hero artifact) + 375/768 for the responsiveness lint.
- **Three lanes:** deterministic linters (token/palette/scale CSS-AST, `tsc`+`eslint`, `axe-core` on DOM, anti-generic gradient/glass/indigo-ramp), rendered measurements (overflow, accent-coverage ratio), subjective vision (hierarchy, layout, originality — on the **screenshot only**, never raw code).
- **Rank by round-robin paired comparison at temp 0** (order-swap de-biased, ranked by win-count); absolute rubric is median-of-3, used only for critique. Judge sees candidates anonymized/shuffled. The **Judge is separate from the in-loop Critique Agent.**
- Weights: brandFidelity 15, visualHierarchy 12, layoutQuality 12, tokenCompliance 10, accessibility 10, originality 10, contentFit/voice 9, responsiveness 8, codeQuality 7.

---

## 6. Architecture & modules

```
src/
  orchestrator/ EvolutionOrchestrator.ts  RunConfig.ts     # runs both pages, enforces fairness, emits events
  agents/  MasterAgent.ts  BrandDeconstruct.ts  Builders.ts  CritiqueAgent.ts
  design/  TeamRunner.ts  Renderer.ts  Judge.ts  Selector.ts  MemberUpskiller.ts
  memory/  MemoryStore.ts  CogneeMemoryStore.ts  NullMemoryStore.ts
  events/  EventBus.ts  events.ts                          # typed events → JSONL log
  model/   ModelProvider.ts                                # hardcoded: Codex gpt-5.4-codex medium (+ mock for tests)
  cli.ts
ui/                                                        # web app: pure replay of the event log
examples/premium-ai-consultancy/{goal.md,brand-book.pdf}
```

The orchestrator is a **pure producer of events**; the UI is a **pure consumer**. Nothing in the UI re-runs logic — it renders state reduced from the event stream. This is what powers both the live view and the recorded, variable-speed demo.

---

## 7. Data model & event schema

### 7.1 Core types

```ts
interface AgentInstance { id:string; role:string; version:number; instructions:string;
  upskilledFrom?: { parentId:string; evidenceRefs:string[]; failuresAddressed:string[]; instructionDiff:string }; }
interface DesignScore { weightedTotal:number; categories:Record<string,number>;
  reasoning:string; failureModes:string[]; judgeModel:string; samples:number; variance:number; }
interface Lesson { id:string; role:string; brandTags:string[]; statement:string; entities:string[];
  whyLearned:string; evidenceRunIds:string[]; }
interface RunResult { runId:string; page:"no-memory"|"memory"; runConfigHash:string;
  winningFiles:Record<string,string>; bestScore:number;
  totals:{ agentsSpawned:number; turns:number; traces:number; improvements:number; lessons:number }; }
```

### 7.2 Event schema (the backbone; counters are reductions over it)

Every event also carries `gen` (the run/generation index, 0-based) so one `--generations N` invocation emits **a single replayable log spanning all runs** and the divergence chart can plot score per `gen`.

```
run.started      { page, gen, goal, brandHash, runConfigHash, model, turnBudget }
master.planned   { plan, roster:[roles] }
agent.spawned    { agentId, role, version }                 → Agents spawned
agent.status     { agentId, doing }                         → "currently doing X"
agent.turn       { agentId, turnIndex }                     → Turns (x/20)
brand.deconstructed { tokens }
trace.written    { agentId, failureMode?, summary }         → Traces made   (memory page only)
memory.recalled  { agentId, hits:[{lessonId, snippet}] }    (horizontal; memory page only)
design.rendered  { htmlRef, screenshotRef }                 → htmlRef = the iframe loads it; screenshotRef = judge/vision only
critique.made    { targetAgentId, findings[] }
team.judged      { score, categories, failureModes[] }
member.upskilled { fromId, toId, role, version, instructionDiff, lessonIds[] }  → Improvements (memory page only)
memory.distilled { sessionId, lessonsAccepted }             → Lessons       (memory page only)
score.updated    { page, gen, bestScore }                   → divergence (plotted per gen)
run.finished     { page, gen, bestScore, totals }
```

Each render pass persists its **self-contained HTML** to `runs/<id>/snapshots/<page>-<gen>-<seq>.html`; `design.rendered.htmlRef` points at it and the UI's `<iframe>` loads that file (srcdoc/src) on replay — so "iframe reloads as the build progresses" works from the pure event log. Tailwind is **vendored/precompiled inside each snapshot** (no CDN → no FOUC, offline-safe).

**The five big numbers** = `agent.spawned` count, `agent.turn` count (vs budget), `trace.written` count, `member.upskilled` count, `memory.distilled.lessonsAccepted` count. On Page 1 the last three never fire → they stay 0.

---

## 8. UI — mission control

Full-screen web app (React + Tailwind + framer-motion; graph via Cytoscape/react-flow; chart via visx). A **pure replay of the event log** (live socket or file) with a playback controller (play/pause/seek/speed/hold-on-beat). Two pages side by side, building simultaneously.

```
┌── PAGE 1 — NO MEMORY ───────────────┐ ┌── PAGE 2 — COGNEE MEMORY ───────────┐
│ Agents 6 · Turns 13/20              │ │ Agents 7 · Turns 12/20              │
│ Traces 0 · Improvements 0 · Lessons 0│ │ Traces 14 · Improvements 4 · Lessons 6│
│ ┌ agent grid (cards: role, vN,     │ │ ┌ agent grid (spawn fly-in,         │
│ │  "currently doing X", turns,     │ │ │  active pulse, fired = grey)      │
│ │  active pulse) ─────────────────┐│ │ │ ─────────────────────────────────┐│
│ └─────────────────────────────────┘│ │ └──────────────────────────────────┘│
│ ┌ LIVE SITE in <iframe> ─┐│ │ ┌ LIVE SITE in <iframe> ──┐│
│ └─────────────────────────────────┘│ │ └──────────────────────────────────┘│
│            SCORE 71                  │ │            SCORE 86                  │
└─────────────────────────────────────┘ └──────────────────────────────────────┘
   DIVERGENCE chart (A vs B best score)  ·  MEMORY GRAPH (Page 2 lessons growing)
```

Each page = a **pinned metrics bar** (the five big numbers) above an **`<iframe>` of the actual website being built** (a real homepage derived from the brand — hero, sections, CTA, as one self-contained HTML+Tailwind file) that **reloads with the Implementer's latest HTML each render pass** so the audience watches the real site materialize, plus the agent grid beneath.

Design rules: **big, persistent counters** (readable when sped up); **one focus at a time**; spawn = fly-in, fired = desaturate+shrink (visible graveyard); the only "memory graph" animation that earns screen time is a Lesson→agent edge synced to a prompt-diff (ban decorative pulses). Focus overlays for the beats: in-run critique→adapt pop, `v1→v2` prompt-diff, final 2-up reveal.

---

## 9. Demo

Full spec and acceptance criteria: **`tasteloop-demo-plan.md`** (source of truth). In short: **run both pages for real, side by side (~10 min), recording the event logs + real screenshots/scores; render the UI replay; edit to ~60s with variable speed** (fast through bulk, real-time on the beats), with a `▶ N× speed` badge. Headline beats: master agents plan & spawn → build + critique → Page 2 mid-build adaptation → across-run Lessons/score pull-ahead → 2-up reveal.

---

## 10. Implementation plan

### 10.1 Build order (existential risk first)

1. **The atom — design → render → judge.** goal + BrandSpec → one model call → HTML/Tailwind → Playwright screenshot → split-rubric judge + one named failure mode. If a single judged design isn't legible and earned, stop.
2. **EventBus + schema.** Emit from the atom; persist JSONL. Everything else is more events.
3. **Master Agent + roster + Brand Deconstruct.** Plan → spawn (visible) → tokens.
4. **Run loop + Critique Agent.** Turn budget, handoffs, one revise loop, render, judge, keep best.
5. **MemoryStore + memory page.** Sessions, `writeTrace`/`recallInRun` (horizontal), `distill`/`recallLessons` + upskilling (vertical). `NullMemoryStore` for Page 1.
6. **The UI.** Mission control replaying the log (can start in parallel with 3–5; only needs the schema).
7. **Record for real + multi-seed sweep.** Run both pages end-to-end on the demo brand the night before; capture logs; run the ablation for the aggregate backstop.

### 10.2 Cut from MVP

npm/dual-API productization; multi-framework (one static HTML+Tailwind file); team merging (post-demo; lead with upskilling); free-form agent DAG (constrained role palette + turn budget instead); Elo/Bradley-Terry (use win-count); nested JSON trace tree (event log instead); "Cognee optional" (mandatory for Page 2).

### 10.3 Top risks → mitigations (full table in `tasteloop-review.md` §9)

- **Judge nondeterminism** → paired comparison + temp 0 + median-of-3 + variance bars; linters carry objective categories.
- **"It's just RAG"** → cross-run distilled (deduped, entity-anchored) lessons + semantic recall; Page 1 structurally cannot do this.
- **Hand-written lessons (unfair)** → lessons form live from real critiques; each cites `evidenceRunIds`; fail on orphan lessons.
- **OPEN PR #3107** → pin head `c505f32…`; all Cognee behind `MemoryStore`; confirm with maintainer; `NullMemoryStore` fallback.
- **PDF parsing on stage** → pre-vet the brand-book PDF; Brand Deconstruct Agent tested against it beforehand.
- **Local model can't do structured output** → small Ollama models often fail Cognee's `cognify`/`distill` JSON → smoke-test your GLM **day 1** (§3.6); if it fails, use a bigger model for Cognee's LLM only (doesn't affect fairness).
- **Page 1 looks crippled** → identical system minus the memory layer; same model/turns/judge; shown via the one-line config diff.

### 10.4 Fairness manifest (asserted at start, shown on screen)

One frozen `RunConfig`; `sha256(canonicalJSON(config − memoryFlag))` must match across pages or the run refuses to start. Identical model, roster palette, turn budget (20), judge; per-call cost/latency/seed ledger; judge blinded; linter config hashed and equal.

---

## 11. CLI

```bash
tasteloop evolve \
  --goal ./goal.md --brand ./brand-book.pdf \
  --turns 20 --generations 3 --seed 42 \
  --pages no-memory,memory \      # run both; emits two event logs
  --record ./runs/<id>
tasteloop ui ./runs/<id>          # serve the mission-control replay
tasteloop evolve … --ablate-memory   # in-run-only ablation (isolates cross-run learning)
```

---

## 12. Appendix — Cognee call sequence (memory page)

```python
# Page 1 (no memory): NullMemoryStore — no calls.
# Page 2, each run: open one session per build
SESSION = f"{run_id}:{build_id}"
# each agent step:
hits = await recall(query_text=role_query, query_type=GRAPH_COMPLETION, datasets=[DS], session_id=SESSION, user=user)
#   ... agent acts; emit session_agent_trace (origin_function, status, return, session_feedback)  → Traces counter
# run end:
res = await cognee.session.distill_session(SESSION, dataset=LONG_TERM, user=user)   # curator→writer → WrittenLesson[]  → Lessons counter
# next run seeding + upskilling:
lessons = await recall(query_text=goal_brand_query, datasets=[LONG_TERM], user=user)  # inject as [MEMORY:lsn_x …]  → Improvements
```

Pin the cognee version; smoke-test `recall(session_id=…)`, `distill_session`, `session.get_session`, `search_session_qa_ids` against the pinned commit before relying on them live.

---

## 13. References & docs (hand these to the agents)

Any agent that touches Cognee or deconstructs the brand should be given these as context.

**Cognee**
- **LLM-readable index (point agents here first):** https://docs.cognee.ai/llms.txt
- Docs home: https://docs.cognee.ai/
- Self-improvement quickstart (the `recall → improve → recall` shape): https://docs.cognee.ai/guides/self-improvement-quickstart
- Local-models / Ollama provider config: https://docs.cognee.ai/setup-configuration (LLM + embedding providers)
- GitHub: https://github.com/topoteretes/cognee
- **PR #3107 (session memory + distillation — what we pin):** https://github.com/topoteretes/cognee/pull/3107 — head `c505f326ddb46d8bcc15f963c29ce5c7ccc2053d`; reference demo `examples/demos/session_distillation_demo.py` (ships inside the installed package).

**Demo brand book:** `/Users/chaosalchemist/Desktop/TikTok_guidelines.pdf` (70 pages) — both pages build from this.

**Local config:** `cognee.env.example` (this repo) — verified Ollama/GLM/nomic env vars.

**Reference architecture (ideas only, not ported):** `agent_evo` — `OneShotBuilder` ≈ the master-agent-that-spawns; `team_runner` ≈ the turns/delegation model. Source extracted at `agent_evo_extracted/`.

> Tip: `llms.txt` is written for LLMs to read — give it to any agent wiring up or querying Cognee so it uses the current API, not guesses.

---

## 14. Packaging — clone-and-run now, package-ready later

For the hackathon, **do not publish an npm package** (it adds `postinstall`/publish friction we don't need). Ship a **clone-and-run repo**, structured so it becomes a package later with ~no rewrite.

**Now (hackathon):**
```bash
git clone … && cd taste-loop
npm install
npm run setup        # idempotent bootstrap (same logic as a future `tasteloop setup`)
npm run doctor       # day-0 smoke test: Ollama up? models present? cognee passes add→cognify→distill_session w/ a valid lesson?
npm run evolve -- --goal examples/tiktok/goal.md --brand /Users/chaosalchemist/Desktop/TikTok_guidelines.pdf --pages no-memory,memory --record ./runs/demo
npm run ui -- ./runs/demo
```

**`npm run setup`** (shells out, idempotent): check Node + python3 → ensure Ollama → `ollama pull nomic-embed-text` → create `.venv` + `pip install` the **vendored** `cognee@<PR-pin>` (commit vendored in-repo so an upstream force-push can't break it) → write cognee `.env` from `cognee.env.example` → (optional) start the local Cognee server. Large models are **prompted, not auto-pulled**; if GLM fails `doctor`, fall back to `gemma3:27b` (§0.1).

**Package-ready structure (so "later" is trivial):** clean `src/` module boundaries (orchestrator / agents / design / memory / events / ui — §6), all Cognee behind the `MemoryStore` adapter (§3.4), one CLI entry (`src/cli.ts`) surfaced as `npm run` scripts now. **Becoming a package later = add `package.json` `bin` (`tasteloop`) / `exports` / `files` + `npm publish`** — each `npm run X -- …` maps 1:1 to a future `tasteloop X …` command. No restructure. (The §11 `tasteloop …` commands are the eventual bin; for now read them as `npm run …`.)
