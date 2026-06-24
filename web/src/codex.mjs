// codex.mjs — run Codex (GPT-5.4, medium reasoning) non-interactively to BUILD real
// site HTML. Uses `codex exec` with the user's ChatGPT auth (keyless).
//
// NO FALLBACK: codexRun retries `retries` times (default 1; the gen-loop callers
// codexBuildSite / reviseHtml / codexJudge / codexCritique / runSvgImage pass 0)
// then throws a clear error. An OUTER Promise.race holds the live child handle and
// SIGKILLs the whole process *tree* on timeout (the inner per-attempt timeout only
// kills the direct child). codexBuildSite throws if Codex fails — it never returns
// a template. The orchestrator is expected to surface the error, not paper over it.
//
// VISION ACTORS (all-LLM, NO regex):
//   * codexJudge   — two-axis judge: returns {quality, brandAdherence, reasoning,
//                    findings}. The LOCKED 0.6/0.4 blend + cap is computed by the
//                    judge.mjs owner in judgeSite (NOT here) — codex.mjs only asks
//                    Codex for the two axes directly.
//   * codexCritique — all-LLM vision critique. Renders its own pre-revise PNG (or
//                    uses a caller-supplied screenshotPath) and returns
//                    [{flaw, brandRuleCited(enum from brand.dont), severity}].
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
//   CODEX_MODEL        default "gpt-5.4"
//   CODEX_EFFORT       default "medium"  (build + default reasoning effort)
//   CODEX_JUDGE_EFFORT default "medium"  (vision/text judge — faster than HIGH)
//   CODEX_TIMEOUT      default 180000 ms
//   CODEX_BIN          default "codex"
//   CODEX_IMAGE        default unset. When "1", codexExecOnce runs with
//                      `-s workspace-write` (so an image-gen turn may write a file)
//                      instead of the default `-s read-only`. Opt-in only — the
//                      default sandbox stays read-only for every other actor.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderShot } from "./render.mjs";

const MODEL = process.env.CODEX_MODEL || "gpt-5.4";
const EFFORT = process.env.CODEX_EFFORT || "medium";
// Judge effort: MEDIUM by default (2.7) — gpt-5.4 medium is markedly faster than
// HIGH while still discriminating, and the vision (-i) path does the heavy lifting.
const JUDGE_EFFORT = process.env.CODEX_JUDGE_EFFORT || "medium";
const DEFAULT_TIMEOUT = Number(process.env.CODEX_TIMEOUT || 180_000);
const CODEX_BIN = process.env.CODEX_BIN || "codex";
// Page sections: env-tunable (SECTIONS, default 5) so the page is RICH enough to
// compose the full .ds-* component vocabulary (hero / problem / how-it-works / stats /
// closing CTA), not a thin 3-section stub. The 2-6 clamp is preserved.
// trimSections() trims ONLY the DEFAULT pool down to SECTION_COUNT (keeping the hero
// first + CTA last and sampling the middle); a planner-supplied brief.sectionOrder is
// honored in full and is NEVER clipped (see codexBuildSite).
const SECTION_COUNT = Math.max(2, Math.min(6, Number(process.env.SECTIONS) || 5));
function trimSections(pool, n) {
  const list = Array.isArray(pool) ? pool.filter(Boolean) : [];
  if (list.length <= n) return list;
  if (n <= 1) return [list[0]];
  const out = [list[0]];
  const inner = list.slice(1, -1);
  const innerCount = n - 2;
  for (let i = 1; i <= innerCount; i++) {
    out.push(inner[Math.min(inner.length - 1, Math.floor((i * inner.length) / (innerCount + 1)))]);
  }
  out.push(list[list.length - 1]);
  return out;
}

// Sandbox for `codex exec`. DEFAULT stays "read-only" for every actor so a turn
// can never touch the filesystem. An OPT-IN image-gen turn (Phase 2.5) may request
// "workspace-write" — globally via CODEX_IMAGE=1 or per-call via the `sandbox`
// option on codexExecOnce/codexRun. Anything other than the two known values falls
// back to "read-only" (never silently widen the sandbox).
const DEFAULT_SANDBOX = process.env.CODEX_IMAGE === "1" ? "workspace-write" : "read-only";
function normalizeSandbox(sandbox) {
  return sandbox === "workspace-write" ? "workspace-write" : "read-only";
}

// Resolve web/run/design-system.css relative to this file (web/src/codex.mjs).
const __dirname = dirname(fileURLToPath(import.meta.url));            // web/src
const DESIGN_CSS_PATH = resolve(__dirname, "..", "run", "design-system.css");

