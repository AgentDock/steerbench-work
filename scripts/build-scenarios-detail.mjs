// MAINTAINER-ONLY. Not part of the public runner surface: this script writes the
// neighboring steerbench-site repo (../steerbench-site/...) and only runs in the
// monorepo checkout, not in a standalone clone of this repo.
//
// Build the site's scenarios-detail.json from one or more locked runs plus the
// scenario set. Each model condition lives in its own run root (off baselines
// in one root, each reasoning condition in its own), so this script accepts
// several roots and merges per scenario.
//
// Per-scenario verdicts come from each variant's cell.json (the validated
// source of truth). Every one of the cell's trials is read directly from its
// trial-N.json so the page can show the full decision split and each trial's
// own reason, not just one. Scenario taxonomy is read from the run manifest,
// which is the validated copy.
//
// Usage:
//   node scripts/build-scenarios-detail.mjs <out.json> \
//     <runRoot>::<variantKey>:<modelLabel> [<runRoot>::<variantKey>:<modelLabel> ...]
//
// Example:
//   node scripts/build-scenarios-detail.mjs \
//     ../steerbench-site/src/data/scenarios-detail.json \
//     runs/canonical-multi-trial/tm-locked-2026-05-29::nano:"gpt-5.4-nano (off)" \
//     runs/canonical-multi-trial/tm-locked-2026-05-29::mini:"gpt-5.4-mini (off)" \
//     runs/canonical-multi-trial/tm-locked-2026-05-30-nano-high::nano-high:"gpt-5.4-nano (high)"
//
import fs from "node:fs";
import path from "node:path";

const [outPath, ...modelSpecs] = process.argv.slice(2);
if (!outPath || modelSpecs.length === 0) {
  console.error("Usage: node scripts/build-scenarios-detail.mjs <out.json> <runRoot>::<variantKey>:<modelLabel> ...");
  process.exit(1);
}

// Parse each model spec into { runRoot, key, label }. The runRoot is split off
// on "::" so labels may contain colons; the remaining "key:label" splits on the
// first colon only.
const models = modelSpecs.map((spec) => {
  const sepIdx = spec.indexOf("::");
  if (sepIdx === -1) {
    console.error(`Bad model spec (missing "::"): ${spec}`);
    process.exit(1);
  }
  const runRoot = spec.slice(0, sepIdx);
  const rest = spec.slice(sepIdx + 2);
  const colonIdx = rest.indexOf(":");
  const key = colonIdx === -1 ? rest : rest.slice(0, colonIdx);
  const label = colonIdx === -1 ? rest : rest.slice(colonIdx + 1);
  return { runRoot, key, label };
});

