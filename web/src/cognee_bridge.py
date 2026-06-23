#!/usr/bin/env python3
"""Cognee v1 CLI bridge for the taste-loop Node demo.

Usage:
    python3 cognee_bridge.py <cmd> '<json-args>'

This is the **Cognee v1** spine (remember / recall / improve / forget +
session.{add_feedback, get_session, distill_session}). It is **session-scoped**
and **reset-per-run**: there is NO durable cross-run lessons store. Every run
mints a fresh ``sessionId = "sess_<runId>_<page>"``; ``reset`` wipes that run's
session dataset; nothing is ever written to a permanent ``tasteloop_lessons``
dataset (that whole cross-run path is deliberately gone — C1/H4).

Commands (cmd -> json-args -> stdout JSON):
    reset                  {"sessionId"}
                           -> {"ok": true, "reset": ["sess_..."], "dataset": "sess_..."}
    remember-trace         {"sessionId","role","finding","severity","node_set":[...]}
                           -> {"ok": true, "added": 1, "dataset": "sess_..."}
    remember-traces-batch  {"sessionId","traces":[{"role","finding","severity","node_set"}]}
                           -> {"ok": true, "added": N, "dataset": "sess_..."}
    recall                 {"sessionId","query","node_name?":[...]}
                           -> {"hits":[{"snippet","role"}], "qa_id": <id|null>}   (VERBATIM)
    cmd_feedback           {"sessionId","qa_id"|null,"feedbackText","feedbackScore"}
                           -> {"ok": true, "applied": true|false}
    cmd_improve            {"sessionIds":[...],"feedbackAlpha": <number>}
                           -> {"ok": true, "improved": true}
    distill                {"sessionId"}
                           -> {"lessonsAccepted":[{"statement"}], "via": "..."}

Stdout contract (frozen):
    * EXACTLY one JSON object is printed to the real stdout. All cognee/log
      chatter is redirected to stderr so the Node caller can JSON.parse stdout.
    * On any failure it prints {"error": "..."} to stdout and exits non-zero,
      so the Node caller falls back gracefully (the shim mirrors every write).

Config (read from cognee.env; see /Users/chaosalchemist/Github/taste-loop/cognee.env):
    LLM   = Ollama glm-4.7-flash:latest via http://localhost:11434/v1 (strong at
            the strict-Pydantic JSON cognify/distill_session need; keyless, local).
            Fallback if GLM struggles: gemma3:27b.
    EMBED = fastembed BAAI/bge-small-en-v1.5 (local, keyless, 384 dims).
    + COGNEE_SKIP_CONNECTION_TEST=true
    + ENABLE_BACKEND_ACCESS_CONTROL=false  (so improve() can persist feedback weights;
      multi-user access control otherwise rejects writes to the session dataset).
    + str-response-model compatibility shim for the Ollama instructor adapter.

Verbatim-recall design (H5 — NON-NEGOTIABLE):
    ``remember(session_id=...)`` writes to the **session cache** (fast, no cognify).
    The verbatim, byte-unchanged finding strings come back from
    ``session.get_session(sessionId)`` (the ``.answer`` field) together with the
    real ``qa_id`` used by ``add_feedback``. We ALSO run the contract-mandated
    ``recall(query, query_type=CHUNKS_LEXICAL, only_context=True, node_name=...)``
    so any cognified token nodes (brand ingest) are matched lexically (BM25,
    exact-term — ideal for ``#25F4EE``). NEITHER path runs GRAPH_COMPLETION, so
    Cognee's own LLM can never rewrite what reaches a build.
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
# 1. WORKING ENV (set before importing cognee). Mirrors cognee.env. We load the
#    cognee.env file directly so the bridge never drifts from the proven config
#    and never silently re-hardcodes the old qwen default.
# ---------------------------------------------------------------------------
def _load_cognee_env():
    """Best-effort: read sibling cognee.env into os.environ (without clobber).

    Looks two levels up from web/src/ (repo root) and in CWD. Lines are
    ``KEY=VALUE``; ``#`` comments and blanks are skipped. We use setdefault so an
    explicit process-level env var (e.g. an override from memory.mjs) still wins.
    """
    here = os.path.dirname(os.path.abspath(__file__))
    candidates = [
        os.path.join(here, "..", "..", "cognee.env"),  # repo root
        os.path.join(here, "..", "cognee.env"),         # web/
        os.path.join(os.getcwd(), "cognee.env"),
    ]
    seen = set()
    for path in candidates:
        path = os.path.abspath(path)
        if path in seen or not os.path.isfile(path):
            continue
        seen.add(path)
        try:
            with open(path, "r", encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    key, _, val = line.partition("=")
                    key = key.strip()
                    val = val.strip().strip('"').strip("'")
                    if key:
                        os.environ.setdefault(key, val)
        except Exception:  # pragma: no cover - env file best-effort
            continue


_load_cognee_env()

# Hard defaults (used only if cognee.env did not supply them). The LLM_MODEL
# MUST come from cognee.env (glm-4.7-flash:latest); we never re-hardcode qwen.
os.environ.setdefault("COGNEE_SKIP_CONNECTION_TEST", "true")
os.environ.setdefault("LLM_PROVIDER", "ollama")
os.environ.setdefault("LLM_MODEL", "glm-4.7-flash:latest")
os.environ.setdefault("LLM_ENDPOINT", "http://localhost:11434/v1")
os.environ.setdefault("LLM_API_KEY", "ollama")
os.environ.setdefault("EMBEDDING_PROVIDER", "fastembed")
os.environ.setdefault("EMBEDDING_MODEL", "BAAI/bge-small-en-v1.5")
os.environ.setdefault("EMBEDDING_DIMENSIONS", "384")
os.environ.setdefault("HUGGINGFACE_TOKENIZER", "BAAI/bge-small-en-v1.5")
os.environ.setdefault("CACHING", "true")
os.environ.setdefault("AUTO_FEEDBACK", "true")
# Disable multi-user access control so improve()/forget() can write to the
# session dataset under the default user (otherwise: 422 write-access errors).
os.environ.setdefault("ENABLE_BACKEND_ACCESS_CONTROL", "false")
# quieter libs
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

# The resolved model (for config API + smoke gate reporting).
_LLM_MODEL = os.environ.get("LLM_MODEL", "glm-4.7-flash:latest")
_LLM_PROVIDER = os.environ.get("LLM_PROVIDER", "ollama")
_LLM_ENDPOINT = os.environ.get("LLM_ENDPOINT", "http://localhost:11434/v1")
_LLM_API_KEY = os.environ.get("LLM_API_KEY", "ollama")
_EMBED_PROVIDER = os.environ.get("EMBEDDING_PROVIDER", "fastembed")
_EMBED_MODEL = os.environ.get("EMBEDDING_MODEL", "BAAI/bge-small-en-v1.5")
_EMBED_DIMS = int(os.environ.get("EMBEDDING_DIMENSIONS", "384") or 384)

# Fixed persistence home so every CLI invocation shares the same graph/vector store.
HOME = os.path.expanduser(os.environ.get("TASTELOOP_COGNEE_HOME", "~/.tasteloop_cognee"))
SYS_DIR = os.path.join(HOME, "system")
DATA_DIR = os.path.join(HOME, "data")
os.makedirs(SYS_DIR, exist_ok=True)
os.makedirs(DATA_DIR, exist_ok=True)

# Default per-command timeout (H7); overridable via env. The DISPATCH layer wraps
# every handler in asyncio.wait_for(..., timeout=COGNEE_CMD_TIMEOUT).
CMD_TIMEOUT = float(os.environ.get("COGNEE_CMD_TIMEOUT", "120"))

# C1c: there is NO durable cross-run lessons store. We keep the constant ONLY so a
# defensive reset can wipe any stale artifact from a previous (pre-v3.1) build; we
# NEVER write to it.
LEGACY_LONG_TERM_DATASET = "tasteloop_lessons"


def _session_dataset(session_id: str) -> str:
    safe = "".join(c if (c.isalnum() or c == "_") else "_" for c in str(session_id))
    return f"sess_{safe}"


# ---------------------------------------------------------------------------
# Lesson quality gate. distill_session (and any GLM graph completion) can still
# emit degenerate filler like "Got it." or "Focus on how to..." with no concrete,
# enforceable rule. A garbage lesson is worse than no lesson: it pollutes recall
# and gets re-injected into builds. So we keep ONLY concrete, actionable
# brand/design rules and drop everything else. (This is a NON-scoring display
# filter on the Lessons counter — never on a learnable score path — Guardrail 5.)
# ---------------------------------------------------------------------------
import re as _re

_DEGENERATE_PREFIX = _re.compile(r"^(got it|understood|okay|ok|sure|noted|focus on how)\b", _re.I)

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
# 2. Import cognee (v1) and apply the Ollama str-response-model compatibility
#    shim. Wrap any import failure into clean JSON so Node can fall back.
# ---------------------------------------------------------------------------
try:
    import cognee
    from cognee.modules.search.types import SearchType
    from cognee.modules.engine.operations.setup import setup as _cognee_setup
    from cognee.modules.users.methods import get_default_user

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
#    Provider config is pinned from cognee.env (NOT hardcoded qwen — C-pin).
# ---------------------------------------------------------------------------
_SETUP_DONE = False


async def _ensure_setup():
    global _SETUP_DONE
    if _SETUP_DONE:
        return
    cognee.config.system_root_directory(SYS_DIR)
    cognee.config.data_root_directory(DATA_DIR)
    cognee.config.set_llm_provider(_LLM_PROVIDER)
    cognee.config.set_llm_model(_LLM_MODEL)  # glm-4.7-flash:latest from cognee.env
    cognee.config.set_llm_endpoint(_LLM_ENDPOINT)
    cognee.config.set_llm_api_key(_LLM_API_KEY)
    cognee.config.set_embedding_provider(_EMBED_PROVIDER)
    cognee.config.set_embedding_model(_EMBED_MODEL)
    cognee.config.set_embedding_dimensions(_EMBED_DIMS)
    await _cognee_setup()
    _SETUP_DONE = True


async def _default_user():
    with contextlib.suppress(Exception):
        return await get_default_user()
    return None


# ---------------------------------------------------------------------------
# Result flattening helpers.
# ---------------------------------------------------------------------------
def _entry_text(entry):
    """Pull the verbatim text out of a v1 recall ResponseEntry (any source)."""
    for field in ("content", "text", "answer"):
        val = getattr(entry, field, None)
        if val is not None and str(val).strip():
            return str(val)
    return None


def _recall_texts(recall_results):
    """Flatten cognee.recall() typed entries into plain verbatim strings."""
    out = []
    for entry in (recall_results or []):
        txt = _entry_text(entry)
        if txt and txt.strip():
            out.append(txt)
    return out


def _recall_qa_id(recall_results):
    """First qa_id present on a recall entry (ResponseQAEntry), else None."""
    for entry in (recall_results or []):
        qid = getattr(entry, "qa_id", None)
        if qid:
            return str(qid)
    return None


def _node_name_match(text, node_name):
    """OR-join read filter (mirrors node_name_filter_operator='OR'): keep a hit if
    ANY requested token appears (case-insensitive) in the verbatim string. With no
    filter, keep everything."""
    if not node_name:
        return True
    low = (text or "").lower()
    return any(str(n).lower() in low for n in node_name if str(n).strip())


# ---------------------------------------------------------------------------
# 4. Command handlers (Cognee v1).
# ---------------------------------------------------------------------------
async def cmd_reset(args):
    """Wipe ALL stores for a run (C1, H4): forget the run's session dataset.

    NEVER writes to / depends on the long-term lessons dataset. Optionally also
    forgets a stale legacy artifact defensively, but never creates/populates it.
    """
    await _ensure_setup()
    sid = args["sessionId"]
    ds = _session_dataset(sid)
    reset = []
    with contextlib.suppress(Exception):
        await cognee.forget(dataset=ds)
        reset.append(sid)
    # Defensive only: wipe any stale pre-v3.1 long-term artifact. We never write here.
    with contextlib.suppress(Exception):
        await cognee.forget(dataset=LEGACY_LONG_TERM_DATASET)
    return {"ok": True, "reset": reset or [sid], "dataset": ds}


async def cmd_remember_trace(args):
    """Write ONE critique finding into the run's session cache (spine step 3).

    remember(finding, session_id=sid, node_set=[token, role, severity]) writes to
    the session cache (NOT the permanent graph) — correct for reset-per-run, and
    fast (no per-trace cognify). Recall reads it back verbatim via get_session.
    """
    await _ensure_setup()
    sid = args["sessionId"]
    role = args.get("role", "critique")
    finding = args["finding"]
    severity = args.get("severity", "info")
    node_set = args.get("node_set") or [role, severity]
    ds = _session_dataset(sid)
    await cognee.remember(finding, session_id=sid, node_set=list(node_set))
    return {"ok": True, "added": 1, "dataset": ds}


async def cmd_remember_traces_batch(args):
    """Batch variant: write MANY findings to the session cache (spine step 3).

    args = {"sessionId", "traces": [{"role","finding","severity","node_set"}, ...]}
    Each remember(session_id=...) is a cheap session-cache write (no cognify), so
    the batch is naturally fast — no separate cognify step is needed for traces.
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
        role = (tr or {}).get("role", "critique")
        severity = (tr or {}).get("severity", "info")
        node_set = (tr or {}).get("node_set") or [role, severity]
        await cognee.remember(finding, session_id=sid, node_set=list(node_set))
        added += 1
    return {"ok": True, "added": added, "dataset": ds}


