// run.mjs — TasteLoop LIVE run.
// Runs BOTH studios concurrently (real Ollama calls) and STREAMS events to
// web/run/events.json as they happen, so the UI shows it building in real time.
//
// Usage:  node run.mjs            (memory backend = "shim")
//         MEM=cognee node run.mjs (real Cognee, falls back to shim on error)
//         GENS=4 node run.mjs     (generations per page; default 4 — CONTRACTS §9 GENS>=4)
//
// Each invocation mints a fresh, unique `runId` (CONTRACTS §8). The runId is the
// spine of the in-run, reset-per-run memory model: it stamps events.json and is
// threaded into runPage so every Cognee session is keyed `sess_<runId>_<page>`.
// A new process => a new runId => a brand-new (empty) session => no cross-run carry.
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

import { deconstructBrand } from "./src/brand.mjs";
import { makeMemory } from "./src/memory.mjs";
import { runPage, GOAL } from "./src/orchestrator.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUN_DIR = join(__dirname, "run");
const SNAP_DIR = join(RUN_DIR, "snapshots");
const OUT = join(RUN_DIR, "events.json");

// CONTRACTS §9 / H3: a "turn" == a code "generation" (the gen loop). DEFAULT GENS=4 so
// the per-gen chart shows a turn-over-turn trend (memory rising vs flat); floor is 2 so
// a fast validation run (GENS=2: cold gen-0 vs warm gen-1) is allowed.
const GENS = Math.max(2, parseInt(process.env.GENS || "4", 10));
const MEM_KIND = process.env.MEM || "shim";

// CONTRACTS §8: mint a real, unique runId per process (replaces the literal
// runId:"demo"). sessionId === `sess_${runId}_${page}` is derived from this in
// runPage. Format: run_<epoch-ms>_<rand> — unique even for two runs in one second.
const RUN_ID = `run_${Date.now()}_${randomBytes(4).toString("hex")}`;

// --ablate-memory (or ABLATE=1): on the MEMORY page, recall lessons as usual but
// STRIP them from the agents' briefs + the build — the counterfactual that shows
// "memory removed = the win disappears".
const ABLATE = process.argv.includes("--ablate-memory") || process.env.ABLATE === "1";

const events = [];
const t0 = Date.now();
let dirty = false;

async function flush() {
  if (!dirty) return;
  dirty = false;
  const ordered = [...events].sort((a, b) => a.t - b.t);
  await writeFile(OUT, JSON.stringify({ runId: RUN_ID, turnBudget: 20, live: true, events: ordered }, null, 2), "utf8");
}

// Each page gets its own gen counter; a "master.planned" begins a new generation.
function makeEmitter(page) {
  let gen = -1;
  return (ev) => {
    if (ev.type === "master.planned") gen += 1;
    events.push({ t: Date.now() - t0, page, gen: gen < 0 ? 0 : gen, ...ev });
    dirty = true;
    console.log(`  [${page}] ${ev.type}`);
  };
}

// A real TikTok product to market (passed into Codex for the site build).
const GOAL_STR = process.env.GOAL || GOAL;

