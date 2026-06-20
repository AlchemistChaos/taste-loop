# Cognee — WORKING locally (GREEN)

Cognee (PR #3107) is fully working locally against **Ollama + fastembed**, with a
CLI bridge the Node demo can shell out to. The full sequence
`setup -> add -> cognify -> search -> session -> distill` returns **real answers**.

## TL;DR — is it GREEN?

YES. Proven sequence:

- `setup()` — idempotent, runs on every bridge call (cached in-process).
- `add(brand fact incl. "NEVER use gradients in the hero; use flat #FE2C55/#25F4EE")` — OK.
- `cognify` — OK (builds graph + 384-dim fastembed vectors).
- `search("what are the rules for the hero background?")` ->
  **"Never use gradients in the hero sections; instead, use flat brand colors #FE2C55 and #25F4EE."**
- 2-turn session + `distill` -> real lesson:
  **"Never use gradients in the hero sections; instead, use flat brand colors #FE2C55 and #25F4EE."**
- `recall_lessons` (long-term, cross-session) ->
  **"Do not use gradients in the hero sections."**

## The exact working config

See `cognee.env`. Key points:

| Setting | Value | Why |
|---|---|---|
| `LLM_PROVIDER` | `ollama` | local, free |
| `LLM_MODEL` | `qwen2.5:7b-instruct` | FAST (glm-4.7-flash is too slow) |
| `LLM_ENDPOINT` | `http://localhost:11434/v1` | Ollama OpenAI-compatible API |
| `LLM_API_KEY` | `ollama` | placeholder, required by adapter |
| `EMBEDDING_PROVIDER` | `fastembed` | local, keyless; fixes the empty-embedding bug |
| `EMBEDDING_MODEL` | `BAAI/bge-small-en-v1.5` | 384-dim non-zero vectors |
| `EMBEDDING_DIMENSIONS` | `384` | matches the model |
| `HUGGINGFACE_TOKENIZER` | `BAAI/bge-small-en-v1.5` | satisfies the ollama LLMConfig validator |
| `COGNEE_SKIP_CONNECTION_TEST` | `true` | the preflight probe times out at 30s otherwise |

### Two non-obvious fixes baked into the bridge

1. **Persistence dir** is set via the **config API** (`cognee.config.system_root_directory()` /
   `data_root_directory()`), NOT env vars — `base_config` reads `SYSTEM_ROOT_DIRECTORY` /
   `DATA_ROOT_DIRECTORY`, not `COGNEE_*`. The bridge pins everything under
   `~/.tasteloop_cognee` so every CLI invocation shares the same graph/vector store.

2. **Ollama str-response-model shim.** cognee's `GRAPH_COMPLETION` final-answer step (and the
   connection probe) call `acreate_structured_output(..., response_model=str)`. The Ollama
   instructor adapter assumes a pydantic `BaseModel` and calls `.model_json_schema()` on the
   bare `str` -> `AttributeError` -> retried with backoff -> hang. The bridge monkeypatches the
   adapter to wrap simple types (`str`/`int`/...) in a one-field pydantic envelope and unwrap
   `.value` afterward. Pure transport shim; real graph/LLM/embeddings are untouched.

## The bridge: `web/src/cognee_bridge.py`

```
python3 cognee_bridge.py <cmd> '<json-args>'
```

| cmd | args | output |
|---|---|---|
| `open_session` | `{"sessionId"}` | `{"ok":true,"sessionId":...,"dataset":...}` |
| `write_trace` | `{"sessionId","role","finding","severity"}` | `{"ok":true,"added":N,"dataset":...}` (add + cognify into a per-session dataset) |
| `recall_in_run` | `{"sessionId","query"}` | `{"hits":[{"snippet":...}]}` |
| `distill` | `{"sessionId"}` | `{"lessonsAccepted":[{"statement":...}]}` |
| `recall_lessons` | `{"query"}` | `{"lessons":[{"statement":...}]}` |

Contract for the Node caller:
- **Only one JSON object** is printed to stdout; all cognee/log chatter is redirected to stderr.
- On any failure it prints `{"error":"..."}` to stdout and **exits non-zero**, so Node can fall back.

Run it under the cognee venv:
```bash
source /tmp/cognee_smoke/venv/bin/activate
python3 web/src/cognee_bridge.py recall_in_run '{...}'
```

## Real captured outputs (live run, clean DB)

```text
$ python3 cognee_bridge.py open_session '{"sessionId":"hero_demo"}'
{"ok": true, "sessionId": "hero_demo", "dataset": "sess_hero_demo"}

$ python3 cognee_bridge.py write_trace '{"sessionId":"hero_demo","role":"designer","severity":"rule","finding":"TikTok brand rules: primary #FE2C55, accent #25F4EE, on black/white; bold Inter-style type; RULE: NEVER use gradients in the hero; use flat brand colors #FE2C55 and #25F4EE."}'
{"ok": true, "added": 1, "dataset": "sess_hero_demo"}

$ python3 cognee_bridge.py recall_in_run '{"sessionId":"hero_demo","query":"what are the rules for the hero background?"}'
{"hits": [{"snippet": "Never use gradients in the hero sections; instead, use flat brand colors #FE2C55 and #25F4EE."}]}

$ python3 cognee_bridge.py recall_in_run '{"sessionId":"hero_demo","query":"which exact colors are allowed in the hero?"}'
{"hits": [{"snippet": "The exact colors allowed in the hero are #FE2C55 and #25F4EE."}]}

$ python3 cognee_bridge.py distill '{"sessionId":"hero_demo"}'
{"lessonsAccepted": [{"statement": "Never use gradients in the hero sections; instead, use flat brand colors #FE2C55 and #25F4EE."}], "via": "fallback"}

$ python3 cognee_bridge.py recall_lessons '{"query":"hero background gradient rule"}'
{"lessons": [{"statement": "Do not use gradients in the hero sections."}]}

$ python3 cognee_bridge.py bogus '{}'   # error path
{"error": "unknown command 'bogus'. valid: ['distill', 'open_session', 'recall_in_run', 'recall_lessons', 'write_trace']"}   # exit 2
```

## Note on `distill_session`

cognee's native `cognee.session.distill_session()` runs but returns `no_accepted_lessons`
with a local qwen model: its auto-feedback step rarely gates session-context entries above the
`MIN_GATE_CONFIDENCE = 0.75` threshold, and the writer LLM is conservative. The bridge therefore
tries `distill_session` first and **falls back to its own grouping** (a single GRAPH_COMPLETION
summary of the session's durable rule), then persists that lesson into the long-term
`tasteloop_lessons` dataset so `recall_lessons` finds it across sessions. Output is identical in
shape (`{"lessonsAccepted":[{"statement":...}]}`), so the Node demo needs no special-casing.