// Spawn one `codex exec` turn. Resolves with the agent's FINAL message (string)
// read from the --output-last-message file, or rejects with a descriptive Error.
// `effort` overrides the default reasoning effort for this turn (e.g. "high").
// `images` is an optional array of image file paths attached via `-i <FILE>` so
// the model can VISION-judge a rendered screenshot.
// `sandbox` selects the `codex exec -s` sandbox (default "read-only"; opt-in
// "workspace-write" for the image-gen turn). `onChild(child)` is invoked with the
// live child process once spawned so an OUTER layer (codexRun) can hold the handle
// and SIGKILL the whole process tree on its own race timeout.
function codexExecOnce(prompt, timeoutMs, effort = EFFORT, images = [], sandbox = DEFAULT_SANDBOX, onChild = null) {
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
          "-c", `model_reasoning_effort="${effort}"`,
          "-c", `approval_policy="never"`,
          "-s", normalizeSandbox(sandbox),
          "--skip-git-repo-check",
          "--ephemeral",
          "-c", "suppress_unstable_features_warning=true",
          "-o", lastMsgPath,
        ];
        // Attach any images via `-i/--image <FILE>` (codex exec supports this) so
        // the model can judge the rendered DESIGN, not just the HTML source.
        for (const img of images) {
          if (img) args.push("-i", img);
        }
        // Read prompt from stdin (must come last).
        args.push("-");

        let child;
        try {
          child = spawn(CODEX_BIN, args, { stdio: ["pipe", "pipe", "pipe"] });
        } catch (err) {
          settled = true;
          cleanup();
          return reject(new Error(`codex spawn failed: ${err?.message || err}`));
        }
        // Hand the live child to the outer race (codexRun) so it can SIGKILL the
        // whole process tree if ITS timeout fires before this attempt settles.
        if (typeof onChild === "function") { try { onChild(child); } catch { /* ignore */ } }

        let stderr = "";
        const tailStderr = () => stderr.split("\n").filter(Boolean).slice(-6).join("\n");

        const killer = setTimeout(() => {
          if (settled) return;
          settled = true;
          try { child.kill("SIGKILL"); } catch { /* ignore */ }
          cleanup();
          reject(new Error(`codex exec timed out after ${timeoutMs}ms (model=${MODEL}, effort=${effort})`));
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
              `codex exec exited with code ${code} (model=${MODEL}, effort=${effort}).\n${tailStderr()}`
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
 * SIGKILL a child process AND any subprocesses it spawned (the "tree"). The inner
 * per-attempt timeout in codexExecOnce only kills the direct `codex` child; codex
 * can fork its own helpers, so a hung turn can survive that. Here we (a) SIGKILL
 * the direct child and (b) best-effort `pkill -KILL -P <pid>` its descendants on
 * POSIX. All errors are swallowed — this is a last-resort cleanup, never fatal.
 * @param {import('node:child_process').ChildProcess|null} child
 */
function killProcessTree(child) {
  if (!child || child.killed || child.pid == null) return;
  const pid = child.pid;
  try { child.kill("SIGKILL"); } catch { /* ignore */ }
  if (process.platform !== "win32") {
    try {
      // Reap direct descendants (codex may spawn helpers). Detached + unref so this
      // cleanup spawn never keeps the event loop alive or blocks.
      const reaper = spawn("pkill", ["-KILL", "-P", String(pid)], {
        stdio: "ignore",
        detached: true,
      });
      reaper.on("error", () => { /* pkill missing — ignore */ });
      reaper.unref();
    } catch { /* ignore */ }
  }
}

/**
 * Run one Codex turn and return its final text. Retries `retries` times on failure
 * (default 1; the in-gen-loop callers — codexBuildSite / reviseHtml / codexJudge /
 * codexCritique / runSvgImage — pass 0 so a slow turn fails fast instead of doubling
 * the wall-clock). NEVER returns null / a silent fallback.
 *
 * Each attempt is wrapped in an OUTER Promise.race that holds the live child handle
 * and SIGKILLs the whole process tree on `timeoutMs` — the inner codexExecOnce
 * timeout only kills the direct child, so this is the real hang-killer (Phase 0.1).
 *
 * @param {string} prompt
 * @param {{timeoutMs?:number, effort?:string, images?:string[], retries?:number,
 *          sandbox?:("read-only"|"workspace-write")}} [opts]
 *   `effort` overrides the default reasoning effort (e.g. "high"); defaults to
 *   CODEX_EFFORT. `images` is an optional list of image file paths attached via
 *   `codex exec -i <FILE>` for vision tasks. `retries` is the number of EXTRA
 *   attempts after the first (default 1 => 2 total). `sandbox` selects the exec
 *   sandbox (default read-only; "workspace-write" for the opt-in image turn).
 * @returns {Promise<string>} the model's final message text
 */
export async function codexRun(
  prompt,
  { timeoutMs = DEFAULT_TIMEOUT, effort = EFFORT, images = [], retries = 1, sandbox = DEFAULT_SANDBOX } = {}
) {
  if (!prompt || !String(prompt).trim()) {
    throw new Error("codexRun: empty prompt");
  }
  // grace window after timeoutMs before the outer race force-kills the tree.
  const GRACE_MS = 2_000;
  const totalAttempts = Math.max(1, 1 + Math.max(0, Math.floor(Number(retries) || 0)));

  // One attempt = codexExecOnce wrapped in an outer race that owns the child so it
  // can SIGKILL the whole tree if the inner timeout fails to.
  const runOnce = () => {
    let liveChild = null;
    let raceTimer = null;
    const exec = codexExecOnce(prompt, timeoutMs, effort, images, sandbox, (c) => { liveChild = c; });
    const race = new Promise((_, reject) => {
      raceTimer = setTimeout(() => {
        killProcessTree(liveChild);
        reject(new Error(
          `codexRun: outer timeout — process tree SIGKILLed after ${timeoutMs + GRACE_MS}ms ` +
          `(model=${MODEL}, effort=${effort})`
        ));
      }, timeoutMs + GRACE_MS);
    });
    return Promise.race([exec, race]).finally(() => {
      if (raceTimer) clearTimeout(raceTimer);
      // If exec lost the race (or already settled), make sure no tree survives.
      killProcessTree(liveChild);
    });
  };

  const errs = [];
  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    try {
      return await runOnce();
    } catch (err) {
      errs.push(`attempt#${attempt}: ${err?.message || err}`);
    }
  }
  if (totalAttempts === 1) {
    throw new Error(`codexRun failed.\n  ${errs.join("\n  ")}`);
  }
  throw new Error(
    `codexRun failed after ${totalAttempts} attempts.\n  ${errs.join("\n  ")}`
  );
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
 * Resolve the real design-system CSS. Prefers `brand.designSystemCss` (already
 * loaded by deconstructBrand), else reads web/run/design-system.css from disk.
 * Returns "" if neither is available (caller decides whether that's fatal).
 * @param {object} brand
 * @returns {Promise<string>} the full stylesheet text (or "")
 */
async function resolveDesignSystemCss(brand) {
  const fromBrand = brand && typeof brand.designSystemCss === "string" ? brand.designSystemCss.trim() : "";
  if (fromBrand) return brand.designSystemCss;
  try {
    if (existsSync(DESIGN_CSS_PATH)) return await readFile(DESIGN_CSS_PATH, "utf8");
  } catch { /* fall through */ }
  return "";
}

/**
 * Build a COMPACT, prompt-friendly summary of the brand's design tokens so Codex
 * knows the exact palette hexes, font families, type scale, spacing & radii to
 * use — without dumping the whole tokens.json. Pulls from `brand.tokens` when
 * present (loaded by deconstructBrand) and falls back to brand.colors/fonts.
 * @param {object} brand
 * @returns {string} multiline token summary for the prompt
 */
function summarizeTokens(brand) {
  const t = brand && brand.tokens ? brand.tokens : null;
  const lines = [];

  // ---- Palette (multiple colors — the page MUST use several) ----------------
  if (t && t.color) {
    const roles = t.color.roles || {};
    const pal = t.color.palette || {};
    const usage = t.color.usage || {};
    const hex = (k) => (pal[k] && pal[k].hex) || roles[k] || null;
    const palette = [
      ["Razzmatazz/primary", roles.primary || hex("razzmatazz")],
      ["Splash/secondary", roles.secondary || hex("splash")],
      ["Black/bg", roles.bg || hex("black")],
      ["White/fg", roles.fg || hex("white")],
      ["surface", roles.surface],
      ["muted-text", roles.muted],
      ["border", roles.border],
    ].filter(([, v]) => v);
    lines.push(`PALETTE (use SEVERAL of these, not just one): ` +
      palette.map(([n, v]) => `${n} ${v}`).join(", ") + ".");
    // The FULL color composition rules from the brand book (not just the one-liner).
    if (usage.rule) lines.push(`COLOR RULE: ${usage.rule}`);
    if (usage.razzmatazz) lines.push(`RAZZMATAZZ #FE2C55 (primary): ${usage.razzmatazz}`);
    if (usage.splash) lines.push(`SPLASH #25F4EE (accent): ${usage.splash}`);
    if (usage.neutrals) lines.push(`NEUTRALS: ${usage.neutrals}`);
    lines.push(`Use ONE brand color per composition; create focus with black or white; never invent new colors.`);
  } else {
    const c = brand.colors || {};
    lines.push(`PALETTE: primary ${c.primary}, accent ${c.accent}, bg ${c.bg}, text ${c.fg}.`);
    lines.push(`Use ONE brand color per composition; create focus with black or white; never invent new colors.`);
  }

  // ---- Fonts (Sofia Pro; Sofia Pro Soft for emphasis ONLY) ------------------
  if (t && t.type && t.type.families) {
    const f = t.type.families;
    lines.push(`FONTS: heading ${f.heading}; body ${f.body}` + (f.emphasis ? `; emphasis ${f.emphasis}` : "") + ".");
    lines.push(`TYPOGRAPHY: Sofia Pro is the heading/body typeface; Sofia Pro Soft is for EMPHASIS only ` +
      `(combine with Sofia Pro to highlight ONE keyword, in Razzmatazz). Left or center align; ` +
      `no all-caps/all-lowercase headlines; no gradients/shadows on type; never set body copy in Bold.`);
    if (t.type.googleFontsHref) {
      lines.push(`The design-system CSS already @imports these Google fonts (League Spartan / Roboto / Baloo 2) — do not add a conflicting CDN font.`);
    }
  } else {
    const headingFont = brand.fonts?.heading || "Inter";
    lines.push(`FONTS: heading ${headingFont}; body ${brand.fonts?.body || headingFont}.`);
  }

  // ---- Type scale -----------------------------------------------------------
  if (t && t.type && Array.isArray(t.type.scale) && t.type.scale.length) {
    const scale = t.type.scale.map((s) => `${s.name} ${s.px}px/${s.weight}`).join(", ");
    lines.push(`TYPE SCALE: ${scale} (keep sizes clearly distinct; big headings).`);
  }

  // ---- Spacing & radius -----------------------------------------------------
  if (t && Array.isArray(t.space) && t.space.length) {
    lines.push(`SPACING (8px rhythm, px): ${t.space.join(", ")} — use generous section padding (96/128px).`);
  }
  if (t && t.radius) {
    const named = t.radius.named || {};
    const r = [named.sm && `sm ${named.sm}`, named.md && `md ${named.md}`, named.lg && `lg ${named.lg}`, `pill ${named.pill || "9999px"} (CTA buttons only)`]
      .filter(Boolean).join(", ");
    if (r) lines.push(`RADIUS: ${r}. CTA buttons are PILLS (100% roundness); image masks use 25%/50%; roundness is limited to 25/50/100%.`);
  }

  // ---- Effects / depth: NO shadows — flat color blocks + layered shapes -----
  lines.push(`DEPTH/EFFECTS: NO drop shadows or other effects — create depth with FLAT color blocks + layered shapes, not shadows. NO gradients.`);

  // ---- Shapes: bubbles from the TikTok logo circles -------------------------
  if (t && t.shapes) {
    const rot = t.shapes.imageRotationIncrementDeg || 10;
    lines.push(`SHAPES: use BUBBLES derived from the two circles in the TikTok logo (and bubbles/pills as CTAs); images may rotate in ${rot}° increments.`);
  }

  return lines.join("\n");
}

/**
 * Render the typed BUILD BRIEF (Phase 2.3 / CONTRACTS §6) into a compact, named
 * directives block for the build prompt. Each non-builder agent fills a named slot;
 * the builder consumes the whole brief so NO agent output is dropped. `mustFix` is
 * handled separately (merged into the fix-rules), so it is NOT echoed here.
 * Returns "" when no brief / no filled slots.
 * @param {object|null} brief
 * @returns {string} multiline directives block (or "")
 */
function summarizeBrief(brief) {
  if (!brief || typeof brief !== "object") return "";
  const lines = [];

  // copy may be a string or {hero, angle} (copywriter slot).
  const copy = brief.copy;
  if (copy && typeof copy === "object") {
    if (copy.hero && String(copy.hero).trim()) lines.push(`HERO COPY: ${String(copy.hero).trim()}`);
    if (copy.angle && String(copy.angle).trim()) lines.push(`COPY ANGLE: ${String(copy.angle).trim()}`);
  } else if (copy && String(copy).trim()) {
    lines.push(`COPY DIRECTION: ${String(copy).trim()}`);
  }

  if (brief.layoutDirection && String(brief.layoutDirection).trim()) {
    lines.push(`LAYOUT: ${String(brief.layoutDirection).trim()}`);
  }
  if (brief.typeScale && String(brief.typeScale).trim()) {
    lines.push(`TYPE SCALE DIRECTION: ${String(brief.typeScale).trim()}`);
  }
  if (brief.imageDirective && String(brief.imageDirective).trim()) {
    lines.push(`IMAGERY: ${String(brief.imageDirective).trim()}`);
  }

  if (!lines.length) return "";
  return `\nBUILD BRIEF (apply every directive — these come from the planning agents):\n` +
    lines.map((l) => `- ${l}`).join("\n") + "\n";
}

/**
 * Build a FULL, real marketing HTML page with Codex, ON the real design system.
 *
 * The produced page (a) INLINES web/run/design-system.css in a <style> block so
 * the brand styling works with NO external CDN dependency, and (b) is built by
 * Codex USING the design-system CSS variables (--color-*, --font-*, --space-*,
 * --radius-*) + the .ds-* utility classes + a compact token summary (palette
 * hexes, fonts, type scale). The result visibly uses the brand palette (several
 * colors), real fonts, and spacing — not a plain page.
 *
 * 5 sections, on-brand, real copy. If `lesson` is provided it MUST be applied
 * (e.g. no gradients). THROWS on any failure — NO template fallback. The design
 * CSS may also be passed explicitly via `brand.designSystemCss`.
 *
 * RULES + REVISE MODE (memory -> page):
 *   `rules` is an array of CONCRETE brand/design fix-rules — the raw critique
 *   trace findings (e.g. "add the #25F4EE Splash accent", "remove the gradient",
 *   "make the tone more provocative") recalled VERBATIM in-run. These bypass the
 *   lossy distill and are fed straight into the build as numbered, non-negotiable
 *   instructions. THIS turn's critique findings reach the build via `brief.mustFix`
 *   (merged into the fix-rules) so same-turn findings hit same-turn builds (1.7).
 *   - When `priorHtml` is provided => REVISE MODE: Codex is shown the prior page
 *     HTML + the numbered rules and must return a CORRECTED full HTML doc that
 *     applies EVERY rule (still on the design system, real copy).
 *     `lesson`/`copyHint`/section directives are not re-derived here — the prior
 *     page is the base and the rules are the diff.
 *   - When `priorHtml` is null but `rules`/`brief.mustFix` are present => fresh build
 *     that ALSO folds the rules into the normal build prompt.
 *
 * TYPED BUILD BRIEF (Phase 2.3 — NO dropped agent output):
 *   `brief` is the typed {copy, sectionOrder, layoutDirection, typeScale,
 *   imageDirective, mustFix[]} object the orchestrator assembles from every
 *   non-builder agent's named slot (CONTRACTS §6). codexBuildSite consumes the WHOLE
 *   brief: each filled slot becomes an explicit prompt directive and `brief.mustFix`
 *   is merged into the verbatim fix-rules. Absent/empty => the build is unchanged
 *   (back-compat with callers that don't pass a brief).
 *
 * @param {{brand:object, goal:string, copyHint?:string, lesson?:string,
 *          rules?:string[], priorHtml?:(string|null),
 *          brief?:{copy?:(string|{hero?:string,angle?:string}), sectionOrder?:string[],
 *                  layoutDirection?:string, typeScale?:string, imageDirective?:string,
 *                  mustFix?:string[]}}} args
 * @returns {Promise<string>} clean HTML document string (with inlined DS css)
 */
export async function codexBuildSite({ brand, goal, copyHint, lesson, rules = [], priorHtml = null, brief = null }) {
  if (!brand || !brand.colors) throw new Error("codexBuildSite: missing brand/colors");
  if (!goal) throw new Error("codexBuildSite: missing goal");

  // Merge the verbatim recalled fix-rules (`rules`) with THIS turn's critique
  // findings (`brief.mustFix`) — both are concrete, non-negotiable build rules. The
  // mustFix items come AFTER the recalled rules (same-turn findings refine the build).
  const mustFix = Array.isArray(brief?.mustFix) ? brief.mustFix : [];
  const fixRules = [...(Array.isArray(rules) ? rules : [rules]), ...mustFix]
    .map((r) => (r == null ? "" : String(r).trim()))
    .filter(Boolean);

  const c = brand.colors;
  const tone = Array.isArray(brand.tone) ? brand.tone.join(", ") : (brand.tone || "");
  const donts = brand.dont || brand.donts || [];
  // Section order: prefer the info-architect's typed sectionOrder, else brand, else a
  // default pool. A PLANNER-supplied sectionOrder is a deliberate, richer plan that maps
  // onto the .ds-* component vocabulary — so it is HONORED IN FULL and never clipped.
  // Only the default/brand fallback pool is trimmed down to SECTION_COUNT (keeping the
  // hero first + CTA last) so an un-planned build stays lean.
  const plannerOrder = Array.isArray(brief?.sectionOrder)
    ? brief.sectionOrder.filter(Boolean)
    : [];
  const sections = plannerOrder.length
    ? plannerOrder
    : trimSections(
        (brand.sections && brand.sections.length
          ? brand.sections
          : ["hero", "problem", "how-it-works", "stats", "closing CTA"]),
        SECTION_COUNT
      );
  // The page builds EXACTLY this many sections (whatever the resolved list holds): a
  // planner's full plan, or the default pool trimmed to SECTION_COUNT.
  const sectionCount = sections.length;

  // Weave the remaining typed brief slots (copy/layout/type/image directives) into a
  // compact, named directives block consumed by BOTH the fresh + revise prompts so no
  // agent's output is dropped (Phase 2.3). Empty when no brief / no filled slots.
  const briefDirectives = summarizeBrief(brief);

  // The REAL design system: prefer the explicitly-passed css, else read from disk.
  const designCss = await resolveDesignSystemCss(brand);
  if (!designCss || !/:root\s*{/.test(designCss)) {
    throw new Error(
      `codexBuildSite: could not load the real design system (web/run/design-system.css or brand.designSystemCss). ` +
      `Refusing to build a plain, off-brand page (no fallback).`
    );
  }
  const tokenSummary = summarizeTokens(brand);

  const rule = lesson
    ? `\nLEARNED RULE you MUST apply (from memory, non-negotiable): ${lesson}\n`
    : "";

  // Numbered, non-negotiable fix-rules block (the raw critique trace findings).
  // These bypass the lossy distill and go straight into the build prompt.
  const numberedRules = fixRules.length
    ? fixRules.map((r, i) => `${i + 1}. ${r}`).join("\n")
    : "";

  // BRAND VOICE & COPY — feed the enriched brandspec voice so headlines/body are
  // written in the REAL TikTok For Business voice (anti-ad, creative, direct) instead
  // of generic hype. The few-shot copyExamples are the strongest signal; tagline /
  // personality / funnel-tone / emphasis rule shape the rest. All optional (back-compat
  // with a thin brandspec — empty string when the fields are absent).
  const voiceLines = [];
  if (brand.personality) voiceLines.push(`Personality: ${brand.personality}`);
  if (brand.tagline) voiceLines.push(`Brand ethos: "${brand.tagline}"${brand.copyPattern ? ` (copy engine: "${brand.copyPattern}")` : ""} — write like a creator, NOT a traditional ad.`);
  if (brand.copyRules && brand.copyRules.funnel) voiceLines.push(`Funnel tone: ${brand.copyRules.funnel}`);
  if (brand.copyRules && brand.copyRules.jargon) voiceLines.push(brand.copyRules.jargon);
  if (brand.emphasisRule) voiceLines.push(`Emphasis rule: ${brand.emphasisRule}`);
  const _ex = brand.copyExamples || {};
  const _exDo = Array.isArray(_ex.do) ? _ex.do.slice(0, 3) : [];
  const _exDont = Array.isArray(_ex.dont) ? _ex.dont.slice(0, 3) : [];
  if (_exDo.length || _exDont.length) {
    voiceLines.push(
      "COPY EXAMPLES — match the voice of the GOOD lines, never the BAD ones:" +
      _exDo.map((s) => `\n  GOOD: ${s}`).join("") +
      _exDont.map((s) => `\n  BAD:  ${s}`).join("")
    );
  }
  const brandVoice = voiceLines.length
    ? `\nBRAND VOICE & COPY (write ALL headlines + body copy in THIS voice):\n${voiceLines.join("\n")}\n`
    : "";

  // AIM-FOR-EXCEPTIONAL — the brand guidelines are the ASPIRATION (the bar to HIT), not just
  // DON'Ts to avoid. A flaw-free page is only "solid ~75"; a page that boldly EMBODIES the brand
  // at its best earns 90+. The critique/revise loop removes flaws (→ competence); THIS makes the
  // build REACH (→ excellence). Identical on BOTH pages (fair). brief.aspire carries this turn's
  // single highest-leverage upgrade when the orchestrator has one (else empty).
  const aspireDirective = brief && typeof brief.aspire === "string" ? brief.aspire.trim() : "";
  const aspiration =
    `\nAIM FOR EXCEPTIONAL — do NOT settle for clean-and-safe:\n` +
    `- A top reviewer scores 90-100 ONLY for flawless craft: confident hierarchy, a BOLD distinctive ` +
    `layout, real sharp copy. "Solid with minor flaws" is ~70; merely avoiding the DON'Ts is ~75 — reach past it.\n` +
    `- Make ONE confident, unmistakable move that embodies the brand at its BEST` +
    (brand.tagline ? ` ("${brand.tagline}")` : "") +
    ` — its energy and attitude — not a correct-but-generic page.\n` +
    (aspireDirective ? `- HIGHEST-LEVERAGE UPGRADE to pursue this turn: ${aspireDirective}\n` : "");

  // Shared design-system contract text used by BOTH the fresh build and the
  // revise prompt so a corrected page stays on the system (DS classes/tokens,
  // no CDN, no gradients).
  const dsContract =
    `\nDESIGN SYSTEM: a full stylesheet is ALREADY INLINED in the page <head> in a <style> tag. ` +
    `It defines CSS variables (--color-splash, --color-razzmatazz, --color-primary, --color-secondary, ` +
    `--color-bg, --color-fg, --font-heading, --font-body, --font-emphasis, --space-1..--space-10, ` +
    `--radius-sm/md/lg/pill) and READY .ds-* classes: foundations (.ds-body on <body>; .ds-section, ` +
    `.ds-container, .ds-stack; .ds-h1, .ds-h2, .ds-subhead, .ds-lead, .ds-body-text, .ds-caption, ` +
    `.ds-emph for ONE highlighted keyword; .ds-bg, .ds-bg-light, .ds-bg-primary, .ds-bg-secondary, ` +
    `.ds-surface, .ds-btn + .ds-btn-primary/.ds-btn-secondary/.ds-btn-outline/.ds-btn-on-primary/.ds-btn-ghost; ` +
    `.ds-actions, .ds-link, .ds-figure (+ .ds-figure-25/.ds-figure-50/.ds-figure-bordered[-razz/-ink/-white]/.ds-rotate-10)), ` +
    `and COMPOSED brand components: .ds-hero, .ds-feature-grid, .ds-stat-band, .ds-steps, .ds-cta-band, ` +
    `.ds-bubble-cluster, .ds-chip, .ds-grid-2, .ds-grid-3; and the BRAND TOOLKIT: emphasis marks ` +
    `.ds-mark(-cross/-chevron/-bracket)(-splash/-razz/-ink/-white), .ds-pattern(-splash/-razz/-ink) dot patterns, ` +
    `.ds-bubble-text(-splash/-razz/-stroke) word-holding pills, .ds-emph-ink (black keyword emphasis), .ds-rrect-mixed; ` +
    `and the EXPRESSIVE TYPE & EDITORIAL set (the keyless "image" system — type carries the page): ` +
    `.ds-display (MEGA hero type, the headline IS the visual), .ds-statement (full-bleed all-type section), ` +
    `.ds-text-outline (outline ONE word for filled+hollow contrast), .ds-quote + .ds-quote-attr (editorial ` +
    `pull-quote), .ds-bignum (oversized graphic number for a stat/proof), .ds-grid-asym (asymmetric editorial split).\n` +
    `BUILD USING THESE: put class="ds-body" on <body>; use the .ds-* classes and the ` +
    `var(--color-*)/var(--font-*)/var(--space-*) tokens for ALL styling. Do NOT hardcode hex colors ` +
    `or font stacks that the system already provides — reference the variables/classes. ` +
    `Do NOT add Tailwind, Bootstrap, or any external CSS/CDN — the inlined design system is the ONLY stylesheet. ` +
    `Do NOT add your OWN <style> block, do NOT use inline style="" attributes, and do NOT invent new .ds-* class ` +
    `names (e.g. NO .ds-cta-frame, NO custom borders/frames) — compose ONLY from the .ds-* classes + var(--*) tokens ` +
    `listed here. For the closing CTA use .ds-cta-band > .ds-container > .ds-cta-inner exactly (no wrapping "frame").\n` +
    // §3b — COMPOSE the page from the NAMED components (no inline-style atoms, no
    // layout invented from scratch); both the fresh build AND the revise share this.
    `COMPOSE THE PAGE FROM THESE NAMED COMPONENTS (do NOT inline-style raw atoms, do NOT invent layout from ` +
    `scratch): use .ds-hero for the opening — add the .ds-hero--type modifier (a full-bleed SINGLE-COLUMN type hero, no media half) whenever no hero image is provided, else the split .ds-hero; .ds-feature-grid with .ds-grid-3 ` +
    `for features; .ds-stat-band for proof numbers; .ds-steps with .ds-grid-3 for how-it-works; ` +
    `.ds-cta-band for the closing call to action; .ds-figure (with .ds-figure-25/.ds-figure-50 and ` +
    `an optional .ds-rotate-10) for ALL imagery; .ds-bubble-cluster for the signature overlapping-circle ` +
    `accent; .ds-chip for eyebrow labels; and .ds-grid-2/.ds-grid-3 for any multi-column row. Drop the ` +
    `skeletons in and fill real copy — do NOT rebuild these from <div>s + inline styles.\n` +
    // IMAGERY POLICY (build-quality): render ONLY provided imagery; never invent any.
    `IMAGERY — render ONLY imagery explicitly PROVIDED to you: a hero <img src> when one is supplied, or a ` +
    `provided inline-SVG directive. Do NOT INVENT imagery of your own: NO abstract colored-block art, NO bare ` +
    `<rect>/<svg> shapes or grey skeleton bars, NO 3D icons, NO app-icon/logo marks (the brand wordmark is TEXT, ` +
    `not a drawn logo), NO stock-style photos, NO decorative illustrations you made up. If NO hero image is ` +
    `provided, you MUST use the .ds-hero--type modifier on .ds-hero — a FULL-BLEED, SINGLE-COLUMN TYPE hero: an ` +
    `oversized .ds-hero-title that fills the width (NO empty media half), a strong subhead, and the pill CTAs. Do ` +
    `NOT place a .ds-bubble-cluster above the headline; if you use one it MUST contain its .ds-bubble circles ` +
    `(NEVER emit an empty .ds-bubble-cluster — it renders as a huge dead box). OMIT every empty .ds-figure frame entirely ` +
    `(never leave a media slot blank). Keep the page DENSE — substantial .ds-card surfaces for feature/step ` +
    `content (real fill + padding, not bare text), and NO large empty bands or dead vertical gaps.\n`;

  // REVISE MODE: a prior page exists. Show Codex that page + the numbered rules
  // and have it return a CORRECTED full document that applies EVERY rule. This is
  // the in-run "recall traces -> fix THIS page" loop that lets memory visibly win.
  const isRevise = Boolean(priorHtml && String(priorHtml).trim());

  let prompt;
  if (isRevise) {
    // Truncate a huge prior page so we never blow the prompt budget, but keep
    // enough of the document (head + body start) for Codex to revise faithfully.
    const MAX_PRIOR = 60_000;
    let prior = String(priorHtml);
    if (prior.length > MAX_PRIOR) {
      prior = prior.slice(0, MAX_PRIOR) +
        `\n<!-- [prior HTML truncated at ${MAX_PRIOR} chars for the revise prompt] -->`;
    }
    // FIX-RULES drive the revise. We do NOT inject a static, brand-specific default
    // here (the old `remove gradients / ensure the brand accent is present` line was
    // hidden side-specific brand help that only the memory page could "earn"). When
    // no concrete fix-rules exist (e.g. the no-memory same-turn revise produced none,
    // or ABLATE strips recalled rules), the revise is a brand-neutral polish pass —
    // the BRAND DON'Ts above remain the only constraint, identical for both pages.
    const hasRules = Boolean(numberedRules);
    const rulesBlock = hasRules
      ? numberedRules
      : `(no specific fix-rules this turn — polish the page within the BRAND DON'Ts above.)`;

    prompt =
      `You are a senior front-end designer REVISING an existing on-brand marketing page. ` +
      `Below is the page's CURRENT HTML, followed by a NUMBERED list of concrete fix-rules ` +
      `(real critique findings). Apply EVERY rule and return the ` +
      `CORRECTED, COMPLETE HTML document.\n` +
      `GOAL: ${goal}\n` +
      `BRAND: tone ${tone}; audience ${brand.audience || "general"}.\n` +
      `BRAND DON'Ts (must obey): ${JSON.stringify(donts)}.\n` +
      brandVoice +
      aspiration +
      rule +
      `\nFIX-RULES — apply ALL of them, non-negotiable:\n${rulesBlock}\n` +
      `\nRevision requirements:\n` +
      (hasRules
        ? `- Apply every numbered rule above to THIS page (e.g. add a color where a rule ` +
          `says it is missing, remove a pattern a rule forbids, sharpen tone/copy where a rule demands it).\n`
        : `- Keep the page faithful to its current design; only tighten obvious quality issues you can see.\n`) +
      `- Keep the page's overall structure and its ${sectionCount} sections — improve, don't rebuild from scratch.\n` +
      `- Keep real, on-brand marketing copy (NO lorem, NO placeholder text). Use flat brand-color blocks ` +
      `only — NO gradients, no drop shadows.\n` +
      briefDirectives +
      dsContract +
      `\nDESIGN TOKENS (use these exact values):\n${tokenSummary}\n` +
      `\nCURRENT PAGE HTML (revise this):\n<<<HTML\n${prior}\nHTML\n` +
      `\nOUTPUT ONLY the corrected HTML document, starting with <!DOCTYPE html> and ending with </html>. ` +
      `No commentary, no explanations, no markdown code fences. ` +
      `Do NOT run any shell commands or read/write files — just produce the corrected HTML in your reply. ` +
      `You do NOT need to include the design-system <style> yourself; it will be re-inlined for you.`;
  } else {
    // FRESH BUILD. If concrete fix-rules were supplied (verbatim recalled rules +
    // this turn's critique mustFix), fold them into the prompt as an explicit,
    // non-negotiable block (in addition to any lesson).
    const rulesDirective = numberedRules
      ? `\nApply these concrete fix-rules (verbatim recalled fixes + this turn's critique findings, non-negotiable):\n${numberedRules}\n`
      : "";

    // Build on the design system: tell Codex to consume the (already-inlined) CSS
    // variables + .ds-* classes + the token palette. We INLINE the stylesheet
    // ourselves so styling never depends on a CDN.
    prompt =
      `You are a senior front-end designer building a real, on-brand marketing website ` +
      `on top of an EXISTING design system.\n` +
      `GOAL: ${goal}\n` +
      `BRAND: tone ${tone}; audience ${brand.audience || "general"}.\n` +
      `BRAND DON'Ts (must obey): ${JSON.stringify(donts)}.\n` +
      brandVoice +
      aspiration +
      rule +
      rulesDirective +
      (copyHint ? `Copy direction: ${copyHint}\n` : "") +
      briefDirectives +
      `\nDESIGN TOKENS (use these exact values):\n${tokenSummary}\n` +
      dsContract +
      // §3c — concrete, component-anchored ART DIRECTION (replaces the vague
      // "MUST VISIBLY be on-brand" line). The brand DON'Ts above still apply.
      `\nART DIRECTION (non-negotiable): the page is BOLD, flat, editorial. Alternate FULL-BLEED color-blocked ` +
      `panels — Razzmatazz, black, and white in sequence (exactly ONE brand color per panel; Splash only as a ` +
      `full-bleed accent band or figure border, NEVER on text). The hero headline is OVERSIZED and breaks the ` +
      `grid, with exactly ONE word wrapped in .ds-emph (Razzmatazz). BRACKET the hero H1 with TWO emphasis marks ` +
      `(.ds-mark) in DIFFERENT brand colors — e.g. a .ds-mark.ds-mark-cross.ds-mark-splash span before it and a ` +
      `.ds-mark.ds-mark-chevron.ds-mark-razz span after (square bracket ONLY at a sentence end). Use at least one ` +
      `.ds-pattern dot band (never under text) as a recurring accent. NOTE: .ds-bubble-cluster is DECORATIVE overlapping ` +
      `CIRCLES ONLY (it must contain .ds-bubble-primary/-secondary/-ink circles, NEVER word-bubbles or text) and is NOT ` +
      `for the hero; .ds-bubble-text pills are the standalone word/CTA holders. Every image is a real .ds-figure media frame (rounded 25%/50%, optional ` +
      `10° rotation) — NEVER a bare rectangle or grey placeholder. Generous 96px/128px section padding. NO ` +
      `gradients, NO drop shadows; create depth with layered flat shapes only.\n` +
      `\nTYPE IS THE HERO (there are NO photographs — type carries the page): make the H1 a MEGA .ds-display ` +
      `headline (ultra-tight leading, breaks the grid — the headline IS the artwork, not an afterthought). You may ` +
      `outline ONE word with .ds-text-outline for filled+hollow contrast. A flat, text-only page must read as BOLD ` +
      `and distinctive, NEVER as a clean-but-generic landing page.\n` +
      `COMPOSITION — vary it; do NOT stack identical centered blocks. Use at least ONE .ds-grid-asym asymmetric ` +
      `split, ONE .ds-statement full-bleed type moment, ONE .ds-quote editorial pull-quote (text-based credibility), ` +
      `and a proof/stat section anchored by a .ds-bignum oversized number. Alternate alignment and rhythm.\n` +
      `COPY — every line is SHARP and SPECIFIC: provocative, native, concrete (a real number, a real outcome). ` +
      `Headlines punch in under 8 words. BAN filler/generic marketing ("built for discovery", "best-in-class", ` +
      `"unlock growth", "supercharge") — write like a creator, not a brand deck.\n` +
      `\nBuild a single self-contained responsive HTML5 page with EXACTLY ${sectionCount} sections ` +
      `(${sections.join(", ")}). Write real, on-brand marketing copy (NO lorem, NO placeholder text). ` +
      `Use flat brand-color blocks only — no gradients, no drop shadows.\n` +
      `OUTPUT ONLY the HTML document, starting with <!DOCTYPE html> and ending with </html>. ` +
      `No commentary, no explanations, no markdown code fences. ` +
      `Do NOT run any shell commands or read/write files — just produce the HTML in your reply. ` +
      `You do NOT need to include the design-system <style> yourself; it will be inlined for you.`;
  }

  // gen-loop caller: 0 retries so a slow build fails fast (Phase 0.1).
  const raw = await codexRun(prompt, { retries: 0 });
  let html = extractHtml(raw); // throws if Codex didn't return real HTML

  // NOTE: the regex anti-gradient HARD-FAIL was REMOVED (v3.1 Guardrail 5 / MED-LOW).
  // It was a hidden, side-specific brand enforcement (a `/gradient/i` string check
  // that only fired when a lesson/rule mentioned gradients). All scoring/brand-fit
  // judgment is now all-LLM via the two-axis judge + codexCritique — NO regex on any
  // learnable/scoring path. The "no gradients" intent reaches Codex purely as a brand
  // DON'T + the flat-color design-system contract, identically on both pages.

  // INLINE the real design system so the page styles correctly with NO external
  // CDN dependency. Insert a <style> just before </head> (or fabricate a <head>
  // if Codex omitted one). Mark it so we never double-inline.
  html = inlineDesignSystem(html, designCss);

  return html;
}

/**
 * Inline the design-system CSS into an HTML document inside a <style> tag so the
 * page renders on-brand with NO external stylesheet/CDN. Idempotent: if the same
 * design system is already inlined (marker present) the html is returned as-is.
 * @param {string} html  clean HTML document
 * @param {string} css   design-system stylesheet text
 * @returns {string} html with the design system inlined in <head>
 */
function inlineDesignSystem(html, css) {
  if (!css || !css.trim()) return html;
  const MARKER = "data-ds=\"taste-loop-design-system\"";
  if (html.includes(MARKER)) return html; // already inlined
  // Guard against breaking out of the <style> element.
  const safeCss = String(css).replace(/<\/style>/gi, "<\\/style>");
  const styleTag = `<style ${MARKER}>\n${safeCss}\n</style>`;

  const headClose = html.search(/<\/head>/i);
  if (headClose !== -1) {
    return html.slice(0, headClose) + styleTag + "\n" + html.slice(headClose);
  }
  // No </head>: try to open one right after <html ...> (or <head>).
  const headOpen = html.match(/<head[^>]*>/i);
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length;
    return html.slice(0, at) + "\n" + styleTag + "\n" + html.slice(at);
  }
  const htmlOpen = html.match(/<html[^>]*>/i);
  if (htmlOpen) {
    const at = htmlOpen.index + htmlOpen[0].length;
    return html.slice(0, at) + `\n<head>\n${styleTag}\n</head>\n` + html.slice(at);
  }
  // Last resort: prepend a head block.
  return `<head>\n${styleTag}\n</head>\n` + html;
}

/**
 * Robustly extract the first balanced JSON object from arbitrary model text.
 * Codex (esp. with -o last-message) may wrap the JSON in prose, markdown fences,
 * or trailing commentary; we locate a `{...}` span and JSON.parse it. THROWS if
 * no parseable object is found.
 * @param {string} text
 * @returns {object}
 */
function extractJsonObject(text) {
  if (!text) throw new Error("extractJsonObject: empty input");
  let s = String(text).trim();

  // Strip a fenced code block if present (```json ... ``` or ``` ... ```).
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  // Fast path: the whole thing is already valid JSON.
  try { return JSON.parse(s); } catch { /* fall through to scanning */ }

  // Scan for a balanced top-level {...} (string-aware so braces inside strings
  // don't throw off the depth count).
  const start = s.indexOf("{");
  if (start === -1) {
    const preview = s.slice(0, 200).replace(/\s+/g, " ");
    throw new Error(`extractJsonObject: no '{' found. preview="${preview}"`);
  }
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) { esc = false; }
      else if (ch === "\\") { esc = true; }
      else if (ch === '"') { inStr = false; }
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const candidate = s.slice(start, i + 1);
        try { return JSON.parse(candidate); }
        catch (err) {
          throw new Error(`extractJsonObject: found {...} but JSON.parse failed: ${err?.message || err}`);
        }
      }
    }
  }
  const preview = s.slice(start, start + 200).replace(/\s+/g, " ");
  throw new Error(`extractJsonObject: unterminated object. preview="${preview}"`);
}

