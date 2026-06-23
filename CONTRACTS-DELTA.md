# CONTRACTS-DELTA.md — FROZEN

Branch: `feat/in-run-self-improvement`. This delta freezes the contract for TWO tasks:
**(A) CREDIT — make it real** and **(B) PHASE 3 — a real typed-graph brand layer**.
Implementers code to THIS file exactly. Re-anchor every `file:line` against the live
file before editing (line numbers below are anchors, not guarantees). Edit ONLY your
assigned files (see §FILE OWNERSHIP MAP); record any cross-file need in `crossFileNotes`.
No git commits. Keep every existing smoke test green and add the ones specified here.

NON-NEGOTIABLE INVARIANTS (do not regress):
- **H5 (verbatim):** every string that reaches a BUILD (brand grounding, recalled
  lessons, fix-rules) is byte-identical to what was stored. Cognee's LLM may NEVER
  rewrite build-feeding text. The ONLY graph reads allowed on a build path are
  `get_session().answer`, `recall(only_context=True, query_type=CHUNKS_LEXICAL)`, and
  the NEW `cmd_query_token` graph-node fetch (all verbatim; NO `*_COMPLETION`).
- **Fairness (A/B):** the ONLY memory-exclusive capabilities are `cognee_recall` +
  `cognee_trace`. STATIC brand facts (token grounding from the graph query) must flow
  IDENTICALLY to BOTH pages — same query, same canonical token set, same verbatim text.
  Only the MEMORY page additionally receives token-anchored *in-run lessons*.
- **Per-run reset; NO cross-run learning.** Session id is frozen `sess_<runId>_<page>`.
- **Locked two-axis judge** (judge.mjs) is untouched. **No regex** on any scoring/
  learnable/lesson-selection path.

---

## §0. VERIFIED-AGAINST-INSTALL (what was actually run, and the observed result)

Live pin: `cognee 1.2.0.dev1` at `/tmp/cognee_smoke/venv` (PY =
`/tmp/cognee_smoke/venv/bin/python3`). All findings below were RUN, not assumed.

1. **SearchType enum (live):** includes `CHUNKS`, `CHUNKS_LEXICAL`, `GRAPH_COMPLETION`,
   `TEMPORAL`, `SUMMARIES`, `RAG_COMPLETION`, `CYPHER`, … (NO `FEEDBACK`). Use
   `CHUNKS_LEXICAL` for verbatim lexical recall (BM25 exact-term — ideal for `#25F4EE`).

2. **`recall` signature (live):** `recall(query_text, query_type=None, *, datasets,
   top_k=15, auto_route=True, node_name=None, node_name_filter_operator='OR',
   only_context=False, session_id=None, user=None, …)`. So `node_name` is a
   **read filter** (OR-joined), `only_context=True` returns context entries (verbatim
   text, no LLM answer). **Observed caveat (RAN):** with per-token chunks,
   `node_name=['#25F4EE']` RANKED the matching chunk first but did **not strictly
   exclude** other chunks — the bridge's existing `_node_name_match` post-filter
   (cognee_bridge.py:317) is REQUIRED to enforce strictness. Keep it.

3. **`cognify` cost is LLM-bound, NOT chunk-bound (RAN, the decisive constraint):**
   Per-token `cognee.add(text, node_set=[token])` ×4 + ONE `cognify()` →
   **`add done in 0.6s`, `cognify done in 537.7s`** (~9 min). That blows the bridge's
   120s `CMD_TIMEOUT` (cognee_bridge.py:159). Splitting into per-token chunks does NOT
   reduce cost; the glm graph-extraction dominates. ⇒ **Do NOT route per-token brand
   ingest through `cognify`.**

4. **`cognee.add()` is text-only (RAN):** `add([BrandToken(...)])` →
   `IngestionError("Data type not supported: <class 'BrandToken'>")`. Typed DataPoints
   do NOT go through the public `add()`.

