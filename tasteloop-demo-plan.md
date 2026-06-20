# TasteLoop — Demo Goal & Spec (the source of truth for "is the plan correct?")

> This is the **definition of done for the demo**. Build decisions get checked against §4 (Acceptance criteria). If something we build doesn't serve a line in here, question it. Companion docs: `tasteloop-design-doc.md` (architecture + build plan), `tasteloop-review.md` (rationale).

---

## 1. Demo goal (one sentence)

On **one screen**, two AI studios build **the same website at the same time** from **one uploaded brand book** — **Page 1 has no memory, Page 2 has Cognee memory** — and it's unmistakable that the memory studio **learns as it works** (traces, improvements, lessons counting up) and ships a **better site**, while the no-memory studio does **none of that**.

**What we are proving:** adding a **Cognee memory layer** to a multi-agent build makes it visibly learn and produce measurably better output — same brand, same model, same turn budget, same judge. Everything is identical except the memory layer.

---

## 2. The single screen (what the audience sees)

Two pages, side by side, building **simultaneously**:

```
┌── PAGE 1 — NO MEMORY ───────────────┐ ┌── PAGE 2 — COGNEE MEMORY ───────────┐
│ Agents 6 · Turns 18/30              │ │ Agents 7 · Turns 17/30              │
│ Traces 0 · Improvements 0 · Lessons 0│ │ Traces 14 · Improvements 4 · Lessons 6│  ◀ the contrast
│ ┌ agent grid: who's spawned,       │ │ ┌ agent grid: who's spawned,        │
│ │ "currently doing X" ───────────┐ │ │ │ "currently doing X" ────────────┐ │
│ └────────────────────────────────┘ │ │ └─────────────────────────────────┘ │
│ ┌ LIVE SITE being built (preview) ┐ │ │ ┌ LIVE SITE being built (preview) ┐ │
│ └────────────────────────────────┘ │ │ └─────────────────────────────────┘ │
└─────────────────────────────────────┘ └──────────────────────────────────────┘
        SCORE: 71                                  SCORE: 86  (and climbing run-over-run)
```

**Big numbers at the top of each page** (large enough to read when the video is sped up):
- **Agents spawned** — how big the swarm is.
- **Turns** — `used / 30` (the shared turn budget; see §5).
- **Traces made** — critiques/findings stored as memory. **Page 1 stays 0.**
- **Improvements** — member upskills driven by memory. **Page 1 stays 0.**
- **Lessons** — durable lessons distilled across runs. **Page 1 stays 0.**

The whole point of the visual: **Page 2's memory counters climb; Page 1's sit at zero** — and Page 2's site looks better and scores higher.

---

## 3. The flow (per page)

Both pages run the **identical** pipeline. The only difference is whether the memory layer is on.

1. **Upload brand book** (PDF) + the goal. Same inputs to both pages. The goal prompt (identical for both):
   > *Using the attached brand book (PDF), design and build a single-page marketing website for **[PRODUCT]** with **exactly 5 sections**: (1) hero — value proposition + primary CTA; (2) the problem / why now; (3) how it works / key features; (4) proof — results, testimonials, or logos; (5) closing CTA + footer. Write **real copy** in the brand's voice (no placeholder text), select **typography** and create **imagery** that fit the brand, and apply the brand book's colors, type scale, spacing, and do/don't rules. Output one self-contained, responsive, accessible HTML+Tailwind page. Honor the brand's negative constraints (e.g. no generic AI gradients).*
