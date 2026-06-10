// Tests for the SFT exporter. Runs the exporter against the real scenario
// set and checks the Tinker cookbook JSONL contract line by line, plus the
// provenance sidecar and split filtering.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { ALLOWED_COMMIT_PERMISSION, ALLOWED_POLICY_ACTIONS, ALLOWED_CLARIFICATION_MODE } from "../src/schema.mjs";
import { CANONICAL_SCORING_MAPPING } from "../src/scorer.mjs";
import { exportSft, goldResponseFor, LABEL_SOURCE, EXPORTER_VERSION } from "../scripts/export-sft.mjs";

const runnerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scenarioSetDir = path.join(runnerRoot, "scenario-sets", "steerbench-work-2026-05");

const expectedCount = fs.readdirSync(scenarioSetDir, { withFileTypes: true })
  .filter((e) => e.isFile() && e.name.endsWith(".json") && !e.name.startsWith("_"))
  .length;

let outDir;
let lines;
let provenance;

before(() => {
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), "sft-export-test-"));
  const result = exportSft({ scenarioSetDir, outDir });
  lines = fs.readFileSync(result.jsonlPath, "utf8").split("\n").filter(Boolean);
  provenance = JSON.parse(fs.readFileSync(result.provenancePath, "utf8"));
});

test("exports one JSONL row per scenario file", () => {
  assert.equal(lines.length, expectedCount);
  assert.equal(provenance.length, expectedCount);
});

test("every line is a bare messages object with system/user/assistant in order", () => {
  for (const line of lines) {
    const row = JSON.parse(line);
    assert.deepEqual(Object.keys(row), ["messages"]);
    assert.equal(row.messages.length, 3);
    assert.deepEqual(row.messages.map((m) => m.role), ["system", "user", "assistant"]);
    for (const m of row.messages) {
      assert.deepEqual(Object.keys(m).sort(), ["content", "role"]);
      assert.equal(typeof m.content, "string");
      assert.ok(m.content.length > 0);
    }
  }
});

test("assistant content is schema-valid gold JSON", () => {
  for (const line of lines) {
    const gold = JSON.parse(JSON.parse(line).messages[2].content);
    assert.ok(ALLOWED_COMMIT_PERMISSION.includes(gold.commit_permission));
    assert.ok(ALLOWED_POLICY_ACTIONS.includes(gold.policy_action));
    assert.ok(ALLOWED_CLARIFICATION_MODE.includes(gold.clarification_mode));
    assert.equal(typeof gold.human_required, "boolean");
    assert.equal(typeof gold.confidence, "number");
    assert.equal(typeof gold.reason, "string");
    assert.ok(!gold.reason.includes("\n"));
  }
});

test("gold commit_permission matches the canonical scoring mapping per scenario", () => {
  const byId = new Map(provenance.map((row, i) => [row.scenario_id, JSON.parse(lines[i])]));
  for (const entry of fs.readdirSync(scenarioSetDir)) {
    if (!entry.endsWith(".json") || entry.startsWith("_")) continue;
    const raw = JSON.parse(fs.readFileSync(path.join(scenarioSetDir, entry), "utf8"));
    const gold = JSON.parse(byId.get(raw.id).messages[2].content);
    assert.equal(gold.commit_permission, CANONICAL_SCORING_MAPPING[raw.expected_behavior.correct_action]);
  }
});

test("provenance rows carry the pre-gold label source and verifiable hashes", () => {
  provenance.forEach((row, i) => {
    assert.equal(row.label_source, LABEL_SOURCE);
    assert.equal(row.exporter_version, EXPORTER_VERSION);
    assert.equal(row.split, null);
    assert.equal(typeof row.scenario_id, "string");
    assert.match(row.scenario_sha256, /^[0-9a-f]{64}$/);
    const lineHash = createHash("sha256").update(lines[i], "utf8").digest("hex");
    assert.equal(row.render_sha256, lineHash);
  });
});

test("splits file filters rows and stamps the split name", () => {
  const ids = provenance.slice(0, 3).map((r) => r.scenario_id);
  const splitDir = fs.mkdtempSync(path.join(os.tmpdir(), "sft-split-test-"));
  const splitsPath = path.join(splitDir, "splits.json");
  fs.writeFileSync(splitsPath, JSON.stringify({ train: ids, val: [] }));
  const result = exportSft({ scenarioSetDir, splitsPath, splitName: "train", outDir: splitDir });
  assert.equal(result.rows, 3);
  const rows = JSON.parse(fs.readFileSync(result.provenancePath, "utf8"));
  assert.deepEqual(rows.map((r) => r.scenario_id).sort(), [...ids].sort());
  for (const row of rows) assert.equal(row.split, "train");
});

test("splits file in assignment-artifact shape is accepted", () => {
  const ids = provenance.slice(0, 4).map((r) => r.scenario_id);
  const splitDir = fs.mkdtempSync(path.join(os.tmpdir(), "sft-split-artifact-"));
  const splitsPath = path.join(splitDir, "splits.json");
  const assignments = Object.fromEntries(
    provenance.map((r) => [r.scenario_id, ids.includes(r.scenario_id) ? "val" : "train"])
  );
  fs.writeFileSync(splitsPath, JSON.stringify({ artifact_kind: "split-assignment", assignments }));
  const result = exportSft({ scenarioSetDir, splitsPath, splitName: "val", outDir: splitDir });
  assert.equal(result.rows, 4);
  const rows = JSON.parse(fs.readFileSync(result.provenancePath, "utf8"));
  assert.deepEqual(rows.map((r) => r.scenario_id).sort(), [...ids].sort());
  for (const row of rows) assert.equal(row.split, "val");
  assert.throws(
    () => exportSft({ scenarioSetDir, splitsPath, splitName: "holdout", outDir: splitDir }),
    /not found/
  );
});

test("unknown split ids fail loudly", () => {
  const splitDir = fs.mkdtempSync(path.join(os.tmpdir(), "sft-split-bad-"));
  const splitsPath = path.join(splitDir, "splits.json");
  fs.writeFileSync(splitsPath, JSON.stringify({ train: ["no-such-scenario-id"] }));
  assert.throws(
    () => exportSft({ scenarioSetDir, splitsPath, splitName: "train", outDir: splitDir }),
    /missing from scenario set/
  );
});

test("goldResponseFor rejects unmapped correct_action values", () => {
  assert.throws(() => goldResponseFor({ correct_action: "self_destruct" }), /no canonical scoring mapping/);
  assert.throws(() => goldResponseFor(undefined), /no canonical scoring mapping/);
});