5. **THE PHASE-3 PATH THAT WORKS (RAN, fast + verbatim):**
   `from cognee.tasks.storage import add_data_points`
   `add_data_points(data_points: List[DataPoint], custom_edges=None, embed_triplets=False)`.
   Built 4 typed `BrandToken` DataPoints and called it →
   **`add_data_points OK in 1.52s -> 4 nodes`** (NO LLM, NO timeout risk).
   Then read back:
   - **Graph (verbatim, authoritative):** `(await get_graph_engine()).get_graph_data()`
     returned 4 `type=="BrandToken"` nodes with `name` AND `statement` **byte-exact**
     (e.g. `name='#25F4EE'`, `statement='BRAND COLOR token #25F4EE is the Splash …'`).
   - **Vector:** the DataPoints were indexed into the model's OWN collections
     (`BrandToken_statement`, `BrandToken_name`) — `get_vector_engine().search(
     "BrandToken_statement", "splash accent color")` returned 3 scored hits.
   - **CHUNK retrievers DO NOT see them (RAN):** `recall(query_type=CHUNKS_LEXICAL,…)`
     after `add_data_points` → `NoDataError("No valid chunks loaded")` /
     `DocumentChunk_text collection not found`. The chunk retrievers read
     `DocumentChunk_text`, which `add_data_points` never populates. **So the token
     grounding must be read via the GRAPH-NODE fetch, not the chunk retriever.**

6. **`DataPoint` import (live):** `from cognee.low_level import DataPoint` (exports
   `['DataPoint','setup']`). Subclass with typed fields + `metadata={"index_fields":[…]}`.

7. **Graph engine node API (live):** `get_graph_engine()` exposes `get_graph_data`,
   `get_filtered_graph_data`, `get_node`, `get_nodes`, `has_node`,
   `get_nodeset_subgraph`, `add_node(s)`, `delete_node(s)`. Use `get_graph_data()` +
   in-Python filter by `name` (simple, total) for `cmd_query_token`.

8. **Unchanged & still required (from MEMORY pins, re-confirmed by signatures):**
   `remember(data, dataset_name|session_id, node_set, run_in_background)`,
   `forget(dataset=…)`, `improve(session_ids=[…], **{feedback_alpha})`,
   `session.get_session(session_id, user)`, `session.add_feedback(session_id, qa_id,
   feedback_text, feedback_score, user)`, `session.distill_session(session_id, dataset,
   user)`. `ENABLE_BACKEND_ACCESS_CONTROL=false` required for improve/forget writes
   (bridge already sets it). `HUGGINGFACE_TOKENIZER` MUST be set (cognee.env supplies it;
   the proto failed without it — the bridge already mirrors cognee.env so it is fine).

---

## §1. PHASE 3 — typed brand DataPoints + a verbatim token-grounding graph query

### 1.1 Ingest: per-token typed `BrandToken` DataPoints (bridge — NOT cognify)

Owner: **cognee_bridge.py** (`cmd_ingest_brand`). Replace the single combined-doc
`remember()` cognify with a **fast typed-DataPoint write** via `add_data_points`.

Add at import time (alongside the existing cognee imports, ~cognee_bridge.py:230):
```python
from cognee.low_level import DataPoint
from cognee.tasks.storage import add_data_points

class BrandToken(DataPoint):
    # name == the canonical node id (the #RRGGBB hex, "no-gradient", "hero", …).
    name: str
    value: str          # the hex / literal rule text / section name
    dp_type: str        # "Color" | "Font" | "Spacing" | "Rule" | "Section"
    statement: str      # the VERBATIM grounding sentence (what reaches the build)
    metadata: dict = {"index_fields": ["statement", "name"]}
```

`cmd_ingest_brand(args)` NEW body (args unchanged: `{sessionId, tokens, dont}`):
1. Reuse the existing `_brand_statements(tokens, dont)` (cognee_bridge.py:524) to derive
   `[(statement, [node]), …]` + `nodes`. **Keep `_brand_statements` as the single
   canonicalization** so node ids match `brand.mjs canonicalToken` (#RRGGBB upper,
   `no-gradient`, `hero`, …). It already emits Color/Font/Spacing/Structure/Rule lines.
