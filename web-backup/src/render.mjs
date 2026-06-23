// render.mjs — render an HTML document to a PNG screenshot with headless Chrome.
//
// One frozen export:
//   export async function renderShot(html, outPng, { width = 1280 } = {}) -> outPng
//
// WHY THIS EXISTS:
//   The TasteLoop judge should grade the PAGE AS RENDERED, not the HTML source
//   (plan §5). A model reading raw HTML can be fooled by markup that looks fine
//   but renders badly (broken layout, invisible text, off-brand color blocks).
//   We rasterize the page with the real browser engine and hand the PNG to the
//   vision judge so it scores what a human would actually see.
//
// HOW:
//   1) Write `html` to a temp .html file.
//   2) Run Google Chrome in headless mode with `--screenshot=<outPng>` pointed at
//      a file:// URL of that temp file.
//   3) Confirm the PNG was produced and is non-trivial (>1KB). THROW otherwise.
//      No silent fallback — a missing/empty screenshot must surface as an error.
//
//   Chrome's `--headless=new` is the modern path; older Chromes only know plain
//   `--headless`. We try `--headless=new` first and, if that invocation fails to
//   produce a valid PNG, retry once with `--headless`.
//
// No npm deps. Plain ESM, Node 18+. macOS Chrome path is the default; override
// with CHROME_BIN for other platforms/installs.
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME_BIN =
  process.env.CHROME_BIN ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// A real screenshot of a non-empty page is comfortably larger than this; a 0-byte
// or tiny file means Chrome failed to paint. Used as the success gate.
const MIN_PNG_BYTES = 1024;

// Headless flag candidates, tried in order. `--headless=new` is preferred; plain
// `--headless` is the fallback for older Chrome builds.
const HEADLESS_FLAGS = ["--headless=new", "--headless"];

// Default render timeout: a single static page paints fast, but Tailwind-via-CDN
// pages must fetch the CDN, so give Chrome room. Env-overridable.
const RENDER_TIMEOUT = Number(process.env.RENDER_TIMEOUT || 60_000);

// Spawn Chrome once with a specific headless flag. Resolves on a clean exit,
// rejects with a descriptive Error (timeout, spawn error, or non-zero exit).
function chromeScreenshotOnce(headlessFlag, fileUrl, outPng, width, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const args = [
      headlessFlag,
      "--disable-gpu",
      "--hide-scrollbars",
      `--screenshot=${outPng}`,
      `--window-size=${width},2000`,
      // Keep Chrome from touching the user's real profile / network state.
      "--no-sandbox",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      fileUrl,
    ];

    let child;
    try {
      child = spawn(CHROME_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      return reject(new Error(`chrome spawn failed (${headlessFlag}): ${err?.message || err}`));
    }

    let stderr = "";
    const tailStderr = () => stderr.split("\n").filter(Boolean).slice(-6).join("\n");

    const killer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      reject(new Error(`chrome screenshot timed out after ${timeoutMs}ms (${headlessFlag})`));
    }, timeoutMs);

    // Drain stdout so the pipe never fills and blocks the child.
    child.stdout.on("data", () => {});
    child.stderr.on("data", (d) => { stderr += d.toString(); });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      reject(new Error(`chrome process error (${headlessFlag}): ${err?.message || err}`));
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      if (code !== 0) {
        return reject(new Error(
          `chrome exited with code ${code} (${headlessFlag}).\n${tailStderr()}`
        ));
      }
      resolve();
    });
  });
}

// Confirm a screenshot file exists and is a plausibly real PNG (>MIN_PNG_BYTES).
// Returns the byte size on success; throws otherwise.
async function assertPng(outPng) {
  let size;
  try {
    size = (await stat(outPng)).size;
  } catch {
    throw new Error(`renderShot: no screenshot was written to ${outPng}`);
  }
  if (size <= MIN_PNG_BYTES) {
    throw new Error(`renderShot: screenshot ${outPng} is too small (${size} bytes <= ${MIN_PNG_BYTES})`);
  }
  return size;
}

/**
 * Render an HTML document to a PNG via headless Chrome.
 *
 * @param {string} html    full HTML document to render
 * @param {string} outPng  absolute path where the PNG should be written
 * @param {{width?:number}} [opts]  viewport width (default 1280)
 * @returns {Promise<string>} the outPng path (so callers can chain)
 * @throws if Chrome fails to produce a non-trivial PNG (no silent fallback)
 */
export async function renderShot(html, outPng, { width = 1280 } = {}) {
  if (!html || !String(html).trim()) throw new Error("renderShot: missing html");
  if (!outPng) throw new Error("renderShot: missing outPng");

  // Write the HTML to a temp file Chrome can load via file://.
  let tmpDir;
  try {
    tmpDir = await mkdtemp(join(tmpdir(), "render-shot-"));
  } catch (err) {
    throw new Error(`renderShot: temp setup failed: ${err?.message || err}`);
  }
  const tmpHtml = join(tmpDir, "page.html");
  const fileUrl = `file://${tmpHtml}`;

  try {
    await writeFile(tmpHtml, String(html), "utf8");

    let firstErr;
    for (const flag of HEADLESS_FLAGS) {
      try {
        await chromeScreenshotOnce(flag, fileUrl, outPng, width, RENDER_TIMEOUT);
        await assertPng(outPng);
        return outPng; // success
      } catch (err) {
        if (!firstErr) firstErr = err;
        // try the next headless flag (e.g. fall from --headless=new to --headless)
      }
    }
    throw new Error(
      `renderShot: Chrome failed to produce a valid PNG. ` +
      `Tried ${HEADLESS_FLAGS.join(", ")}.\n  first error: ${firstErr?.message || firstErr}`
    );
  } finally {
    try { await rm(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ---- smoke test: `node web/src/render.mjs` renders a tiny page to a PNG ----
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const out = join(tmpdir(), `render-smoke-${Date.now()}.png`);
    const html =
      `<!DOCTYPE html><html><head><meta charset="utf-8"><title>smoke</title>` +
      `<style>body{margin:0;background:#FE2C55;color:#fff;font:48px/1.2 system-ui;` +
      `display:flex;align-items:center;justify-content:center;height:400px}</style></head>` +
      `<body><h1>TasteLoop render smoke</h1></body></html>`;

    const t0 = Date.now();
    const png = await renderShot(html, out, { width: 800 });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const size = (await stat(png)).size;

    console.log("CHROME_BIN:", CHROME_BIN);
    console.log("out png:", png);
    console.log("png bytes:", size);
    console.log("png > 1KB:", size > MIN_PNG_BYTES);
    console.log("render time (s):", secs);

    if (size <= MIN_PNG_BYTES) {
      console.error("render.mjs smoke: FAIL (png too small)");
      process.exit(1);
    }
    console.log("render.mjs smoke: PASS");
    // Clean up the smoke artifact.
    try { await rm(png, { force: true }); } catch { /* ignore */ }
  })().catch((err) => {
    console.error("render.mjs smoke FAILED:", err.message);
    process.exit(1);
  });
}
