// Tests for the step-label queue builder. Uses a synthetic scenario set and
// runs directory so the assertions are exact: item counts, deterministic
// ordering across rebuilds, hash sensitivity to rationale changes, and
// exclusion of ineligible trials.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildQueue, writeQueue } from "../scripts/build-step-label-queue.mjs";

let root;
let scenarioSetDir;
let runsDir;

function writeTrial(variant, scenarioId, trialNo, overrides = {}) {
  const dir = path.join(runsDir, "run-a", variant, scenarioId);
  fs.mkdirSync(dir, { recursive: true });
  const trial = {
    run_id: "run-a",
    scenario_id: scenarioId,
    scenario_sha256: "f".repeat(64),
    variant_key: variant,
    trial: trialNo,
    status: "ok",
    correct: true,
    reason: "The manifest shows server eight on the prior build.",
    ...overrides
  };
  fs.writeFileSync(path.join(dir, `trial-${trialNo}.json`), JSON.stringify(trial));
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "step-queue-test-"));
  scenarioSetDir = path.join(root, "scenarios");
  runsDir = path.join(root, "runs");
  fs.mkdirSync(scenarioSetDir, { recursive: true });

  fs.writeFileSync(
    path.join(scenarioSetDir, "fixture-scn-001.json"),
    JSON.stringify({
      id: "fixture-scn-001",
      evidence: [
        { id: "E01", legacy_id: "doc:freeze", title: "Active code freeze policy", raw_ref: "policies/freeze.md" },
        { id: "E03", title: "Owner approval required in writing" }
      ],
      evidence_used: [
        { src: "deploy-checklist.md", title: "All servers must run the same build" },
        { src: "build-manifest.json", title: "Server eight is on the prior version" },
        "E01",
        "E99"
      ],
      evidence_missing: [
        { src: "kill-switch.log", reason: "No kill switch wired to the new router" },
        "E03"
      ],
      expected_behavior: { correct_action: "escalate" }
    })
  );

  writeTrial("variant-a", "fixture-scn-001", 1);
  // Ineligible: parse failure status.
  writeTrial("variant-a", "fixture-scn-001", 2, { status: "parse_failed" });
  // Ineligible: empty rationale.
  writeTrial("variant-b", "fixture-scn-001", 1, { reason: "   " });
  // Ineligible: scenario not in the set.
  writeTrial("variant-a", "other-scn-999", 1, { scenario_id: "other-scn-999" });
});

test("builds one item per resolvable (trial, evidence entry) for eligible trials only", () => {
  const queue = buildQueue({ runsDir, scenarioSetDir, trialsPerScenario: 5, seed: 1 });
  assert.equal(queue.stats.eligible_trial_count, 1);
  // 2 inline used + 1 catalog-resolved used + 1 inline missing + 1 catalog
  // missing; the dangling "E99" reference is dropped, never half-rendered.
  assert.equal(queue.items.length, 5);
  const kinds = queue.items.map((i) => i.evidence_kind);
  assert.deepEqual(kinds, ["used", "used", "used", "missing", "missing"]);
  const resolved = queue.items.find((i) => i.evidence_src === "policies/freeze.md");
  assert.equal(resolved.evidence_text, "Active code freeze policy");
  assert.ok(queue.items.every((i) => i.evidence_text !== ""));
  assert.ok(queue.items.every((i) => i.rationale.includes("server eight")));
  assert.ok(queue.items.every((i) => /^[0-9a-f]{64}$/.test(i.item_sha256)));
});

test("rebuild with the same seed is byte-identical", () => {
  const a = buildQueue({ runsDir, scenarioSetDir, trialsPerScenario: 1, seed: 7 });
  const b = buildQueue({ runsDir, scenarioSetDir, trialsPerScenario: 1, seed: 7 });
  assert.equal(JSON.stringify(a.items), JSON.stringify(b.items));
});

test("item hash changes when the rationale changes", () => {
  const baseline = buildQueue({ runsDir, scenarioSetDir, seed: 1 });
  writeTrial("variant-a", "fixture-scn-001", 1, { reason: "A different rationale." });
  const changed = buildQueue({ runsDir, scenarioSetDir, seed: 1 });
  assert.notEqual(baseline.items[0].item_sha256, changed.items[0].item_sha256);
  // Restore the original trial for any later assertions.
  writeTrial("variant-a", "fixture-scn-001", 1);
});

test("writeQueue emits JSONL plus a provenance sidecar with matching counts", () => {
  const queue = buildQueue({ runsDir, scenarioSetDir, seed: 1 });
  const outPath = path.join(root, "out", "queue.jsonl");
  const sidecar = writeQueue(outPath, queue, {
    runsDir,
    scenarioSetDir,
    trialsPerScenario: 1,
    maxScenarios: 0,
    seed: 1
  });
  const lines = fs.readFileSync(outPath, "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, queue.items.length);
  assert.equal(sidecar.item_count, queue.items.length);
  const fromDisk = JSON.parse(fs.readFileSync(`${outPath}.provenance.json`, "utf8"));
  assert.equal(fromDisk.generator, "build-step-label-queue");
  assert.equal(fromDisk.item_count, queue.items.length);
});
