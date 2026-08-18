// Tests for the preference-pair exporter. Runs the exporter against a real
// canonical run root and checks the Tinker comparison JSONL contract line
// by line: labels are strictly A or B (never Tie), the labeled side always
// holds the trial the benchmark scored correct, completions differ, prompts
// match the canonical render, and the export is deterministic under a
// fixed seed.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { reshapeToLegacy, buildModelInputFor } from "../src/canonical-runner.mjs";
import { renderUserMessage } from "../src/model-input.mjs";
import { parseAndNormalize } from "../src/schema.mjs";
import { isCorrectByPermission } from "../src/scorer.mjs";
import { exportPreferences, LABEL_SOURCE, EXPORTER_VERSION } from "../scripts/export-preferences.mjs";

const runnerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scenarioSetDir = path.join(runnerRoot, "scenario-sets", "steerbench-work-2026-05");
// One completed full-set run root keeps the test fast while still exercising
// real trial files and cross-variant pairing.
const runsDir = path.join(runnerRoot, "runs", "canonical-new-2026-06-07");
const MAX_PAIRS = 6;
const SEED = 1;

// The preference exporter mines real trial files from a canonical run under
// runs/, which is gitignored and therefore absent on a fresh CI checkout. When
// the run is not present these tests skip rather than fail; the SFT exporter
// tests cover the shared render/scoring path from the committed scenario set.
function runExport(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pref-export-test-"));
  const result = exportPreferences({
    runsDir, scenarioSetDir, outDir: dir,
    maxPairsPerScenario: MAX_PAIRS, seed: SEED,
    ...extra
  });
  return { dir, result };
}

const hasRun = fs.existsSync(runsDir);
// The exporter refuses any trial whose recorded user message differs from a
// fresh render, so a run recorded under the v1 descriptive-id prefix yields no
// pairs under v2 opaque rendering. That refusal is the point (exporting it
// would fabricate a prompt the model never saw) and is asserted separately in
// "a run recorded under a different render exports nothing". These
// pair-shape tests need a run recorded under the CURRENT render.
const exportsUnderCurrentRender = hasRun && runExport().result.files.length > 0;
const skip = !hasRun
  ? "requires a local canonical run under runs/ (gitignored; not in CI)"
  : (exportsUnderCurrentRender ? false : "local run was recorded under a different render; see the render-mismatch test");
const maybe = (name, fn) => test(name, { skip }, fn);

let outDir;
let lines;
let provenance;

const trialCache = new Map();
function loadTrial(relPath) {
  if (!trialCache.has(relPath)) {
    trialCache.set(relPath, JSON.parse(fs.readFileSync(path.join(runnerRoot, relPath), "utf8")));
  }
  return trialCache.get(relPath);
}

const renderCache = new Map();
function canonicalUserFor(scenarioId) {
  if (!renderCache.has(scenarioId)) {
    const raw = JSON.parse(fs.readFileSync(path.join(scenarioSetDir, `${scenarioId}.json`), "utf8"));
    const { model_input } = buildModelInputFor(reshapeToLegacy(raw));
    renderCache.set(scenarioId, renderUserMessage({ scenarioId, modelInput: model_input }));
  }
  return renderCache.get(scenarioId);
}

