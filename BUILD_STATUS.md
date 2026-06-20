# TASTELOOP — BUILD STATUS (live, updated by lead)

**Target:** submittable demo in ~45 min. Local + keyless (Ollama).

## MVP goal
Two studios side-by-side build a TikTok site from `TikTok_guidelines.pdf`. **Page 2 (memory) learns & scores higher; Page 1 (no memory) doesn't.** Web UI replays an event log with live counters (Agents · Turns x/20 · Traces · Improvements · Lessons) + a live `<iframe>` of each site.

## Status — TIER 2.5 v2 IN PROGRESS (workflow wxhw5wrj9, 7 agents)
**Tier 2 ✅ verified real but thesis FAILED honestly:** real Codex builds (gpt-5.4) + real Cognee (no fallbacks), BUT memory **lost 55 vs 75** — because (a) qwen judge = noise, (b) Codex never makes the gradient mistake so the win-lever never fired.
**Tier 2.5 v2 fixes both (7 agents):** master authors the full team (count + per-agent prompts + skills) · every agent does real work · **judge = Codex gpt-5.4 HIGH** (no qwen) · honest brand-rule lever (memory recalls a real rule Codex misses → no-memory violates → deterministic penalty → memory wins on merit) · UI shows each agent's prompt+skills. Verify runs end-to-end (~15 min: Codex builds + Codex-high judge are slow).

## (old) Status — TIER 2 (workflow wlljqy6mg)
**Tier 1 ✅ (honest checkpoint on disk):** real Cognee in loop + deterministic brand-lint → **no-memory 45 vs memory 65** (memory wins on merit: it removed the forbidden gradient; no-memory kept it → −25). 7 real traces, distilled lessons.
**Tier 2 building (no fallbacks, Codex 5.4-Codex medium):** make-codex-work · real brand-PDF deconstruct · orchestrator rewrite (real master-spawn + Codex-built HTML + injected Cognee lessons) · end-to-end verify. ⚠️ Risk: if `codex exec` can't run non-interactively in this env, there's no fallback by design — the verify agent will report honestly.

## (Tier 1) Status
**✅ LIVE-STREAMING demo — `http://localhost:8080`** (hard-refresh to load live UI). run.mjs now streams events.json as it builds + runs BOTH studios concurrently; app.js polls every 0.6s and renders in real time (verified: events.json grows live). REAL Ollama run in progress (task bxsbbq3p4, GENS=2, shim memory).

**Sequencing (Ollama is shared/sequential):** (1) ✅ live run working → (2) re-run Cognee fix (fastembed leader) with Ollama free → (3) wire `memory.mjs('cognee')` → final `MEM=cognee` live run = the recording.

**Build fleet** (task w0fmlpy1k) — ✅ DONE, all syntax-clean, server smoke-tested:
- [x] **S** scaffold + sample 87-event log + static server
- [x] **U** mission-control UI (verified via headless screenshot)
- [x] **M** modules ollama/memory(shim)/brand (smoke-tested)
- [x] **O** orchestrator + run.mjs (real Ollama build — not yet executed)
- [x] **A** assets (TikTok SVG/template)

**Cognee-fix race** (task w8t0aof6z) — ⏳ RUNNING. `fastembed` trending as winner; not yet confirmed green.

**Lead next:** (1) Cognee-fix lands → wire winner into `memory.mjs('cognee')`; (2) `node web/run.mjs` for a REAL Ollama site build (replaces sample); (3) re-open :8080 → record. Sample demo is the safety net throughout.

## Run
```
node web/serve.mjs           # already running → http://localhost:8080
node web/run.mjs             # (next) real two-page Ollama build → overwrites web/run/
```

## Proven by smoke test
- ✅ Ollama up; `nomic-embed-text` 768-dim embeddings; `glm-4.7-flash` valid JSON; PDF→PNG (`pdftoppm`); HTML→screenshot (`/tmp/site/shot.png`).
- ⚠️ Cognee installs but loop blocked on `await cognee.setup()` + empty-vector embedding → **shim memory drives the demo; real Cognee is the stretch swap.**

## Models (local, keyless)
- Site/agents/judge: Ollama `qwen2.5:7b-instruct` (fast) — was "Codex 5.4" in plan; **using local for keyless + speed in the sprint.**
- Cognee (if revived): `glm-4.7-flash` + `nomic-embed-text`.

## Run (current)
```
cd web && python3 -m http.server 8080   # open http://localhost:8080
node run.mjs                             # (once O lands) generates web/run/events.json
```
