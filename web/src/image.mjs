// image.mjs — REAL image generation via OpenAI Images API (gpt-image-1).
//
// generateImage() crafts a brand-aware prompt (weaving the brand palette + tone,
// and forbidding the brand DON'Ts e.g. "no gradients"), calls the OpenAI Images
// API by direct fetch, decodes the returned base64 PNG, writes it to
// web/run/assets/<name>.png, and returns { path, dataUri }.
//
// NO FALLBACK: if OPENAI_API_KEY is missing or the API errors, this THROWS a
// clear Error. Transient failures (HTTP 429 / 5xx) are retried ONCE.
//
// Frozen signature (other modules import this exact shape):
//   export async function generateImage({prompt, brand, name, size}) ->
//     { path: "run/assets/<name>.png", dataUri: "data:image/png;base64,..." }
//
// CLI:
//   node web/src/image.mjs "<prompt>" <name>
//     -> prints {path, dataUri} as JSON (smoke only runs if OPENAI_API_KEY set)
//
// API reference (OpenAI Images, model gpt-image-1):
//   POST https://api.openai.com/v1/images/generations
//   Authorization: Bearer ${OPENAI_API_KEY}
//   body: { model:"gpt-image-1", prompt, size, n }
//   response: { data: [ { b64_json: "<base64 png>" } ] }
//   (gpt-image-1 always returns b64_json — there is no url response mode.)

import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url)); // web/src
const WEB_ROOT = path.resolve(__dirname, "..");                 // web
const ASSETS_DIR = path.join(WEB_ROOT, "run", "assets");        // web/run/assets

const OPENAI_IMAGES_URL = "https://api.openai.com/v1/images/generations";
const IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1";
const DEFAULT_SIZE = "1536x1024";
const REQUEST_TIMEOUT = Number(process.env.OPENAI_IMAGE_TIMEOUT || 120_000);

// gpt-image-1 only accepts a fixed set of sizes; coerce to the nearest valid one.
const VALID_SIZES = new Set(["1024x1024", "1536x1024", "1024x1536", "auto"]);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// Slugify <name> into a safe filename stem (no extension, no path traversal).
function safeName(name) {
  const stem = String(name || "")
    .trim()
    .replace(/\.png$/i, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 80);
  if (!stem) throw new Error("generateImage: a non-empty 'name' is required");
  return stem;
}

// Build a brand-aware image prompt: weave palette + tone, forbid brand DON'Ts.
function buildBrandPrompt(prompt, brand) {
  const base = String(prompt || "").trim();
  if (!base) throw new Error("generateImage: a non-empty 'prompt' is required");
  if (!brand) return base;

  const c = brand.colors || {};
  const parts = [base];

  const palette = [
    c.primary && `primary ${c.primary}`,
    c.accent && `accent ${c.accent}`,
    c.bg && `background ${c.bg}`,
    c.fg && `text/foreground ${c.fg}`,
  ].filter(Boolean);
  if (palette.length) {
    parts.push(
      `Use ONLY this flat brand color palette: ${palette.join(", ")}. ` +
      `Flat, bold, high-contrast color — no other colors, no gradients. Depict a real focal subject, not abstract color blocks.`
    );
  }

  const tone = Array.isArray(brand.tone) ? brand.tone.join(", ") : brand.tone;
  if (tone) parts.push(`Visual tone: ${tone}.`);

  if (brand.audience) parts.push(`Audience: ${brand.audience}.`);

  const donts = brand.dont || brand.donts || [];
  if (Array.isArray(donts) && donts.length) {
    parts.push(`STRICT constraints — do NOT include any of: ${donts.join("; ")}.`);
  }
  // Always reinforce the demo's core brand rule even if not parsed into dont[].
  parts.push("Absolutely no gradients — flat color only. No lorem/placeholder text, no generic AI stock look.");

  return parts.join(" ");
}

// Coerce a requested size to a value gpt-image-1 accepts.
function coerceSize(size) {
  const s = String(size || DEFAULT_SIZE).trim();
  return VALID_SIZES.has(s) ? s : DEFAULT_SIZE;
}

