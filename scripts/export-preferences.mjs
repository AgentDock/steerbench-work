// Preference-pair exporter for SteerBench-Work.
//
// Pairs correct against incorrect trial responses from canonical benchmark
// runs and writes Tinker cookbook comparison JSONL: one
// {"comparison": {...}, "label": "A"|"B"} object per line. Provenance lives
// in a sidecar file next to each JSONL output, same convention as the SFT
// exporter, so the training file itself stays renderer-clean.
//
// Pairing rule: within one scenario, every (correct, incorrect) trial pair
// across any variants is a candidate. A seeded shuffle samples up to
// --max-pairs-per-scenario candidates per scenario, then a seeded coin flip
// decides which completion lands on side A. The label always names the side
// holding the correct response. A Tie label can never appear: correctness
// is boolean, and the downstream DPO tooling silently treats Tie as a B
// win, so ties are banned outright.
//
// Canonical run roots are discovered by walking --runs-dir for RUN_PLAN.json
// and keeping roots planned against the full given scenario set. Each
// exported trial's user message is verified byte-identical to the current
// canonical render of its scenario, so a pair can never mix prompts.
//
// Usage:
//   node scripts/export-preferences.mjs --runs-dir runs \
//     --scenario-set-dir scenario-sets/steerbench-work-2026-05 \
//     [--splits <splits.json> [--split <name>]] --out <dir> \
//     [--max-pairs-per-scenario 6] [--seed 1]
//
// The splits file is either the assign-splits artifact (its `assignments`
// map of scenario id to split name) or the plain shape the SFT exporter
// documents: { "train": ["id-a"], "test": ["id-b"] }. With --splits, one
// <split>.jsonl is written per split that has pairs; --split restricts the
// export to that single split. Without --splits everything goes to all.jsonl.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { reshapeToLegacy, buildModelInputFor } from "../src/canonical-runner.mjs";
import { TRIAL_STATUS } from "../src/trial-store.mjs";
import { SCORED_FIELD } from "../src/schema.mjs";

export const EXPORTER_VERSION = "preference-exporter/0.1.0";

// Labels exported now predate the human-gold pass, so every row says so.
export const LABEL_SOURCE = "benchmark-owner-pre-gold";

/** Deterministic 32-bit PRNG (mulberry32), same generator assign-splits uses. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleInPlace(arr, rand) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Fold a scenario id into the base seed so each scenario gets its own RNG
 * stream. Keeps sampling for one scenario independent of which other
 * scenarios happen to be present in the runs directory.
 */
function seedForScenario(baseSeed, scenarioId) {
  const digest = createHash("sha256").update(scenarioId, "utf8").digest();
  return (digest.readUInt32LE(0) ^ (baseSeed >>> 0)) >>> 0;
}

function listScenarioFiles(scenarioSetDir) {
  return fs.readdirSync(scenarioSetDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".json") && !e.name.startsWith("_"))
    .map((e) => path.join(scenarioSetDir, e.name))
    .sort();
}

/** Map scenario id to the exact user message the runner sends on the wire. */
function canonicalUserMessages(scenarioSetDir) {
  const byId = new Map();
  for (const filePath of listScenarioFiles(scenarioSetDir)) {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!raw.id) throw new Error(`scenario without id: ${filePath}`);
    const { model_input } = buildModelInputFor(reshapeToLegacy(raw));
    byId.set(raw.id, `scenario_id: ${raw.id}\n\n${model_input}`);
  }
  return byId;
}

/**
 * Walk runsDir for directories containing RUN_PLAN.json and keep the ones
 * planned against the full given scenario set. Smoke and partial-set runs
 * fall out of the scenario_count check. Run roots do not nest, so the walk
 * stops descending once it finds a plan.
 */
function findCanonicalRunRoots(runsDir, scenarioSetName, scenarioCount) {
  const roots = [];
  const walk = (dir) => {
    if (fs.existsSync(path.join(dir, "RUN_PLAN.json"))) {
      try {
        const plan = JSON.parse(fs.readFileSync(path.join(dir, "RUN_PLAN.json"), "utf8"));
        if (plan.scenario_set === scenarioSetName && plan.scenario_count === scenarioCount) {
          roots.push({ dir, plan });
        }
      } catch {
        // Unreadable plan: not a usable run root.
      }
      return;
    }
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isDirectory()) walk(path.join(dir, e.name));
    }
  };
  walk(runsDir);
  return roots;
}

const runnerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Collect exportable trials grouped by scenario, split into correct and
 * incorrect sides. Only status "ok" trials with a boolean `correct` and a
 * user message byte-identical to the canonical render qualify. Trials are
 * additionally grouped by system message so one pair can never mix system
 * prompts; the largest group per scenario wins.
 */
