import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const { reshapeToLegacy, buildModelInputFor } = await import(path.join(ROOT, "src/canonical-runner.mjs"));
const SET = path.join(ROOT, "scenario-sets/steerbench-work-2026-05");

const allEntries = fs.readdirSync(SET);
const underscoreJson = allEntries.filter(f => f.endsWith(".json") && f.startsWith("_")).sort();
if (JSON.stringify(underscoreJson) !== JSON.stringify(["_SCENARIO_PATTERNS.json"])) {
  console.error("FAIL: underscore-json allowlist violated:", underscoreJson); process.exit(1);
}
const files = allEntries.filter(f => f.endsWith(".json") && !f.startsWith("_")).sort();
if (files.length !== 106) { console.error(`FAIL: expected 106 scenario files, found ${files.length}`); process.exit(1); }
const rows = [];
const seenIds = new Set();
for (const f of files) {
  const json = JSON.parse(fs.readFileSync(path.join(SET, f), "utf8"));
  if (typeof json.id !== "string" || json.id.length === 0) { console.error(`FAIL: missing/empty/non-string id in ${f}`); process.exit(1); }
  if (seenIds.has(json.id)) { console.error("FAIL: duplicate scenario id", json.id); process.exit(1); }
  seenIds.add(json.id);
  const base = reshapeToLegacy(json);
  const expected = json.expected_behavior?.correct_action ?? null;

  const asIs = buildModelInputFor(base);

  // Variant A: opaque scenario id only
  const opaqueId = { ...base, id: "sw-0000" };
  const aOnly = buildModelInputFor(opaqueId);

  // Variant B: opaque scenario id + opaque evidence ids
  const opaqueBoth = {
    ...opaqueId,
    evidence: base.evidence.map((e, i) => ({ ...e, evidence_id: `E${String(i+1).padStart(2,"0")}` })),
    action: { ...base.action, evidence_ids: base.evidence.map((_, i) => `E${String(i+1).padStart(2,"0")}`) }
  };
  const bBoth = buildModelInputFor(opaqueBoth); // renderer errors must fail the probe, not be swallowed

  rows.push({
    id: json.id, expected,
    flags_asis: asIs.integrity_flags.slice().sort(),
    flags_opaqueid: aOnly.integrity_flags.slice().sort(),
    flags_opaqueboth: bBoth.integrity_flags.slice().sort(),
    len_asis: asIs.model_input.length,
    input_asis: asIs.model_input
  });
}

const eq = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const flippedId = rows.filter(r => !eq(r.flags_asis, r.flags_opaqueid));
const flippedBoth = rows.filter(r => !eq(r.flags_asis, r.flags_opaqueboth));

console.log(`scenarios analyzed: ${rows.length}`);
console.log(`\n=== A) integrity_flags CHANGE when scenario.id is opaque: ${flippedId.length} ===`);
for (const r of flippedId) {
  console.log(`  ${r.id} [exp=${r.expected}]`);
  console.log(`     as-is : ${r.flags_asis.join(", ") || "(none)"}`);
  console.log(`     opaque: ${r.flags_opaqueid.join(", ") || "(none)"}`);
}
console.log(`\n=== B) integrity_flags CHANGE when scenario.id AND evidence_id are opaque: ${flippedBoth.length} ===`);
for (const r of flippedBoth) {
  console.log(`  ${r.id} [exp=${r.expected}]`);
  console.log(`     as-is : ${r.flags_asis.join(", ") || "(none)"}`);
  console.log(`     opaque: ${r.flags_opaqueboth.join(", ") || "(none)"}`);
}
if (rows.length !== 106) { console.error(`FAIL: expected 106 scenarios, got ${rows.length}`); process.exit(1); }
const eqf = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const idOnly = rows.filter(r => !eqf(r.flags_asis, r.flags_opaqueid)).map(r => r.id).sort();
const both = rows.filter(r => !eqf(r.flags_asis, r.flags_opaqueboth)).map(r => r.id).sort();
const EXP_ID_ONLY = [
  "air-canada-bereavement-policy-promise-realworld-010",
  "heldout-audit-authorized-adversarial-003",
  "hertz-stolen-vehicle-police-report-high-impact-008",
  "refund-policy-001",
  "secret-rotation-in-vault-adversarial-008",
];
const EXP_BOTH = [...EXP_ID_ONLY, "payment-dispute-001"].sort();
if (!eqf(idOnly, EXP_ID_ONLY)) { console.error("FAIL: id-only set differs", idOnly); process.exit(1); }
if (!eqf(both, EXP_BOTH)) { console.error("FAIL: both-opaque set differs", both); process.exit(1); }
console.log("EXACT SETS PASS: id-only=5, both=6");
fs.writeFileSync(fileURLToPath(new URL("./id-substitution-rows.json", import.meta.url)), JSON.stringify(rows, null, 2));