// One POST to the Images API. Returns the raw b64_json string or throws.
// Retryable HTTP failures (429 / 5xx) reject with err.retryable = true.
async function imagesGenerateOnce({ apiKey, prompt, size }) {
  const controller = new AbortController();
  const killer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  let res;
  try {
    res = await fetch(OPENAI_IMAGES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: IMAGE_MODEL, prompt, size, n: 1 }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(killer);
    if (err?.name === "AbortError") {
      const e = new Error(`OpenAI Images request timed out after ${REQUEST_TIMEOUT}ms`);
      e.retryable = true;
      throw e;
    }
    const e = new Error(`OpenAI Images request failed (network): ${err?.message || err}`);
    e.retryable = true; // network blips are worth one retry
    throw e;
  }
  clearTimeout(killer);

  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = body?.error?.message || JSON.stringify(body);
    } catch {
      try { detail = await res.text(); } catch { /* ignore */ }
    }
    const e = new Error(`OpenAI Images API ${res.status} ${res.statusText}: ${detail || "(no body)"}`);
    e.retryable = res.status === 429 || res.status >= 500;
    throw e;
  }

  let json;
  try {
    json = await res.json();
  } catch (err) {
    throw new Error(`OpenAI Images API returned non-JSON response: ${err?.message || err}`);
  }

  const b64 = json?.data?.[0]?.b64_json;
  if (!b64 || typeof b64 !== "string") {
    throw new Error(
      `OpenAI Images API response missing data[0].b64_json: ${JSON.stringify(json).slice(0, 300)}`
    );
  }
  return b64;
}

// ---------------------------------------------------------------------------
// public API (frozen signature)
// ---------------------------------------------------------------------------

/**
 * Generate a real, brand-aware PNG with OpenAI gpt-image-1 and save it under
 * web/run/assets/. THROWS if OPENAI_API_KEY is missing or the API errors
 * (no fallback); retries ONCE on HTTP 429 / 5xx / network timeout.
 *
 * @param {{prompt:string, brand?:object, name:string, size?:string}} args
 * @returns {Promise<{path:string, dataUri:string}>}
 *   path    — relative to the web root, e.g. "run/assets/hero.png"
 *   dataUri — "data:image/png;base64,<...>"
 */
export async function generateImage({ prompt, brand, name, size = DEFAULT_SIZE }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "generateImage: OPENAI_API_KEY is required (no fallback). " +
      "Set OPENAI_API_KEY to call the OpenAI Images API (gpt-image-1)."
    );
  }

  const stem = safeName(name);
  const fullPrompt = buildBrandPrompt(prompt, brand);
  const reqSize = coerceSize(size);

  // first attempt + single retry on transient failures
  let b64;
  try {
    b64 = await imagesGenerateOnce({ apiKey, prompt: fullPrompt, size: reqSize });
  } catch (firstErr) {
    if (!firstErr?.retryable) throw firstErr;
    try {
      b64 = await imagesGenerateOnce({ apiKey, prompt: fullPrompt, size: reqSize });
    } catch (secondErr) {
      throw new Error(
        `generateImage failed after 2 attempts.\n` +
        `  attempt#1: ${firstErr?.message || firstErr}\n` +
        `  attempt#2: ${secondErr?.message || secondErr}`
      );
    }
  }

  const buf = Buffer.from(b64, "base64");
  if (!buf.length) throw new Error("generateImage: decoded image is empty");

  await mkdir(ASSETS_DIR, { recursive: true });
  const absPath = path.join(ASSETS_DIR, `${stem}.png`);
  await writeFile(absPath, buf);

  const relPath = `run/assets/${stem}.png`;            // relative to web root
  const dataUri = `data:image/png;base64,${b64}`;
  return { path: relPath, dataUri };
}

// ---------------------------------------------------------------------------
// CLI: node web/src/image.mjs "<prompt>" <name>
// ---------------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const prompt = process.argv[2];
    const name = process.argv[3] || "image";
    if (!prompt) {
      console.error('usage: node web/src/image.mjs "<prompt>" <name>');
      process.exit(2);
    }
    if (!process.env.OPENAI_API_KEY) {
      console.error("OPENAI_API_KEY is required to generate an image (no fallback).");
      process.exit(1);
    }
    // Brand-aware demo prompt using the verified TikTok palette.
    const brand = {
      colors: { primary: "#FE2C55", accent: "#25F4EE", bg: "#000000", fg: "#FFFFFF" },
      tone: ["bold", "energetic", "direct"],
      audience: "creators & businesses",
      dont: ["no gradients", "no generic AI stock", "no tiny text"],
    };
    const { path: outPath, dataUri } = await generateImage({ prompt, brand, name });
    // Print the frozen return shape (truncate dataUri so the CLI stays readable).
    console.log(JSON.stringify({
      path: outPath,
      dataUri: dataUri.slice(0, 64) + "...(" + dataUri.length + " chars)",
    }, null, 2));
  })().catch((err) => {
    console.error("IMAGE GEN FAILED:", err.message);
    process.exit(1);
  });
}
