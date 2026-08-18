// Mutation tests for the Checkpoint-2 red gate. Each mutation breaks a real
// production path in an isolated repository copy. The gate must stop before
// replacing its prior receipt.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const RECEIPT = "integrity-audit/v2-audit/cp2-red-fixture-receipt.json";
const SENTINEL = "existing reviewed receipt\n";

const copyFixtureTree = () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "sbw-cp2-red-mutation-"));
  for (const relative of [
    "ID_MAP.json",
    "src",
    "scenario-sets/steerbench-work-2026-05",
    "integrity-audit/v2-audit"
  ]) {
    fs.cpSync(path.join(ROOT, relative), path.join(target, relative), { recursive: true });
  }
  fs.writeFileSync(path.join(target, RECEIPT), SENTINEL);
  return target;
};

const assertMutationBlocked = (relative, before, after, expectedMessage) => {
  const target = copyFixtureTree();
  try {
    const file = path.join(target, relative);
    const source = fs.readFileSync(file, "utf8");
    assert.ok(source.includes(before), `mutation target missing in ${relative}`);
    fs.writeFileSync(file, source.replace(before, after));

    const result = spawnSync(process.execPath, ["integrity-audit/v2-audit/cp2-red-fixtures.mjs"], {
      cwd: target,
      encoding: "utf8"
    });
    assert.notEqual(result.status, 0, "known-bad production mutation must fail the red gate");
    assert.match(`${result.stdout}\n${result.stderr}`, expectedMessage);
    assert.equal(fs.readFileSync(path.join(target, RECEIPT), "utf8"), SENTINEL,
      "a failed gate must not replace its existing receipt");
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }
};

test("CP2 gate blocks a descriptive production scenario reference", () => {
  assertMutationBlocked(
    "src/model-input.mjs",
    "return `scenario_ref: ${scenarioIdFor(scenarioId)}\\n\\n${modelInput}`;",
    "return `scenario_ref: ${scenarioId}\\n\\n${modelInput}`;",
    /corrected opacity failures/
  );
});

test("CP2 gate blocks a production scenario lookup that returns its join key", () => {
  assertMutationBlocked(
    "src/id-map.mjs",
    "return scenarioTokenFor(load(), scenarioId);",
    "return scenarioId;",
    /corrected opacity failures/
  );
});

test("CP2 gate blocks a production evidence lookup that returns its join key", () => {
  assertMutationBlocked(
    "src/id-map.mjs",
    "return evidenceTokenFor(load(), scenarioId, evidenceId);",
    "return evidenceId;",
    /corrected evidence identifier leaks/
  );
});