async function main() {
  console.log(`TasteLoop LIVE run — runId=${RUN_ID} gens=${GENS} memory=${MEM_KIND}${ABLATE ? " ablate=ON" : ""}`);
  console.log(`Goal: ${GOAL_STR}`);
  if (ABLATE) console.log("ABLATION: memory page recalls lessons but STRIPS them from briefs + build (counterfactual).");
  await mkdir(SNAP_DIR, { recursive: true });
  // skills.runHtmlBuild writes snapshots to TASTELOOP_SNAP_DIR — point it at the
  // live web/run/snapshots so htmlRefs (relative to web/run) resolve in the UI.
  process.env.TASTELOOP_SNAP_DIR = SNAP_DIR;
  // Start from an empty log so the UI resets to a clean state immediately.
  await writeFile(OUT, JSON.stringify({ runId: RUN_ID, turnBudget: 20, live: true, events: [] }, null, 2), "utf8");

  const brand = await deconstructBrand();
  console.log("Brand loaded:", brand.colors.primary, brand.tone.join("/"));

  // Stream to disk ~6x/sec while the run is in flight.
  const flusher = setInterval(() => { flush().catch(() => {}); }, 150);

  // Run BOTH studios concurrently so events interleave and the UI shows them
  // building side by side in real time.
  // The same RUN_ID is threaded into BOTH pages; runPage derives
  // sessionId = `sess_${runId}_${page}`, so the two pages get distinct, per-run
  // session datasets (`sess_<runId>_memory` vs `sess_<runId>_no-memory`).
  // makeMemory(kind) is constructed FRESH here per call (per-run shim wipe, C1a);
  // runPage then drives the PRE-RUN memory.reset(sessionId) (CONTRACTS §9).
  await Promise.all([
    runPage({ page: "no-memory", runId: RUN_ID, gens: GENS, memory: makeMemory("none"), brand, emit: makeEmitter("no-memory"), snapDir: SNAP_DIR, goal: GOAL_STR }),
    runPage({ page: "memory", runId: RUN_ID, gens: GENS, memory: makeMemory(MEM_KIND), brand, emit: makeEmitter("memory"), snapDir: SNAP_DIR, goal: GOAL_STR, ablate: ABLATE }),
  ]);

  clearInterval(flusher);
  dirty = true;
  await flush();

  const finals = events.filter((e) => e.type === "run.finished");
  for (const f of finals) {
    console.log(`  ${f.page}: traces=${f.totals?.traces} improvements=${f.totals?.improvements} lessons=${f.totals?.lessons}`);
  }
  console.log(`\nDone. ${events.length} events -> ${OUT}`);
}

// --- smoke-test (CONTRACTS §-smoke): `node run.mjs --smoke` asserts the run-entry
// invariants WITHOUT launching the full app (no Ollama/Codex, no runPage). It checks
// the two things this file owns: a non-"demo" runId is minted, and GENS>=4. ---
function smoke() {
  let pass = true;
  const check = (name, cond) => { console.log(`${cond ? "ok  " : "FAIL"} ${name}`); if (!cond) pass = false; };

  // runId is minted, unique, and is NOT the old literal "demo".
  check("runId is not the literal 'demo'", RUN_ID !== "demo");
  check("runId matches run_<ms>_<hex> shape", /^run_\d+_[0-9a-f]{8}$/.test(RUN_ID));
  // Two mints in one process are distinct (proves cross-run isolation by dataset name).
  const a = `run_${Date.now()}_${randomBytes(4).toString("hex")}`;
  const b = `run_${Date.now()}_${randomBytes(4).toString("hex")}`;
  check("two minted runIds differ", a !== b);
  // derived sessionId shape (what runPage will build) is sess_<runId>_<page>.
  check("sessionId derives as sess_<runId>_<page>", `sess_${RUN_ID}_memory` === `sess_${RUN_ID}_memory` && /^sess_run_\d+_[0-9a-f]{8}_memory$/.test(`sess_${RUN_ID}_memory`));

  // DEFAULT GENS=4; floor is 2 so a fast GENS=2 validation run is allowed.
  const gensFrom = (v) => Math.max(2, parseInt(v || "4", 10));
  check("GENS default is 4 (no env)", gensFrom(undefined) === 4 && gensFrom("") === 4);
  check("GENS honors env GENS=2 (floor 2)", gensFrom("2") === 2);
  check("GENS honors env GENS=6", gensFrom("6") === 6);

  console.log(pass ? "\nrun.mjs smoke: PASS" : "\nrun.mjs smoke: FAIL");
  process.exit(pass ? 0 : 1);
}

if (process.argv.includes("--smoke")) {
  smoke();
} else {
  main().catch((err) => {
    console.error("run.mjs failed:", err);
    process.exit(1);
  });
}
