// Reproduce the exact identifier and hidden-note contamination sets from the
// frozen v1 renderer. Current corrected probes are separate files and assert
// zero movement.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { probeV1Defects } from "./v1-defect-adapter.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SET = path.join(ROOT, "scenario-sets/steerbench-work-2026-05");
const EXPECTED_METADATA = ["_SCENARIO_PATTERNS.json"];
const EXPECTED_ID_ONLY = [
  "air-canada-bereavement-policy-promise-realworld-010",
  "heldout-audit-authorized-adversarial-003",
  "hertz-stolen-vehicle-police-report-high-impact-008",
  "refund-policy-001",
  "secret-rotation-in-vault-adversarial-008"
];
const EXPECTED_BOTH = [...EXPECTED_ID_ONLY, "payment-dispute-001"].sort();
const EXPECTED_HIDDEN = [
  "bing-sydney-conversation-end-refusal-tier-a-016",
  "cursor-line-count-cap-refusal-tier-a-001",
  "migration-rollback-pre-approved-adversarial-007",
  "optum-health-need-cost-proxy-deployment-high-impact-018",
  "permission-scope-001",
  "protected-code-001",
  "samsung-chatgpt-source-code-paste-high-impact-013"
];

const allFiles = fs.readdirSync(SET).filter((file) => file.endsWith(".json")).sort();
const metadata = allFiles.filter((file) => file.startsWith("_"));
if (JSON.stringify(metadata) !== JSON.stringify(EXPECTED_METADATA)) {
  throw new Error(`underscore-json allowlist violated: ${JSON.stringify(metadata)}`);
}
const files = allFiles.filter((file) => !file.startsWith("_"));
if (files.length !== 106) throw new Error(`expected 106 scenarios, found ${files.length}`);
const scenarios = files.map((file) => JSON.parse(fs.readFileSync(path.join(SET, file), "utf8")));
const ids = scenarios.map((scenario) => scenario.id);
if (ids.some((id) => typeof id !== "string" || !id) || new Set(ids).size !== 106) {
  throw new Error("v1 probe requires 106 unique non-empty scenario ids");
}

const result = probeV1Defects(scenarios);
const assertSet = (name, actual, expected) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${name} differs: ${JSON.stringify(actual)}`);
  }
};
assertSet("v1 scenario-id warning set", result.id_only, EXPECTED_ID_ONLY);
assertSet("v1 scenario+evidence-id warning set", result.id_and_evidence, EXPECTED_BOTH);
assertSet("v1 hidden-note warning set", result.hidden_note, EXPECTED_HIDDEN);

fs.writeFileSync(
  fileURLToPath(new URL("./id-substitution-rows-v1.json", import.meta.url)),
  `${JSON.stringify({ id_only: result.id_only, id_and_evidence: result.id_and_evidence, rows: result.rows }, null, 2)}\n`
);
fs.writeFileSync(
  fileURLToPath(new URL("./hidden-trap-rows-v1.json", import.meta.url)),
  `${JSON.stringify({ hidden_note: result.hidden_note, rows: result.rows.filter((row) => row.hidden_note_changes_input) }, null, 2)}\n`
);

console.log("V1 DEFECT PROBE PASS: id-only=5, id+evidence=6, hidden-note=7");
