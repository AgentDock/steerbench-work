// Identifier-opacity probe (v2). Asserts the fixed behaviour that replaced the
// v1 defect: derived surfaces and rendered bytes must not move when source
// identifiers or source-metadata title/raw_ref fields are renamed, and the only
// byte that may move when a mapped token changes is that token.
//
// The v1 defect this replaced (warnings changed on 5 scenarios under scenario-ID
// substitution and 1 more under evidence-ID substitution) is recorded in
// AUDIT.md and frozen in git history at commit 4b5b54c.
//
// Variants:
//   A  source ids and source-only metadata renamed, mapped tokens preserved
//      -> rendered bytes identical
//   B  mapped tokens changed, source ids preserved  -> only the token differs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const { renderUserMessage } = await import(path.join(ROOT, "src/model-input.mjs"));
const { reshapeToLegacy, buildModelInputFor } = await import(path.join(ROOT, "src/canonical-runner.mjs"));
const { opaqueIdResolversForMap } = await import(path.join(ROOT, "src/id-map.mjs"));
const SET = path.join(ROOT, "scenario-sets/steerbench-work-2026-05");
const BASE_MAP = JSON.parse(fs.readFileSync(path.join(ROOT, "ID_MAP.json"), "utf8"));

const allEntries = fs.readdirSync(SET);
const underscoreJson = allEntries.filter((f) => f.endsWith(".json") && f.startsWith("_")).sort();
if (JSON.stringify(underscoreJson) !== JSON.stringify(["_SCENARIO_PATTERNS.json"])) {
  console.error("FAIL: underscore-json allowlist violated:", underscoreJson); process.exit(1);
}
const files = allEntries.filter((f) => f.endsWith(".json") && !f.startsWith("_")).sort();
if (files.length !== 106) { console.error(`FAIL: expected 106 scenario files, found ${files.length}`); process.exit(1); }

const scenarios = [];
const seenIds = new Set();
for (const f of files) {
  const json = JSON.parse(fs.readFileSync(path.join(SET, f), "utf8"));
  if (typeof json.id !== "string" || json.id.length === 0) { console.error(`FAIL: missing/empty/non-string id in ${f}`); process.exit(1); }
  if (seenIds.has(json.id)) { console.error("FAIL: duplicate scenario id", json.id); process.exit(1); }
  seenIds.add(json.id);
  scenarios.push(json);
}

// Variant A map: every source id renamed, every token preserved.
const neutralScenarioIds = new Map(scenarios.map((json, index) => [json.id, `q-${String(index + 1).padStart(4, "0")}`]));
const renamedEvidenceIds = new Map();
const RENAME = (id) => neutralScenarioIds.get(id);
const mapA = { ...BASE_MAP, scenarios: {}, evidence: {} };
for (const [id, token] of Object.entries(BASE_MAP.scenarios)) mapA.scenarios[RENAME(id)] = token;
for (const json of scenarios) {
  const table = BASE_MAP.evidence[json.id] || {};
  const renamed = {};
  const keyMap = new Map();
  for (const [index, item] of (json.evidence || []).entries()) {
    const oldKey = item.legacy_id || item.id;
    const newKey = `r-${String(index + 1).padStart(3, "0")}`;
    keyMap.set(item.id, newKey);
    keyMap.set(oldKey, newKey);
    renamed[newKey] = table[oldKey];
  }
  renamedEvidenceIds.set(json.id, keyMap);
  if (Object.keys(renamed).length) mapA.evidence[RENAME(json.id)] = renamed;
}

// Variant B map: source ids preserved, every token replaced by a fixed marker.
const B_TOKEN = (token) => `${token[0]}-${[...token.slice(2)]
  .map((digit) => (15 - Number.parseInt(digit, 16)).toString(16))
  .join("")}`;
const mapB = { ...BASE_MAP, scenarios: {}, evidence: {} };
for (const [id, token] of Object.entries(BASE_MAP.scenarios)) mapB.scenarios[id] = B_TOKEN(token);
for (const [id, table] of Object.entries(BASE_MAP.evidence)) {
  mapB.evidence[id] = Object.fromEntries(Object.entries(table).map(([k, v]) => [k, B_TOKEN(v)]));
}

