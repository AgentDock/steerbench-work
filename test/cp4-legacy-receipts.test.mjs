// Complete-CP4 legacy-cohort source-receipt enforcement tests.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  LEGACY_MIGRATION_RULE_ARTIFACT,
  LEGACY_SCENARIO_IDS,
  loadAndValidateLegacyMigrationRule
} from "../src/cp4-legacy-migration-rule.mjs";
import {
  createPendingCp4Recertification,
  validateCp4Recertification
} from "../src/cp4-recertification.mjs";
import {
  ACTIVATED_CP4_TEST_ROOT,
  activationTestReceipt,
  createCompleteActivationTestCp4,
  signActivationTestCp4
} from "./cp4-activation-fixture.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LEGACY_SCENARIO_ID_SET = new Set(LEGACY_SCENARIO_IDS);

function validateCompleteArtifact(artifact, repositoryRoot = ACTIVATED_CP4_TEST_ROOT) {
  return validateCp4Recertification(
    artifact,
    { repositoryRoot }
  );
}

function rowById(artifact, scenarioId) {
  const record = artifact.records.find((candidate) => candidate.scenario_id === scenarioId);
  assert.ok(record, "fixture must contain " + scenarioId);
  return record;
}

function sortReceipts(receipts) {
  receipts.sort((left, right) => left.artifact < right.artifact ? -1 : 1);
}

function ensureExactReceipt(receipts, expectedReceipt) {
  if (!receipts.some((receipt) => receipt.artifact === expectedReceipt.artifact
    && receipt.sha256 === expectedReceipt.sha256)) {
    receipts.push({ ...expectedReceipt });
  }
}

function completeArtifactWithLegacyReceipts(repositoryRoot = ACTIVATED_CP4_TEST_ROOT) {
  const artifact = createCompleteActivationTestCp4({ repositoryRoot });
  const { rule, receipt: ruleReceipt } = loadAndValidateLegacyMigrationRule(repositoryRoot);
  for (let index = 0; index < LEGACY_SCENARIO_IDS.length; index += 1) {
    const scenarioId = LEGACY_SCENARIO_IDS[index];
    const receipts = rowById(artifact, scenarioId).source_receipts;
    ensureExactReceipt(receipts, rule.source_cohort.source_receipts[index]);
    ensureExactReceipt(receipts, ruleReceipt);
    sortReceipts(receipts);
  }
  return signActivationTestCp4(artifact);
}

function cloneActivatedRepository(t) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cp4-receipt-alias-"));
  const repositoryRoot = path.join(temporaryRoot, "repository");
  fs.cpSync(ACTIVATED_CP4_TEST_ROOT, repositoryRoot, { recursive: true });
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  return repositoryRoot;
}

function copyReceiptToAlias(repositoryRoot, sourceArtifact, aliasArtifact) {
  const aliasPath = path.join(repositoryRoot, aliasArtifact);
  fs.mkdirSync(path.dirname(aliasPath), { recursive: true });
  fs.copyFileSync(path.join(repositoryRoot, sourceArtifact), aliasPath);
  return activationTestReceipt(aliasArtifact, repositoryRoot);
}

function removeExactReceipt(receipts, expectedReceipt) {
  const index = receipts.findIndex((receipt) => receipt.artifact === expectedReceipt.artifact
    && receipt.sha256 === expectedReceipt.sha256);
  assert.notEqual(index, -1, "fixture must contain the receipt being removed");
  receipts.splice(index, 1);
}

test("complete validation accepts all eleven exact legacy row and rule receipts", () => {
  const artifact = completeArtifactWithLegacyReceipts();
  const { rule, receipt: ruleReceipt } = loadAndValidateLegacyMigrationRule(ROOT);

  assert.doesNotThrow(() => validateCompleteArtifact(artifact));
  for (let index = 0; index < LEGACY_SCENARIO_IDS.length; index += 1) {
    const record = rowById(artifact, LEGACY_SCENARIO_IDS[index]);
    assert.ok(record.source_receipts.some(
      (receipt) => receipt.artifact === rule.source_cohort.source_receipts[index].artifact
        && receipt.sha256 === rule.source_cohort.source_receipts[index].sha256
    ));
    assert.ok(record.source_receipts.some(
      (receipt) => receipt.artifact === ruleReceipt.artifact
        && receipt.sha256 === ruleReceipt.sha256
    ));
    assert.ok(record.source_receipts.length > 2, "additional receipts remain allowed");
  }
});