async def cmd_recall(args):
    """VERBATIM in-run recall + qa_id (C2, H5; spine step 1).

    Two complementary verbatim sources, NEITHER running GRAPH_COMPLETION:
      (a) session cache via get_session(sid): the byte-unchanged finding strings
          (the .answer field) plus the real qa_id used by add_feedback. This is
          the authoritative verbatim trace recall for the reset-per-run model.
      (b) lexical graph search: recall(query, query_type=CHUNKS_LEXICAL,
          only_context=True, node_name=[...]) — BM25 exact-term, ideal for hex
          tokens like #25F4EE that were cognified into a dataset (brand ingest).

    node_name (OPTIONAL) is an OR-joined read filter applied to both sources.
    Returns {"hits": [{"snippet", "role"}], "qa_id": <id|null>} — snippets are
    byte-identical to what was stored.
    """
    await _ensure_setup()
    sid = args["sessionId"]
    query = args["query"]
    node_name = args.get("node_name") or None
    ds = _session_dataset(sid)

    snippets = []  # preserve order; dedupe by exact string
    seen = set()
    qa_id = None

    def _add(text):
        if not text:
            return
        s = str(text)
        if s in seen:
            return
        if not _node_name_match(s, node_name):
            return
        seen.add(s)
        snippets.append(s)

    # (a) Authoritative verbatim session cache + qa_id.
    user = await _default_user()
    with contextlib.suppress(Exception):
        sess = await cognee.session.get_session(session_id=sid, user=user)
        # Most-recent qa first so feedback targets the latest interaction.
        for entry in reversed(list(sess or [])):
            if qa_id is None:
                qid = getattr(entry, "qa_id", None)
                if qid:
                    qa_id = str(qid)
            ans = getattr(entry, "answer", None)
            _add(ans)

    # (b) Lexical (BM25, exact-term) graph recall — VERBATIM only_context.
    #     Pinned to CHUNKS_LEXICAL explicitly (auto_route may not pick lexical).
    with contextlib.suppress(Exception):
        recall_kwargs = dict(
            query_type=SearchType.CHUNKS_LEXICAL,
            datasets=[ds],
            only_context=True,
            session_id=sid,
        )
        if node_name:
            recall_kwargs["node_name"] = list(node_name)
        results = await cognee.recall(query, **recall_kwargs)
        if qa_id is None:
            qa_id = _recall_qa_id(results)
        for txt in _recall_texts(results):
            _add(txt)

    hits = [{"snippet": s, "role": "memory"} for s in snippets]
    return {"hits": hits, "qa_id": qa_id}


