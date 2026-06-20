// run.mjs — TasteLoop LIVE run.
// Runs BOTH studios concurrently (real Ollama calls) and STREAMS events to
// web/run/events.json as they happen, so the UI shows it building in real time.
//
// Usage:  node run.mjs            (memory backend = "shim")
//         MEM=cognee node run.mjs (real Cognee, falls back to shim on error)
//         GENS=2 node run.mjs     (generations per page; default 2)
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

import { deconstructBrand } from "./src/brand.mjs";
import { makeMemory } from "./src/memory.mjs";
import { runPage } from "./src/orchestrator.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUN_DIR = join(__dirname, "run");
const SNAP_DIR = join(RUN_DIR, "snapshots");
const OUT = join(RUN_DIR, "events.json");

const GENS = Math.max(1, parseInt(process.env.GENS || "2", 10));
const MEM_KIND = process.env.MEM || "shim";

const events = [];
const t0 = Date.now();
let dirty = false;

async function flush() {
  if (!dirty) return;
  dirty = false;
  const ordered = [...events].sort((a, b) => a.t - b.t);
  await writeFile(OUT, JSON.stringify({ runId: "demo", turnBudget: 20, live: true, events: ordered }, null, 2), "utf8");
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

async function main() {
  console.log(`TasteLoop LIVE run — gens=${GENS} memory=${MEM_KIND}`);
  await mkdir(SNAP_DIR, { recursive: true });
  // Start from an empty log so the UI resets to a clean state immediately.
  await writeFile(OUT, JSON.stringify({ runId: "demo", turnBudget: 20, live: true, events: [] }, null, 2), "utf8");

  const brand = await deconstructBrand();
  console.log("Brand loaded:", brand.colors.primary, brand.tone.join("/"));

  // Stream to disk ~6x/sec while the run is in flight.
  const flusher = setInterval(() => { flush().catch(() => {}); }, 150);

  // Run BOTH studios concurrently so events interleave and the UI shows them
  // building side by side in real time.
  await Promise.all([
    runPage({ page: "no-memory", gens: GENS, memory: makeMemory("none"), brand, emit: makeEmitter("no-memory"), snapDir: SNAP_DIR }),
    runPage({ page: "memory", gens: GENS, memory: makeMemory(MEM_KIND), brand, emit: makeEmitter("memory"), snapDir: SNAP_DIR }),
  ]);

  clearInterval(flusher);
  dirty = true;
  await flush();

  const finals = events.filter((e) => e.type === "run.finished");
  for (const f of finals) {
    console.log(`  ${f.page}: score=${f.totals?.score} traces=${f.totals?.traces} improvements=${f.totals?.improvements} lessons=${f.totals?.lessons}`);
  }
  console.log(`\nDone. ${events.length} events -> ${OUT}`);
}

main().catch((err) => {
  console.error("run.mjs failed:", err);
  process.exit(1);
});
