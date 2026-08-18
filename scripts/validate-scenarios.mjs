// Scenario-set validator for SteerBench-Work.
//
// Checks every scenario JSON in a set against the structural contract the
// runner and scorer depend on. Hard failures (exit 1) are conditions that
// would corrupt a run: bad ids, an unscoreable correct_action, missing core
// request fields, dangling evidence references, no resolvable license.
// Enrichment gaps (taxonomy, decision_point, recovery fields) only warn.
//
// Usage:
//   node scripts/validate-scenarios.mjs --scenario-set-dir <dir> [--report out.json]

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { CANONICAL_SCORING_MAPPING, IRREVERSIBILITY_WEIGHTS } from "../src/scorer.mjs";
import { reshapeToLegacy, buildModelInputFor } from "../src/canonical-runner.mjs";

const USAGE = `Usage: node scripts/validate-scenarios.mjs --scenario-set-dir <dir> [--report <file>]

Validates every scenario JSON in the directory. Scoring-critical gaps
(missing id or correct_action, unresolvable evidence ids, unknown
irreversibility class, empty family key, missing license) fail loudly with
exit 1; enrichment gaps warn only.`;

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}

export const VALIDATOR_VERSION = "validate-scenarios/1.0.0";

const KNOWN_ACTIONS = Object.keys(CANONICAL_SCORING_MAPPING);
const KNOWN_IRREVERSIBILITY = Object.keys(IRREVERSIBILITY_WEIGHTS);

function validationEvidenceId(scenarioId, evidenceId) {
  return `e-${createHash("sha256").update(`${scenarioId}|${evidenceId}`, "utf8").digest("hex").slice(0, 10)}`;
}

function validationScenarioId(scenarioId) {
  return `s-${createHash("sha256").update(String(scenarioId), "utf8").digest("hex").slice(0, 10)}`;
}