const renameScenario = (json) => {
  const copy = structuredClone(json);
  copy.id = RENAME(json.id);
  const keyMap = renamedEvidenceIds.get(json.id);
  for (const [index, item] of (copy.evidence || []).entries()) {
    const newKey = keyMap.get(item.legacy_id || item.id);
    item.id = newKey;
    if (item.legacy_id) item.legacy_id = newKey;
    item.raw_ref = `neutral/reference-${index + 1}.dat`;
    item.title = `Neutral evidence ${index + 1}`;
  }
  if (Array.isArray(copy.decision_point?.evidence_ids)) {
    copy.decision_point.evidence_ids = copy.decision_point.evidence_ids.map((e) => keyMap.get(e));
  }
  return copy;
};

async function renderAll(candidateMap, transform) {
  const { scenarioIdFor, evidenceIdFor } = opaqueIdResolversForMap(candidateMap);
  const out = new Map();
  for (const json of scenarios) {
    const subject = transform ? transform(json) : json;
    const r = buildModelInputFor(reshapeToLegacy(subject), { scenarioIdFor, evidenceIdFor });
    out.set(json.id, {
      input: renderUserMessage({ scenarioId: subject.id, modelInput: r.model_input, scenarioIdFor }),
      flags: r.integrity_flags.slice().sort()
    });
  }
  return out;
}

const base = await renderAll(BASE_MAP, null);
const varA = await renderAll(mapA, renameScenario);
const varB = await renderAll(mapB, null);

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const flagsMovedA = [], bytesMovedA = [], flagsMovedB = [], bytesUnexpectedB = [];
const absentTokensB = [], absentEvidenceTokensB = [];

for (const json of scenarios) {
  const b = base.get(json.id), a = varA.get(json.id), c = varB.get(json.id);
  if (!eq(a.flags, b.flags)) flagsMovedA.push(json.id);
  if (a.input !== b.input) bytesMovedA.push(json.id);
  if (!eq(c.flags, b.flags)) flagsMovedB.push(json.id);
  const baseToken = BASE_MAP.scenarios[json.id];
  const changedToken = B_TOKEN(baseToken);
  if (!b.input.includes(baseToken) || !c.input.includes(changedToken)) absentTokensB.push(json.id);
  for (const [evidenceId, token] of Object.entries(BASE_MAP.evidence[json.id] || {})) {
    if (b.input.includes(token) && !c.input.includes(B_TOKEN(token))) {
      absentEvidenceTokensB.push(`${json.id}/${evidenceId}`);
    }
  }
  // Variant B may differ only by mapped tokens: normalizing every token back
  // must restore the base bytes exactly.
  let normalized = c.input;
  for (const [, token] of Object.entries(BASE_MAP.scenarios)) normalized = normalized.split(B_TOKEN(token)).join(token);
  for (const table of Object.values(BASE_MAP.evidence)) {
    for (const token of Object.values(table)) normalized = normalized.split(B_TOKEN(token)).join(token);
  }
  if (normalized !== b.input) bytesUnexpectedB.push(json.id);
}

// No descriptive source identifier may appear anywhere in a rendered input.
// raw_ref is tested through the origin-sensitive Variant A mutation above,
// rather than by string matching: a selected tool payload may independently
// contain the same decision-relevant path and must remain lossless.
const leaked = [];
for (const json of scenarios) {
  const input = base.get(json.id).input;
  const descriptive = [
    json.id,
    ...(json.evidence || []).flatMap((e) => [e.legacy_id, e.id].filter(Boolean))
  ];
  for (const d of descriptive) if (String(d).length > 3 && input.includes(d)) leaked.push(`${json.id}:${d}`);
}

const rows = {
  flagsMovedA,
  bytesMovedA,
  flagsMovedB,
  absentTokensB,
  absentEvidenceTokensB,
  bytesUnexpectedB,
  leaked
};
fs.writeFileSync(fileURLToPath(new URL("./id-substitution-rows-v2.json", import.meta.url)), `${JSON.stringify(rows, null, 2)}\n`);

let bad = false;
const must = (name, actual) => {
  if (actual.length) { console.error(`FAIL ${name}:`, actual.slice(0, 5), `(${actual.length} total)`); bad = true; }
  else console.log(`PASS ${name}: 0`);
};
must("A: derived flags invariant under source-id rename", flagsMovedA);
must("A: rendered bytes invariant under source-id rename", bytesMovedA);
must("B: derived flags invariant under token change", flagsMovedB);
must("B: old and new mapped tokens occur in the full wire message", absentTokensB);
must("B: every visible evidence token has its mapped replacement", absentEvidenceTokensB);
must("B: only the mapped token differs", bytesUnexpectedB);
must("no descriptive identifier appears in rendered bytes", leaked);
if (bad) process.exit(1);
console.log("IDENTIFIER OPACITY: all invariants hold across 106 scenarios");