test("complete validation rejects a missing authored-row receipt", () => {
  const artifact = completeArtifactWithLegacyReceipts();
  const { rule } = loadAndValidateLegacyMigrationRule(ROOT);
  removeExactReceipt(
    rowById(artifact, LEGACY_SCENARIO_IDS[0]).source_receipts,
    rule.source_cohort.source_receipts[0]
  );
  signActivationTestCp4(artifact);

  assert.throws(
    () => validateCompleteArtifact(artifact),
    /must contain the exact authored-row receipt/
  );
});

test("complete validation rejects a stale authored-row hash", () => {
  const artifact = completeArtifactWithLegacyReceipts();
  const { rule } = loadAndValidateLegacyMigrationRule(ROOT);
  const receipt = rowById(artifact, LEGACY_SCENARIO_IDS[0]).source_receipts.find(
    (candidate) => candidate.artifact === rule.source_cohort.source_receipts[0].artifact
  );
  assert.ok(receipt, "fixture must contain the authored-row receipt");
  receipt.sha256 = "0".repeat(64);
  signActivationTestCp4(artifact);

  assert.throws(() => validateCompleteArtifact(artifact), /SHA-256 mismatch/);
});

test("complete validation rejects a missing exact rule receipt", () => {
  const artifact = completeArtifactWithLegacyReceipts();
  const { receipt: ruleReceipt } = loadAndValidateLegacyMigrationRule(ROOT);
  removeExactReceipt(
    rowById(artifact, LEGACY_SCENARIO_IDS[0]).source_receipts,
    ruleReceipt
  );
  signActivationTestCp4(artifact);

  assert.throws(
    () => validateCompleteArtifact(artifact),
    /must contain the exact LEGACY_MIGRATION_RULE\.json receipt/
  );
});

test("complete validation rejects a wrong rule hash", () => {
  const artifact = completeArtifactWithLegacyReceipts();
  const record = rowById(artifact, LEGACY_SCENARIO_IDS[0]);
  const ruleReceipt = record.source_receipts.find(
    (receipt) => receipt.artifact === LEGACY_MIGRATION_RULE_ARTIFACT
  );
  assert.ok(ruleReceipt, "fixture must contain the rule receipt");
  ruleReceipt.sha256 = "0".repeat(64);
  signActivationTestCp4(artifact);

  assert.throws(() => validateCompleteArtifact(artifact), /SHA-256 mismatch/);
});

test("complete validation forbids the rule artifact outside the exact cohort", () => {
  const artifact = completeArtifactWithLegacyReceipts();
  const { receipt: ruleReceipt } = loadAndValidateLegacyMigrationRule(ROOT);
  const outsideRecord = artifact.records.find(
    (record) => !LEGACY_SCENARIO_ID_SET.has(record.scenario_id)
  );
  assert.ok(outsideRecord, "fixture must include a record outside the legacy cohort");
  outsideRecord.source_receipts.push(ruleReceipt);
  signActivationTestCp4(artifact);

  assert.throws(
    () => validateCompleteArtifact(artifact),
    /must not contain LEGACY_MIGRATION_RULE\.json outside the exact legacy cohort/
  );
});

test("complete validation forbids a wrong-hash rule artifact outside the cohort", () => {
  const artifact = completeArtifactWithLegacyReceipts();
  const outsideRecord = artifact.records.find(
    (record) => !LEGACY_SCENARIO_ID_SET.has(record.scenario_id)
  );
  assert.ok(outsideRecord, "fixture must include a record outside the legacy cohort");
  outsideRecord.source_receipts.push({
    artifact: LEGACY_MIGRATION_RULE_ARTIFACT,
    sha256: "0".repeat(64)
  });
  signActivationTestCp4(artifact);

  assert.throws(
    () => validateCompleteArtifact(artifact),
    /must not contain LEGACY_MIGRATION_RULE\.json outside the exact legacy cohort/
  );
});