// Per-file license is the strict requirement. Release sets covered by a
// set-level data license file (LICENSE-DATA next to or above the set dir)
// downgrade a missing per-file license to a warning: the scenario is still
// licensed, just not self-describing.
export function findSetLicense(setDir) {
  let dir = path.resolve(setDir);
  for (let depth = 0; depth < 5; depth++) {
    for (const name of ["LICENSE-DATA", "LICENSE"]) {
      if (fs.existsSync(path.join(dir, name))) return name;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function validateScenario(raw, fileBase, seenIds, setLicense) {
  const errors = [];
  const warnings = [];

  if (!raw.id || typeof raw.id !== "string") {
    errors.push("missing id");
  } else {
    if (seenIds.has(raw.id)) {
      errors.push(`duplicate id "${raw.id}" (already declared by ${seenIds.get(raw.id)})`);
    } else {
      seenIds.set(raw.id, `${fileBase}.json`);
    }
    if (raw.id !== fileBase) {
      errors.push(`id "${raw.id}" does not match filename "${fileBase}.json"`);
    }
  }

  const correctAction = raw.expected_behavior?.correct_action;
  if (!correctAction) {
    errors.push("missing expected_behavior.correct_action");
  } else if (!KNOWN_ACTIONS.includes(correctAction)) {
    errors.push(
      `correct_action "${correctAction}" is not a key of the canonical scoring mapping (${KNOWN_ACTIONS.join(", ")})`
    );
  }

  if (!raw.user_request) errors.push("missing user_request");
  if (!raw.action_verb) errors.push("missing action_verb");

  const irr = raw.irreversibility_class;
  if (!irr || !KNOWN_IRREVERSIBILITY.includes(irr)) {
    errors.push(
      `irreversibility_class "${irr ?? "(missing)"}" outside known set (${KNOWN_IRREVERSIBILITY.join(", ")})`
    );
  }

  const evidenceIds = new Set((raw.evidence || []).flatMap((e) => [e.id, e.legacy_id].filter(Boolean)));
  for (const eid of raw.expected_evidence || []) {
    if (!evidenceIds.has(eid)) {
      errors.push(`expected_evidence id "${eid}" does not resolve to an evidence entry`);
    }
  }
  for (const eid of raw.decision_point?.evidence_ids || []) {
    if (!evidenceIds.has(eid)) {
      errors.push(`decision_point.evidence_ids id "${eid}" does not resolve to an evidence entry`);
    }
  }

  if (!(raw.metadata?.legacy_family || raw.domain)) {
    errors.push("empty family key (metadata.legacy_family || domain)");
  }

  if (!raw.license) {
    if (setLicense) {
      warnings.push(`license missing on file; covered by set-level ${setLicense}`);
    } else {
      errors.push("missing license and no set-level LICENSE-DATA found");
    }
  }

  // Enrichment fields: useful for the site, docs, and analysis but not
  // required for a scoreable run.
  if (!raw.taxonomy) warnings.push("missing taxonomy");
  if (!raw.decision_point) warnings.push("missing decision_point");
  const eb = raw.expected_behavior || {};
  for (const field of ["recovery_summary", "human_correction", "clean_outcome", "autonomous_failure"]) {
    if (!eb[field]) warnings.push(`missing expected_behavior.${field}`);
  }
  if (!raw.context?.goal) warnings.push("missing context.goal");
  if (!raw.context?.hidden_trap) warnings.push("missing context.hidden_trap");
  if (!raw.title) warnings.push("missing title");
  if (!raw.version) warnings.push("missing version");
  if (!raw.contributors?.length) warnings.push("missing contributors");
  if (!raw.tags?.length) warnings.push("missing tags");
  if (!raw.evidence?.length) warnings.push("evidence list empty");

  // A structurally valid scenario must also survive the canonical render
  // pipeline, otherwise the runner cannot produce a model input for it.
  if (errors.length === 0) {
    try {
      const { model_input } = buildModelInputFor(reshapeToLegacy(raw), {
        scenarioIdFor: validationScenarioId,
        evidenceIdFor: validationEvidenceId
      });
      if (typeof model_input !== "string" || !model_input.trim()) {
        errors.push("canonical render produced an empty model input");
      }
    } catch (err) {
      errors.push(`canonical render failed: ${err.message}`);
    }
  }

  return { errors, warnings };
}

export function validateScenarioSet(setDir) {
  const resolved = path.resolve(setDir);
  const names = fs
    .readdirSync(resolved)
    .filter((f) => f.endsWith(".json") && !f.startsWith("_"))
    .sort();
  const setLicense = findSetLicense(resolved);
  const seenIds = new Map();
  const files = [];
  for (const name of names) {
    const fileBase = name.replace(/\.json$/, "");
    let result;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(resolved, name), "utf8"));
      result = validateScenario(raw, fileBase, seenIds, setLicense);
    } catch (err) {
      result = { errors: [`unreadable JSON: ${err.message}`], warnings: [] };
    }
    files.push({ file: name, ...result });
  }
  const errorCount = files.reduce((n, f) => n + f.errors.length, 0);
  const warningCount = files.reduce((n, f) => n + f.warnings.length, 0);
  return {
    files,
    file_count: files.length,
    error_count: errorCount,
    warning_count: warningCount,
    files_with_errors: files.filter((f) => f.errors.length).length,
    files_with_warnings: files.filter((f) => f.warnings.length).length,
    status: errorCount === 0 ? "pass" : "fail"
  };
}

function parseArgs(argv) {
  const args = { scenarioSetDir: null, report: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--scenario-set-dir") args.scenarioSetDir = argv[++i];
    else if (argv[i] === "--report") args.report = argv[++i];
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!args.scenarioSetDir) throw new Error("--scenario-set-dir is required");
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = validateScenarioSet(args.scenarioSetDir);

  for (const f of result.files) {
    for (const e of f.errors) console.error(`FAIL ${f.file}: ${e}`);
    if (f.warnings.length) console.warn(`WARN ${f.file}: ${f.warnings.join("; ")}`);
  }

  const verdict =
    result.status === "pass"
      ? result.warning_count > 0
        ? "PASS (warnings only)"
        : "PASS"
      : "FAIL";
  console.log(
    `validate-scenarios: ${result.file_count} files, ${result.error_count} hard failures ` +
      `(${result.files_with_errors} files), ${result.warning_count} warnings ` +
      `(${result.files_with_warnings} files) -> ${verdict}`
  );

  if (args.report) {
    const report = {
      validator_version: VALIDATOR_VERSION,
      exporter_version: VALIDATOR_VERSION,
      label_source: "benchmark-owner-pre-gold",
      generated_at: new Date().toISOString(),
      scenario_set_dir: args.scenarioSetDir,
      ...result
    };
    fs.writeFileSync(args.report, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`report written: ${args.report}`);
  }

  process.exit(result.status === "pass" ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