async def cmd_feedback(args):
    """Record the judged delta as feedback (spine step 5; C2).

    Resolve qa_id (use the passed one, else get_session(sid) latest), then
    session.add_feedback(sid, qa_id, feedback_text, feedback_score). applied:false
    when no qa_id can be resolved (callers handle gracefully).
    """
    await _ensure_setup()
    sid = args["sessionId"]
    qa_id = args.get("qa_id")
    feedback_text = args.get("feedbackText")
    feedback_score = args.get("feedbackScore")

    user = await _default_user()
    if not qa_id:
        with contextlib.suppress(Exception):
            sess = await cognee.session.get_session(session_id=sid, user=user)
            for entry in reversed(list(sess or [])):
                qid = getattr(entry, "qa_id", None)
                if qid:
                    qa_id = str(qid)
                    break
    if not qa_id:
        return {"ok": True, "applied": False}

    try:
        await cognee.session.add_feedback(
            session_id=sid,
            qa_id=qa_id,
            feedback_text=feedback_text,
            feedback_score=feedback_score,
            user=user,
        )
        return {"ok": True, "applied": True}
    except Exception as e:  # non-fatal: feedback miss != dead run
        print(f"add_feedback failed: {e}", file=sys.stderr)
        return {"ok": True, "applied": False}