test("complete validation recursively forbids nested rule receipts outside the cohort", () => {
  const artifact = completeArtifactWithLegacyReceipts();
  const outsideRecord = artifact.records.find(
    (record) => !LEGACY_SCENARIO_ID_SET.has(record.scenario_id)
  );
  assert.ok(outsideRecord, "fixture must include a record outside the legacy cohort");
  outsideRecord.ordinary_authority.source_receipts.unshift({
    artifact: LEGACY_MIGRATION_RULE_ARTIFACT,
    sha256: "0".repeat(64)
  });
  signActivationTestCp4(artifact);

  assert.throws(
    () => validateCompleteArtifact(artifact),
    (error) => {
      assert.match(error.message, /ordinary_authority\.source_receipts\[0\]/);
      assert.match(
        error.message,
        /must not contain LEGACY_MIGRATION_RULE\.json outside the exact legacy cohort/
      );
      return true;
    }
  );
});

test("complete validation forbids a nested rule receipt inside a legacy cohort row", () => {
  const artifact = completeArtifactWithLegacyReceipts();
  const { receipt: ruleReceipt } = loadAndValidateLegacyMigrationRule(ROOT);
  const record = rowById(artifact, LEGACY_SCENARIO_IDS[0]);
  record.ordinary_authority.source_receipts.unshift({ ...ruleReceipt });
  signActivationTestCp4(artifact);

  assert.throws(
    () => validateCompleteArtifact(artifact),
    (error) => {
      assert.match(error.message, /ordinary_authority\.source_receipts\[0\]/);
      assert.match(
        error.message,
        /legacy cohort records permit it only in top-level source_receipts/
      );
      return true;
    }
  );
});

test("complete validation reserves exact rule bytes copied to a nested alias", (t) => {
  const repositoryRoot = cloneActivatedRepository(t);
  const artifact = completeArtifactWithLegacyReceipts(repositoryRoot);
  const aliasReceipt = copyReceiptToAlias(
    repositoryRoot,
    LEGACY_MIGRATION_RULE_ARTIFACT,
    "aliases/rule-alias.json"
  );
  const outsideRecord = artifact.records.find(
    (record) => !LEGACY_SCENARIO_ID_SET.has(record.scenario_id)
  );
  assert.ok(outsideRecord, "fixture must include a record outside the legacy cohort");
  outsideRecord.ordinary_authority.source_receipts = [aliasReceipt];
  signActivationTestCp4(artifact);

  assert.throws(
    () => validateCompleteArtifact(artifact, repositoryRoot),
    (error) => {
      assert.match(error.message, /ordinary_authority\.source_receipts\[0\]/);
      assert.match(
        error.message,
        /reserved legacy rule receipt must use canonical artifact LEGACY_MIGRATION_RULE\.json/
      );
      return true;
    }
  );
});

test("complete validation forbids the matching authored row receipt when nested", () => {
  const artifact = completeArtifactWithLegacyReceipts();
  const { rule } = loadAndValidateLegacyMigrationRule(ROOT);
  const record = rowById(artifact, LEGACY_SCENARIO_IDS[0]);
  record.model_visible_evidence.source_receipts.unshift({
    ...rule.source_cohort.source_receipts[0]
  });
  signActivationTestCp4(artifact);

  assert.throws(
    () => validateCompleteArtifact(artifact),
    (error) => {
      assert.match(error.message, /model_visible_evidence\.source_receipts\[0\]/);
      assert.match(
        error.message,
        /matching legacy cohort record permits it only in top-level source_receipts/
      );
      return true;
    }
  );
});

test("complete validation reserves exact authored-row bytes copied to a nested alias", (t) => {
  const repositoryRoot = cloneActivatedRepository(t);
  const artifact = completeArtifactWithLegacyReceipts(repositoryRoot);
  const { rule } = loadAndValidateLegacyMigrationRule(repositoryRoot);
  const authoredReceipt = rule.source_cohort.source_receipts[0];
  const aliasReceipt = copyReceiptToAlias(
    repositoryRoot,
    authoredReceipt.artifact,
    "aliases/authored-row-alias.json"
  );
  const record = rowById(artifact, LEGACY_SCENARIO_IDS[0]);
  record.model_visible_evidence.source_receipts = [aliasReceipt];
  signActivationTestCp4(artifact);

  assert.throws(
    () => validateCompleteArtifact(artifact, repositoryRoot),
    (error) => {
      assert.match(error.message, /model_visible_evidence\.source_receipts\[0\]/);
      assert.match(
        error.message,
        /reserved authored-row receipt must use its canonical scenario artifact/
      );
      return true;
    }
  );
});

