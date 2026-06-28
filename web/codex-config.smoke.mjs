/* codex-config.smoke.mjs — verifies the default Codex CLI config without
 * invoking the real Codex binary.
 *
 * Run: node web/codex-config.smoke.mjs
 */
import { mkdtemp, readFile, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log("  ok  -", label); }
  else { fail++; console.error("  FAIL-", label); }
}

console.log("codex.mjs config smoke tests:");

const tmp = await mkdtemp(join(tmpdir(), "tasteloop-codex-config-"));
try {
  const capturePath = join(tmp, "argv.json");
  const fakeCodexPath = join(tmp, "fake-codex.mjs");
  await writeFile(fakeCodexPath, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
writeFileSync(process.env.CODEX_ARGV_CAPTURE, JSON.stringify(args));
const outIndex = args.indexOf("-o");
if (outIndex !== -1 && args[outIndex + 1]) {
  writeFileSync(args[outIndex + 1], process.env.FAKE_CODEX_FINAL || "fake final message");
}
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
`);
  await chmod(fakeCodexPath, 0o755);

  process.env.CODEX_BIN = fakeCodexPath;
  process.env.CODEX_ARGV_CAPTURE = capturePath;
  delete process.env.CODEX_EFFORT;
  delete process.env.CODEX_JUDGE_EFFORT;

  const codexUrl = new URL("./src/codex.mjs", import.meta.url);
  codexUrl.searchParams.set("smoke", String(Date.now()));
  const { codexRun, codexJudge } = await import(codexUrl.href);

  process.env.FAKE_CODEX_FINAL = "fake final message";
  const result = await codexRun("hello", { timeoutMs: 10_000, retries: 0 });
  ok(result === "fake final message", "codexRun reads the fake CLI final message");

  const runArgs = JSON.parse(await readFile(capturePath, "utf8"));
  ok(runArgs.includes('model="gpt-5.4"'), "default model remains gpt-5.4");
  ok(runArgs.includes('model_reasoning_effort="high"'), "default reasoning effort is high");
  ok(runArgs.includes('service_tier="fast"'), "default service tier is fast");
  ok(runArgs.includes("features.fast_mode=true"), "fast mode feature is enabled");

  process.env.FAKE_CODEX_FINAL = JSON.stringify({
    quality: 80,
    brandAdherence: 90,
    reasoning: "Uses the brand colors and clear layout.",
    findings: [],
  });
  await codexJudge({
    brand: {
      colors: { primary: "#FE2C55", accent: "#25F4EE", bg: "#000000", fg: "#FFFFFF" },
      tone: ["direct"],
      dont: [],
      fonts: { heading: "Inter" },
    },
    html: "<!doctype html><html><body><h1>Hello</h1></body></html>",
    goal: "test page",
  });
  const judgeArgs = JSON.parse(await readFile(capturePath, "utf8"));
  ok(judgeArgs.includes('model_reasoning_effort="high"'), "judge reasoning effort defaults to high");
  ok(judgeArgs.includes('service_tier="fast"'), "judge uses the fast service tier");
} finally {
  await rm(tmp, { recursive: true, force: true });
}

console.log(`\ncodex config smoke: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