/**
 * Robustly extract the first balanced JSON ARRAY from arbitrary model text (the
 * codexCritique findings list). Mirrors extractJsonObject but for `[...]`. Tolerant
 * of markdown fences / surrounding prose. Returns [] for an empty/"none" answer
 * rather than throwing (an empty critique is a valid "no flaws" verdict). THROWS
 * only when text exists but no parseable array can be found.
 * @param {string} text
 * @returns {Array<any>}
 */
function extractJsonArray(text) {
  if (text == null) return [];
  let s = String(text).trim();
  if (!s) return [];

  // Strip a fenced code block if present.
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  // Fast path: the whole thing is already a valid JSON array.
  try {
    const v = JSON.parse(s);
    if (Array.isArray(v)) return v;
  } catch { /* fall through to scanning */ }

  // Scan for a balanced top-level [...] (string-aware).
  const start = s.indexOf("[");
  if (start === -1) {
    // No array at all — tolerate a bare empty answer; otherwise it's malformed.
    return [];
  }
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) { esc = false; }
      else if (ch === "\\") { esc = true; }
      else if (ch === '"') { inStr = false; }
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) {
        const candidate = s.slice(start, i + 1);
        try {
          const v = JSON.parse(candidate);
          return Array.isArray(v) ? v : [];
        } catch (err) {
          throw new Error(`extractJsonArray: found [...] but JSON.parse failed: ${err?.message || err}`);
        }
      }
    }
  }
  const preview = s.slice(start, start + 200).replace(/\s+/g, " ");
  throw new Error(`extractJsonArray: unterminated array. preview="${preview}"`);
}