test("complete validation forbids cross-row legacy authored receipt reuse", () => {
  const artifact = completeArtifactWithLegacyReceipts();
  const { rule } = loadAndValidateLegacyMigrationRule(ROOT);
  const targetRecord = rowById(artifact, LEGACY_SCENARIO_IDS[1]);
  targetRecord.source_receipts.push({ ...rule.source_cohort.source_receipts[0] });
  sortReceipts(targetRecord.source_receipts);
  signActivationTestCp4(artifact);

  assert.throws(
    () => validateCompleteArtifact(artifact),
    /must not contain reserved authored-row receipt.*outside its matching legacy cohort record/
  );
});

test("complete validation forbids legacy authored receipts in non-cohort rows", () => {
  const artifact = completeArtifactWithLegacyReceipts();
  const { rule } = loadAndValidateLegacyMigrationRule(ROOT);
  const outsideRecord = artifact.records.find(
    (record) => !LEGACY_SCENARIO_ID_SET.has(record.scenario_id)
  );
  assert.ok(outsideRecord, "fixture must include a record outside the legacy cohort");
  outsideRecord.source_receipts.push({ ...rule.source_cohort.source_receipts[0] });
  sortReceipts(outsideRecord.source_receipts);
  signActivationTestCp4(artifact);

  assert.throws(
    () => validateCompleteArtifact(artifact),
    /must not contain reserved authored-row receipt.*outside its matching legacy cohort record/
  );
});

test("pending blank cohort shells validate without loading legacy receipts", () => {
  const artifact = createPendingCp4Recertification();
  assert.doesNotThrow(() => validateCp4Recertification(artifact));
  for (const scenarioId of LEGACY_SCENARIO_IDS) {
    assert.deepEqual(rowById(artifact, scenarioId).source_receipts, []);
  }
});

test("legacy receipt enforcement cannot be spoofed by matching receipt counts", () => {
  const artifact = completeArtifactWithLegacyReceipts();
  const { rule, receipt: ruleReceipt } = loadAndValidateLegacyMigrationRule(ROOT);
  const authoredReceipts = rule.source_cohort.source_receipts;

  for (let index = 0; index < LEGACY_SCENARIO_IDS.length; index += 1) {
    const record = rowById(artifact, LEGACY_SCENARIO_IDS[index]);
    removeExactReceipt(record.source_receipts, authoredReceipts[index]);
    record.source_receipts.push(
      authoredReceipts[(index + 1) % authoredReceipts.length]
    );
    sortReceipts(record.source_receipts);
  }
  signActivationTestCp4(artifact);

  assert.equal(
    artifact.records.flatMap((record) => record.source_receipts)
      .filter((receipt) => receipt.artifact === ruleReceipt.artifact
        && receipt.sha256 === ruleReceipt.sha256).length,
    LEGACY_SCENARIO_IDS.length
  );
  assert.equal(
    artifact.records.filter((record) => LEGACY_SCENARIO_ID_SET.has(record.scenario_id))
      .filter((record) => record.source_receipts.some(
        (receipt) => receipt.artifact.startsWith("scenario-sets/")
      )).length,
    LEGACY_SCENARIO_IDS.length
  );
  assert.throws(
    () => validateCompleteArtifact(artifact),
    /must not contain reserved authored-row receipt.*outside its matching legacy cohort record/
  );
});

test("complete legacy records may carry additional valid receipts", () => {
  const artifact = completeArtifactWithLegacyReceipts();
  rowById(artifact, LEGACY_SCENARIO_IDS[0]).source_receipts.push(
    activationTestReceipt("CP4_RECERTIFICATION_SCHEMA.json")
  );
  sortReceipts(rowById(artifact, LEGACY_SCENARIO_IDS[0]).source_receipts);
  signActivationTestCp4(artifact);

  assert.doesNotThrow(() => validateCompleteArtifact(artifact));
});
