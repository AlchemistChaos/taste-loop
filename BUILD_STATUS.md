# TASTELOOP — BUILD STATUS & COMPLETED WORK (live record)

> Self-contained handoff record (context may roll). The working app is in `web/`. Full concept/plan: `tasteloop-design-doc.md` + `tasteloop-demo-plan.md`. Critique: `tasteloop-review.md`.

## What it is
A local web demo: two AI **studios** build a TikTok marketing site side-by-side — **Page 1 "No Memory"** vs **Page 2 "Cognee Memory"** — proving Cognee memory makes the build measurably better. Recorded → sped to ~60s; also live-replayable in the UI.

## RUN IT
```bash
# main (work-in-progress) — http://localhost:8080
node web/serve.mjs
GENS=2 MEM=cognee node web/run.mjs      # produces web/run/events.json + snapshots (streams live)

# frozen backup (memory WINS 64v54) — http://localhost:8090
PORT=8090 node web-backup/serve.mjs

# Cognee: venv /tmp/cognee_smoke/venv ; bridge web/src/cognee_bridge.py ; env cognee.env
```
- **"⟲ Replay" button** = timed client-side replay of the saved run (NO re-run / no model calls); **1x/4x/8x** speed buttons scale it (8x ≈ tight demo).
- Agent cards show **names**; **click a card** to expand its master-authored prompt + skills.

## MODELS (locked)
- **Build/design/judge agents: Codex `gpt-5.4` medium** via `codex exec` (ChatGPT login, keyless). ⚠️ `-codex` variants (`gpt-5.4-codex`, Spark `gpt-5.3-codex`) are **REJECTED on a ChatGPT account** — only plain `gpt-5.4`/`gpt-5.5` work.
- **Cognee LLM + embeddings: local Ollama** — `qwen2.5:7b-instruct` (LLM) + **fastembed** (embeddings; nomic-embed-text also pulled). Keyless.
- **Images: OpenAI `gpt-image-1`** — needs `OPENAI_API_KEY`; `image_gen` skips gracefully if unset.

## COGNEE USAGE (we DO use it — central)
Traces are **stored in the Cognee graph** (`add`+`cognify`) and **recalled via Cognee graph search** (`search` GRAPH_COMPLETION, session-scoped). That IS the core engine. The only step we stopped depending on is `distill_session` (local model mangled it to "Got it.") — we recall the raw traces from the graph instead, and can synthesize rules via Cognee GRAPH_COMPLETION rather than distill. The Cognee graph (nodes/edges) is the proof surface for 2.9.

## ARCHITECTURE (web/src unless noted)
- `run.mjs` — entry; both pages concurrent; **streams** web/run/events.json live; GENS env (default 2); MEM=none|shim|cognee.
- `orchestrator.mjs` — per gen: master plan → run every agent → build → critique → (memory: traces→recall→**revise this page** [2.8]) → judge → distill. Emits all events.
- `team.mjs` — **the MASTER**: `planTeam()` real model call authoring the team `[{id,role,instructions(prompt),tools(skills),produces}]`; `ROLE_PALETTE`, `SKILL_PALETTE`; weaves recalled lessons into prompts + grants matching skills (lesson→skill-grant).
- `skills.mjs` — `runAgent()` runs each master-spec'd agent with its granted tools; skills: `html_build`(codex), `svg_image`, `cognee_recall`/`cognee_trace`, `image_gen`, `a11y_check`, `contrast_check`, `copy_lint`; `brandRuleViolations()` deterministic lint; `reviseHtml()` [2.8].
- `codex.mjs` — `codexBuildSite({brand,goal,copyHint,lesson,rules,priorHtml})` real HTML via `codex exec` (inlines design-system.css, NO fallback; rules+priorHtml = revise mode [2.8]); `codexRun`; `codexJudge` (vision: screenshot + `codex exec -i`).
- `render.mjs` — `renderShot(html→PNG)` via headless Chrome.
- `judge.mjs` — `judgeSite()` = codexJudge (vision on the screenshot) − brandRuleViolations penalty.
- `image.mjs` — `generateImage()` OpenAI gpt-image-1 (OPENAI_API_KEY; graceful skip).
- `memory.mjs` — `makeMemory(none|shim|cognee)`; cognee → bridge subprocess; `writeTrace(s)`/`recallInRun`/`recallLessons`/`distill`; degenerate-lesson filter.
- `cognee_bridge.py` — REAL Cognee (add/cognify/search/distill_session) on Ollama+fastembed; persists `~/.tasteloop_cognee`; cmds open_session/write_trace/recall_in_run/distill/recall_lessons.
- `brand.mjs` — `deconstructBrand()` real from `~/Desktop/TikTok_guidelines.pdf` → BrandSpec + `brand.tokens` + `brand.designSystemCss`.
- `web/run/design-system.css` + `tokens.json` — REAL design system from the PDF (Razzmatazz #FE2C55, Splash #25F4EE, Sofia Pro fonts, type scale, do/don'ts — verbatim).
- `web/index.html` + `web/app.js` — mission-control UI: 2 columns, 5 counters, click-expand agent cards, live iframes, score, **Replay** (timed) + speed, **upskill prompt-diff panel**.
- `web/serve.mjs` — zero-dep static server (PORT env).

## TIERS COMPLETED
- ✅ **Core** — master-spawn, real Codex-built HTML (no fallback), real Cognee bridge, brand-PDF deconstruction, mission-control UI, event-stream + timed replay.
- ✅ **2.5** — master authors the whole team (count + per-agent prompts + skills); every agent real; Codex-HIGH judge. **Result: memory WON 64 vs 54** → this is the frozen **:8090 backup**.
- ✅ **2.6** — vision judge (render→screenshot→`codex -i`), prompt-diff/provenance climax + `--ablate-memory`, image-gen wired, lesson→skill-grant.
- ✅ **2.7** — design-system inlined into builds, judge→medium, progressive render (**preview-on-copy**), batch-cognee, lesson quality filter. **Result: sites richer/on-brand BUT memory LOST 38v42** — the lesson filter starved memory (distill emitted "Got it.", lessons=0).
- 🔄 **2.8 (RUNNING — task wq9ztr4l5)** — feed **RAW traces** (recalled from Cognee) into the build as rules + **in-run revise loop** (critique → recall traces → revise THIS page). Goal: memory wins because traces visibly fix the page (add #25F4EE accent, remove gradient).
- ⏳ **2.9 (QUEUED — after 2.8)** — **PROVE learning**: deterministic `trace.resolved` checks (the named flaw is verifiably gone, with evidence), ablation counterfactual (no-memory/ablated keeps the flaw), UI provenance panel (trace→recall→revise→resolved→score Δ), per-run resolution rate climbing.

## KEY DIAGNOSIS (why memory lost in 2.7 — fixed in 2.8)
The 6 critique traces were GOOD ("accent #25F4EE missing", "gradient present", "tone not provocative"). But: (a) critique runs LAST → traces written after the page is built; (b) the builder only consumed *distilled* lessons; (c) distill mangled them to "Got it." (lessons=0) → builder got nothing → memory built ~same as no-memory → lost to judge noise. The upskill fired with lessonText "Got it.", before==after, score 38→38. **2.8 fixes both: raw traces → builder, + in-run revise.**

## DEMO
Recorded ~10min real → sped to ~60s, OR live-replay via the **Replay** button. **For a demo NOW: use `:8090`** (memory wins 64v54, stable). Story: two studios build the same TikTok site; the memory studio recalls Cognee traces → fixes flaws → scores higher; no-memory keeps them. 2.9 adds the provable **trace → verified-fix ledger** (the demo-winner).
