// Read-only integrity audit for the SteerBench-Work release corpus.
//
// Separates three provenance layers that a single whole-file hash conflates:
//
//   full_json_sha256   raw bytes of the scenario file on disk
//   model_input_sha256 the exact rendered text the benchmarked model read
//   scored labels      expected_action / direction / functional_category /
//                      irreversibility_class (the answer-key + weighting fields)
//
// A whole-file hash flips on any byte change, including human-facing research
// metadata (title, source notes, taxonomy.source_provenance) that the model
// never sees. This audit reports each layer at the fidelity the saved evidence
// actually supports:
//
//   - The frozen run manifest stores the OLD whole-file hash and the OLD scored
//     labels. We have those exactly.
//   - Each frozen trial stores the OLD rendered model input inside its
//     request_body. We can recover and hash those exact bytes.
//   - The OLD whole-file *bytes* were not saved by any run. A SHA-256 is
//     one-way, so old prose/formatting edits cannot be reconstructed from the
//     hash alone. This audit never pretends otherwise.
//
// It mutates nothing: no scenario file, no manifest, no run artifact. It reads
// the live scenario set, the frozen manifest, and the frozen trials, then
// prints a per-scenario verdict and optionally writes a JSON report.
//
// Usage:
//   node scripts/integrity-audit.mjs
//   node scripts/integrity-audit.mjs --out /tmp/integrity-audit.json

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import { sha256File, buildScenarioManifest } from "../src/manifest.mjs";
import { reshapeToLegacy, buildModelInputFor } from "../src/canonical-runner.mjs";
import { stripUserMessagePrefix } from "../src/model-input.mjs";

const SCENARIO_SET = "steerbench-work-2026-05";
const SCENARIO_SET_DIR = `scenario-sets/${SCENARIO_SET}`;
const RUN_ROOT_BASE = "runs/canonical-multi-trial";

// Reference run whose frozen manifest + trials we read OLD values from. All
// canonical run roots froze byte-identical scenario hashes (verified
// separately), so any one is authoritative for the OLD layer; this one is the
// latest full grid.
const REFERENCE_RUN = "tm-locked-2026-06-03-gemini-pro";

// Scored-label fields the manifest froze. Splitting them by whether a change
// can move a score:
//   scoring-critical: changing these changes what "correct" means or its weight
//   reporting/taxonomy: changing these changes only how rows are grouped/shown
const SCORING_CRITICAL_FIELDS = ["expected_action", "irreversibility_class"];
const REPORTING_FIELDS = ["direction", "functional_category", "domain", "source_provenance", "action_verb"];