// Clamp a value to an integer in [0,100]. Used to sanitize the two raw axes from
// the model BEFORE the locked blend (which the judge.mjs owner computes).
function clamp0to100(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return Math.max(0, Math.min(100, Math.round(v)));
}

/**
 * TWO-AXIS design judge (v3.1, all-LLM, NO regex). Runs Codex gpt-5.4 (vision via
 * `-i` on the rendered screenshot, MEDIUM effort by default; override with
 * CODEX_JUDGE_EFFORT) and asks for the two raw axes DIRECTLY:
 *   - `quality`        0-100 — design quality (hierarchy, layout, legibility, copy)
 *   - `brandAdherence` 0-100 — brand fit (palette, tone, DON'T compliance)
 * plus `reasoning` and `findings[]`. THROWS on failure (no silent fallback).
 *
 * IMPORTANT — the LOCKED blend/cap is NOT computed here. `judge.mjs`'s `judgeSite`
 * owns the deterministic `score = round(0.6*quality + 0.4*brandAdherence)`,
 * `brandAdherence < 50 => cap 69`, clamp (CONTRACTS §4). codexJudge returns ONLY
 * the two axes + reasoning + findings so the anchor's math lives in one place and
 * can never be tuned post-hoc inside the model prompt.
 *
 * Calibration is deliberately BRAND-GENERIC (it never enumerates the specific flaws
 * memory fixes) so the anchor cannot be gamed toward the memory win.
 *
 * When `imagePath` is provided the model VISIONS the screenshot (HTML is supporting
 * context). When omitted it grades the HTML source.
 *
 * @param {{brand:object, html:string, goal:string, imagePath?:string}} args
 * @returns {Promise<{quality:number, brandAdherence:number, reasoning:string, findings:string[]}>}
 */