function collectTrials(runRoots, canonicalUserById, counters) {
  const byScenario = new Map();
  for (const { dir, plan } of runRoots) {
    for (const variantKey of [...plan.planned_variants].sort()) {
      const variantDir = path.join(dir, variantKey);
      if (!fs.existsSync(variantDir)) continue;
      for (const scenarioId of [...canonicalUserById.keys()].sort()) {
        const cellDir = path.join(variantDir, scenarioId);
        if (!fs.existsSync(cellDir)) continue;
        const trialFiles = fs.readdirSync(cellDir)
          .filter((f) => /^trial-\d+\.json$/.test(f))
          .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
        for (const f of trialFiles) {
          const trialPath = path.join(cellDir, f);
          counters.trials_scanned += 1;
          const trial = JSON.parse(fs.readFileSync(trialPath, "utf8"));
          if (trial.status !== TRIAL_STATUS.OK) { counters.skipped_status += 1; continue; }
          if (typeof trial.correct !== "boolean") { counters.skipped_correct_null += 1; continue; }
          if (typeof trial.raw_text !== "string" || trial.raw_text.length === 0) { counters.skipped_no_raw_text += 1; continue; }
          const messages = trial.request_body?.messages ?? trial.request_body?.input;
          const system = messages?.find?.((m) => m.role === "system")?.content;
          const user = messages?.find?.((m) => m.role === "user")?.content;
          if (typeof system !== "string" || typeof user !== "string") { counters.skipped_bad_messages += 1; continue; }
          if (user !== canonicalUserById.get(scenarioId)) { counters.skipped_prompt_mismatch += 1; continue; }
          counters.trials_usable += 1;
          if (!byScenario.has(scenarioId)) byScenario.set(scenarioId, new Map());
          const bySystem = byScenario.get(scenarioId);
          if (!bySystem.has(system)) bySystem.set(system, { correct: [], incorrect: [] });
          (trial.correct ? bySystem.get(system).correct : bySystem.get(system).incorrect).push({
            path: path.relative(runnerRoot, trialPath),
            run_id: trial.run_id,
            variant_key: trial.variant_key,
            trial: trial.trial,
            raw_text: trial.raw_text
          });
        }
      }
    }
  }
  return byScenario;
}

/** Sample up to `cap` correct-vs-incorrect pairs for one scenario. */
function buildPairsForScenario(scenarioId, bySystem, cap, baseSeed, counters) {
  const groups = [...bySystem.entries()]
    .sort((a, b) => (b[1].correct.length + b[1].incorrect.length) - (a[1].correct.length + a[1].incorrect.length)
      || a[0].localeCompare(b[0]));
  const [system, { correct, incorrect }] = groups[0];
  for (const [, g] of groups.slice(1)) {
    counters.skipped_system_minority += g.correct.length + g.incorrect.length;
  }
  const candidates = [];
  for (const c of correct) {
    for (const w of incorrect) {
      if (c.raw_text !== w.raw_text) candidates.push([c, w]);
    }
  }
  const rand = mulberry32(seedForScenario(baseSeed, scenarioId));
  shuffleInPlace(candidates, rand);
  return candidates.slice(0, cap).map(([c, w]) => {
    const correctOnA = rand() < 0.5;
    return { scenarioId, system, correctTrial: c, incorrectTrial: w, label: correctOnA ? "A" : "B" };
  });
}

/** Parse a splits file into a Map of scenario id to split name. */
function loadSplitAssignments(splitsPath) {
  const parsed = JSON.parse(fs.readFileSync(splitsPath, "utf8"));
  const assignments = new Map();
  const source = parsed.assignments && typeof parsed.assignments === "object"
    ? Object.entries(parsed.assignments)
    : Object.entries(parsed).flatMap(([split, ids]) =>
        Array.isArray(ids) ? ids.map((id) => [id, split]) : []);
  for (const [id, split] of source) assignments.set(id, split);
  if (assignments.size === 0) throw new Error(`no split assignments found in ${splitsPath}`);
  return assignments;
}

/**
 * Export preference pairs as Tinker comparison JSONL plus provenance
 * sidecars. Returns { files, counters }.
 */