function readJsonOrNull(p) {
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

function patternDefinition(patterns, id) {
  return patterns?.pattern_definitions?.[id] ?? { label: id, definition: "" };
}

function inferBoundaryPattern({ entry, file }) {
  const tags = new Set([...(entry.tags || []), ...(file.tags || [])]);

  if (entry.source_provenance === "incident-mirror" || [...tags].some((t) => /mirror/i.test(t))) {
    return {
      id: "incident_mirror",
      source: "source_inferred",
      note: "source_provenance or mirror tag identifies a public-incident mirror construction"
    };
  }
  if (tags.has("adversarial")) {
    return {
      id: "adversarial_control",
      source: "tag_inferred",
      note: "adversarial tag identifies a synthetic hard-control construction"
    };
  }
  if (tags.has("false_positive_flag")) {
    return {
      id: "detector_conflict",
      source: "tag_inferred",
      note: "false_positive_flag tag identifies a detector-conflict construction"
    };
  }
  if (tags.has("safe_control")) {
    return {
      id: "clean_control",
      source: "tag_inferred",
      note: "safe_control tag identifies a clean control construction"
    };
  }
  if (
    entry.source_provenance === "real-world-cited" ||
    entry.source_provenance === "literature + analogous incident"
  ) {
    return {
      id: "public_harm_anchor",
      source: "source_inferred",
      note: "public-source provenance without mirror, adversarial, detector-conflict, or clean-control tags"
    };
  }
  if (entry.source_provenance == null) {
    return {
      id: "calibration_control",
      source: "source_inferred",
      note: "no source_provenance in the locked manifest; treated as a calibration control"
    };
  }
  return {
    id: "unassigned",
    source: "unassigned",
    note: "no construction pattern was curated or safely inferred from source metadata"
  };
}

function inferredSecondaryPatterns({ entry, file, primary }) {
  const tags = new Set([...(entry.tags || []), ...(file.tags || [])]);
  const out = [];

  if (tags.has("false_positive_flag") && primary !== "detector_conflict") out.push("detector_conflict");
  if (tags.has("adversarial") && primary !== "adversarial_control") out.push("adversarial_control");
  if (entry.source_provenance === "incident-mirror" && primary !== "incident_mirror") out.push("incident_mirror");
  if (tags.has("safe_control") && primary !== "clean_control") out.push("clean_control");
  if (
    (entry.source_provenance === "real-world-cited" ||
      entry.source_provenance === "literature + analogous incident") &&
    primary !== "public_harm_anchor"
  ) out.push("public_harm_anchor");
  if (entry.source_provenance == null && primary !== "calibration_control") out.push("calibration_control");

  return [...new Set(out)];
}

function boundaryPatternFor({ entry, file, patterns }) {
  const override = patterns?.scenarios?.[entry.id] ?? {};
  const inferred = inferBoundaryPattern({ entry, file });
  const id = override.boundary_pattern ?? inferred.id;
  const def = patternDefinition(patterns, id);
  const secondary = override.secondary_patterns ?? inferredSecondaryPatterns({ entry, file, primary: id });
  const source = override.boundary_pattern ? "curated_sidecar" : inferred.source;
  const sourceLabels = {
    curated_sidecar: "curated",
    tag_inferred: "inferred from tags",
    source_inferred: "inferred from source metadata",
    unassigned: "unassigned"
  };

  return {
    id,
    label: def.label ?? id,
    definition: def.definition ?? "",
    secondary,
    source,
    source_label: sourceLabels[source] ?? source,
    inference_note: override.boundary_pattern
      ? "explicit entry in _SCENARIO_PATTERNS.json"
      : inferred.note,
    trigger: override.trigger ?? null,
    clearing_evidence: override.clearing_evidence ?? null,
    why_it_matters: override.why_it_matters ?? null,
    training_use: override.training_use ?? null
  };
}

// Per run root: load the manifest once, build an id -> entry index, and resolve
// the scenario set directory against cwd (the manifest stores it relative to
// the runner root, which is where this script is invoked from).
const runRootCache = new Map();
function runRootContext(runRoot) {
  if (runRootCache.has(runRoot)) return runRootCache.get(runRoot);
  const manifest = readJsonOrNull(path.join(runRoot, "SCENARIO_MANIFEST.json"));
  if (!manifest) {
    console.error(`No SCENARIO_MANIFEST.json under ${runRoot}`);
    process.exit(1);
  }
  const scenarioSetDir = path.isAbsolute(manifest.scenario_set_dir)
    ? manifest.scenario_set_dir
    : path.resolve(process.cwd(), manifest.scenario_set_dir);
  const byId = new Map(manifest.scenarios.map((e) => [e.id, e]));
  const ctx = { manifest, scenarioSetDir, byId };
  runRootCache.set(runRoot, ctx);
  return ctx;
}

// Read the cell plus all its trials for one (runRoot, variantKey, scenarioId).
// Returns null when the cell is absent (model has not run this scenario).
function readModelVerdict(runRoot, variantKey, scenarioId, label) {
  const cellPath = path.join(runRoot, variantKey, scenarioId, "cell.json");
  const cell = readJsonOrNull(cellPath);
  if (!cell) return null;

  const nTrials = cell.n_trials ?? (cell.trial_permissions || []).length;
  const trials = [];
  for (let t = 1; t <= nTrials; t += 1) {
    const tr = readJsonOrNull(path.join(runRoot, variantKey, scenarioId, `trial-${t}.json`));
    if (!tr) continue;
    trials.push({
      trial: tr.trial ?? t,
      commit_permission: tr.commit_permission ?? null,
      policy_action: tr.policy_action ?? null,
      human_required: tr.human_required ?? null,
      confidence: typeof tr.confidence === "number" ? tr.confidence : null,
      reason: typeof tr.reason === "string" ? tr.reason : "",
      status: tr.status ?? null,
      correct: tr.correct ?? null
    });
  }

  // Decision split across the trials, e.g. { allowed: 4, blocked: 1 }.
  const split = {};
  for (const p of cell.trial_permissions || trials.map((x) => x.commit_permission)) {
    if (p == null) continue;
    split[p] = (split[p] || 0) + 1;
  }

  const unanimous = cell.n_correct_trials === nTrials || cell.n_correct_trials === 0;

  return {
    model: label,
    expected: cell.expected_action,
    modal_decision: cell.modal_commit_permission,
    modal_count: cell.modal_count ?? null,
    n_trials: nTrials,
    n_correct: cell.n_correct_trials ?? null,
    pass_all: cell.pass_all_trials ?? null,
    correct: cell.modal_correct,
    // Modal accuracy counts a parse-failed/no-decision cell as a miss in the
    // run summary denominator. Directional error rates cannot classify that
    // cell as over- or under-refusal because there is no allow/block decision.
    // Exposing both booleans keeps the matrix/scenario pages aligned with the
    // scorer instead of letting downstream code guess from nulls.
    modal_scored: cell.expected_action != null && cell.provider_filtered !== true,
    directionally_scored:
      cell.expected_action != null &&
      cell.modal_commit_permission != null &&
      cell.provider_filtered !== true,
    // True when the provider's own content filter refused every trial, so the
    // model never produced a steering decision. The page renders this as a
    // distinct "provider filtered" state, not a proceed/hold verdict.
    provider_filtered: cell.provider_filtered === true,
    split,
    unanimous,
    trials
  };
}

// Union of scenario ids across every run root, preserving manifest order from
// the first root and appending any extras. In practice all roots share the
// frozen 106-scenario set, so this is just the first root's order.
const seen = new Set();
const orderedIds = [];
for (const m of models) {
  const ctx = runRootContext(m.runRoot);
  for (const e of ctx.manifest.scenarios) {
    if (!seen.has(e.id)) { seen.add(e.id); orderedIds.push(e.id); }
  }
}

const scenarios = [];
for (const id of orderedIds) {
  // Find the manifest entry and scenario file from the first root that has it.
  let entry = null;
  let scenarioSetDir = null;
  let patterns = null;
  for (const m of models) {
    const ctx = runRootContext(m.runRoot);
    if (ctx.byId.has(id)) {
      entry = ctx.byId.get(id);
      scenarioSetDir = ctx.scenarioSetDir;
      // Explanatory sidecar, deliberately underscore-prefixed so the scenario
      // manifest builder skips it and locked scenario hashes stay untouched.
      patterns = readJsonOrNull(path.join(scenarioSetDir, "_SCENARIO_PATTERNS.json"))
        ?? readJsonOrNull(path.join(scenarioSetDir, "SCENARIO_PATTERNS.json"));
      break;
    }
  }
  if (!entry) continue;
  const file = readJsonOrNull(path.join(scenarioSetDir, entry.file));
  if (!file) continue;

  const verdicts = [];
  for (const m of models) {
    const v = readModelVerdict(m.runRoot, m.key, id, m.label);
    if (v) verdicts.push(v);
  }

  const dp = file.decision_point || {};
  const eb = file.expected_behavior || {};
  const pattern = boundaryPatternFor({ entry, file, patterns });
  const evidence = (file.evidence || []).map((e) => ({
    id: e.legacy_id || e.id,
    title: e.title,
    status: e.status ?? null,
    type: e.source_type ?? null
  }));

  scenarios.push({
    id,
    title: file.title || id,
    // Taxonomy comes from the validated manifest entry, not the raw file.
    direction: entry.direction ?? null,
    functional_category: entry.functional_category ?? null,
    domain: entry.domain ?? null,
    action_effect: entry.action_verb ?? null,
    irreversibility: entry.irreversibility_class ?? file.irreversibility_class ?? null,
    source_provenance: file.taxonomy?.source_provenance ?? entry.source_provenance ?? null,
    boundary_pattern: pattern.id,
    boundary_pattern_label: pattern.label,
    boundary_pattern_definition: pattern.definition,
    boundary_pattern_secondary: pattern.secondary,
    boundary_pattern_source: pattern.source,
    boundary_pattern_source_label: pattern.source_label,
    boundary_pattern_inference_note: pattern.inference_note,
    boundary_trigger: pattern.trigger,
    boundary_clearing_evidence: pattern.clearing_evidence,
    boundary_why_it_matters: pattern.why_it_matters,
    boundary_training_use: pattern.training_use,
    expected_action: eb.correct_action ?? entry.expected_action ?? null,
    // Zone 1 situation fields.
    user_request: file.user_request ?? null,
    proposed_action: dp.proposed_action ?? null,
    draft: dp.draft ?? null,
    evidence,
    hidden_trap: file.context?.hidden_trap ?? null,
    expected_steering: file.expected_steering ?? eb.human_correction ?? null,
    autonomous_failure: eb.autonomous_failure ?? null,
    model_verdicts: verdicts
  });
}

const out = {
  built_from: models.map((m) => ({ run_root: path.basename(m.runRoot), variant: m.key, label: m.label })),
  models: models.map((m) => m.label),
  scenario_count: scenarios.length,
  scenarios
};
fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${scenarios.length} scenarios with up to ${models.length} model verdicts each to ${outPath}`);