// Alias: judge.mjs imports the two-axis judge under the name `codexJudgeTwoAxis`.
// codexJudge IS the two-axis ({quality,brandAdherence}) judge; export both names.
export { codexJudge as codexJudgeTwoAxis };

export async function codexJudge({ brand, html, goal, imagePath }) {
  if (!brand || !brand.colors) throw new Error("codexJudge: missing brand/colors");
  if (!html || !String(html).trim()) throw new Error("codexJudge: missing html");
  if (!goal) throw new Error("codexJudge: missing goal");

  const c = brand.colors;
  const tone = Array.isArray(brand.tone) ? brand.tone.join(", ") : (brand.tone || "");
  const donts = brand.dont || brand.donts || [];
  const audience = brand.audience || "general";
  const headingFont = brand.fonts?.heading || "Inter";

  const brandBlock =
    `GOAL: ${goal}\n` +
    `BRAND: colors primary ${c.primary}, accent ${c.accent}, bg ${c.bg}, text ${c.fg}; ` +
    `font ${headingFont}; tone ${tone}; audience ${audience}.\n` +
    `BRAND DON'Ts (hard rules): ${JSON.stringify(donts)}.\n\n`;

  // Two-axis rubric — BRAND-GENERIC calibration (worked-example structure ported
  // from the evo few-shot judge), NOT a list of the specific fixes memory makes.
  const rubric =
    `SCORE TWO INDEPENDENT AXES, each 0-100, harshly and discriminatingly:\n\n` +
    `QUALITY (craft, brand-agnostic) — visual hierarchy, layout balance, spacing rhythm, ` +
    `legibility/contrast, type scale, and persuasive real copy (no lorem/placeholder).\n` +
    `  - 90-100: flawless craft; clear hierarchy; confident layout; real, sharp copy.\n` +
    `  - 70-89: solid with minor craft flaws (a weak section, slightly flat hierarchy).\n` +
    `  - 40-69: noticeable craft problems (muddy hierarchy, cramped/empty spacing, dull copy).\n` +
    `  - 0-39: broken or default-looking layout, illegible text, or placeholder copy.\n\n` +
    `BRAND ADHERENCE (fit to THIS brand) — does it use the brand palette/fonts/tone and ` +
    `OBEY every brand DON'T listed above?\n` +
    `  - 90-100: unmistakably this brand; palette + tone right; zero DON'T violations.\n` +
    `  - 50-89: on-brand but with brand-fit gaps (one color/tone slip, weak brand presence).\n` +
    `  - BELOW 50: a visible brand DON'T violation OR off-brand palette/tone. A single ` +
    `clear DON'T violation MUST put brandAdherence below 50.\n\n` +
    `Score the axes INDEPENDENTLY — do NOT blend them yourself; return both raw numbers.\n\n`;

  const jsonInstr =
    `Return ONLY a JSON object, no prose, no markdown fences:\n` +
    `{"quality": <integer 0-100>, "brandAdherence": <integer 0-100>, ` +
    `"reasoning": "<1-3 sentences citing concrete visual evidence for BOTH axes>", ` +
    `"findings": ["<concrete flaw 1>", "<concrete flaw 2>"]}`;

  const useImage = Boolean(imagePath && String(imagePath).trim());

  const prompt = useImage
    ? // VISION path: grade the DESIGN IN THE ATTACHED IMAGE.
      `You are a STRICT senior brand & design judge. The ATTACHED IMAGE is a ` +
      `screenshot of a rendered marketing page. Score the DESIGN IN THE IMAGE on the ` +
      `two axes below. Be deterministic and consistent (temperature 0).\n\n` +
      brandBlock +
      rubric +
      `Judge what you actually SEE in the image: real layout, visual hierarchy, ` +
      `the colors as rendered, legibility, copy tone, and whether any brand DON'T ` +
      `is visibly present (e.g. gradients, generic stock, tiny text). Be strict ` +
      `against the brand DON'Ts. Do not be generous. The HTML below is supporting ` +
      `context only — your verdict is about the rendered design in the image.\n\n` +
      `SUPPORTING HTML (context):\n<<<HTML\n${html}\nHTML\n\n` +
      jsonInstr
    : // TEXT path: grade the HTML source.
      `You are a STRICT senior brand & design judge. Score the marketing page below ` +
      `on the two axes below. Be deterministic and consistent (temperature 0).\n\n` +
      brandBlock +
      rubric +
      `Inspect the actual HTML/CSS — check colors used, copy tone, banned patterns, and ` +
      `whether brand DON'Ts appear. Do not be generous.\n\n` +
      `PAGE HTML:\n<<<HTML\n${html}\nHTML\n\n` +
      jsonInstr;

  // MEDIUM reasoning (2.7) — faster than HIGH; keep the vision (-i) image path.
  // Override via CODEX_JUDGE_EFFORT. gen-loop caller: 0 retries (fail fast).
  const raw = await codexRun(prompt, {
    effort: JUDGE_EFFORT,
    timeoutMs: 180_000,
    images: useImage ? [String(imagePath)] : [],
    retries: 0,
  });
  const obj = extractJsonObject(raw);

  const quality = clamp0to100(obj.quality);
  const brandAdherence = clamp0to100(obj.brandAdherence);
  if (quality == null) {
    throw new Error(`codexJudge: non-numeric quality in judge output: ${JSON.stringify(obj.quality)}`);
  }
  if (brandAdherence == null) {
    throw new Error(`codexJudge: non-numeric brandAdherence in judge output: ${JSON.stringify(obj.brandAdherence)}`);
  }
  const reasoning = typeof obj.reasoning === "string" && obj.reasoning.trim()
    ? obj.reasoning.trim()
    : "(no reasoning provided)";
  const findings = Array.isArray(obj.findings)
    ? obj.findings.map((f) => (f == null ? "" : String(f).trim())).filter(Boolean)
    : [];

  return { quality, brandAdherence, reasoning, findings };
}

