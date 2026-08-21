// Checkpoint-3 input-confidence opacity tests. Output confidence remains part
// of the model response schema; authored scenario confidence is never input.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { reshapeToLegacy } from "../src/canonical-runner.mjs";
import { inputForModel, renderUserMessage } from "../src/model-input.mjs";
import { ActionGateway, WorkerAgent } from "../src/policies.mjs";
import { STEERBENCH_STEERING_SYSTEM_PROMPT } from "../src/prompts.mjs";
import { parseAndNormalize } from "../src/schema.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SET = path.join(ROOT, "scenario-sets", "steerbench-work-2026-05");
const files = fs.readdirSync(SET)
  .filter((file) => file.endsWith(".json") && !file.startsWith("_"))
  .sort();

function load(file) {
  return JSON.parse(fs.readFileSync(path.join(SET, file), "utf8"));
}

function snapshot(raw) {
  const scenario = reshapeToLegacy(raw);
  const action = new WorkerAgent({ scenario }).proposeAction();
  const preflight = new ActionGateway({
    scenario,
    runId: "confidence-opacity-test",
    mode: "structured_steering"
  }).preflight({ action, timeMs: 132000 });
  const modelInput = inputForModel({
    scenario,
    event: preflight.event,
    evidence: preflight.evidence,
    mode: "structured_steering"
  });
  return {
    action,
    event: preflight.event,
    decision: preflight.decision,
    authorization: preflight.authorization,
    wire: renderUserMessage({ scenarioId: raw.id, modelInput }),
    prompt: STEERBENCH_STEERING_SYSTEM_PROMPT
  };
}

function withDecisionConfidence(raw, value, remove = false) {
  const copy = structuredClone(raw);
  copy.decision_point = { ...(copy.decision_point || {}) };
  if (remove) delete copy.decision_point.confidence;
  else copy.decision_point.confidence = value;
  return copy;
}

function withLegacyConfidence(raw, value, remove = false) {
  const copy = structuredClone(raw);
  copy.metadata = { ...(copy.metadata || {}) };
  copy.metadata.legacy_action = { ...(copy.metadata.legacy_action || {}) };
  if (remove) delete copy.metadata.legacy_action.confidence;
  else copy.metadata.legacy_action.confidence = value;
  return copy;
}

function withBothConfidences(raw, value, remove = false) {
  return withLegacyConfidence(withDecisionConfidence(raw, value, remove), value, remove);
}

test("all 106 rows are invariant to each authored confidence channel alone and jointly", () => {
  assert.equal(files.length, 106);
  const values = [0, 0.75, 1];
  for (const file of files) {
    const raw = load(file);
    const baseline = snapshot(raw);
    assert.equal(Object.hasOwn(baseline.action, "confidence"), false, `${raw.id} action leaked confidence`);
    assert.equal(Object.hasOwn(baseline.event, "confidence"), false, `${raw.id} event leaked confidence`);
    assert.doesNotMatch(baseline.wire, /^confidence:/mu);
    assert.doesNotMatch(baseline.wire, /medium_or_low_confidence/u);

    for (const value of values) {
      assert.deepEqual(snapshot(withDecisionConfidence(raw, value)), baseline, `${raw.id} decision confidence ${value}`);
      assert.deepEqual(snapshot(withLegacyConfidence(raw, value)), baseline, `${raw.id} legacy confidence ${value}`);
      assert.deepEqual(snapshot(withBothConfidences(raw, value)), baseline, `${raw.id} joint confidence ${value}`);
    }
    assert.deepEqual(snapshot(withDecisionConfidence(raw, null, true)), baseline, `${raw.id} decision confidence deletion`);
    assert.deepEqual(snapshot(withLegacyConfidence(raw, null, true)), baseline, `${raw.id} legacy confidence deletion`);
    assert.deepEqual(snapshot(withBothConfidences(raw, null, true)), baseline, `${raw.id} joint confidence deletion`);
  }
});

test("prompt retains response confidence without input-confidence semantics", () => {
  assert.match(STEERBENCH_STEERING_SYSTEM_PROMPT, /"confidence":0\.0/u);
  assert.doesNotMatch(STEERBENCH_STEERING_SYSTEM_PROMPT, /low-confidence|high-confidence/u);
  assert.doesNotMatch(
    STEERBENCH_STEERING_SYSTEM_PROMPT,
    /Allowed state_to_show values:[^\n]*confidence/u
  );
  const normalized = parseAndNormalize('{"commit_permission":"allowed","confidence":0.83}');
  assert.equal(normalized.confidence, 0.83);
});
