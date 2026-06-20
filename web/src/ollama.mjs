// ollama.mjs — minimal, dependency-free client for a local Ollama server.
// Frozen signatures:
//   export async function chat(messages, opts={}) -> string (assistant content)
//   export async function chatJSON(messages, opts={}) -> parsed object
//
// Uses global fetch (Node 18+). No npm deps.

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434/api/chat";
const DEFAULT_MODEL = "qwen2.5:7b-instruct";
const TIMEOUT_MS = 60_000;

/**
 * Send a chat completion request to the local Ollama server.
 * @param {Array<{role:string,content:string}>} messages
 * @param {{model?:string, json?:boolean, temperature?:number}} opts
 * @returns {Promise<string>} assistant message content
 */
export async function chat(messages, opts = {}) {
  const {
    model = DEFAULT_MODEL,
    json = false,
    temperature = 0.6,
  } = opts;

  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("ollama.chat: `messages` must be a non-empty array");
  }

  const body = {
    model,
    messages,
    stream: false,
    // Only include `format` when JSON mode is requested.
    format: json ? "json" : undefined,
    options: { temperature },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res;
  try {
    res = await fetch(OLLAMA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err && err.name === "AbortError") {
      throw new Error(`ollama.chat: request timed out after ${TIMEOUT_MS}ms (is Ollama running at ${OLLAMA_URL}?)`);
    }
    throw new Error(`ollama.chat: fetch failed (${err && err.message ? err.message : err}). Is Ollama running at ${OLLAMA_URL}?`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let detail = "";
    try { detail = await res.text(); } catch { /* ignore */ }
    throw new Error(`ollama.chat: HTTP ${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 500)}` : ""}`);
  }

  let data;
  try {
    data = await res.json();
  } catch (err) {
    throw new Error(`ollama.chat: could not parse response JSON (${err && err.message ? err.message : err})`);
  }

  // Ollama /api/chat returns { message: { role, content }, ... }
  const content = data && data.message && typeof data.message.content === "string"
    ? data.message.content
    : "";

  if (!content) {
    throw new Error(`ollama.chat: empty assistant content in response: ${JSON.stringify(data).slice(0, 500)}`);
  }

  return content;
}

/**
 * Same as chat() but forces JSON mode and tolerantly parses the result.
 * @param {Array<{role:string,content:string}>} messages
 * @param {{model?:string, temperature?:number}} opts
 * @returns {Promise<any>} parsed object/array
 */
export async function chatJSON(messages, opts = {}) {
  const raw = await chat(messages, { ...opts, json: true });
  return parseTolerantJSON(raw);
}

/**
 * Tolerant JSON parser: strips code fences, then tries a direct parse,
 * then falls back to extracting the first balanced {...} or [...] block.
 * @param {string} text
 * @returns {any}
 */
export function parseTolerantJSON(text) {
  if (text == null) throw new Error("chatJSON: no text to parse");
  let s = String(text).trim();

  // Strip ```json ... ``` or ``` ... ``` fences.
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  // First attempt: parse as-is.
  try {
    return JSON.parse(s);
  } catch { /* fall through */ }

  // Second attempt: extract the first balanced object or array.
  const candidate = extractFirstJSON(s);
  if (candidate != null) {
    try {
      return JSON.parse(candidate);
    } catch { /* fall through */ }
  }

  throw new Error(`chatJSON: could not parse JSON from model output: ${s.slice(0, 300)}`);
}

/**
 * Scan for the first balanced JSON object or array, ignoring braces inside strings.
 * @param {string} s
 * @returns {string|null}
 */
function extractFirstJSON(s) {
  const openIdx = (() => {
    const o = s.indexOf("{");
    const a = s.indexOf("[");
    if (o === -1) return a;
    if (a === -1) return o;
    return Math.min(o, a);
  })();
  if (openIdx === -1) return null;

  const open = s[openIdx];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;

  for (let i = openIdx; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) { esc = false; }
      else if (ch === "\\") { esc = true; }
      else if (ch === '"') { inStr = false; }
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return s.slice(openIdx, i + 1);
    }
  }
  return null;
}

// ---- tiny smoke test (no network required) ----
if (import.meta.url === `file://${process.argv[1]}`) {
  const tests = [
    ['```json\n{"a":1}\n```', { a: 1 }],
    ['here you go: {"score": 87, "note": "good {nested}"}', { score: 87, note: "good {nested}" }],
    ['[{"x":1},{"y":2}]', [{ x: 1 }, { y: 2 }]],
    ['  {"quote":"say \\"hi\\""}  ', { quote: 'say "hi"' }],
  ];
  let ok = true;
  for (const [input, expected] of tests) {
    const got = parseTolerantJSON(input);
    const pass = JSON.stringify(got) === JSON.stringify(expected);
    if (!pass) ok = false;
    console.log(pass ? "PASS" : "FAIL", JSON.stringify(input).slice(0, 50), "->", JSON.stringify(got));
  }
  console.log(ok ? "ollama.mjs smoke: ALL PASS" : "ollama.mjs smoke: FAILURES");
  process.exit(ok ? 0 : 1);
}
