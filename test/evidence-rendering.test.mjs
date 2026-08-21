// Checkpoint-3 evidence-rendering contract tests.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildModelInputFor, reshapeToLegacy } from "../src/canonical-runner.mjs";
import {
  EVIDENCE_RENDER_SCHEMA,
  canonicalJson,
  prepareRuntimeEvidence,
  renderEvidenceRecords
} from "../src/evidence-rendering.mjs";
import { opaqueEvidenceId } from "../src/id-map.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SET = path.join(ROOT, "scenario-sets", "steerbench-work-2026-05");
const files = fs.readdirSync(SET)
  .filter((file) => file.endsWith(".json") && !file.startsWith("_"))
  .sort();

function load(file) {
  return JSON.parse(fs.readFileSync(path.join(SET, file), "utf8"));
}

function selectedSourceRecords(raw) {
  return (raw.decision_point?.evidence_ids || []).map((selectedId) => {
    const matches = (raw.evidence || []).filter(
      (item) => item.id === selectedId || item.legacy_id === selectedId
    );
    assert.equal(matches.length, 1, `${raw.id}/${selectedId} must join exactly once`);
    return matches[0];
  });
}

function parseFencedEvidence(modelInput) {
  const marker = "evidence:\n";
  const start = modelInput.indexOf(marker);
  assert.notEqual(start, -1, "model input must contain one evidence section");
  const end = modelInput.indexOf("\nintegrity:\n", start);
  assert.notEqual(end, -1, "evidence section must end before structured integrity evidence");
  const section = modelInput.slice(start + marker.length, end);
  if (section === "none") return [];
  const matches = [...section.matchAll(/```json\n([^\n]*)\n```/gu)];
  assert.equal(matches.map((match) => match[0]).join("\n"), section);
  return matches.map((match) => JSON.parse(match[1]));
}

test("frozen schema recognizes sixteen keys and suppresses the four opacity fields", () => {
  const properties = EVIDENCE_RENDER_SCHEMA.source_record.properties;
  assert.deepEqual(Object.keys(properties).sort(), [
    "amount_usd",
    "approval_threshold_usd",
    "effective_from",
    "effective_until",
    "evaluation_provenance",
    "id",
    "legacy_id",
    "protected_path_match",
    "raw_ref",
    "source_type",
    "status",
    "supervisor_approval_threshold_months",
    "timezone",
    "title",
    "tool_call_result",
    "value"
  ]);
  assert.deepEqual(
    Object.entries(properties).filter(([, rule]) => !rule.render).map(([key]) => key).sort(),
    ["id", "legacy_id", "raw_ref", "title"]
  );
});

test("all current selected evidence renders exactly once, in selection order, without payload loss", () => {
  assert.equal(files.length, 106);
  const observedSourceKeys = new Set();
  let selectedCount = 0;
  let payloadCount = 0;
  let evidenceRows = 0;

  for (const file of files) {
    const raw = load(file);
    const selected = selectedSourceRecords(raw);
    const modelInput = buildModelInputFor(reshapeToLegacy(raw)).model_input;
    const rendered = parseFencedEvidence(modelInput);
    assert.equal(rendered.length, selected.length, `${raw.id} evidence count changed`);
    if (selected.length) evidenceRows += 1;

    for (let index = 0; index < selected.length; index += 1) {
      const source = selected[index];
      const record = rendered[index];
      selectedCount += 1;
      for (const key of Object.keys(source)) observedSourceKeys.add(key);
      assert.equal(
        record.evidence_ref,
        opaqueEvidenceId(raw.id, source.legacy_id || source.id),
        `${raw.id} evidence order changed at index ${index}`
      );
      for (const hidden of ["id", "legacy_id", "title", "raw_ref"]) {
        assert.equal(Object.hasOwn(record, hidden), false, `${raw.id} rendered forbidden ${hidden}`);
      }
      if (Object.hasOwn(source, "tool_call_result")) {
        payloadCount += 1;
        assert.deepEqual(
          record.tool_call_result,
          source.tool_call_result,
          `${raw.id} tool_call_result changed at index ${index}`
        );
      }
    }
  }

  assert.equal(selectedCount, 351);
  assert.equal(payloadCount, 187);
  assert.equal(evidenceRows, 95);
  assert.deepEqual([...observedSourceKeys].sort(), [
    "amount_usd",
    "approval_threshold_usd",
    "effective_from",
    "effective_until",
    "id",
    "legacy_id",
    "protected_path_match",
    "raw_ref",
    "source_type",
    "status",
    "supervisor_approval_threshold_months",
    "timezone",
    "title",
    "tool_call_result",
    "value"
  ]);
});

test("canonical rendering sorts objects recursively and preserves arrays and primitive types", () => {
  assert.equal(
    canonicalJson({ z: false, a: { z: 0, a: [3, "two", null, true] } }),
    '{"a":{"a":[3,"two",null,true],"z":0},"z":false}'
  );
});

test("nested payload keys are allowed and backticks cannot terminate the JSON fence", () => {
  const source = {
    id: "E01",
    source_type: "tool_call",
    title: "Synthetic receipt",
    status: "current",
    raw_ref: "synthetic/receipt.json",
    tool_call_result: {
      "z`key": { text: "before ```json after", array: [false, 0, "x", null] },
      extra_nested_key: true
    }
  };
  const runtime = prepareRuntimeEvidence([source], ["E01"]);
  const rendered = renderEvidenceRecords({
    scenarioId: "synthetic-scenario",
    evidence: runtime.evidence,
    evidenceIdFor: () => "e-aaaaaaaaaa"
  });
  assert.equal((rendered.match(/```/gu) || []).length, 2);
  assert.ok(rendered.includes("\\u0060"));
  const parsed = JSON.parse(rendered.match(/```json\n([^\n]*)\n```/u)[1]);
  assert.deepEqual(parsed.tool_call_result, source.tool_call_result);
});

test("unknown source keys, wrong types, and malformed provenance fail closed", () => {
  const base = {
    id: "E01",
    source_type: "document",
    title: "Synthetic receipt",
    status: "current",
    raw_ref: "synthetic/receipt.json"
  };
  assert.throws(
    () => prepareRuntimeEvidence([{ ...base, unexpected: true }], ["E01"]),
    /unexpected is not allowed/
  );
  assert.throws(
    () => prepareRuntimeEvidence([{ ...base, status: 1 }], ["E01"]),
    /status must be string/
  );
  assert.throws(
    () => prepareRuntimeEvidence([{
      ...base,
      evaluation_provenance: {
        evaluation_role: "held_out",
        relationship: "evaluated_on",
        assessment: "confirmed",
        extra: true
      }
    }], ["E01"]),
    /evaluation_provenance\.extra is not allowed/
  );
});

test("selection is an exact unique join", () => {
  const record = (id, legacyId) => ({
    id,
    ...(legacyId ? { legacy_id: legacyId } : {}),
    source_type: "document",
    title: id,
    status: "current",
    raw_ref: `${id}.json`
  });
  assert.throws(
    () => prepareRuntimeEvidence([record("E01")], ["E01", "E01"]),
    /appears more than once/
  );
  assert.throws(
    () => prepareRuntimeEvidence([record("E01"), record("E02", "E01")], ["E01"]),
    /alias "E01" is not unique/
  );
  assert.throws(
    () => prepareRuntimeEvidence([record("E01")], ["E99"]),
    /does not resolve exactly/
  );
});
