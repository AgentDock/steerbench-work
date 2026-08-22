// Tests for the committed unsigned CP4 recertification artifact.
//
// These checks pin the offline generator to the committed bytes, validate the
// complete 106-row pending shape, freeze all three cohort shells, and ensure
// every runtime-loaded JSON contract is included in the package allowlist.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  ADAPTATION_RECORDS,
  AUTHORITY_RECORD_IDS,
  EXPECTED_SCENARIO_IDS,
  PROVISIONAL_RECORDS,
  canonicalizeCp4Recertification,
  validateCp4Recertification
} from "../src/cp4-recertification.mjs";
import {
  generateCp4RecertificationArtifact
} from "../scripts/generate-cp4-recertification.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ARTIFACT_PATH = path.join(ROOT, "CP4_RECERTIFICATION.json");
const GENERATOR_PATH = path.join(ROOT, "scripts/generate-cp4-recertification.mjs");
const PACKAGE_PATH = path.join(ROOT, "package.json");

test("pending CP4 regeneration is deterministic and byte-identical", () => {
  const first = generateCp4RecertificationArtifact();
  const second = generateCp4RecertificationArtifact();
  const committedBytes = fs.readFileSync(ARTIFACT_PATH, "utf8");

  assert.equal(first.bytes, second.bytes);
  assert.equal(first.bytes, committedBytes);
  assert.equal(committedBytes.endsWith("\n"), true);
  assert.equal(committedBytes.endsWith("\n\n"), false);

  const committedArtifact = JSON.parse(committedBytes);
  assert.deepEqual(validateCp4Recertification(committedArtifact), committedArtifact);
  assert.equal(
    committedBytes,
    `${canonicalizeCp4Recertification(committedArtifact)}\n`
  );
});

test("committed pending artifact has the exact 106 IDs and cohort shells", () => {
  const artifact = JSON.parse(fs.readFileSync(ARTIFACT_PATH, "utf8"));
  assert.equal(artifact.status, "pending_owner_recertification");
  assert.equal(artifact.signature_envelope, null);
  assert.equal(artifact.scenario_count, 106);
  assert.equal(artifact.records.length, 106);
  assert.deepEqual(
    artifact.records.map((record) => record.scenario_id),
    EXPECTED_SCENARIO_IDS
  );

  assert.deepEqual(
    artifact.records
      .filter((record) => record.authority_review !== null)
      .map((record) => record.scenario_id),
    AUTHORITY_RECORD_IDS
  );
  assert.deepEqual(
    artifact.records
      .filter((record) => record.adaptation_license !== null)
      .map((record) => record.scenario_id),
    Object.keys(ADAPTATION_RECORDS).sort()
  );
  assert.deepEqual(
    Object.fromEntries(artifact.records
      .filter((record) => record.provisional_review !== null)
      .map((record) => [
        record.scenario_id,
        record.provisional_review.kind
      ])),
    PROVISIONAL_RECORDS
  );
});

test("generator accepts only one explicit --out argument", (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cp4-artifact-"));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const outPath = path.join(temporaryRoot, "pending.json");

  const generated = spawnSync(
    process.execPath,
    [GENERATOR_PATH, "--out", outPath],
    { cwd: ROOT, encoding: "utf8" }
  );
  assert.equal(generated.status, 0, generated.stderr);
  assert.equal(
    fs.readFileSync(outPath, "utf8"),
    fs.readFileSync(ARTIFACT_PATH, "utf8")
  );

  const missingOut = spawnSync(
    process.execPath,
    [GENERATOR_PATH],
    { cwd: ROOT, encoding: "utf8" }
  );
  assert.notEqual(missingOut.status, 0);
  assert.match(missingOut.stderr, /--out <file> is required/u);

  const unknown = spawnSync(
    process.execPath,
    [GENERATOR_PATH, "--output", outPath],
    { cwd: ROOT, encoding: "utf8" }
  );
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /unknown argument --output/u);
});

test("package allowlist includes every runtime-loaded CP4 contract", () => {
  const packageManifest = JSON.parse(fs.readFileSync(PACKAGE_PATH, "utf8"));
  const requiredArtifacts = [
    "HISTORICAL_V1_SHORTCUT_ROWS.json",
    "CP4_RECERTIFICATION_SCHEMA.json",
    "CP4_RECERTIFICATION.json"
  ];
  for (const artifact of requiredArtifacts) {
    assert.equal(
      packageManifest.files.includes(artifact),
      true,
      `${artifact} is missing from package.json files`
    );
    assert.equal(
      fs.statSync(path.join(ROOT, artifact)).isFile(),
      true,
      `${artifact} is not a runtime file`
    );
  }
});