/**
 * ALL-LLM vision CRITIQUE (v3.1, Phase A.2 — NO regex). Mirrors `codexJudge`: one
 * Codex gpt-5.4 vision call over the rendered pre-revise screenshot that returns a
 * structured list of concrete flaws. Each finding cites a brand DON'T (enum drawn
 * from `brand.dont[]`) and carries a STRUCTURED severity (high|med|low) — this is
 * the ONLY severity source in the system (it kills the severity regex elsewhere).
 *
 * RENDERING CONTRACT (CONTRACTS §3): the caller (orchestrator) normally renders the
 * pre-revise PNG once and passes `screenshotPath` (so the same shot is reused for
 * trace.resolved before/after). If `screenshotPath` is empty, codexCritique renders
 * its OWN PNG from the passed `html` via the frozen `renderShot`. THROWS if neither
 * a screenshotPath nor html is available, and THROWS on Codex failure (no silent
 * fallback) — the orchestrator catches so a critique miss != a dead run.
 *
 * Findings feed BOTH (a) the trace set (replacing the regex brandRuleViolations) and
 * (b) the build brief `mustFix[]` so same-turn findings reach same-turn builds.
 *
 * @param {{brand:object, screenshotPath?:string, goal:string, html?:string}} args
 * @returns {Promise<Array<{flaw:string, brandRuleCited:string, severity:("high"|"med"|"low")}>>}
 */