2. **Master Agent** reads the goal + brand book, **writes a plan**, and **decides which agents to spawn** — then spawns them. (Adapted from `agent_evo`'s OneShotBuilder, which has one LLM call emit the full roster + handoff graph; we constrain it to a role palette + turn budget — design doc §2.)
3. The roster it can spawn from (a palette):
   - **Brand Deconstruct Agent** — brand-book PDF → **design system / tokens** (vision);
   - **Copywriter** — **real site copy** for all 5 sections in the brand voice;
   - **Typographer** — font pairing that fits the brand;
   - **Image Generator / Art Director** — hero/section **imagery**;
   - **Information Architect**, **Visual Designer**, **Frontend Implementer** — assemble the **website** (copy + design + images);
   - **Critique Agent** — reviews and **gives feedback to the others** (on the memory page, via **Cognee traces**; the no-memory page has no Cognee).
4. Agents build the **website** over a **shared 30-turn budget** (a "turn" = one agent taking the floor; handoffs follow the Master's plan — the `agent_evo` delegation/rounds model).
5. **Memory page only:** every Critique Agent finding is written as a **trace**, **recalled** by the relevant teammate (so the Visual Designer adapts to the critique mid-build), distilled into **Lessons** at run end, and used to **upskill** members next run (`Visual Designer v2`). Counters climb.
   **No-memory page:** the Critique Agent still reviews, but its feedback is used once and forgotten — nothing is stored, recalled, or improved. Counters stay 0.
6. Both sites are **rendered and judged**; the memory page scores higher and **keeps improving across repeated runs**.

---

## 4. Acceptance criteria (grade the build against this)

A build is "demo-correct" when **all** of these are true. Tick them off.

**Setup & fairness**
- [ ] One brand-book PDF is uploaded and used **identically** by both pages.
- [ ] Both pages use the **same** model, **same** turn budget (30), **same** judge, **same** role palette. The **only** difference is the memory layer on/off (asserted + shown as a one-line config diff).
- [ ] No hand-written lessons or pre-baked prompts: every Page-2 lesson is produced live from a real Critique Agent finding and cites the trace it came from.

**Master agent & spawning (visible)**
- [ ] A **Master Agent** is shown reading the brief, producing a **plan**, and **spawning a roster** — the spawn is visible (cards fly in).
- [ ] A **Brand Deconstruct Agent** is spawned and visibly converts the PDF → design tokens shown on screen.
- [ ] A **Critique Agent** is shown reviewing work and sending feedback to other agents.

**Frontend output & brand input**
- [ ] Each page renders a **real marketing website derived from the brand book** — **5 sections about the product**, with **real written copy** (no lorem), **selected fonts**, and **generated imagery** — as a self-contained **HTML+Tailwind** file, shown **live in an `<iframe>`** with the **metrics bar pinned on top**. (It must be unmistakable that a *website* is being built — copy + design + images, not a wireframe.)
- [ ] **Both copy and design** are produced by the agents (a Copywriter writes the section copy; a Typographer picks fonts; an Image agent supplies imagery).
- [ ] On the memory page, the **Critique Agent's feedback flows through Cognee traces**; on the no-memory page it does not (no Cognee).
- [ ] The iframe **reloads as the build progresses** so the audience watches the actual site take shape.
- [ ] The brand book is uploaded as a **PDF**; pages are rendered to images and **vision-analyzed** into design tokens shown on screen (the design/vision model, e.g. Codex — same for both pages).
- [ ] **Cognee runs on local Ollama** (your GLM for the LLM + `nomic-embed-text` for embeddings), **smoke-tested to produce valid lessons** before the real recording.

**The contrast (the whole point)**
- [ ] Top-of-page big numbers are present and readable on both pages: **Agents spawned, Turns (x/30), Traces, Improvements, Lessons.**
- [ ] Page 1 (no memory): **Traces / Improvements / Lessons stay 0** for the entire run.
- [ ] Page 2 (memory): **Traces, Improvements, Lessons visibly count up** during the run.
- [ ] At least one **visible mid-build adaptation on Page 2**: Critique flags something → trace → another agent recalls it → fixes it (the no-memory page repeats or never fixes it).
- [ ] Page 2's **score is higher**, and improves across repeated runs; Page 1's does not improve across runs.

**Honesty**
- [ ] All scores shown are **real** (from the judge), not invented; if the gap is within judge noise, the headline shifts to the specific thing the lesson fixed (see §6).
- [ ] If the video is sped up, a **`▶ N× speed`** badge is visible; nothing is presented as real-time that isn't.

---

## 5. The turn budget (a decision to confirm)

- A **"turn"** = one agent taking the floor (plans, acts, or critiques), then handing off — the `agent_evo` "round" model.
- **Budget = 30 turns per page, identical on both** (fairness). The turn meter shows `used / 30`.
- **What memory buys is quality-per-turn, not more turns:** with the same 30 turns, the memory page wastes fewer of them repeating mistakes and lands a better site (and, across runs, gets better still). This is the honest reading — memory is **not** given a bigger budget.
- *Open question to confirm with you:* is 30 the budget **per page** (recommended, fair) or 30 **combined** across both pages? Recommend **30 per page**.

---

## 6. Storyboard (record both for real ~10 min → edit to ~60s)

Run both pages for real, recording the event logs + real screenshots/scores; render the UI replay; edit pacing. **Variable speed:** 8–12× through bulk build, real-time/slow-mo on the beats below.

1. **(0–8s) Setup.** Upload the brand book; "two studios, same brief, same model, same 30 turns — one remembers, one doesn't." Show the one-line config diff (`memory: off | on`).
2. **(8–20s) Master agents plan & spawn.** Both Master Agents write a plan and spawn rosters; Brand Deconstruct Agents turn the PDF into tokens. Agent-spawned and Turn counters race up on both.
3. **(20–35s) Build + critique.** Sites take shape in both previews. Critique Agents review. **Page 2's Traces counter starts climbing; Page 1's stays 0.**
4. **(35–48s) The adaptation (real-time beat — the PRIMARY wow).** Page 2: Critique flags "forbidden gradient in the hero" → trace → Visual Designer recalls it → re-render, gradient gone. Page 1: same flaw stays. **Traces counter ticks on Page 2** (the recalled-and-fixed beat). *(Improvements ticks later, in beat 5, across runs — not here.)*
5. **(48–58s) Across-run learning (headline).** Fast-forward repeated runs: Page 2's **Lessons** counter climbs and its score line pulls ahead of Page 1's; `Visual Designer v2` prompt-diff flashes.
6. **(58–60s) Reveal.** Both finished sites, 2-up, with real scores and the specific category memory improved.

---

## 7. What would make this demo wrong or unfair (avoid)

- Page 1 deliberately crippled (worse model, fewer turns, weaker prompts). It must be the **same system minus the memory layer**.
- Hand-authored lessons, or a pre-baked `v2` agent. Lessons must form live from real critiques and cite their trace.
- Invented scores, or a "win" that's actually inside judge noise.
- Claiming real-time when the video is sped up (always show the speed badge).
- A memory page that just pastes the last critique into the next prompt (that's not memory) — Page 2 must **store traces, recall them semantically, distill lessons, and upskill** (the full Cognee layer), which Page 1 structurally cannot do.

---

## 8. Borrowed from `agent_evo` (and how we change it)

| `agent_evo` | We use it for | Change |
|---|---|---|
| `OneShotBuilder` — one LLM call emits `agents.json` (roles, system prompts, tools) + `team.json` (edges, `entry_point`) | The **Master Agent** that plans + spawns the roster | Constrain to a fixed **role palette** + **turn budget** + a (mostly linear) order + one critique→revise loop, for determinism. Conditionally spawn the Brand Deconstruct Agent when a PDF is provided. |
| `team_runner` — `max_rounds` budget; entry agent **delegates** via `[DELEGATE: agent_id]` along edges; auto-handoff to next unvisited member; cycle guard | The **30-turn** model + handoffs | Make each round a visible "turn" event; cap at 30; the Critique Agent can hand back to a builder once (the one revise loop). |
| `OneShotJudge` — holistic 0–10 + reasoning | The judge | Replace with **render→screenshot + split rubric** (linters + vision) and **paired comparison**; the **Critique Agent** (in-loop) is separate from the final judge. |
| `agent.py` — agent = system_prompt + tools + temperature | Agent/member definition | Add `version` + `upskilledFrom` so upskilling is first-class. |
| `OneShotMerger` | (not in MVP) | Cut to post-demo; we lead with upskilling, not merging. |

---

## 9. Locked decisions (resolved post red-team — full table in design-doc §0.1)

1. **Turn budget:** **30 per page** (locked, equal both pages).
2. **Counters:** **Traces** = stored critiques · **Improvements** = across-run upskills only · **Lessons** = distilled lessons. Page 1 stays 0 on all three.
3. **Runs in the recording:** **in-run adaptation is the primary, must-land beat (2 runs total)**; the across-run climb (Lessons/score/`v2`) is the **stretch** beat — record if it lands.
4. **Brand book:** `TikTok_guidelines.pdf` (pre-vetted; the Brand Deconstruct agent renders pages → vision). `[PRODUCT]` = one concrete TikTok product, baked into the shared RunConfig.
5. **Screen:** single 16:9 split into the two pages.
6. **Cognee on local Ollama (keyless):** `glm-4.7-flash` + `nomic-embed-text` (already pulled). **Day-0 smoke test gates this**; if GLM fails structured output → fallback to **`gemma3:27b`** (local, already installed → stays keyless).
7. **Score:** one **0–100 vision-judge score** per page (+ the category memory improved); rich rubric is post-MVP.
8. **Imagery:** **sourced/curated (incl. SVG), not live-generated** for the demo.
