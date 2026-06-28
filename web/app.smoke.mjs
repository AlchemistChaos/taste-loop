/* app.smoke.mjs — UI replay-engine smoke tests (Phase 4 consumer logic).
 *
 * app.js is a browser IIFE (no exports, needs a DOM to boot). Under Node it skips
 * boot() and exposes its pure, DOM-free helpers on globalThis.__TASTELOOP_APP_TEST__
 * so we can assert the load-bearing v3.1 consumer behaviors WITHOUT a DOM:
 *   - per-gen chart vs bestScore headline separation (H2 / CONTRACTS §5)
 *   - score->y chart scaling (0..100 mapped into the chart band)
 *   - memory-graph token mining (#hex + no-X tokens, "brand" fallback)
 *
 * Run:  node web/app.smoke.mjs   (exit 0 = pass, non-zero = fail)
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
require(path.join(here, "app.js")); // loads under Node; exposes the test hook

const T = globalThis.__TASTELOOP_APP_TEST__;
let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log("  ok  -", label); }
  else { fail++; console.error("  FAIL-", label); }
}

console.log("app.js consumer smoke tests:");

// 0. The test hook is present at all.
ok(!!T && typeof T.mineTokens === "function", "Node-load exposes pure test hook (no DOM access at module top)");

// 1. Headline = best per-gen score seen so far (monotonic max), NOT the last gen.
//    The chart plots the per-gen series; the headline must never regress (H2).
ok(T.headlineFromGens([40, 55, 52, 71]) === 71, "headline = max per-gen score (monotonic)");
ok(T.headlineFromGens([60, 50, 45]) === 60, "headline holds the peak even when later gens dip");
ok(T.headlineFromGens([]) === 0, "headline defaults to 0 with no gens");
ok(T.htmlRefForIframe({ type: "score.updated", htmlRef: "snapshots/kept.html", reverted: true }) === "snapshots/kept.html",
  "score.updated htmlRef can drive the iframe to the kept page after a revert");
ok(T.htmlRefForIframe({ type: "score.updated" }) === "",
  "score.updated without htmlRef does not drive the iframe");

// 2. Chart y-scaling maps the 0..100 judge range into the chart band correctly:
//    score 100 -> top (padT), score 0 -> bottom (padT+innerH), monotonic decreasing.
const yTop = T.yForScore(100), yBot = T.yForScore(0), yMid = T.yForScore(50);
ok(yTop < yMid && yMid < yBot, "higher score -> higher on chart (smaller y)");
ok(Math.abs(yTop - 8) < 1e-6, "score 100 maps to the top padding (y=padT=8)");
ok(Math.abs(yBot - (8 + 50)) < 1e-6, "score 0 maps to the chart floor (y=padT+innerH)");
ok(Math.abs(yMid - (8 + 25)) < 1e-6, "score 50 maps to the chart midline");
ok(Math.abs(T.yForScore(150) - yTop) < 1e-6, "out-of-range high score clamps to the top");
ok(Math.abs(T.yForScore(-20) - yBot) < 1e-6, "out-of-range low score clamps to the floor");

// 3. Memory-graph token mining: hex colors + no-X rules become token anchors;
//    text with neither falls back to the generic "brand" node (handled by caller,
//    but mineTokens must return [] so the fallback can trigger).
ok(JSON.stringify(T.mineTokens("use #25F4EE for the CTA")) === JSON.stringify(["#25f4ee"]),
  "mineTokens extracts a hex color token (lowercased)");
ok(T.mineTokens("never add a no-gradient please").includes("no-gradient"),
  "mineTokens extracts a no-X rule token");
{
  const both = T.mineTokens("brand wants #FE2C55 and no-shadow");
  ok(both.includes("#fe2c55") && both.includes("no-shadow"), "mineTokens extracts hex + no-X together");
}
ok(T.mineTokens("the hero copy is too generic").length === 0,
  "mineTokens returns [] when no token present (caller anchors under 'brand')");
ok(T.mineTokens("").length === 0 && T.mineTokens(null).length === 0,
  "mineTokens is safe on empty/null input");

// 3b. Phase 3: VERBATIM brand-grounding / token-anchored lesson statements name the
//     canonical node after "BRAND <KIND> token <node>" — every canonical kind must
//     become its own per-token graph node (not collapse onto the generic "brand" hub).
ok(JSON.stringify(T.mineTokens("BRAND COLOR token #25F4EE is the Splash accent color.")) === JSON.stringify(["#25f4ee"]),
  "mineTokens mines the hex node from a typed COLOR grounding statement");
ok(T.mineTokens("BRAND FONT token sofia-pro is the heading typeface.").includes("sofia-pro"),
  "mineTokens mines a FONT slug node the hex/no-X heuristics would miss");
ok(T.mineTokens("BRAND STRUCTURE token hero is a canonical page section.").includes("hero"),
  "mineTokens mines a STRUCTURE/section node (e.g. hero)");
ok(T.mineTokens("BRAND SPACING token s0=8 defines layout rhythm.").includes("s0"),
  "mineTokens mines a SPACING node id (stops at '=')");
ok(T.mineTokens("BRAND RULE: one-brand-color keep a single brand color").includes("one-brand-color") ||
   T.mineTokens("BRAND RULE token one-brand-color").includes("one-brand-color"),
  "mineTokens mines a non-'no-' rule slug node (one-brand-color)");
{
  // A token-anchored lesson statement still surfaces its canonical node so the lesson
  // edge hangs off the right per-token node in the graph.
  const t = T.mineTokens("Lesson: enforce BRAND COLOR token #FE2C55 in the hero CTA");
  ok(t.includes("#fe2c55") && t.length === 1, "mineTokens dedupes + anchors a lesson to its token node");
}

console.log(`\napp.js smoke: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
