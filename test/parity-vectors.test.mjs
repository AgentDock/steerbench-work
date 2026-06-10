// Tests for the Tinker parity vectors export.
//
// The committed integrations/tinker/parity-vectors.json is the contract the
// Python reward adapter reads. These tests pin that contract against the
// live source of truth: scoring vocabulary against src/schema.mjs and
// src/scorer.mjs, rendered inputs against a fresh run of the render
// pipeline, scenario hashes against the live files, and every response
// parity case against a re-run of the real scorer. Any drift between the
// committed file and the codebase fails here before it can mislead a
// training run.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { reshapeToLegacy, buildModelInputFor } from "../src/canonical-runner.mjs";
import { STEERBENCH_STEERING_SYSTEM_PROMPT } from "../src/prompts.mjs";
import { ALLOWED_COMMIT_PERMISSION, SCORED_FIELD } from "../src/schema.mjs";
import { CANONICAL_SCORING_MAPPING } from "../src/scorer.mjs";
import { sha256File } from "../src/manifest.mjs";
import {
  strictCommitPermission,
  scoreResponseCase,
  LABEL_SOURCE,
  EXPORTER_VERSION
} from "../scripts/generate-parity-vectors.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vectorsPath = path.join(repoRoot, "integrations", "tinker", "parity-vectors.json");

const vectors = JSON.parse(fs.readFileSync(vectorsPath, "utf8"));

test("vectors file carries the required provenance fields", () => {
  assert.equal(vectors.schema_version, "steerbench.tinker_parity_vectors.v1");
  assert.equal(vectors.label_source, "benchmark-owner-pre-gold");
  assert.equal(vectors.label_source, LABEL_SOURCE);
  assert.equal(vectors.exporter_version, EXPORTER_VERSION);
  assert.ok(typeof vectors.generated_at === "string" && vectors.generated_at.length > 0);
  assert.equal(vectors.scenario_set, "steerbench-work-2026-05");
});

test("scoring vocabulary in the file matches the live src exports", () => {
  assert.equal(vectors.scoring_field, SCORED_FIELD);
  assert.deepEqual(vectors.allowed_commit_permission, ALLOWED_COMMIT_PERMISSION);
  assert.deepEqual(vectors.canonical_scoring_mapping, { ...CANONICAL_SCORING_MAPPING });
  assert.equal(vectors.system_prompt, STEERBENCH_STEERING_SYSTEM_PROMPT);
});

test("scenario list is complete, unique, and labeled", () => {
  assert.equal(vectors.scenario_count, vectors.scenarios.length);
  const ids = new Set(vectors.scenarios.map((s) => s.id));
  assert.equal(ids.size, vectors.scenarios.length);
  for (const s of vectors.scenarios) {
    assert.ok(s.expected_action, `${s.id} missing expected_action`);
    assert.equal(
      s.required_commit_permission,
      CANONICAL_SCORING_MAPPING[s.expected_action],
      `${s.id} required_commit_permission disagrees with the canonical mapping`
    );
  }
});

test("scenario hashes match the live scenario files", () => {
  for (const s of vectors.scenarios) {
    const filePath = path.join(repoRoot, vectors.scenario_set_dir, s.file);
    assert.ok(fs.existsSync(filePath), `${s.file} missing from the live set`);
    assert.equal(sha256File(filePath), s.sha256, `${s.id} drifted from the exported hash`);
  }
});

test("every stored user_input matches a fresh render byte for byte", () => {
  for (const s of vectors.scenarios) {
    const rawPath = path.join(repoRoot, vectors.scenario_set_dir, s.file);
    const rawJson = JSON.parse(fs.readFileSync(rawPath, "utf8"));
    const { model_input } = buildModelInputFor(reshapeToLegacy(rawJson));
    assert.equal(
      s.user_input,
      `scenario_id: ${s.id}\n\n${model_input}`,
      `${s.id} rendered input drifted from the exported bytes`
    );
  }
});

test("render pipeline is deterministic across repeated calls", () => {
  const s = vectors.scenarios[0];
  const rawPath = path.join(repoRoot, vectors.scenario_set_dir, s.file);
  const rawJson = JSON.parse(fs.readFileSync(rawPath, "utf8"));
  const first = buildModelInputFor(reshapeToLegacy(rawJson)).model_input;
  const second = buildModelInputFor(reshapeToLegacy(rawJson)).model_input;
  assert.equal(first, second);
});

test("every response parity case replays to the same result through the real scorer", () => {
  const scenarioById = new Map(vectors.scenarios.map((s) => [s.id, s]));
  assert.equal(vectors.response_case_count, vectors.response_cases.length);
  for (const c of vectors.response_cases) {
    const scenario = scenarioById.get(c.scenario_id);
    assert.ok(scenario, `${c.case_id} references unknown scenario ${c.scenario_id}`);
    assert.equal(c.expected_action, scenario.expected_action);
    const replay = scoreResponseCase(c.expected_action, c.response);
    assert.equal(replay.expected_format_ok, c.expected_format_ok, `${c.case_id} format drifted`);
    assert.equal(replay.expected_correct, c.expected_correct, `${c.case_id} correctness drifted`);
  }
});

test("every scenario has gate cases in both directions", () => {
  const caseIds = new Set(vectors.response_cases.map((c) => c.case_id));
  for (const s of vectors.scenarios) {
    for (const permission of ALLOWED_COMMIT_PERMISSION) {
      assert.ok(caseIds.has(`${s.id}::gate-${permission}`), `${s.id} missing gate-${permission} case`);
    }
  }
});

test("strict contract refuses what the benchmark extractor would rescue", () => {
  // The benchmark-side extractor recovers fenced JSON and infers the field
  // from policy_action; the reward contract must not. These two pins keep
  // the divergence intentional rather than accidental.
  assert.equal(strictCommitPermission('```json\n{"commit_permission":"blocked"}\n```'), null);
  assert.equal(strictCommitPermission('{"policy_action":"continue"}'), null);
  assert.equal(strictCommitPermission('{"commit_permission":"blocked"}'), "blocked");
});
