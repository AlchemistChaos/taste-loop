#!/usr/bin/env python3
"""Cognee CLI bridge for the taste-loop Node demo.

Usage:
    python3 cognee_bridge.py <cmd> '<json-args>'

Commands (cmd -> json-args -> stdout JSON):
    open_session       {"sessionId": "..."}                 -> {"ok": true, "sessionId": ...}
    write_trace        {"sessionId","role","finding","severity"} -> {"ok": true, "added": N}
    write_traces_batch {"sessionId","traces":[{role,finding,severity}]} -> {"ok": true, "added": N}
                       (adds all traces then cognifies ONCE — fast path)
    recall_in_run      {"sessionId","query"}                -> {"hits": [{"snippet": ...}]}
    distill        {"sessionId"}                        -> {"lessonsAccepted": [{"statement": ...}]}
    recall_lessons {"query"}                            -> {"lessons": [{"statement": ...}]}

Contract:
    * ONLY a single JSON object is printed to stdout. All cognee/log chatter is
      redirected to stderr so the Node caller can JSON.parse stdout safely.
    * On any failure it prints {"error": "..."} to stdout and exits non-zero, so
      the Node caller can fall back gracefully.

Proven-working config (see /Users/chaosalchemist/Github/taste-loop/cognee.env):
    LLM   = Ollama qwen2.5:7b-instruct via http://localhost:11434/v1 (FAST)
    EMBED = fastembed BAAI/bge-small-en-v1.5 (local, keyless, 384 dims)
    + COGNEE_SKIP_CONNECTION_TEST=true
    + str-response-model compatibility shim for the Ollama instructor adapter.
"""

import os
import sys
import json
import asyncio
import contextlib

# ---------------------------------------------------------------------------
# 0. CRITICAL: keep stdout clean. cognee + libs print warnings/logs everywhere.
#    Swap real stdout for stderr during all work; restore only to emit the JSON.
# ---------------------------------------------------------------------------
_REAL_STDOUT = sys.stdout
sys.stdout = sys.stderr  # everything noisy goes to stderr from here on


def _emit(obj, code=0):
    """Print exactly one JSON object to the real stdout and exit."""
    sys.stdout = _REAL_STDOUT
    print(json.dumps(obj))
    sys.stdout.flush()
    sys.exit(code)


# ---------------------------------------------------------------------------
# 1. WORKING ENV (set before importing cognee). Mirrors cognee.env.
# ---------------------------------------------------------------------------
os.environ.setdefault("COGNEE_SKIP_CONNECTION_TEST", "true")
os.environ.setdefault("LLM_PROVIDER", "ollama")
os.environ.setdefault("LLM_MODEL", "qwen2.5:7b-instruct")
os.environ.setdefault("LLM_ENDPOINT", "http://localhost:11434/v1")
os.environ.setdefault("LLM_API_KEY", "ollama")
os.environ.setdefault("EMBEDDING_PROVIDER", "fastembed")
os.environ.setdefault("EMBEDDING_MODEL", "BAAI/bge-small-en-v1.5")
os.environ.setdefault("EMBEDDING_DIMENSIONS", "384")
os.environ.setdefault("HUGGINGFACE_TOKENIZER", "BAAI/bge-small-en-v1.5")
os.environ.setdefault("CACHING", "true")
os.environ.setdefault("AUTO_FEEDBACK", "true")
# quieter libs
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

# Fixed persistence home so every CLI invocation shares the same graph/vector store.
HOME = os.path.expanduser(os.environ.get("TASTELOOP_COGNEE_HOME", "~/.tasteloop_cognee"))
SYS_DIR = os.path.join(HOME, "system")
DATA_DIR = os.path.join(HOME, "data")
os.makedirs(SYS_DIR, exist_ok=True)
os.makedirs(DATA_DIR, exist_ok=True)

LONG_TERM_DATASET = "tasteloop_lessons"


