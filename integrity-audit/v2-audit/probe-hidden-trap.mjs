import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const { reshapeToLegacy, buildModelInputFor } = await import(path.join(ROOT, "src/canonical-runner.mjs"));
const SET = path.join(ROOT, "scenario-sets/steerbench-work-2026-05");
const changed = [];
let processed = 0;
const seenIds = new Set();
const allEntries = fs.readdirSync(SET);
const underscoreJson = allEntries.filter(f => f.endsWith(".json") && f.startsWith("_")).sort();
if (JSON.stringify(underscoreJson) !== JSON.stringify(["_SCENARIO_PATTERNS.json"])) {
  console.error("FAIL: underscore-json allowlist violated:", underscoreJson); process.exit(1);
}
const probeFiles = allEntries.filter(f => f.endsWith(".json") && !f.startsWith("_")).sort();
if (probeFiles.length !== 106) { console.error(`FAIL: expected 106 scenario files, found ${probeFiles.length}`); process.exit(1); }
for (const f of probeFiles) {
  const json = JSON.parse(fs.readFileSync(path.join(SET, f), "utf8"));
  if (typeof json.id !== "string" || json.id.length === 0) { console.error(`FAIL: missing/empty/non-string id in ${f}`); process.exit(1); }
  if (seenIds.has(json.id)) { console.error("FAIL: duplicate scenario id", json.id); process.exit(1); }
  seenIds.add(json.id);
  processed++;
  const a = buildModelInputFor(reshapeToLegacy(json)).model_input;
  const m = structuredClone(json); if (m.context) m.context.hidden_trap = ""; m.hidden_trap = "";
  const b = buildModelInputFor(reshapeToLegacy(m)).model_input;
  if (a !== b) {
    // find first differing line
    const al=a.split("\n"), bl=b.split("\n");
    let diff="";
    for (let i=0;i<Math.max(al.length,bl.length);i++)
      if (al[i]!==bl[i]) { diff = `"${al[i]}" -> "${bl[i]}"`; break; }
    changed.push(`${json.id}\n      ${diff}`);
  }
}
console.log(`hidden_trap affects the rendered input on ${changed.length} scenarios (v2 expects 0):`);
changed.forEach(s => console.log("  " + s));
if (processed !== 106) { console.error(`FAIL: expected 106 scenarios, processed ${processed}`); process.exit(1); }
const EXPECTED = []; // v2: author-only notes must not reach any derived surface
const ids = changed.map(s => s.split("\n")[0]).sort();
if (JSON.stringify(ids) !== JSON.stringify(EXPECTED)) {
  console.error("FAIL: hidden_trap still reaches model-visible content on", ids); process.exit(1);
}
fs.writeFileSync(fileURLToPath(new URL("./hidden-trap-rows-v2.json", import.meta.url)), `${JSON.stringify(changed, null, 2)}\n`);