async def cmd_improve(args):
    """Reweight the session(s) by feedback (spine step 6).

    improve(session_ids=[...], feedback_alpha=...) persists session Q&A into the
    graph + applies feedback weights so the NEXT turn's recall ranks proven fixes
    higher. feedback_alpha rides in **kwargs (NOT a named param). This is the only
    op allowed graph-completion-class work (it is NOT build-feeding).
    """
    await _ensure_setup()
    session_ids = args.get("sessionIds") or []
    if isinstance(session_ids, str):
        session_ids = [session_ids]
    feedback_alpha = args.get("feedbackAlpha", 0.5)
    user = await _default_user()
    kwargs = {"feedback_alpha": feedback_alpha}
    if user is not None:
        kwargs["user"] = user
    await cognee.improve(session_ids=list(session_ids), **kwargs)
    return {"ok": True, "improved": True}


async def _ensure_session_dataset(sid, ds, user):
    """distill_session requires the `dataset` to EXIST and be writable (it calls
    get_authorized_existing_datasets). remember(session_id=...) only writes to the
    session cache — it never registers a `sess_*` dataset — so distill would 422.
    Seed the named dataset ONCE from the session's own verbatim findings (one
    cognify) so the distillation scope resolves. This stays session-only (the
    seed is the very findings the session already holds; nothing durable/cross-run).
    Returns True if the dataset now has content to distill against.
    """
    # Pull the verbatim findings the session already holds.
    findings = []
    with contextlib.suppress(Exception):
        sess = await cognee.session.get_session(session_id=sid, user=user)
        for entry in (sess or []):
            ans = getattr(entry, "answer", None)
            if ans and str(ans).strip():
                findings.append(str(ans))
    if not findings:
        return False
    with contextlib.suppress(Exception):
        await cognee.remember(
            "\n".join(findings), dataset_name=ds, node_set=["session"], run_in_background=False
        )
        return True
    return False


