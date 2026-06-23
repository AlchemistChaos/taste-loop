// observatory/serve.mjs — a live "mission control" for the multi-agent WORKFLOWS
// run by the orchestrator (the Workflow tool), styled after the TasteLoop demo UI.
//
// It reads, with ZERO dependencies, the on-disk artifacts every workflow leaves:
//   <root>/<session>/subagents/workflows/wf_<id>/journal.jsonl   (agent started/result)
//   <root>/<session>/subagents/workflows/wf_<id>/agent-*.jsonl   (each agent transcript)
//   <root>/<session>/workflows/scripts/<name>-wf_<id>.js          (the workflow name)
// and serves a small UI that lets you watch the fan-out live: phases -> agent cards
// with their PROMPT, their TOOL-CALL timeline (what work they did), and their OUTPUT.
//
//   node observatory/serve.mjs            # http://localhost:8091  (override with PORT=)
//   OBS_ROOT=/path/to/project-claude-dir node observatory/serve.mjs
//
// Default root is auto-derived from cwd: ~/.claude/projects/<cwd-with-/-as-->/

import http from "node:http";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.env.PORT || 8091);

// Default: this project's Claude data dir (cwd path with / replaced by -).
const ROOT =
  process.env.OBS_ROOT ||
  join(homedir(), ".claude", "projects", process.cwd().replace(/\//g, "-"));

const readJsonl = (file) => {
  const out = [];
  let txt;
  try { txt = readFileSync(file, "utf8"); } catch { return out; }
  for (const line of txt.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { /* skip partial trailing line */ }
  }
  return out;
};

// ---- discovery: find every wf_<id> dir under any session, + its human name ----
function findWorkflows() {
  const found = [];
  let sessions = [];
  try { sessions = readdirSync(ROOT); } catch { return found; }
  for (const sess of sessions) {
    const wfDir = join(ROOT, sess, "subagents", "workflows");
    if (!existsSync(wfDir)) continue;
    // map wf_id -> script name
    const names = {};
    const scriptsDir = join(ROOT, sess, "workflows", "scripts");
    if (existsSync(scriptsDir)) {
      for (const f of readdirSync(scriptsDir)) {
        const m = f.match(/^(.*)-(wf_[a-z0-9-]+)\.js$/i);
        if (m) names[m[2]] = m[1];
      }
    }
    for (const wf of readdirSync(wfDir)) {
      if (!wf.startsWith("wf_")) continue;
      const dir = join(wfDir, wf);
      let mtime = 0;
      try { mtime = statSync(join(dir, "journal.jsonl")).mtimeMs; } catch { try { mtime = statSync(dir).mtimeMs; } catch {} }
      found.push({ id: wf, name: names[wf] || wf, dir, session: sess, mtime });
    }
  }
  found.sort((a, b) => b.mtime - a.mtime);
  return found;
}

// ---- transcript parsing: one agent-*.jsonl -> {prompt, toolCalls, output, ...} ----
const contentOf = (line) => {
  const c = line?.message?.content ?? line?.content;
  if (Array.isArray(c)) return c;
  if (typeof c === "string") return [{ type: "text", text: c }];
  return [];
};
const textOf = (blocks) =>
  blocks.filter((b) => b?.type === "text").map((b) => b.text || "").join("\n").trim();

function toolSummary(name, input) {
  if (!input || typeof input !== "object") return "";
  if (name === "Bash") return String(input.command || "").slice(0, 160);
  if (name === "Read" || name === "Edit" || name === "Write" || name === "NotebookEdit")
    return String(input.file_path || "");
  if (name === "Grep" || name === "Glob") return String(input.pattern || input.query || "");
  if (name === "Agent" || name === "Task") return String(input.description || input.prompt || "").slice(0, 160);
  if (name === "StructuredOutput") return "(structured result)";
  const firstStr = Object.values(input).find((v) => typeof v === "string");
  return firstStr ? String(firstStr).slice(0, 160) : "";
}

function parseAgent(file) {
  const lines = readJsonl(file);
  let prompt = "", output = "", structured = null;
  const toolCalls = [];
  let firstTs = null, lastTs = null;
  for (const ln of lines) {
    if (ln.timestamp) { firstTs ??= ln.timestamp; lastTs = ln.timestamp; }
    const blocks = contentOf(ln);
    if (ln.type === "user" && !prompt) {
      // first real user turn = the task prompt (ignore tool_result-only turns)
      const t = textOf(blocks);
      if (t) prompt = t;
    }
    if (ln.type === "assistant") {
      const t = textOf(blocks);
      if (t) output = t; // last non-empty assistant text wins
      for (const b of blocks) {
        if (b?.type === "tool_use") {
          toolCalls.push({ name: b.name, summary: toolSummary(b.name, b.input), ts: ln.timestamp || null });
          if (b.name === "StructuredOutput") structured = b.input;
        }
      }
    }
  }
  // a structured-output result is the truest "output"
  if (structured) { try { output = JSON.stringify(structured, null, 2); } catch {} }
  const counts = toolCalls.reduce((m, t) => ((m[t.name] = (m[t.name] || 0) + 1), m), {});
  return {
    prompt, output, toolCalls, counts,
    durationMs: firstTs && lastTs ? new Date(lastTs) - new Date(firstTs) : null,
    lines: lines.length,
  };
}

// The harness keeps the nice agent label/phase in memory, not on disk — so we
// derive them from each agent's prompt (which is distinctive per task).
const PHASE_ORDER = ["contracts", "research", "investigate", "review", "implement", "synthesize", "agents"];
function deriveLabel(prompt = "") {
  const own = prompt.match(/You OWN:\s*([^\n]+)/i);
  if (own) {
    const seg = own[1].split(/\bImplement\b|\bBrief:/i)[0]; // stop before the brief text
    const paths = seg.match(/\/[^\s,]+?\.[a-z]{2,5}\b/gi) || [];
    const files = [...new Set(paths.map((s) => s.split("/").pop()))].slice(0, 3);
    return { phase: "implement", label: files.length ? "impl: " + files.join(", ") : "implement" };
  }
  if (/CONTRACTS architect|freeze the shared interfaces/i.test(prompt)) return { phase: "contracts", label: "contracts" };
  if (/INTEGRATION reviewer/i.test(prompt)) return { phase: "review", label: "review: integration" };
  if (/FAIRNESS\b|CORRECTNESS reviewer/i.test(prompt)) return { phase: "review", label: "review: fairness" };
  if (/adversarially verify|try to refute|REFUTE/i.test(prompt)) return { phase: "review", label: "verify" };
  if (/\breviewer\b|review the /i.test(prompt)) return { phase: "review", label: "review" };
  if (/consolidat|synthesi[sz]e|definitive answer|punch-?list/i.test(prompt)) return { phase: "synthesize", label: "synthesize" };
  // generic fallback: first distinctive sentence after any shared preamble
  const line = prompt.split(/\n|\. /).map((s) => s.trim())
    .find((s) => s.length > 12 && !/^you are executing|hard rules/i.test(s)) || "agent";
  return { phase: "agents", label: line.slice(0, 50) };
}

function buildModel(wf) {
  const journal = readJsonl(join(wf.dir, "journal.jsonl"));
  const status = {}; // agentId -> 'running' | 'done'
  for (const e of journal) {
    if (!e.agentId) continue;
    if (e.type === "started") status[e.agentId] ??= "running";
    if (e.type === "result") status[e.agentId] = "done";
  }
  const agents = [];
  for (const f of readdirSync(wf.dir)) {
    if (!/^agent-.*\.jsonl$/.test(f)) continue;
    const agentId = f.replace(/^agent-/, "").replace(/\.jsonl$/, "");
    const parsed = parseAgent(join(wf.dir, f));
    const { phase, label } = deriveLabel(parsed.prompt);
    agents.push({ agentId, label, phase, status: status[agentId] || "running", ...parsed });
  }
  agents.sort((a, b) => a.label.localeCompare(b.label));
  const phases = [...new Set(agents.map((a) => a.phase))]
    .sort((a, b) => (PHASE_ORDER.indexOf(a) + 1 || 99) - (PHASE_ORDER.indexOf(b) + 1 || 99));
  return { id: wf.id, name: wf.name, session: wf.session, phases, agents };
}

// ---- http ----
const send = (res, code, body, type = "application/json") =>
  (res.writeHead(code, { "content-type": type, "cache-control": "no-store" }), res.end(body));

http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/" ) return send(res, 200, readFileSync(join(HERE, "index.html")), "text/html");
    if (url.pathname === "/app.js") return send(res, 200, readFileSync(join(HERE, "app.js")), "text/javascript");
    if (url.pathname === "/api/workflows")
      return send(res, 200, JSON.stringify(findWorkflows().map(({ dir, ...w }) => w)));
    if (url.pathname === "/api/workflow") {
      const id = url.searchParams.get("id");
      const wf = findWorkflows().find((w) => w.id === id);
      if (!wf) return send(res, 404, JSON.stringify({ error: "not found" }));
      return send(res, 200, JSON.stringify(buildModel(wf)));
    }
    return send(res, 404, JSON.stringify({ error: "no route" }));
  } catch (e) {
    return send(res, 500, JSON.stringify({ error: String(e && e.message || e) }));
  }
}).listen(PORT, () => {
  console.log(`agent observatory → http://localhost:${PORT}`);
  console.log(`watching: ${ROOT}`);
});