2. Map each `(statement, [node])` → one `BrandToken(name=node, value=<derived>, dp_type=
   <derived from the statement prefix: "BRAND COLOR"→Color, "BRAND FONT"→Font, "BRAND
   SPACING"→Spacing, "BRAND STRUCTURE"→Section, "BRAND RULE"→Rule>, statement=statement)`.
   De-dupe by `name` (first wins) so each canonical token is exactly one node.
3. `await add_data_points(points)` (NO cognify, NO LLM). Wrap in the existing
   `contextlib.suppress`-style guard so a failure degrades to the OLD combined-doc
   `remember()` fallback (keep the old code path as the `except` branch so brand ingest
   never hard-fails and stays under timeout regardless).
4. Return shape UNCHANGED: `{"ok": True, "ingested": <len(points)>, "nodes": [name,…]}`.
   `memory.mjs ingestBrand` and `brand.mjs ingestBrandGraph` already consume exactly this.

VERIFIED: this is the 1.52s path (§0.5). Nodes carry `name` + `statement` verbatim.

### 1.2 NEW bridge command: `cmd_query_token` — verbatim token grounding + anchored lessons

Owner: **cognee_bridge.py**. Register in `_COMMANDS` (cognee_bridge.py:707) as
`"query-token"` (kebab, matching the existing `remember-trace`/`recall` style).

Signature (json-args → stdout JSON):
```
query-token  {"sessionId", "nodeName":[...], "query"?:string, "withLessons"?:bool}
             -> {"grounding":[{"node","statement"}],            # VERBATIM token nodes
                 "lessons":[{"snippet","role"}],                # in-run anchored lessons (may be [])
                 "nodes":[...]}                                 # the node ids that matched
```

Behavior (ALL verbatim — NO `*_COMPLETION`):
- **grounding (symmetric / fair — BOTH pages):** fetch the typed brand nodes by name.
  ```python
  from cognee.infrastructure.databases.graph import get_graph_engine
  ge = await get_graph_engine()
  nodes, _edges = await ge.get_graph_data()
  want = {str(n).strip().lower() for n in (args.get("nodeName") or [])}
  grounding = []
  for nid, props in nodes:                       # nodes are (id, props_dict) tuples
      if not isinstance(props, dict): continue
      if props.get("type") != "BrandToken": continue
      name = str(props.get("name") or "")
      if want and name.strip().lower() not in want: continue
      stmt = props.get("statement")
      if stmt and str(stmt).strip():
          grounding.append({"node": name, "statement": str(stmt)})  # BYTE-EXACT
  ```
  `statement` is returned **byte-identical** to what `cmd_ingest_brand` wrote (verified
  in §0.5: graph `statement` == the ingest statement). This is the brand grounding that
  routes to BOTH pages.