export async function codexCritique({ brand, screenshotPath, goal, html }) {
  if (!brand || !brand.colors) throw new Error("codexCritique: missing brand/colors");
  if (!goal) throw new Error("codexCritique: missing goal");

  // Resolve the screenshot: prefer a caller-rendered one, else render our own
  // pre-revise PNG from the passed html via the frozen renderShot (render.mjs:133).
  let shot = screenshotPath && String(screenshotPath).trim() ? String(screenshotPath).trim() : "";
  let tmpShotDir = null;
  if (!shot) {
    if (!html || !String(html).trim()) {
      throw new Error("codexCritique: need screenshotPath OR html to render a pre-revise PNG (no fallback)");
    }
    tmpShotDir = await mkdtemp(join(tmpdir(), "codex-critique-"));
    shot = join(tmpShotDir, "pre-revise.png");
    await renderShot(String(html), shot); // throws if Chrome can't paint a real PNG
  }

  const c = brand.colors;
  const tone = Array.isArray(brand.tone) ? brand.tone.join(", ") : (brand.tone || "");
  const donts = brand.dont || brand.donts || [];
  const audience = brand.audience || "general";

  const brandBlock =
    `GOAL: ${goal}\n` +
    `BRAND: colors primary ${c.primary}, accent ${c.accent}, bg ${c.bg}, text ${c.fg}; ` +
    `tone ${tone}; audience ${audience}.\n` +
    `BRAND DON'Ts (the rule enum — cite one of these VERBATIM as brandRuleCited): ` +
    `${JSON.stringify(donts)}.\n\n`;

  const jsonInstr =
    `Return ONLY a JSON OBJECT (no prose, no markdown fences):\n` +
    `{"flaws": [{"flaw":"<one concrete, fixable visual flaw>", ` +
    `"brandRuleCited":"<closest BRAND DON'T, copied VERBATIM from the list above>", ` +
    `"severity":"high"|"med"|"low"}],\n` +
    ` "upgrade": "<the SINGLE highest-leverage CONSTRUCTIVE move that would take this page from ` +
    `good to EXCEPTIONAL — a bold, SPECIFIC art-direction or copy upgrade that embodies the brand at ` +
    `its BEST (lean into a brand strength; name the .ds component or section to change). This is NOT a ` +
    `flaw fix — it is what would make the page a 90+ instead of a competent 75.>",\n` +
    ` "strengths": ["<what already works and must be preserved>"]}\n` +
    `Rules:\n` +
    `- flaws: brandRuleCited MUST be one of the BRAND DON'Ts above, byte-for-byte. If no DON'T is ` +
    `violated but a flaw remains, cite the CLOSEST DON'T. Do NOT invent rules.\n` +
    `- severity: high = a clear DON'T violation or broken design; med = a real non-breaking issue; low = a minor nit.\n` +
    `- upgrade: be specific and ambitious — the ONE change with the biggest quality payoff, even if the page has ` +
    `NO flaws. NEVER leave it empty. CONSTRAINT: this page has NO photographs and none can be added (no image ` +
    `generation) — propose a TYPE, LAYOUT, or COPY upgrade ONLY (e.g. mega .ds-display type, an asymmetric ` +
    `.ds-grid-asym split, a .ds-quote pull-quote, a .ds-bignum stat). NEVER suggest adding a photo/image/video.\n` +
    `- If the page is genuinely flawless, return "flaws": [] but STILL give an upgrade.`;

  const prompt =
    `You are a senior brand & design LEAD reviewing the ATTACHED IMAGE (a screenshot of a rendered ` +
    `marketing page). Do TWO things: (1) AUDIT — list the concrete, fixable visual flaws (brand DON'T ` +
    `violations, off-brand color/tone, weak hierarchy, placeholder copy, legibility); (2) ELEVATE — name ` +
    `the single highest-leverage CONSTRUCTIVE upgrade that would make this page EXCEPTIONAL (a 90-100: ` +
    `flawless craft, bold confident layout, sharp copy), embodying the brand at its best. Removing flaws ` +
    `gets a page to ~75; the upgrade is how it reaches 90. Judge ONLY what you can SEE in the image; the ` +
    `HTML below is supporting context.\n\n` +
    brandBlock +
    (html && String(html).trim()
      ? `SUPPORTING HTML (context):\n<<<HTML\n${String(html)}\nHTML\n\n`
      : "") +
    jsonInstr;

  let raw;
  try {
    // MEDIUM reasoning (matches the judge); gen-loop caller: 0 retries (fail fast).
    raw = await codexRun(prompt, {
      effort: JUDGE_EFFORT,
      timeoutMs: 180_000,
      images: [shot],
      retries: 0,
    });
  } finally {
    if (tmpShotDir) { try { await rm(tmpShotDir, { recursive: true, force: true }); } catch { /* ignore */ } }
  }

  // Parse the constructive critique {flaws, upgrade, strengths}. Tolerant: a bare JSON array
  // (model ignored the object shape) degrades to flaws-only with no upgrade.
  let upgrade = "", strengths = [], flawsSource = raw;
  if (typeof raw === "string") {
    const m = raw.match(/\{[\s\S]*\}/); // first { … last } — captures the object incl. nested arrays
    if (m) {
      try {
        const obj = JSON.parse(m[0]);
        if (obj && typeof obj === "object" && !Array.isArray(obj)) {
          if (Array.isArray(obj.flaws)) flawsSource = JSON.stringify(obj.flaws);
          if (typeof obj.upgrade === "string") upgrade = obj.upgrade.trim();
          if (Array.isArray(obj.strengths)) strengths = obj.strengths.map((s) => String(s).trim()).filter(Boolean);
        }
      } catch { /* not a clean object — fall back to array extraction below */ }
    }
  }
  return { findings: normalizeCritiqueFindings(flawsSource, donts), upgrade, strengths };
}