function syntheticFixture({ legacyPrefix = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pref-synthetic-"));
  const scenarioSetDir = path.join(root, "scenario-set");
  const runsDir = path.join(root, "runs");
  const runRoot = path.join(runsDir, "run-001");
  const variantKey = "fixture-variant";
  const scenarioId = "safe-readme-typo-001";
  const cellDir = path.join(runRoot, variantKey, scenarioId);
  const outDir = path.join(root, "out");
  fs.mkdirSync(scenarioSetDir, { recursive: true });
  fs.mkdirSync(cellDir, { recursive: true });

  const raw = JSON.parse(fs.readFileSync(
    path.join(runnerRoot, "scenario-sets", "steerbench-work-2026-05", `${scenarioId}.json`),
    "utf8"
  ));
  fs.writeFileSync(path.join(scenarioSetDir, `${scenarioId}.json`), `${JSON.stringify(raw, null, 2)}\n`);
  const { model_input } = buildModelInputFor(reshapeToLegacy(raw));
  const currentUser = renderUserMessage({ scenarioId, modelInput: model_input });
  const recordedUser = legacyPrefix ? `scenario_id: ${scenarioId}\n\n${model_input}` : currentUser;
  fs.writeFileSync(path.join(runRoot, "RUN_PLAN.json"), `${JSON.stringify({
    scenario_set: path.basename(scenarioSetDir),
    scenario_count: 1,
    planned_variants: [variantKey]
  }, null, 2)}\n`);

  const trial = (number, correct, rawText) => ({
    run_id: "synthetic-run",
    variant_key: variantKey,
    trial: number,
    status: "ok",
    correct,
    expected_action: "continue",
    raw_text: rawText,
    request_body: {
      messages: [
        { role: "system", content: "Synthetic system prompt" },
        { role: "user", content: recordedUser }
      ]
    }
  });
  fs.writeFileSync(path.join(cellDir, "trial-1.json"), `${JSON.stringify(trial(1, true, '{"commit_permission":"allowed"}'), null, 2)}\n`);
  fs.writeFileSync(path.join(cellDir, "trial-2.json"), `${JSON.stringify(trial(2, false, '{"commit_permission":"blocked"}'), null, 2)}\n`);
  return { runsDir, scenarioSetDir, outDir, currentUser };
}


before(() => {
  if (skip) return;
  const { dir, result } = runExport();
  outDir = dir;
  assert.equal(result.files.length, 1);
  lines = fs.readFileSync(result.files[0].jsonlPath, "utf8").split("\n").filter(Boolean);
  provenance = JSON.parse(fs.readFileSync(result.files[0].provenancePath, "utf8"));
  assert.ok(lines.length > 0, "expected at least one pair from the run root");
  assert.equal(lines.length, provenance.length);
});

maybe("every line is a comparison object labeled A or B, never Tie", () => {
  for (const line of lines) {
    const row = JSON.parse(line);
    assert.deepEqual(Object.keys(row), ["comparison", "label"]);
    assert.deepEqual(Object.keys(row.comparison), ["prompt_conversation", "completion_A", "completion_B"]);
    assert.notEqual(row.label, "Tie");
    assert.ok(row.label === "A" || row.label === "B");
    for (const side of [row.comparison.completion_A, row.comparison.completion_B]) {
      assert.equal(side.length, 1);
      assert.equal(side[0].role, "assistant");
      assert.equal(typeof side[0].content, "string");
      assert.ok(side[0].content.length > 0);
    }
  }
});

maybe("completions always differ within a pair", () => {
  for (const line of lines) {
    const { comparison } = JSON.parse(line);
    assert.notEqual(comparison.completion_A[0].content, comparison.completion_B[0].content);
  }
});

maybe("label points at the correct trial, verified against the trial files", () => {
  provenance.forEach((p, i) => {
    const row = JSON.parse(lines[i]);
    const correctTrial = loadTrial(p.correct_trial.path);
    const incorrectTrial = loadTrial(p.incorrect_trial.path);
    assert.equal(correctTrial.status, "ok");
    assert.equal(incorrectTrial.status, "ok");
    assert.equal(correctTrial.correct, true);
    assert.equal(incorrectTrial.correct, false);
    const labeled = row.label === "A" ? row.comparison.completion_A : row.comparison.completion_B;
    const other = row.label === "A" ? row.comparison.completion_B : row.comparison.completion_A;
    assert.equal(labeled[0].content, correctTrial.raw_text);
    assert.equal(other[0].content, incorrectTrial.raw_text);
    assert.equal(p.correct_variant, correctTrial.variant_key);
    assert.equal(p.incorrect_variant, incorrectTrial.variant_key);
    // Re-derive correctness from the raw response text through the scoring
    // pipeline, independent of the stored flag.
    for (const t of [correctTrial, incorrectTrial]) {
      const normalized = parseAndNormalize(t.raw_text);
      assert.equal(isCorrectByPermission(t.expected_action, normalized.commit_permission), t.correct);
    }
  });
});

maybe("prompt conversation matches the canonical scenario render", () => {
  provenance.forEach((p, i) => {
    const { prompt_conversation } = JSON.parse(lines[i]).comparison;
    assert.deepEqual(prompt_conversation.map((m) => m.role), ["system", "user"]);
    assert.equal(prompt_conversation[1].content, canonicalUserFor(p.scenario_id));
  });
});

maybe("provenance rows carry pre-gold honesty fields and respect the cap", () => {
  const perScenario = new Map();
  provenance.forEach((p) => {
    assert.equal(p.label_source, LABEL_SOURCE);
    assert.equal(p.exporter_version, EXPORTER_VERSION);
    assert.ok(p.pair_id.startsWith(`${p.scenario_id}:`));
    perScenario.set(p.scenario_id, (perScenario.get(p.scenario_id) || 0) + 1);
  });
  for (const count of perScenario.values()) {
    assert.ok(count <= MAX_PAIRS);
  }
});

maybe("export is deterministic under a fixed seed", () => {
  const { result } = runExport();
  const again = fs.readFileSync(result.files[0].jsonlPath, "utf8");
  assert.equal(again, fs.readFileSync(path.join(outDir, "all.jsonl"), "utf8"));
  const provAgain = fs.readFileSync(result.files[0].provenancePath, "utf8");
  assert.equal(provAgain, fs.readFileSync(path.join(outDir, "all.provenance.json"), "utf8"));
});

maybe("splits file partitions pairs into per-split JSONL files", () => {
  const scenarioIds = [...new Set(provenance.map((p) => p.scenario_id))].sort();
  assert.ok(scenarioIds.length >= 2, "need at least two paired scenarios to test splits");
  const train = scenarioIds.filter((_, i) => i % 2 === 0);
  const testIds = scenarioIds.filter((_, i) => i % 2 === 1);
  const splitDir = fs.mkdtempSync(path.join(os.tmpdir(), "pref-splits-test-"));
  const splitsPath = path.join(splitDir, "splits.json");
  fs.writeFileSync(splitsPath, JSON.stringify({ train, test: testIds }));

  const { result } = runExport({ splitsPath });
  const bySplit = Object.fromEntries(result.files.map((f) => [f.split, f]));
  assert.deepEqual(Object.keys(bySplit).sort(), ["test", "train"]);
  for (const [split, ids] of [["train", train], ["test", testIds]]) {
    const rows = JSON.parse(fs.readFileSync(bySplit[split].provenancePath, "utf8"));
    for (const p of rows) {
      assert.ok(ids.includes(p.scenario_id));
      assert.equal(p.split, split);
    }
  }
  // Per-scenario sampling is seeded per scenario, so splitting must not
  // change which pairs a scenario exports.
  const unionIds = result.files.flatMap((f) =>
    JSON.parse(fs.readFileSync(f.provenancePath, "utf8")).map((p) => p.pair_id));
  assert.deepEqual(unionIds.sort(), provenance.map((p) => p.pair_id).sort());

  // The assign-splits artifact shape (assignments map) plus --split writes
  // only the named split.
  const assignmentsPath = path.join(splitDir, "assignments.json");
  fs.writeFileSync(assignmentsPath, JSON.stringify({
    assignments: Object.fromEntries(scenarioIds.map((id, i) => [id, i % 2 === 0 ? "train" : "test"]))
  }));
  const { result: only } = runExport({ splitsPath: assignmentsPath, splitName: "train" });
  assert.equal(only.files.length, 1);
  assert.equal(only.files[0].split, "train");
  for (const p of JSON.parse(fs.readFileSync(only.files[0].provenancePath, "utf8"))) {
    assert.ok(train.includes(p.scenario_id));
  }
});

test("a run recorded under a different render exports nothing", { skip: hasRun ? false : "requires a local canonical run under runs/" }, () => {
  const { result } = runExport();
  if (result.files.length > 0) return; // run matches the current render
  assert.equal(result.files.length, 0, "a render mismatch must produce no export files");
  assert.ok((result.counters?.skipped_prompt_mismatch ?? 0) > 0,
    "every trial from a differently-rendered run must be refused as a prompt mismatch");
});

test("synthetic current-render trials export the exact opaque canonical message", () => {
  const fixture = syntheticFixture();
  const result = exportPreferences({
    runsDir: fixture.runsDir,
    scenarioSetDir: fixture.scenarioSetDir,
    outDir: fixture.outDir,
    maxPairsPerScenario: 1,
    seed: 1
  });
  assert.equal(result.files.length, 1);
  assert.equal(result.counters.skipped_prompt_mismatch, 0);
  const [row] = fs.readFileSync(result.files[0].jsonlPath, "utf8").split("\n").filter(Boolean).map(JSON.parse);
  assert.equal(row.comparison.prompt_conversation[1].content, fixture.currentUser);
  assert.match(fixture.currentUser, /^scenario_ref: s-[0-9a-f]{10}\n\n/);
});

test("synthetic descriptive-v1 trials are rejected as prompt mismatches", () => {
  const fixture = syntheticFixture({ legacyPrefix: true });
  const result = exportPreferences({
    runsDir: fixture.runsDir,
    scenarioSetDir: fixture.scenarioSetDir,
    outDir: fixture.outDir,
    maxPairsPerScenario: 1,
    seed: 1
  });
  assert.equal(result.files.length, 0);
  assert.equal(result.counters.trials_scanned, 2);
  assert.equal(result.counters.skipped_prompt_mismatch, 2);
});