function sha256String(s) {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function short(h) {
  return h ? h.slice(0, 12) : "(none)";
}

// === OLD layer: read from frozen artifacts ===

function loadFrozenManifest(runRoot) {
  const p = path.join(RUN_ROOT_BASE, runRoot, "SCENARIO_MANIFEST.json");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

// Recover the exact OLD rendered model input for a scenario from a frozen
// trial. The user message was written as `scenario_id: <id>\n\n<modelInput>`,
// so we strip that one prefix to get back the model input bytes the model saw.
function frozenModelInput(runRoot, variantDir, scenarioId) {
  const dir = path.join(RUN_ROOT_BASE, runRoot, variantDir, scenarioId);
  if (!fs.existsSync(dir)) return null;
  const trials = fs.readdirSync(dir).filter((f) => /^trial-\d+\.json$/.test(f)).sort();
  for (const t of trials) {
    let trial;
    try {
      trial = JSON.parse(fs.readFileSync(path.join(dir, t), "utf8"));
    } catch {
      continue;
    }
    const rb = trial.request_body;
    if (!rb) continue;
    const msgs = rb.input || rb.messages;
    if (!Array.isArray(msgs)) continue;
    const user = msgs.find((m) => m.role === "user");
    if (!user || typeof user.content !== "string") continue;
    return stripUserMessagePrefix({ scenarioId, content: user.content });
  }
  return null;
}

function firstVariantDir(runRoot) {
  const root = path.join(RUN_ROOT_BASE, runRoot);
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)[0];
}

// === CURRENT layer: render from the live scenario file ===

// Render through the canonical path. The audit must not maintain a second
// reshape or detector implementation: that duplication previously let
// answer-key evidence selection and author-only fields drift back in here.
function currentModelInput(json) {
  return buildModelInputFor(reshapeToLegacy(json)).model_input;
}

// === audit ===

const frozen = loadFrozenManifest(REFERENCE_RUN);
const frozenById = new Map(frozen.scenarios.map((s) => [s.id, s]));
const variantDir = firstVariantDir(REFERENCE_RUN);

const current = buildScenarioManifest({ scenarioSet: SCENARIO_SET, scenarioSetDir: SCENARIO_SET_DIR });
const currentById = new Map(current.scenarios.map((s) => [s.id, s]));

const report = {
  generated_at: new Date().toISOString(),
  scenario_set: SCENARIO_SET,
  reference_run: REFERENCE_RUN,
  scenario_count: frozen.scenarios.length,
  note:
    "Old full-file BYTES were never saved by any run; only the old whole-file hash, " +
    "old rendered model input, and old scored labels were frozen. This audit compares " +
    "those layers exactly and does not reconstruct old prose.",
  scenarios: []
};

for (const fEntry of frozen.scenarios) {
  const id = fEntry.id;
  const cEntry = currentById.get(id);
  const livePath = path.join(SCENARIO_SET_DIR, fEntry.file);

  if (!cEntry || !fs.existsSync(livePath)) {
    report.scenarios.push({ id, verdict: "MISSING", file: fEntry.file });
    continue;
  }

  const fullDrift = fEntry.sha256 !== cEntry.sha256;

  // Scored / reporting label diffs from the frozen manifest vs current rebuild.
  const labelDiffs = [];
  for (const field of [...SCORING_CRITICAL_FIELDS, ...REPORTING_FIELDS]) {
    if (fEntry[field] !== cEntry[field]) {
      labelDiffs.push({ field, old: fEntry[field] ?? null, current: cEntry[field] ?? null });
    }
  }
  const scoringCriticalChanged = labelDiffs.some((d) => SCORING_CRITICAL_FIELDS.includes(d.field));

  let modelInputBlock = null;
  if (fullDrift) {
    const oldMI = frozenModelInput(REFERENCE_RUN, variantDir, id);
    const newMI = currentModelInput(JSON.parse(fs.readFileSync(livePath, "utf8")));
    modelInputBlock = {
      old_sha256: oldMI ? sha256String(oldMI) : null,
      current_sha256: sha256String(newMI),
      old_recovered: oldMI !== null,
      identical: oldMI !== null && sha256String(oldMI) === sha256String(newMI)
    };
  }

  const modelInputChanged = modelInputBlock ? !modelInputBlock.identical : false;

  let verdict;
  if (!fullDrift) {
    verdict = "CLEAN"; // byte-identical file => every layer identical
  } else if (modelInputChanged || scoringCriticalChanged) {
    verdict = "FATAL"; // model-facing or scoring-critical change => rerun required
  } else {
    verdict = "BENIGN_DRIFT"; // file bytes drifted, but model input + scored labels intact
  }

  report.scenarios.push({
    id,
    file: fEntry.file,
    verdict,
    full_json_sha256: { old: fEntry.sha256, current: cEntry.sha256, drift: fullDrift },
    model_input_sha256: modelInputBlock,
    scored_label_diffs: labelDiffs
  });
}

// === print ===

const clean = report.scenarios.filter((s) => s.verdict === "CLEAN");
const benign = report.scenarios.filter((s) => s.verdict === "BENIGN_DRIFT");
const fatal = report.scenarios.filter((s) => s.verdict === "FATAL");
const missing = report.scenarios.filter((s) => s.verdict === "MISSING");

console.log(`\nSteerBench-Work integrity audit  (reference run: ${REFERENCE_RUN})`);
console.log(`scenarios: ${report.scenario_count}`);
console.log(`  CLEAN (byte-identical):        ${clean.length}`);
console.log(`  BENIGN_DRIFT (meta/website):   ${benign.length}`);
console.log(`  FATAL (model/scoring changed): ${fatal.length}`);
if (missing.length) console.log(`  MISSING:                       ${missing.length}`);

const drifted = [...benign, ...fatal, ...missing];
if (drifted.length) {
  console.log(`\nDrifted scenarios (full-file hash changed):`);
  for (const s of drifted) {
    console.log(`\n  ${s.id}   [${s.verdict}]`);
    console.log(`    full_json_sha256:   ${short(s.full_json_sha256.old)} (old)  ->  ${short(s.full_json_sha256.current)} (current)`);
    if (s.model_input_sha256) {
      const mi = s.model_input_sha256;
      const tag = mi.old_recovered ? (mi.identical ? "IDENTICAL" : "CHANGED") : "OLD NOT RECOVERED";
      console.log(`    model_input_sha256: ${short(mi.old_sha256)} (old)  ->  ${short(mi.current_sha256)} (current)   [${tag}]`);
    }
    if (s.scored_label_diffs.length === 0) {
      console.log(`    scored labels:      no change`);
    } else {
      for (const d of s.scored_label_diffs) {
        const crit = SCORING_CRITICAL_FIELDS.includes(d.field) ? " (SCORING-CRITICAL)" : " (reporting/metadata)";
        console.log(`    ${d.field}:${crit}\n        old:     ${JSON.stringify(d.old)}\n        current: ${JSON.stringify(d.current)}`);
      }
    }
  }
}

console.log(
  `\nverdict: ${fatal.length === 0
    ? "no model-facing or scoring-critical change detected; drift is metadata/website-only"
    : `${fatal.length} scenario(s) have model-facing or scoring-critical drift`}`
);

const outArg = process.argv.indexOf("--out");
if (outArg !== -1 && process.argv[outArg + 1]) {
  fs.writeFileSync(process.argv[outArg + 1], `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nwrote ${process.argv[outArg + 1]}`);
}
