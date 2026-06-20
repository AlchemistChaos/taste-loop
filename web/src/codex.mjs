// codex.mjs — run Codex (GPT-5.4, medium reasoning) non-interactively to BUILD real
// site HTML. Uses `codex exec` with the user's ChatGPT auth (keyless).
//
// NO FALLBACK: codexRun retries ONCE then throws a clear error. codexBuildSite
// throws if Codex fails — it never returns a template. The orchestrator is
// expected to surface the error, not paper over it.
//
// === Verified working invocation (codex-cli 0.141.0, ChatGPT auth) ===
//   codex exec \
//     -c model="gpt-5.4" \
//     -c model_reasoning_effort="medium" \
//     -c approval_policy="never" \
//     -s read-only \
//     --skip-git-repo-check \
//     --ephemeral \
//     -c suppress_unstable_features_warning=true \
//     -o <last-message-file> \
//     -                      # prompt is piped on stdin
//
// Notes from investigation:
//   * `-a/--ask-for-approval` is NOT a valid `codex exec` flag (interactive only);
//     for exec you MUST use `-c approval_policy="never"`.
//   * `gpt-5.4-codex` / `gpt-5.5-codex` are REJECTED with a ChatGPT account
//     ("model is not supported when using Codex with a ChatGPT account").
//     `gpt-5.4` (and `gpt-5.5`) work. We default to gpt-5.4 medium per directive.
//   * `-o/--output-last-message <FILE>` writes ONLY the agent's final message to a
//     file — far cleaner than scraping stdout (which is full of TUI chrome).
//   * `-s read-only` + approval_policy=never => the agent cannot run shell tools
//     and never blocks on a prompt; it just produces its final text answer.
//   * One TikTok-site build took ~51s. We default the timeout to 180s.
//
// Config (env overridable):
//   CODEX_MODEL   default "gpt-5.4"
//   CODEX_EFFORT  default "medium"
//   CODEX_TIMEOUT default 180000 ms
//   CODEX_BIN     default "codex"
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MODEL = process.env.CODEX_MODEL || "gpt-5.4";
const EFFORT = process.env.CODEX_EFFORT || "medium";
const DEFAULT_TIMEOUT = Number(process.env.CODEX_TIMEOUT || 180_000);
const CODEX_BIN = process.env.CODEX_BIN || "codex";

// Spawn one `codex exec` turn. Resolves with the agent's FINAL message (string)
// read from the --output-last-message file, or rejects with a descriptive Error.
function codexExecOnce(prompt, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let lastMsgPath = null;
    let tmpDir = null;

    const cleanup = async () => {
      if (tmpDir) { try { await rm(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } }
    };

    mkdtemp(join(tmpdir(), "codex-exec-"))
      .then((dir) => {
        tmpDir = dir;
        lastMsgPath = join(dir, "last.txt");

        const args = [
          "exec",
          "-c", `model="${MODEL}"`,
          "-c", `model_reasoning_effort="${EFFORT}"`,
          "-c", `approval_policy="never"`,
          "-s", "read-only",
          "--skip-git-repo-check",
          "--ephemeral",
          "-c", "suppress_unstable_features_warning=true",
          "-o", lastMsgPath,
          "-", // read prompt from stdin
        ];

        let child;
        try {
          child = spawn(CODEX_BIN, args, { stdio: ["pipe", "pipe", "pipe"] });
        } catch (err) {
          settled = true;
          cleanup();
          return reject(new Error(`codex spawn failed: ${err?.message || err}`));
        }

        let stderr = "";
        const tailStderr = () => stderr.split("\n").filter(Boolean).slice(-6).join("\n");

        const killer = setTimeout(() => {
          if (settled) return;
          settled = true;
          try { child.kill("SIGKILL"); } catch { /* ignore */ }
          cleanup();
          reject(new Error(`codex exec timed out after ${timeoutMs}ms (model=${MODEL}, effort=${EFFORT})`));
        }, timeoutMs);

        // Drain stdout so the pipe never fills and blocks the child.
        child.stdout.on("data", () => {});
        child.stderr.on("data", (d) => { stderr += d.toString(); });

        child.on("error", (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(killer);
          cleanup();
          reject(new Error(`codex process error: ${err?.message || err}`));
        });

        child.on("close", async (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(killer);
          let finalMsg = null;
          try { finalMsg = (await readFile(lastMsgPath, "utf8")).trim(); } catch { /* file may not exist */ }
          await cleanup();

          if (code !== 0) {
            return reject(new Error(
              `codex exec exited with code ${code} (model=${MODEL}, effort=${EFFORT}).\n${tailStderr()}`
            ));
          }
          if (!finalMsg) {
            return reject(new Error(
              `codex exec produced no final message (exit 0, empty output).\n${tailStderr()}`
            ));
          }
          resolve(finalMsg);
        });

        try {
          child.stdin.write(prompt);
          child.stdin.end();
        } catch (err) {
          if (settled) return;
          settled = true;
          clearTimeout(killer);
          try { child.kill("SIGKILL"); } catch { /* ignore */ }
          cleanup();
          reject(new Error(`failed to write prompt to codex stdin: ${err?.message || err}`));
        }
      })
      .catch((err) => {
        if (settled) return;
        settled = true;
        reject(new Error(`codex temp setup failed: ${err?.message || err}`));
      });
  });
}