def _session_dataset(session_id: str) -> str:
    safe = "".join(c if (c.isalnum() or c == "_") else "_" for c in str(session_id))
    return f"sess_{safe}"


# ---------------------------------------------------------------------------
# Lesson quality gate. Distillation (especially the qwen-backed graph
# completion) loves to emit degenerate filler like "Got it." or "Focus on how
# to..." with no concrete, enforceable rule. A garbage lesson is worse than no
# lesson: it pollutes recall and gets re-injected into builds. So we keep ONLY
# concrete, actionable brand/design rules and drop everything else.
# ---------------------------------------------------------------------------
import re as _re

_DEGENERATE_PREFIX = _re.compile(r"^(got it|understood|okay|ok|sure|noted|focus on how)\b", _re.I)

# A real lesson should name a concrete brand/design lever (color, spacing, a
# forbidden element, a rule verb, etc). This catches the common useful signals
# without being so strict it drops legitimate rules.
_CONCRETE_HINT = _re.compile(
    r"(gradient|color|colour|contrast|accent|cta|button|font|type|typograph|spacing|"
    r"padding|margin|radius|shadow|border|hero|headline|buzzword|jargon|brand|"
    r"token|palette|hex|#[0-9a-f]{3,8}|layout|align|whitespace|forbid|avoid|"
    r"never|always|ensure|prefer|require|must|don'?t|do not|use\b|keep\b|remove)",
    _re.I,
)


def _is_quality_lesson(statement) -> bool:
    """True only for concrete, actionable brand/design rules."""
    if not statement:
        return False
    s = str(statement).strip()
    if len(s) < 20:
        return False
    if _DEGENERATE_PREFIX.search(s):
        return False
    # Reject meta-fluff that has no concrete brand/design lever at all.
    if not _CONCRETE_HINT.search(s):
        return False
    return True


def _filter_lessons(lessons):
    """Filter a list of {"statement": ...} dicts down to quality lessons."""
    out = []
    seen = set()
    for lsn in lessons or []:
        stmt = (lsn or {}).get("statement") if isinstance(lsn, dict) else lsn
        stmt = (str(stmt or "")).strip()
        if not _is_quality_lesson(stmt):
            continue
        key = stmt.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append({"statement": stmt})
    return out


# ---------------------------------------------------------------------------
# 2. Import cognee and apply the Ollama str-response-model compatibility shim.
#    Wrap any import failure into clean JSON so Node can fall back.
# ---------------------------------------------------------------------------
try:
    import cognee
    from cognee.modules.search.types import SearchType
    from cognee.modules.engine.operations.setup import setup as _cognee_setup

    from pydantic import BaseModel as _BaseModel, create_model as _create_model
    from cognee.infrastructure.llm.structured_output_framework.litellm_instructor.llm.ollama import (
        adapter as _ollama_adapter,
    )

    _orig_acso = _ollama_adapter.OllamaAPIAdapter.acreate_structured_output

    async def _patched_acso(self, text_input, system_prompt, response_model, **kwargs):
        # Real pydantic models: behave exactly as before.
        if isinstance(response_model, type) and issubclass(response_model, _BaseModel):
            return await _orig_acso(self, text_input, system_prompt, response_model, **kwargs)
        # Simple types (str/int/...): wrap in a pydantic envelope, unwrap .value after.
        Wrapper = _create_model("SimpleValue", value=(response_model, ...))
        sys_p = f'{system_prompt}\n\nReturn your answer as JSON: {{"value": <your answer>}}'
        wrapped = await _orig_acso(self, text_input, sys_p, Wrapper, **kwargs)
        return wrapped.value

    _ollama_adapter.OllamaAPIAdapter.acreate_structured_output = _patched_acso
except Exception as e:  # pragma: no cover
    _emit({"error": f"cognee import failed: {e}"}, code=1)


# ---------------------------------------------------------------------------
# 3. Idempotent setup. cognee.setup() is cheap to re-run (creates DBs if absent).
# ---------------------------------------------------------------------------
_SETUP_DONE = False