async def cmd_distill(args):
    """SESSION-ONLY distill (spine step 9). Writes NOTHING durable cross-run (C1c).

    distill_session(session_id, dataset) runs on glm-4.7-flash and returns
    WrittenLessons. We quality-gate them and feed ONLY the in-run Lessons counter.
    If GLM yields 0 valid lessons (or there are no gated context entries — the
    auto-feedback gate can stay empty on the local stack) the counter degrades
    gracefully (Traces-only): we return an empty list + the distill `status`/note,
    never silently claiming success.
    """
    await _ensure_setup()
    sid = args["sessionId"]
    ds = _session_dataset(sid)
    user = await _default_user()

    # Ensure the distillation dataset exists (else distill_session 422s).
    await _ensure_session_dataset(sid, ds, user)

    try:
        res = await cognee.session.distill_session(session_id=sid, dataset=ds, user=user)
        status = getattr(res, "status", None)
        docs = list(getattr(res, "documents", []) or [])
        raw = [{"statement": str(d).strip()} for d in docs if d and str(d).strip()]
        lessons = _filter_lessons(raw)
        # status ∈ {completed, no_gated_entries, no_proposed_lessons, no_accepted_lessons}
        note = None
        if not lessons:
            note = f"no lessons (status={status})" if status else "no quality lessons"
        return {
            "lessonsAccepted": lessons,
            "via": "distill_session",
            "status": str(status) if status is not None else None,
            "note": note,
        }
    except Exception as e:  # fail-open: degrade gracefully to Traces-only
        print(f"distill_session failed: {e}", file=sys.stderr)
        return {"lessonsAccepted": [], "via": "distill_session", "note": f"distill error: {e}"}


_COMMANDS = {
    "reset": cmd_reset,
    "remember-trace": cmd_remember_trace,
    "remember-traces-batch": cmd_remember_traces_batch,
    "recall": cmd_recall,
    # Legacy alias kept for back-compat; body is the verbatim path (no GRAPH_COMPLETION).
    "recall_in_run": cmd_recall,
    "cmd_feedback": cmd_feedback,
    "cmd_improve": cmd_improve,
    "distill": cmd_distill,
}


