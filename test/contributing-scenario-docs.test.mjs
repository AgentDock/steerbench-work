// Tests that the "Contributing a Scenario" section in CONTRIBUTING.md names
// the fields the scenario corpus actually uses, and that the README files
// table lists the dataset tooling. Docs drift silently; the corpus does not.
// These checks pin the docs to the schema in scenario-sets/ and the scoring
// vocabulary in src/scorer.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CANONICAL_SCORING_MAPPING } from "../src/scorer.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCENARIO_DIR = join(ROOT, "scenario-sets", "steerbench-work-2026-05");

const contributing = readFileSync(join(ROOT, "CONTRIBUTING.md"), "utf8");
const readme = readFileSync(join(ROOT, "README.md"), "utf8");

function scenarioSection(text) {
  const start = text.indexOf("## Contributing a Scenario");
  assert.ok(start >= 0, "CONTRIBUTING.md must keep the Contributing a Scenario section");
  const end = text.indexOf("\n## ", start + 1);
  return end >= 0 ? text.slice(start, end) : text.slice(start);
}

const section = scenarioSection(contributing);

test("scenario steps name every field a standard scenario carries", () => {
  const documented = [
    "`id`", "`version`", "`domain`", "`action_verb`", "`irreversibility_class`",
    "`title`", "`user_request`", "`context.goal`", "`context.hidden_trap`",
    "`tools_available`", "`decision_point`", "`proposed_action`", "`draft`",
    "`confidence`", "`evidence_ids`", "`evidence[]`", "`source_type`",
    "`status`", "`raw_ref`", "`expected_evidence`", "`expected_behavior`",
    "`correct_action`", "`human_correction`", "`recovery_summary`",
    "`clean_outcome`", "`autonomous_failure`", "`tags`", "`license`"
  ];
  for (const token of documented) {
    assert.ok(section.includes(token), `section must name ${token}`);
  }
});

test("scenario steps no longer name fields that exist in no scenario file", () => {
  const dead = [
    "`task`", "`tools`", "`commit_point`", "`worker_proposal`",
    "`expected_action`", "`expected_outcome`"
  ];
  for (const token of dead) {
    assert.ok(!section.includes(token), `section must not name ${token}`);
  }
});

test("scenario steps include the scenario validator command", () => {
  assert.ok(
    section.includes("node scripts/validate-scenarios.mjs --scenario-set-dir"),
    "section must tell contributors to run the scenario validator"
  );
});

test("documented correct_action values match the canonical scoring mapping", () => {
  for (const label of Object.keys(CANONICAL_SCORING_MAPPING)) {
    assert.ok(section.includes(`\`${label}\``), `section must list scoring label ${label}`);
  }
});

test("documented fields exist in the released corpus", () => {
  const files = readdirSync(SCENARIO_DIR).filter(
    (f) => f.endsWith(".json") && !f.startsWith("_")
  );
  assert.ok(files.length > 0, "scenario set must not be empty");

  const validLabels = new Set(Object.keys(CANONICAL_SCORING_MAPPING));
  let fullShape = 0;
  for (const f of files) {
    const j = JSON.parse(readFileSync(join(SCENARIO_DIR, f), "utf8"));
    for (const key of [
      "id", "version", "domain", "action_verb", "irreversibility_class",
      "title", "user_request", "expected_behavior"
    ]) {
      assert.ok(key in j, `${f} must carry ${key}`);
    }
    assert.ok(
      validLabels.has(j.expected_behavior.correct_action),
      `${f} expected_behavior.correct_action must be a scoring label`
    );
    if (
      j.context && j.decision_point && Array.isArray(j.evidence) &&
      Array.isArray(j.expected_evidence) && Array.isArray(j.tools_available)
    ) {
      fullShape += 1;
    }
  }
  assert.ok(fullShape > 0, "corpus must contain standard-shape scenarios");
});

test("README files table lists the dataset tooling", () => {
  const entries = [
    "`scripts/validate-scenarios.mjs`",
    "`scripts/assign-splits.mjs`",
    "`scripts/export-sft.mjs`",
    "`scripts/export-preferences.mjs`",
    "`scripts/integrations/tinker/`"
  ];
  for (const entry of entries) {
    assert.ok(readme.includes(entry), `README files table must list ${entry}`);
  }
});