export function exportPreferences({ runsDir, scenarioSetDir, splitsPath, splitName, outDir, maxPairsPerScenario = 6, seed = 1 }) {
  if (splitName && !splitsPath) throw new Error("--split requires --splits <file>");
  const assignments = splitsPath ? loadSplitAssignments(splitsPath) : null;
  const canonicalUserById = canonicalUserMessages(scenarioSetDir);
  const counters = {
    run_roots: 0, trials_scanned: 0, trials_usable: 0,
    skipped_status: 0, skipped_correct_null: 0, skipped_no_raw_text: 0,
    skipped_bad_messages: 0, skipped_prompt_mismatch: 0, skipped_system_minority: 0,
    skipped_unassigned_split: 0,
    scenarios_total: canonicalUserById.size, scenarios_with_pairs: 0,
    total_pairs: 0, label_a: 0, label_b: 0
  };
  const runRoots = findCanonicalRunRoots(runsDir, path.basename(scenarioSetDir), canonicalUserById.size);
  counters.run_roots = runRoots.length;
  const byScenario = collectTrials(runRoots, canonicalUserById, counters);

  const byStem = new Map();
  for (const scenarioId of [...byScenario.keys()].sort()) {
    const split = assignments ? assignments.get(scenarioId) ?? null : null;
    if (assignments && split === null) { counters.skipped_unassigned_split += 1; continue; }
    if (splitName && split !== splitName) continue;
    const pairs = buildPairsForScenario(scenarioId, byScenario.get(scenarioId), maxPairsPerScenario, seed, counters);
    if (pairs.length === 0) continue;
    counters.scenarios_with_pairs += 1;
    const stem = assignments ? split : "all";
    if (!byStem.has(stem)) byStem.set(stem, { lines: [], provenance: [] });
    const bucket = byStem.get(stem);
    for (const p of pairs) {
      counters.total_pairs += 1;
      counters[p.label === "A" ? "label_a" : "label_b"] += 1;
      const correctSide = [{ role: "assistant", content: p.correctTrial.raw_text }];
      const incorrectSide = [{ role: "assistant", content: p.incorrectTrial.raw_text }];
      const line = JSON.stringify({
        comparison: {
          prompt_conversation: [
            { role: "system", content: p.system },
            { role: "user", content: canonicalUserById.get(scenarioId) }
          ],
          completion_A: p.label === "A" ? correctSide : incorrectSide,
          completion_B: p.label === "A" ? incorrectSide : correctSide
        },
        label: p.label
      });
      bucket.lines.push(line);
      const refOf = ({ raw_text, ...ref }) => ref;
      bucket.provenance.push({
        pair_id: `${scenarioId}:${createHash("sha256").update(`${p.correctTrial.path}|${p.incorrectTrial.path}`, "utf8").digest("hex").slice(0, 12)}`,
        scenario_id: scenarioId,
        split,
        label: p.label,
        scored_field: SCORED_FIELD,
        correct_variant: p.correctTrial.variant_key,
        incorrect_variant: p.incorrectTrial.variant_key,
        correct_trial: refOf(p.correctTrial),
        incorrect_trial: refOf(p.incorrectTrial),
        label_source: LABEL_SOURCE,
        exporter_version: EXPORTER_VERSION,
        // SHA-256 of the exact JSONL line bytes (utf-8, no trailing newline),
        // so any row can be re-verified against the file directly.
        render_sha256: createHash("sha256").update(line, "utf8").digest("hex")
      });
    }
  }

  fs.mkdirSync(outDir, { recursive: true });
  const files = [];
  for (const stem of [...byStem.keys()].sort()) {
    const { lines, provenance } = byStem.get(stem);
    const jsonlPath = path.join(outDir, `${stem}.jsonl`);
    const provenancePath = path.join(outDir, `${stem}.provenance.json`);
    fs.writeFileSync(jsonlPath, lines.map((l) => `${l}\n`).join(""));
    fs.writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
    files.push({ split: stem, jsonlPath, provenancePath, pairs: lines.length });
  }
  return { files, counters };
}

function parseArgs(argv) {
  const args = {};
  const flags = {
    "--runs-dir": "runsDir",
    "--scenario-set-dir": "scenarioSetDir",
    "--splits": "splitsPath",
    "--split": "splitName",
    "--out": "outDir",
    "--max-pairs-per-scenario": "maxPairsPerScenario",
    "--seed": "seed"
  };
  for (let i = 0; i < argv.length; i += 2) {
    const key = flags[argv[i]];
    if (!key || argv[i + 1] === undefined) {
      throw new Error(`unexpected or valueless argument: ${argv[i]}`);
    }
    args[key] = argv[i + 1];
  }
  if (!args.runsDir || !args.scenarioSetDir || !args.outDir) {
    throw new Error("required: --runs-dir <dir> --scenario-set-dir <dir> --out <dir>");
  }
  for (const k of ["maxPairsPerScenario", "seed"]) {
    if (args[k] !== undefined) {
      args[k] = Number(args[k]);
      if (!Number.isInteger(args[k]) || args[k] < 0) throw new Error(`${k} must be a non-negative integer`);
    }
  }
  return args;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { files, counters } = exportPreferences(parseArgs(process.argv.slice(2)));
  console.log(`run roots used: ${counters.run_roots}`);
  console.log(`trials scanned: ${counters.trials_scanned}, usable: ${counters.trials_usable} (skipped: status=${counters.skipped_status}, correct_null=${counters.skipped_correct_null}, no_raw_text=${counters.skipped_no_raw_text}, bad_messages=${counters.skipped_bad_messages}, prompt_mismatch=${counters.skipped_prompt_mismatch}, system_minority=${counters.skipped_system_minority}, unassigned_split=${counters.skipped_unassigned_split})`);
  console.log(`scenarios with at least one pair: ${counters.scenarios_with_pairs} / ${counters.scenarios_total}`);
  console.log(`total pairs: ${counters.total_pairs}`);
  const frac = counters.total_pairs ? (counters.label_a / counters.total_pairs).toFixed(4) : "n/a";
  console.log(`label balance: A=${counters.label_a}, B=${counters.label_b} (A fraction ${frac})`);
  for (const f of files) {
    console.log(`  ${f.jsonlPath} (${f.pairs} pairs)`);
    console.log(`  ${f.provenancePath}`);
  }
}