- **lessons (MEMORY page only; `withLessons:true`):** the in-run, token-anchored traces.
  Reuse the EXISTING verbatim recall path — call the existing `cmd_recall` internals with
  `node_name = args["nodeName"]` (the same canonical token nodes) so any trace whose
  `node_set` included a token surfaces VERBATIM via `get_session().answer` +
  `CHUNKS_LEXICAL only_context`. Return them as `{"snippet","role"}` (same shape as
  `cmd_recall`'s hits). When `withLessons` is falsey OR the page never traced, return `[]`.
- Total + fail-open: any graph/recall miss → that channel returns `[]`; the command never
  throws (mirror the `cmd_recall` `contextlib.suppress` style). Honors the dispatch-layer
  timeout (cognee_bridge.py:822) — the graph fetch is sub-second so it never times out.

Why a graph fetch and not `recall(CHUNKS_LEXICAL)` for grounding: VERIFIED (§0.5) the
chunk retrievers raise `NoDataError` because `add_data_points` indexes the DataPoint's own
collection, not `DocumentChunk_text`. The graph node IS the canonical store; reading its
`statement` is the verbatim, no-LLM grounding read. (`recall` is still used for the
*lessons* channel because traces are remembered the old session-cache way.)

### 1.3 memory.mjs — expose `queryToken`

Owner: **memory.mjs**. Add to ALL THREE backends (none/shim/cognee) so the API is total:
```
async queryToken(id, { nodeName, query?, withLessons? } = {})
  -> { grounding:[{node,statement}], lessons:[{snippet,role}], nodes:[...] }
```
- **cognee:** `execBridge("query-token", { sessionId:id, nodeName, query, withLessons })`;
  on `b.ok !== false && Array.isArray(b.grounding)` return
  `{ grounding:b.grounding, lessons:(b.lessons||[]).map(h=>({snippet:h.snippet,role:h.role||"memory"})), nodes:b.nodes||[] }`,
  else fall back to `shim.queryToken(...)`.
- **shim:** synthesize grounding from the LOCAL brand graph is out of scope — the shim has
  no brand nodes; return `{ grounding:[], lessons:<recallInRun(id,query,{nodeName}).hits>, nodes:nodeName||[] }`
  (lessons reuse the shim's keyword recall so the memory page still degrades usefully).
- **none:** `{ grounding:[], lessons:[], nodes:[] }`.
Update the frozen header block (memory.mjs:1–16) to list `queryToken`.

### 1.4 brand.mjs — `brandGraphQuery` is the producer of `{query, nodeName}` (already exists)

Owner: **brand.mjs** (NO behavioral change required; it already returns
`{ query, nodeName }` from `buildBrandGraph` — brand.mjs:541). The build will call
`memory.queryToken(sessionId, { nodeName: brandGraphQuery(brand).nodeName,
query: brandGraphQuery(brand).query, withLessons: isMemory })`. `ingestBrandGraph`
(brand.mjs:513) already routes the LOADED tokens through `memory.ingestBrand` — UNCHANGED.
Keep `buildBrandGraph`/`brandGraphQuery`/`canonicalToken` as the single canonicalization
source of truth; the bridge's `_brand_statements` MUST stay node-id-compatible with it.

### 1.5 The BUILD routes brand grounding through the graph query (symmetric/fair)

Owner: **skills.mjs** (`runHtmlBuild` → `designSystemBrief`) + **orchestrator.mjs**
(thread the grounding). This is where Phase 3 replaces "plain string interpolation".

Current state: `runHtmlBuild` (skills.mjs:557) builds brand grounding via
`designSystemBrief(brand)` (skills.mjs:705) = pure string interpolation of `brand.tokens`.
`codex.mjs summarizeTokens` (codex.mjs:349) likewise interpolates. NEITHER is a graph query.

NEW (frozen):
- **orchestrator.mjs (owner: orchestrator):** ONCE per gen, on BOTH pages, call
  `const tokenGrounding = await memory.queryToken(sessionId, { nodeName:
  brandGraphQuery(brand).nodeName, query: brandGraphQuery(brand).query, withLessons:
  isMemory && !ablateMemory });` (import `brandGraphQuery` from `./brand.mjs`). Thread the
  result onto `ctx.tokenGrounding = tokenGrounding.grounding` (an array of `{node,
  statement}` — IDENTICAL on both pages by construction) and, MEMORY-only,
  fold `tokenGrounding.lessons` snippets into `recalledRules`/`lessons` exactly like the
  existing recall hits (so token-anchored lessons reach the build/revise verbatim, and
  are dropped under ablation just like recall hits). On any error, `ctx.tokenGrounding = []`
  (build still works via the legacy `designSystemBrief`). **Fairness:** `grounding` is the
  SAME static brand text on both pages; only `lessons` (memory-only) differs.
- **skills.mjs (owner: skills):** `runHtmlBuild` prefers `ctx.tokenGrounding` when present:
  render each `{node, statement}`'s `statement` VERBATIM into the build directive
  (a `BRAND TOKENS (from the brand graph):` block appended to `copyHint`, exactly where
  `designSystemBrief` is appended today, skills.mjs:588). When `ctx.tokenGrounding` is
  empty/absent, FALL BACK to `designSystemBrief(brand)` unchanged (back-compat + the
  no-bridge path). The verbatim statements are NEVER rewritten (H5).

Symmetry proof to preserve: because `brandGraphQuery(brand).nodeName` and the ingested
nodes are derived identically for both pages and the grounding read is a pure graph fetch
of the same `statement` text, `ctx.tokenGrounding` is byte-identical on no-memory and
memory. Only the memory page additionally gets `lessons` (the memory-exclusive channel).

### 1.6 Phase-3 smoke (add; keep green)

- **cognee_bridge.py:** extend `__smoke__` (cognee_bridge.py:728) with a Phase-3 leg:
  `cmd_ingest_brand` a tiny `{tokens, dont}`, then `cmd_query_token` for `["#25F4EE",
  "no-gradient"]` and assert `grounding[*].statement` is non-empty + contains the literal
  token (e.g. `#25F4EE`) — proving verbatim graph grounding works end-to-end. Must run
  well under timeout (it is the 1.5s path).
- **brand.mjs / memory.mjs:** existing smokes stay green; add a memory.mjs assertion that
  `queryToken` exists on all three backends and returns the `{grounding,lessons,nodes}`
  shape (none → all empty).
- **orchestrator.mjs / skills.mjs:** add a no-network unit assertion that when
  `ctx.tokenGrounding=[{node:"#25F4EE",statement:"…#25F4EE…"}]`, the build directive
  contains that verbatim statement and that an EMPTY `ctx.tokenGrounding` falls back to
  `designSystemBrief` (no crash, on-brand). NO real bridge/Codex in the smoke.

---

## §2. CREDIT — make it real (today it is half-wired theater)

Today: orchestrator computes `creditByRole` and passes `credit:` to `planTeam`
(orchestrator.mjs:634) but **`planTeam` ignores it** (team.mjs:492 destructures only
`{brand, goal, isMemory, lessons}`). Nothing emits `grantProvenance` / `credit` on
`agent.spawned`. app.js already CONSUMES `ev.grantProvenance=[{skill,fromLesson}]` and
`ev.credit={flaw,attributedTo}` (app.js:838–851, renderers app.js:240–268) but there is
no producer. Fix all three: planTeam USES credit to seed briefs; the master PRODUCES
grantProvenance; skills.mjs EMITS both on `agent.spawned`.

### 2.1 `creditByRole` shape (frozen — orchestrator already produces this)

`creditByRole : { [role:string]: { flaw:string, attributedTo:string, severity:"high"|"med"|"low" } }`
(orchestrator.mjs:839–851 already builds exactly this — the highest-severity flaw per role
from last turn). Empty `{}` on gen 0, no-memory, or under ablation. UNCHANGED.

### 2.2 `planTeam(credit)` — signature + how credit SEEDS the responsible agent brief

Owner: **team.mjs**. New signature (frozen):
```
planTeam({ brand, goal, isMemory, lessons = [], credit = {} })
```
- Destructure `credit` and carry it on `ctx` (team.mjs:496):
  `const ctx = { brand, goal, isMemory, lessons, credit: (credit && typeof credit === "object") ? credit : {} };`
- **Seed the responsible agent's brief with its own prior miss** — in `repairTeam`
  (team.mjs:295), for EACH agent whose `role` is a key in `credit` (memory page only;
  `credit` is already `{}` for no-memory/ablate so this is inert there):
  - Append a verbatim miss clause to that agent's `instructions`/`briefV2` via a NEW helper
    `seedCredit(instructions, miss)` (mirrors `weaveLessons`, team.mjs:267):
    ```
    LAST TURN this role was attributed the flaw: "<credit[role].flaw>" (severity
    <credit[role].severity>) — you MUST fix it this turn.
    ```
    Idempotent (skip if the flaw text is already present), and it GROWS `briefV2` so the
    existing prompt-diff (`briefDiff = {before:briefV1, after:briefV2}`, team.mjs:398)
    naturally reflects the credit seeding too.
  - Record per-agent credit on the agent object: `agent.credit = { flaw: credit[role].flaw,
    attributedTo: role }` (this is the EXACT shape app.js `renderCredit` consumes,
    app.js:261). Set it whenever `credit[agent.role]` exists; leave undefined otherwise.
- Seeding runs in BOTH the main coercion loop (team.mjs:307) and the MIN_AGENTS backfill
  (team.mjs:429) so a credited role that gets added by repair is still seeded.
- Fairness: `credit` is `{}` on the no-memory studio, so no no-memory brief is ever seeded
  and no `agent.credit` is set there. (Belt-and-suspenders: only apply `seedCredit`/
  `agent.credit` when `isMemory`.)

### 2.3 The MASTER produces `grantProvenance` (LESSON_SKILL_RULES is gone)

Owner: **team.mjs**. `grantProvenance = [{ skill:string, fromLesson:string }]` per agent —
"this recalled lesson motivated granting this tool". Since the master now decides tools in
its prompt and `LESSON_SKILL_RULES` was deleted, DERIVE provenance from the master's OWN
output (NO regex ladder, NO resurrected rule table):

- **Primary (master-authored):** extend the master JSON shape so the model may RETURN, per
  agent, the lesson→tool reasoning. Add to the system prompt's agent schema
  (team.mjs:154–167) an OPTIONAL field:
  `"grantProvenance": [{ "skill": "<one granted tool>", "fromLesson": "<the recalled lesson, verbatim, that made you grant it>" }]`
  and instruct (memory branch only, team.mjs:138): *"For each tool you grant BECAUSE of a
  recalled lesson, add a grantProvenance entry naming the tool and quoting that lesson
  verbatim."* In `repairTeam`, accept `a.grantProvenance` when it is an array of
  `{skill,fromLesson}` whose `skill` ∈ the agent's final `tools` and whose `fromLesson`
  matches (case-insensitive substring) one of the recalled `lessons[*].statement` — drop
  any entry that fails this validation (so the master cannot fabricate provenance).
- **Fallback (derived, deterministic, NO regex over flaw text):** when the master returns
  none but the agent (a) holds a memory-granted/lesson-implied tool AND (b) `lessons` is
  non-empty, synthesize ONE entry: pair the agent's FIRST non-`html_build` granted tool
  with the FIRST recalled lesson statement (`lessons[0].statement`) — `improve()` already
  feedback-ranks lessons so the first is the proven one (same principle as
  `firstLesson`, orchestrator.mjs:95). This makes provenance honest ("we granted <tool>
  and the run had learned <lesson>") without inventing a lesson→tool classifier.
- Memory page only; `grantProvenance` stays undefined on no-memory and under ablation
  (gate on `isMemory && lessons.length`). Store as `agent.grantProvenance`.
- `planTeam`'s returned agent shape GAINS two optional fields:
  `{ …, briefV1, briefV2, credit?, grantProvenance? }`. Update the JSDoc/header
  (team.mjs:27–35, 482–491) to list them.

### 2.4 skills.mjs EMITS `agent.grantProvenance` + `agent.credit` on `agent.spawned`

Owner: **skills.mjs** (`runAgent`, the `agent.spawned` emit at skills.mjs:424). Add the two
fields straight through from the master-authored agent object:
```js
e({
  type: "agent.spawned",
  agentId, role, version,
  prompt: instructions.slice(0, 200),
  skills: granted,
  ...(Array.isArray(agent.grantProvenance) && agent.grantProvenance.length
      ? { grantProvenance: agent.grantProvenance } : {}),
  ...(agent.credit && typeof agent.credit === "object" && agent.credit.flaw
      ? { credit: agent.credit } : {}),
});
```
- Shapes (frozen, EXACTLY what app.js consumes):
  - `agent.spawned.grantProvenance : [{ skill:string, fromLesson:string }]`
    (app.js:240 `renderGrantProvenance`, app.js:847 graph seed via `g.fromLesson`).
  - `agent.spawned.credit : { flaw:string, attributedTo:string }`
    (app.js:261 `renderCredit`, app.js:850 graph seed via `credit.flaw`).
- Both OPTIONAL: omit the field entirely when absent (app.js renderers no-op on absence).
  No-memory spawns carry NEITHER (fairness — they never exist there).

### 2.5 Credit smoke (add; keep green)

- **team.mjs smoke (team.mjs:522):** with `credit = { "frontend-implementer": { flaw:"text
  is hard to read", attributedTo:"frontend-implementer", severity:"high" } }` and 1 lesson:
  assert (a) the builder's `briefV2` contains the verbatim flaw text and `briefV1` does NOT
  (credit seeded, prompt-diff grew); (b) `agent.credit` on the builder equals
  `{flaw:"text is hard to read", attributedTo:"frontend-implementer"}`; (c) at least one
  agent carries a validated `grantProvenance:[{skill,fromLesson}]` whose `skill` is in its
  tools and whose `fromLesson` matches the recalled lesson; (d) the NO-MEMORY team (credit
  `{}`) has NO `agent.credit` and NO `grantProvenance` on ANY agent (fairness).
- **skills.mjs smoke:** assert `runAgent` puts `grantProvenance`/`credit` on the
  `agent.spawned` event when present on the agent, and OMITS them when absent.
- **orchestrator.mjs smoke (orchestrator.mjs:1074):** existing `creditByRole` assertions
  stay; add that `planTeam` is CALLED with `credit: creditByRole` (already true) and that
  the value is non-empty only on memory + non-ablate + gen>0 (already structurally true).

---

## §FILE OWNERSHIP MAP (disjoint — edit ONLY your files)

| File | Owner lane | Phase-3 responsibilities | Credit responsibilities |
|---|---|---|---|
| `web/src/cognee_bridge.py` | **bridge** | §1.1 `cmd_ingest_brand` → `add_data_points` typed `BrandToken`s (+ old-doc fallback); §1.2 NEW `cmd_query_token`/`"query-token"` (graph grounding + verbatim lessons); §1.6 smoke leg | — |
| `web/src/memory.mjs` | **memory** | §1.3 `queryToken` on none/shim/cognee + header; §1.6 shape smoke | — |
| `web/src/brand.mjs` | **brand** | §1.4 keep `brandGraphQuery`/`buildBrandGraph`/`canonicalToken` as canonical source (NO behavior change); ensure node ids stay bridge-compatible | — |
| `web/src/orchestrator.mjs` | **orchestrator** | §1.5 call `memory.queryToken` per gen both pages; thread `ctx.tokenGrounding`; fold memory-only `lessons`; ablation drops lessons | §2.1 `creditByRole` already built (verify only); pass-through `credit:` already wired |
| `web/src/skills.mjs` | **skills** | §1.5 `runHtmlBuild` prefers `ctx.tokenGrounding` verbatim, falls back to `designSystemBrief`; §1.6 smoke | §2.4 emit `grantProvenance`+`credit` on `agent.spawned`; smoke |
| `web/src/team.mjs` | **team** | — | §2.2 `planTeam(credit)` seeds briefs + sets `agent.credit`; §2.3 master produces/validates `grantProvenance`; §2.5 smoke |
| `web/app.js` | **(frozen — DO NOT EDIT)** | already consumes `ctx`-graph signals | already consumes `grantProvenance`+`credit` (app.js:240–268, 838–851) |
| `web/src/codex.mjs` | **(no edit needed)** | `summarizeTokens`/`dsContract` keep working as the legacy/back-compat grounding the build still inlines; grounding statements ride in via `copyHint` | — |

CROSS-FILE CONTRACT POINTS (record in your `crossFileNotes`, do NOT edit across lanes):
- bridge ↔ memory: `query-token` json ⇄ `queryToken` (§1.2/§1.3 shapes are the seam).
- memory/brand ↔ orchestrator: `memory.queryToken(...)` + `brandGraphQuery(brand)` (§1.5).
- orchestrator ↔ skills: `ctx.tokenGrounding=[{node,statement}]` + memory-only `lessons`
  folded into `ctx.rules`/`ctx.lessons` (§1.5).
- team ↔ skills: `agent.credit` + `agent.grantProvenance` shapes (§2.2/§2.3 ⇒ §2.4).
- team ↔ orchestrator: `planTeam({…, credit})` (§2.1/§2.2).

ACCEPTANCE (all must hold): H5 verbatim preserved (grounding + lessons byte-exact, no
`*_COMPLETION` on any build path); A/B fairness (grounding identical both pages, only
memory gets token-anchored lessons + credit/grantProvenance); per-run reset intact; judge
untouched; every smoke green; Phase-3 ingest stays under the 120s bridge timeout (the
`add_data_points` path = ~1.5s, verified).