/**
 * Run one Codex turn and return its final text. Retries ONCE on failure, then
 * throws. NEVER returns null / a silent fallback.
 * @param {string} prompt
 * @param {{timeoutMs?:number}} [opts]
 * @returns {Promise<string>} the model's final message text
 */
export async function codexRun(prompt, { timeoutMs = DEFAULT_TIMEOUT } = {}) {
  if (!prompt || !String(prompt).trim()) {
    throw new Error("codexRun: empty prompt");
  }
  let firstErr;
  try {
    return await codexExecOnce(prompt, timeoutMs);
  } catch (err) {
    firstErr = err;
  }
  // single retry
  try {
    return await codexExecOnce(prompt, timeoutMs);
  } catch (err) {
    throw new Error(
      `codexRun failed after 2 attempts.\n  attempt#1: ${firstErr?.message || firstErr}\n  attempt#2: ${err?.message || err}`
    );
  }
}

/**
 * Extract a clean <!DOCTYPE ...</html> document from Codex output. Codex may wrap
 * the answer in markdown fences or add stray prose; we strip that. THROWS if no
 * usable HTML document is found (no null fallback).
 * @param {string} text
 * @returns {string} clean HTML document
 */
export function extractHtml(text) {
  if (!text) throw new Error("extractHtml: empty input");
  let s = String(text);

  // Strip a fenced code block if the whole answer is wrapped in one.
  const fence = s.match(/```(?:html)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1];

  const lower = s.toLowerCase();
  const doctype = lower.indexOf("<!doctype");
  const startHtml = doctype === -1 ? lower.indexOf("<html") : doctype;
  const end = lower.lastIndexOf("</html>");

  if (startHtml === -1 || end === -1 || end <= startHtml) {
    const preview = s.slice(0, 200).replace(/\s+/g, " ");
    throw new Error(`extractHtml: no <!DOCTYPE..</html> document found. preview="${preview}"`);
  }
  return s.slice(startHtml, end + "</html>".length).trim();
}

/**
 * Build a FULL, real marketing HTML page with Codex. 5 sections, Tailwind CDN,
 * on-brand, real copy. If `lesson` is provided it MUST be applied (e.g. no
 * gradients). THROWS on any failure — NO template fallback.
 * @param {{brand:object, goal:string, copyHint?:string, lesson?:string}} args
 * @returns {Promise<string>} clean HTML document string
 */
export async function codexBuildSite({ brand, goal, copyHint, lesson }) {
  if (!brand || !brand.colors) throw new Error("codexBuildSite: missing brand/colors");
  if (!goal) throw new Error("codexBuildSite: missing goal");

  const c = brand.colors;
  const headingFont = brand.fonts?.heading || "Inter";
  const tone = Array.isArray(brand.tone) ? brand.tone.join(", ") : (brand.tone || "");
  const donts = brand.dont || brand.donts || [];
  const sections = (brand.sections && brand.sections.length === 5)
    ? brand.sections
    : ["hero", "problem", "how-it-works", "proof", "closing CTA"];

  const rule = lesson
    ? `\nLEARNED RULE you MUST apply (from memory, non-negotiable): ${lesson}\n`
    : "";

  const prompt =
    `You are a senior front-end designer building a real marketing website.\n` +
    `GOAL: ${goal}\n` +
    `BRAND: colors primary ${c.primary}, accent ${c.accent}, bg ${c.bg}, text ${c.fg}; ` +
    `font ${headingFont}; tone ${tone}; audience ${brand.audience || "general"}.\n` +
    `BRAND DON'Ts (must obey): ${JSON.stringify(donts)}.\n` +
    rule +
    (copyHint ? `Copy direction: ${copyHint}\n` : "") +
    `Build a single self-contained responsive HTML5 page with EXACTLY 5 sections ` +
    `(${sections.join(", ")}), using Tailwind via CDN (https://cdn.tailwindcss.com) ` +
    `and the ${headingFont} Google font. Write real, on-brand marketing copy (NO lorem, ` +
    `NO placeholder text). Use flat brand-color blocks only. Strong visual hierarchy, ` +
    `large headings, real CTAs.\n` +
    `OUTPUT ONLY the HTML document, starting with <!DOCTYPE html> and ending with </html>. ` +
    `No commentary, no explanations, no markdown code fences. ` +
    `Do NOT run any shell commands or read/write files — just produce the HTML in your reply.`;

  const raw = await codexRun(prompt);
  const html = extractHtml(raw); // throws if Codex didn't return real HTML

  // Enforce the learned anti-gradient rule when present: fail loudly instead of
  // silently shipping a violating page.
  if (lesson && /gradient/i.test(lesson) && /gradient/i.test(html)) {
    throw new Error(
      `codexBuildSite: lesson forbids gradients but Codex output contains "gradient". ` +
      `Refusing to return a rule-violating page (no fallback).`
    );
  }
  return html;
}

// ---- proof harness: `node web/src/codex.mjs` builds a real TikTok page ----
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const brand = {
      colors: { primary: "#FE2C55", accent: "#25F4EE", bg: "#000000", fg: "#FFFFFF" },
      fonts: { heading: "Inter", body: "Inter" },
      tone: ["bold", "energetic", "direct"],
      audience: "creators & businesses",
      dont: ["NO gradients", "no generic AI stock", "no tiny text"],
      sections: ["hero", "problem", "how-it-works", "proof", "cta"],
    };
    const t0 = Date.now();
    const html = await codexBuildSite({
      brand,
      goal: "Go viral. Get customers. Landing page for a TikTok marketing tool.",
      copyHint: 'Hero headline tone: "Go viral. Get customers."',
      lesson: "never use gradients; use flat #FE2C55/#25F4EE color blocks",
    });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log("===== FIRST 300 CHARS =====");
    console.log(html.slice(0, 300));
    console.log("\n===== STATS =====");
    console.log("length:", html.length);
    console.log("starts <!DOCTYPE:", /^<!doctype html/i.test(html));
    console.log("ends </html>:", /<\/html>\s*$/i.test(html));
    console.log("gradient count:", (html.match(/gradient/gi) || []).length);
    console.log("has Tailwind CDN:", html.includes("cdn.tailwindcss.com"));
    console.log("build time (s):", secs);
  })().catch((err) => {
    console.error("PROOF FAILED:", err.message);
    process.exit(1);
  });
}