async def _ensure_setup():
    global _SETUP_DONE
    if _SETUP_DONE:
        return
    # Pin persistence + provider config via the config API (env var NAMES differ,
    # so the API is the reliable path for the fixed home dir).
    cognee.config.system_root_directory(SYS_DIR)
    cognee.config.data_root_directory(DATA_DIR)
    cognee.config.set_llm_provider("ollama")
    cognee.config.set_llm_model("qwen2.5:7b-instruct")
    cognee.config.set_llm_endpoint("http://localhost:11434/v1")
    cognee.config.set_llm_api_key("ollama")
    cognee.config.set_embedding_provider("fastembed")
    cognee.config.set_embedding_model("BAAI/bge-small-en-v1.5")
    cognee.config.set_embedding_dimensions(384)
    await _cognee_setup()
    _SETUP_DONE = True


def _result_texts(search_results):
    """Flatten cognee.search() output into a list of plain answer strings."""
    out = []
    if isinstance(search_results, list):
        for item in search_results:
            if isinstance(item, dict):
                sr = item.get("search_result")
                if isinstance(sr, list):
                    out.extend(str(x) for x in sr if str(x).strip())
                elif sr:
                    out.append(str(sr))
                else:
                    txt = item.get("answer") or item.get("text")
                    if txt:
                        out.append(str(txt))
            elif item is not None and str(item).strip():
                out.append(str(item))
    elif search_results:
        out.append(str(search_results))
    return out


# ---------------------------------------------------------------------------
# 4. Command handlers.
# ---------------------------------------------------------------------------
async def cmd_open_session(args):
    await _ensure_setup()
    sid = args["sessionId"]
    return {"ok": True, "sessionId": sid, "dataset": _session_dataset(sid)}


async def cmd_write_trace(args):
    await _ensure_setup()
    sid = args["sessionId"]
    role = args.get("role", "agent")
    finding = args["finding"]
    severity = args.get("severity", "info")
    ds = _session_dataset(sid)
    text = f"[{severity}] {role}: {finding}"
    await cognee.add(text, dataset_name=ds)
    await cognee.cognify(datasets=[ds])
    return {"ok": True, "added": 1, "dataset": ds}


async def cmd_write_traces_batch(args):
    """Fast path: add MANY traces, then cognify the dataset exactly ONCE.

    cognify is the expensive (graph-building) step; running it per-trace is the
    memory-page slowness. Batching every finding into a single cognify keeps the
    same graph result for a fraction of the wall-clock cost.

    args = {"sessionId", "traces": [{"role","finding","severity"}, ...]}
    """
    await _ensure_setup()
    sid = args["sessionId"]
    ds = _session_dataset(sid)
    traces = args.get("traces") or []
    added = 0
    for tr in traces:
        finding = (tr or {}).get("finding")
        if not finding or not str(finding).strip():
            continue
        role = (tr or {}).get("role", "agent")
        severity = (tr or {}).get("severity", "info")
        text = f"[{severity}] {role}: {finding}"
        await cognee.add(text, dataset_name=ds)
        added += 1
    # Single cognify for the whole batch (vs once per trace).
    if added:
        await cognee.cognify(datasets=[ds])
    return {"ok": True, "added": added, "dataset": ds}


async def cmd_recall_in_run(args):
    await _ensure_setup()
    sid = args["sessionId"]
    query = args["query"]
    ds = _session_dataset(sid)
    results = await cognee.search(
        query,
        query_type=SearchType.GRAPH_COMPLETION,
        datasets=[ds],
        session_id=sid,
    )
    hits = [{"snippet": t} for t in _result_texts(results)]
    return {"hits": hits}