// Word-overlap stopwords for the DON'T enum snap (ignore filler words so a cited
// phrase like "tiny text" still aligns to "No tiny body text").
const DONT_STOPWORDS = new Set(["do", "not", "no", "the", "a", "an", "of", "to", "and", "or", "use", "any"]);
function dontTokens(s) {
  return String(s).toLowerCase().split(/[^a-z0-9#]+/i).filter((w) => w && !DONT_STOPWORDS.has(w));
}

/**
 * Snap a model-cited rule string to the CLOSEST entry in the brand DON'T enum by
 * shared content-word overlap. Pure selection — it ALWAYS returns one of `donts`
 * (never an invented rule). Falls back to the first DON'T when there is no overlap.
 * @param {string} cited
 * @param {string[]} donts
 * @returns {string}
 */
function closestDont(cited, donts) {
  if (!Array.isArray(donts) || !donts.length) return cited;
  const want = new Set(dontTokens(cited));
  if (!want.size) return donts[0];
  let best = donts[0], bestScore = -1;
  for (const d of donts) {
    let score = 0;
    for (const w of dontTokens(d)) if (want.has(w)) score++;
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return bestScore > 0 ? best : donts[0];
}

/**
 * Parse + normalize raw Codex critique text into the frozen
 * `[{flaw, brandRuleCited, severity}]` shape (CONTRACTS §3). Pulled out of
 * codexCritique so the no-network smoke test can exercise it with a stubbed Codex
 * answer. NO regex on a learnable/scoring path: brandRuleCited is snapped to the
 * `donts` ENUM (exact, then substring containment, then first), never invented;
 * severity is constrained to {high,med,low} (default med).
 * @param {string} raw  the model's final message text (a JSON array)
 * @param {string[]} donts  the brand DON'T enum
 * @returns {Array<{flaw:string, brandRuleCited:string, severity:("high"|"med"|"low")}>}
 */
export function normalizeCritiqueFindings(raw, donts = []) {
  const findings = extractJsonArray(raw);
  const validSeverity = new Set(["high", "med", "low"]);
  const out = [];
  for (const item of findings) {
    if (!item || typeof item !== "object") continue;
    const flaw = item.flaw == null ? "" : String(item.flaw).trim();
    if (!flaw) continue;
    let brandRuleCited = item.brandRuleCited == null ? "" : String(item.brandRuleCited).trim();
    // Constrain brandRuleCited to the DON'T enum: if the model didn't return an exact
    // match, snap to the CLOSEST DON'T by word overlap (else the first), never an
    // invented rule. This is enum normalization (not a scoring path) — it only ever
    // selects from `donts`, so a flaw can never cite a fabricated rule.
    if (Array.isArray(donts) && donts.length) {
      const exact = donts.find((d) => String(d).trim() === brandRuleCited);
      if (!exact) {
        brandRuleCited = String(closestDont(brandRuleCited, donts)).trim();
      }
    }
    let severity = item.severity == null ? "" : String(item.severity).trim().toLowerCase();
    if (!validSeverity.has(severity)) severity = "med";
    out.push({ flaw, brandRuleCited, severity });
  }
  return out;
}

// ---------------------------------------------------------------------------
// NO-NETWORK SMOKE TEST — `node web/src/codex.mjs --smoke`.
// Proves the v3.1 pure logic without any Codex / network call (CONTRACTS §
// "Smoke-test ownership" for codex.mjs): codexCritique parsing returns
// [{flaw,brandRuleCited,severity}] (stubbed Codex), two-axis judge parsing, the
// build-brief weaving, the sandbox opt-in default, and the process-tree hang-kill.
// ---------------------------------------------------------------------------
async function runSmoke() {
  let pass = 0, fail = 0;
  const log = (ok, msg) => { console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`); ok ? pass++ : fail++; };

  // 1) codexCritique parsing -> [{flaw, brandRuleCited, severity}] (stubbed Codex).
  const donts = ["Do not use gradients", "No generic stock photos", "No tiny body text"];
  const stubbed =
    'Here are the flaws:\n```json\n[' +
    '{"flaw":"Hero uses a purple gradient background","brandRuleCited":"Do not use gradients","severity":"high"},' +
    '{"flaw":"Body copy is 11px and hard to read","brandRuleCited":"tiny text","severity":"MED"},' +
    '{"flaw":"CTA lacks the brand accent","brandRuleCited":"some invented rule","severity":"weird"},' +
    '{"flaw":"   ","brandRuleCited":"x","severity":"low"}' +
    ']\n```';
  const crit = normalizeCritiqueFindings(stubbed, donts);
  log(Array.isArray(crit), "codexCritique: parse returns an array");
  log(crit.length === 3, "codexCritique: drops the blank-flaw item (3 valid of 4)");
  log(
    crit.every((f) => typeof f.flaw === "string" && f.flaw &&
      typeof f.brandRuleCited === "string" && ["high", "med", "low"].includes(f.severity)),
    "codexCritique: every item is {flaw, brandRuleCited, severity(enum)}"
  );
  log(crit[0].brandRuleCited === "Do not use gradients" && crit[0].severity === "high",
    "codexCritique: exact DON'T match + high severity preserved");
  log(crit[1].brandRuleCited === "No tiny body text" && crit[1].severity === "med",
    'codexCritique: snaps "tiny text" -> "No tiny body text" DON\'T; lowercases MED->med');
  log(donts.includes(crit[2].brandRuleCited),
    "codexCritique: an invented rule is snapped to a real DON'T (never invented)");
  log(crit[2].severity === "med",
    "codexCritique: an invalid severity defaults to med");
  log(normalizeCritiqueFindings("no flaws at all", donts).length === 0,
    "codexCritique: a non-array / empty answer => [] (flawless verdict)");

  // 2) Two-axis judge parsing (the shape codex.mjs hands judgeSite).
  const judgeRaw = '{"quality": 84, "brandAdherence": 41.6, "reasoning":"solid craft, off-brand accent", "findings":["accent missing"," "]}';
  const jobj = extractJsonObject(judgeRaw);
  const q = clamp0to100(jobj.quality);
  const b = clamp0to100(jobj.brandAdherence);
  log(q === 84 && b === 42, "judge: two raw axes parsed + clamped/rounded (84, 41.6->42)");
  log(clamp0to100(150) === 100 && clamp0to100(-3) === 0 && clamp0to100("x") === null,
    "judge: clamp0to100 clamps + rejects non-numeric");
  const jfindings = Array.isArray(jobj.findings)
    ? jobj.findings.map((f) => String(f).trim()).filter(Boolean) : [];
  log(jfindings.length === 1 && jfindings[0] === "accent missing",
    "judge: findings[] trimmed + blanks dropped");

  // 3) Build-brief weaving (Phase 2.3 — no dropped agent output).
  const briefStr = summarizeBrief({
    copy: { hero: "Go viral. Get customers.", angle: "punchy, founder-to-founder" },
    layoutDirection: "asymmetric hero, 3-up proof grid",
    typeScale: "oversized display H1",
    imageDirective: "flat brand-color hero illustration",
    mustFix: ["this is handled as a fix-rule, not echoed here"],
  });
  log(/HERO COPY: Go viral/.test(briefStr) && /COPY ANGLE: punchy/.test(briefStr),
    "brief: copy {hero,angle} woven");
  log(/LAYOUT: asymmetric/.test(briefStr) && /TYPE SCALE DIRECTION: oversized/.test(briefStr) &&
    /IMAGERY: flat brand-color/.test(briefStr), "brief: layout/type/image slots woven");
  log(!/mustFix|handled as a fix-rule/.test(briefStr), "brief: mustFix is NOT echoed (it's merged into fix-rules)");
  log(summarizeBrief(null) === "" && summarizeBrief({}) === "",
    "brief: empty/absent brief => empty block (back-compat)");

  // 4) Sandbox opt-in: default stays read-only; only workspace-write opts in.
  log(normalizeSandbox(undefined) === "read-only" && normalizeSandbox("anything") === "read-only",
    "sandbox: default + unknown => read-only (never silently widened)");
  log(normalizeSandbox("workspace-write") === "workspace-write",
    "sandbox: explicit workspace-write honored (CODEX_IMAGE opt-in path)");

  // 5) Hang-kill: a stubbed hanging child is SIGKILLed (Phase 0.1 accept).
  await new Promise((done) => {
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    let killedSignal = null;
    const t0 = Date.now();
    child.on("exit", (_code, signal) => {
      killedSignal = signal;
      const ms = Date.now() - t0;
      log(killedSignal === "SIGKILL" && ms < 2000,
        `hang-kill: killProcessTree SIGKILLed the child in ${ms}ms (< grace)`);
      done();
    });
    // give the child a tick to actually start, then kill the tree.
    setTimeout(() => killProcessTree(child), 100);
  });

  console.log(`\n${fail === 0 ? "ALL PASS" : "SOME FAILED"} — ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

// ---- proof harness: `node web/src/codex.mjs` builds a real TikTok page ----
//   `--smoke` runs the no-network logic test above instead of the real build.
if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes("--smoke")) {
    runSmoke().catch((err) => { console.error("SMOKE FAILED:", err.message); process.exit(1); });
  } else {
  (async () => {
    const { deconstructBrand } = await import("./brand.mjs");
    const brand = await deconstructBrand(); // real brand + tokens + designSystemCss
    const t0 = Date.now();
    const html = await codexBuildSite({
      brand,
      goal: "Go viral. Get customers. Landing page for a TikTok marketing tool.",
      copyHint: 'Hero headline tone: "Go viral. Get customers."',
      // Same-turn critique findings reach the build via the typed brief's mustFix.
      brief: { mustFix: ["use flat #FE2C55/#25F4EE color blocks instead of any gradient"] },
    });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log("===== FIRST 300 CHARS =====");
    console.log(html.slice(0, 300));
    console.log("\n===== STATS =====");
    console.log("length:", html.length);
    console.log("starts <!DOCTYPE:", /^<!doctype html/i.test(html));
    console.log("ends </html>:", /<\/html>\s*$/i.test(html));
    console.log("gradient count:", (html.match(/gradient/gi) || []).length);
    console.log("inlines design system:", html.includes("taste-loop-design-system"));
    console.log("inlines :root vars:", /:root\s*{/.test(html));
    console.log("uses .ds-* classes:", /class="[^"]*\bds-/.test(html));
    console.log("uses Razzmatazz #FE2C55:", /#FE2C55/i.test(html));
    console.log("uses Splash #25F4EE:", /#25F4EE/i.test(html));
    console.log("no external CDN:", !/cdn\.tailwindcss\.com|cdn\.jsdelivr|bootstrap/i.test(html));
    console.log("build time (s):", secs);
  })().catch((err) => {
    console.error("PROOF FAILED:", err.message);
    process.exit(1);
  });
  }
}