# ---------------------------------------------------------------------------
# 5. Smoke gate (Plan 1.0): run `python3 cognee_bridge.py __smoke__` to prove the
#    v1 surface imports AND glm-4.7-flash emits >=1 valid strict-Pydantic
#    WrittenLesson JSON from distill_session on a small fixture. PASS prints
#    {"ok": true, "lessons": N>0, ...}; FAIL prints {"ok": false, ...} so the
#    caller can switch cognee.env LLM_MODEL to gemma3:27b and retry.
# ---------------------------------------------------------------------------
async def _smoke_gate():
    # (a) v1 surface imports (already proven by the module-level import block).
    surface = {
        "remember": hasattr(cognee, "remember"),
        "recall": hasattr(cognee, "recall"),
        "improve": hasattr(cognee, "improve"),
        "forget": hasattr(cognee, "forget"),
        "session.add_feedback": hasattr(cognee.session, "add_feedback"),
        "session.get_session": hasattr(cognee.session, "get_session"),
        "session.distill_session": hasattr(cognee.session, "distill_session"),
    }
    if not all(surface.values()):
        return {"ok": False, "stage": "import", "surface": surface, "model": _LLM_MODEL}

    # (b) glm WrittenLesson count > 0 from a 2-3 trace fixture, driven through the
    #     REALISTIC spine (remember -> recall -> feedback -> improve -> distill) so
    #     the auto-feedback context gate has its best chance to populate.
    await _ensure_setup()
    sid = "sess_smoke_gate"
    ds = _session_dataset(sid)
    user = await _default_user()
    fixture = [
        "The CTA button uses a gradient fill but the brand forbids gradients; use the flat #25F4EE accent instead.",
        "Body copy contrast is below 4.5:1 against the dark hero; raise foreground to a brand-safe near-white.",
        "Headline uses generic jargon ('synergy'); replace with concrete brand voice per the tone tokens.",
    ]
    with contextlib.suppress(Exception):
        await cognee.forget(dataset=ds)
    # spine 3: remember each finding into the session cache
    for f in fixture:
        await cognee.remember(f, session_id=sid, node_set=["smoke", "critique"])
    # spine 1+5: recall (creates QA + context) then positive feedback on the qa_id
    for f in fixture:
        with contextlib.suppress(Exception):
            await cmd_recall({"sessionId": sid, "query": f})
        with contextlib.suppress(Exception):
            await cmd_feedback({"sessionId": sid, "qa_id": None, "feedbackText": f, "feedbackScore": 5})
    # spine 6: improve so the session persists/reweights
    with contextlib.suppress(Exception):
        await cmd_improve({"sessionIds": [sid], "feedbackAlpha": 0.5})
    # spine 9: distill
    out = await cmd_distill({"sessionId": sid})
    lessons = out.get("lessonsAccepted") or []
    status = out.get("status")
    ok = len(lessons) > 0
    if ok:
        note = None
    elif status and "gated" in str(status):
        note = ("distill returned no_gated_entries: the auto-feedback context gate "
                "did not promote entries on this stack. Lessons degrade to Traces-only "
                "(honest); the spine still records Traces. Retry/larger model "
                "(gemma3:27b) MAY populate gated entries.")
    else:
        note = ("glm emitted 0 valid WrittenLessons -> switch cognee.env LLM_MODEL to "
                "gemma3:27b and retry; counters degrade to Traces-only.")

    return {
        "ok": ok,
        "stage": "distill",
        "model": _LLM_MODEL,
        "lessons": len(lessons),
        "via": out.get("via"),
        "status": status,
        "surface": surface,
        "note": note,
    }


# ---------------------------------------------------------------------------
# 6. Dispatch (H7: timeout wrapper at the _COMMANDS dispatch layer).
# ---------------------------------------------------------------------------
async def _main():
    if len(sys.argv) < 2:
        _emit({"error": "usage: cognee_bridge.py <cmd> '<json-args>'"}, code=2)
    cmd = sys.argv[1]

    # Smoke gate is a special, untimed (long) dev command.
    if cmd in ("__smoke__", "--smoke", "smoke"):
        try:
            result = await _smoke_gate()
        except Exception as e:
            import traceback
            traceback.print_exc(file=sys.stderr)
            _emit({"ok": False, "error": f"smoke failed: {e}"}, code=1)
        _emit(result, code=0 if result.get("ok") else 1)

    raw_args = sys.argv[2] if len(sys.argv) > 2 else "{}"
    if cmd not in _COMMANDS:
        _emit({"error": f"unknown command '{cmd}'. valid: {sorted(_COMMANDS)}"}, code=2)
    try:
        args = json.loads(raw_args)
    except Exception as e:
        _emit({"error": f"invalid json args: {e}"}, code=2)
    try:
        # H7: wrap EVERY handler at the dispatch layer with a timeout.
        result = await asyncio.wait_for(_COMMANDS[cmd](args), timeout=CMD_TIMEOUT)
    except asyncio.TimeoutError:
        _emit({"error": f"{cmd} timed out"}, code=1)
    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        _emit({"error": f"{cmd} failed: {e}"}, code=1)
    _emit(result, code=0)


if __name__ == "__main__":
    asyncio.run(_main())