async def cmd_distill(args):
    await _ensure_setup()
    sid = args["sessionId"]
    ds = _session_dataset(sid)

    # --- Path A: cognee's native distill_session (best when auto-feedback gated
    #     enough high-confidence context entries during the session). ---
    try:
        from cognee.modules.users.methods import get_default_user

        user = await get_default_user()
        res = await cognee.session.distill_session(session_id=sid, dataset=ds, user=user)
        docs = list(getattr(res, "documents", []) or [])
        if docs:
            raw = [{"statement": d.strip()} for d in docs if d and d.strip()]
            # Quality gate: only concrete, actionable brand/design rules survive.
            lessons = _filter_lessons(raw)
            if lessons:
                # Also publish into the long-term lessons dataset for cross-run recall.
                with contextlib.suppress(Exception):
                    for lsn in lessons:
                        await cognee.add(lsn["statement"], dataset_name=LONG_TERM_DATASET)
                    await cognee.cognify(datasets=[LONG_TERM_DATASET])
                return {"lessonsAccepted": lessons, "via": "distill_session"}
            # docs existed but none were quality -> return zero, not garbage.
            if raw:
                return {"lessonsAccepted": [], "via": "distill_session", "note": "no quality lessons"}
    except Exception as e:  # fail-open into the fallback grouping
        print(f"distill_session fell back: {e}", file=sys.stderr)

    # --- Path B: own grouping. Ask the session's graph for its durable rules,
    #     synthesize a WrittenLesson-shaped statement, persist it long-term. ---
    summary = await cognee.search(
        "Summarize the single most important durable design/brand rule from this "
        "session as one standalone imperative sentence.",
        query_type=SearchType.GRAPH_COMPLETION,
        datasets=[ds],
        session_id=sid,
    )
    texts = _result_texts(summary)
    if not texts:
        return {"lessonsAccepted": [], "via": "fallback", "note": "no graph content"}
    # Quality gate every candidate sentence; keep only concrete brand/design rules.
    lessons = _filter_lessons([{"statement": t} for t in texts])
    if not lessons:
        return {"lessonsAccepted": [], "via": "fallback", "note": "no quality lessons"}
    lessons = lessons[:1]  # fallback path stays conservative: one durable rule.
    # Persist into the long-term lessons dataset so recall_lessons can find it later.
    with contextlib.suppress(Exception):
        for lsn in lessons:
            await cognee.add(lsn["statement"], dataset_name=LONG_TERM_DATASET)
        await cognee.cognify(datasets=[LONG_TERM_DATASET])
    return {"lessonsAccepted": lessons, "via": "fallback"}


async def cmd_recall_lessons(args):
    await _ensure_setup()
    query = args["query"]
    results = await cognee.search(
        query,
        query_type=SearchType.GRAPH_COMPLETION,
        datasets=[LONG_TERM_DATASET],
    )
    lessons = [{"statement": t} for t in _result_texts(results)]
    return {"lessons": lessons}


_COMMANDS = {
    "open_session": cmd_open_session,
    "write_trace": cmd_write_trace,
    "write_traces_batch": cmd_write_traces_batch,
    "recall_in_run": cmd_recall_in_run,
    "distill": cmd_distill,
    "recall_lessons": cmd_recall_lessons,
}


async def _main():
    if len(sys.argv) < 2:
        _emit({"error": "usage: cognee_bridge.py <cmd> '<json-args>'"}, code=2)
    cmd = sys.argv[1]
    raw_args = sys.argv[2] if len(sys.argv) > 2 else "{}"
    if cmd not in _COMMANDS:
        _emit({"error": f"unknown command '{cmd}'. valid: {sorted(_COMMANDS)}"}, code=2)
    try:
        args = json.loads(raw_args)
    except Exception as e:
        _emit({"error": f"invalid json args: {e}"}, code=2)
    try:
        result = await _COMMANDS[cmd](args)
    except Exception as e:
        import traceback

        traceback.print_exc(file=sys.stderr)
        _emit({"error": f"{cmd} failed: {e}"}, code=1)
    _emit(result, code=0)


if __name__ == "__main__":
    asyncio.run(_main())
