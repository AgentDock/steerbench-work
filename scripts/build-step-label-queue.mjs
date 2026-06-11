#!/usr/bin/env node
/**
 * @fileoverview Builds a step-evidence labeling queue from stored trials.
 * @module scripts/build-step-label-queue
 *
 * Pairs sampled trial rationales with their scenario's evidence items so a
 * human rater can answer one binary question per (rationale, evidence) pair:
 * did the rationale actually use this evidence, or flag this missing
 * safeguard? The resulting answers form the human gold set that any
 * automated step grader must be validated against before its output is
 * trusted as a reward signal.
 *
 * @remarks
 * - Only trials with status "ok" and a non-empty rationale are eligible.
 *   Both correct and incorrect verdicts are included on purpose: process
 *   quality is graded independently of the verdict.
 * - Sampling is deterministic. Each scenario folds its id into the base
 *   seed, so adding scenarios never reshuffles existing ones.
 * - Every queue item carries an item_sha256 over its content fields. The
 *   labeling server refuses answers whose hash does not match, so a queue
 *   regenerated from different data can never silently absorb old answers.
 *
 * Usage:
 * ```bash
 * node scripts/build-step-label-queue.mjs \
 *   --runs-dir runs --scenario-set-dir scenario-sets/steerbench-work-2026-05 \
 *   [--trials-per-scenario 1] [--max-scenarios 0] [--seed 1] \
 *   [--out annotations/step-label-queue.jsonl]
 * ```
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const GENERATOR_VERSION = 2;

const USAGE = `Usage: node scripts/build-step-label-queue.mjs --runs-dir <dir> --scenario-set-dir <dir> [--trials-per-scenario N] [--max-scenarios N] [--seed N] [--out <file>]

Builds a labeling queue: one yes/no/unclear question per sampled trial
rationale and scenario evidence item. Output is JSONL plus a provenance
sidecar. Offline; never calls a model API.`;

/** Deterministic PRNG, same construction the preference exporter uses. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleInPlace(arr, rand) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Fold a scenario id into the base seed so each scenario gets its own RNG. */
function foldSeed(baseSeed, scenarioId) {
  const digest = createHash("sha256").update(`${baseSeed}:${scenarioId}`).digest();
  return digest.readUInt32BE(0);
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Resolves one evidence entry to a {src, text} pair. Entries come in two
 * shapes across the scenario set: inline objects ({src, title} for used,
 * {src, reason} for missing) and string codes ("E01") that reference the
 * scenario's top-level `evidence` catalog.
 */
function resolveEvidence(entry, kind, catalog) {
  if (entry && typeof entry === "object") {
    return {
      src: entry.src ?? "",
      text: (kind === "missing" ? entry.reason : entry.title) ?? ""
    };
  }
  if (typeof entry === "string") {
    const hit = catalog.get(entry);
    if (hit) {
      return { src: hit.raw_ref ?? hit.legacy_id ?? entry, text: hit.title ?? "" };
    }
    return { src: entry, text: "" };
  }
  return { src: "", text: "" };
}

/** Loads scenario evidence lists and catalogs keyed by scenario id. */
function loadScenarios(scenarioSetDir) {
  const out = new Map();
  const entries = fs.readdirSync(scenarioSetDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name.startsWith("_")) continue;
    const scenario = JSON.parse(fs.readFileSync(path.join(scenarioSetDir, entry.name), "utf8"));
    if (!scenario?.id) continue;
    const catalog = new Map(
      (Array.isArray(scenario.evidence) ? scenario.evidence : [])
        .filter((ev) => ev && typeof ev === "object" && ev.id)
        .map((ev) => [ev.id, ev])
    );
    out.set(scenario.id, {
      title: typeof scenario.title === "string" ? scenario.title : "",
      evidenceUsed: Array.isArray(scenario.evidence_used) ? scenario.evidence_used : [],
      evidenceMissing: Array.isArray(scenario.evidence_missing) ? scenario.evidence_missing : [],
      catalog
    });
  }
  return out;
}

/** Walks a runs directory for eligible trial records. */
function collectTrials(runsDir, scenarioIds) {
  const trials = [];
  const stack = [runsDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!/^trial-\d+\.json$/.test(entry.name)) continue;
      let trial;
      try {
        trial = JSON.parse(fs.readFileSync(full, "utf8"));
      } catch {
        continue;
      }
      if (trial?.status !== "ok") continue;
      if (typeof trial.reason !== "string" || trial.reason.trim() === "") continue;
      if (!scenarioIds.has(trial.scenario_id)) continue;
      trials.push({
        scenarioId: trial.scenario_id,
        scenarioSha256: trial.scenario_sha256 ?? null,
        runId: trial.run_id ?? null,
        variantKey: trial.variant_key ?? "unknown-variant",
        trial: trial.trial ?? 0,
        correct: trial.correct === true,
        rationale: trial.reason.trim()
      });
    }
  }
  return trials;
}

function itemsForTrial(trial, evidence) {
  const items = [];
  const push = (kind, idx, src, text, question) => {
    const core = {
      scenario_id: trial.scenarioId,
      run_id: trial.runId,
      variant_key: trial.variantKey,
      trial: trial.trial,
      evidence_kind: kind,
      evidence_src: src,
      evidence_text: text,
      question,
      rationale: trial.rationale
    };
    items.push({
      item_id: `${trial.scenarioId}::${trial.variantKey}::trial-${trial.trial}::${kind}-${idx}`,
      scenario_sha256: trial.scenarioSha256,
      // Display-only context for the labeling interface; deliberately kept
      // out of the hashed core so wording fixes never invalidate answers.
      scenario_title: evidence.title,
      correct: trial.correct,
      ...core,
      item_sha256: sha256Hex(JSON.stringify(core))
    });
  };
  evidence.evidenceUsed.forEach((ev, idx) => {
    const { src, text } = resolveEvidence(ev, "used", evidence.catalog);
    if (text === "") return; // unresolvable entries make unanswerable questions
    push("used", idx, src || `used-${idx}`, text, "Did the rationale make use of this evidence?");
  });
  evidence.evidenceMissing.forEach((ev, idx) => {
    const { src, text } = resolveEvidence(ev, "missing", evidence.catalog);
    if (text === "") return;
    push(
      "missing",
      idx,
      src || `missing-${idx}`,
      text,
      "Did the rationale flag that this safeguard is missing?"
    );
  });
  return items;
}

/**
 * Builds the labeling queue deterministically.
 *
 * @param options - runsDir, scenarioSetDir, trialsPerScenario, maxScenarios
 *   (0 = no cap), seed
 * @returns Object with `items` and a `stats` summary for the sidecar
 */
export function buildQueue({ runsDir, scenarioSetDir, trialsPerScenario = 1, maxScenarios = 0, seed = 1 }) {
  const scenarios = loadScenarios(scenarioSetDir);
  const trials = collectTrials(runsDir, new Set(scenarios.keys()));

  const byScenario = new Map();
  for (const trial of trials) {
    if (!byScenario.has(trial.scenarioId)) byScenario.set(trial.scenarioId, []);
    byScenario.get(trial.scenarioId).push(trial);
  }

  let scenarioIds = [...byScenario.keys()].sort();
  if (maxScenarios > 0) {
    shuffleInPlace(scenarioIds, mulberry32(foldSeed(seed, "scenario-cap")));
    scenarioIds = scenarioIds.slice(0, maxScenarios).sort();
  }

  const items = [];
  let sampledTrials = 0;
  for (const scenarioId of scenarioIds) {
    const evidence = scenarios.get(scenarioId);
    if (evidence.evidenceUsed.length === 0 && evidence.evidenceMissing.length === 0) continue;
    const candidates = [...byScenario.get(scenarioId)];
    candidates.sort((a, b) =>
      `${a.variantKey}:${a.trial}`.localeCompare(`${b.variantKey}:${b.trial}`)
    );
    shuffleInPlace(candidates, mulberry32(foldSeed(seed, scenarioId)));
    for (const trial of candidates.slice(0, trialsPerScenario)) {
      sampledTrials += 1;
      items.push(...itemsForTrial(trial, evidence));
    }
  }

  return {
    items,
    stats: {
      scenario_count: scenarioIds.length,
      eligible_trial_count: trials.length,
      sampled_trial_count: sampledTrials,
      item_count: items.length
    }
  };
}

/** Writes the queue JSONL and its provenance sidecar. */
export function writeQueue(outPath, queue, options) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const lines = queue.items.map((item) => JSON.stringify(item)).join("\n");
  fs.writeFileSync(outPath, lines.length > 0 ? `${lines}\n` : "");
  const sidecar = {
    generator: "build-step-label-queue",
    generator_version: GENERATOR_VERSION,
    seed: options.seed,
    trials_per_scenario: options.trialsPerScenario,
    max_scenarios: options.maxScenarios,
    runs_dir: options.runsDir,
    scenario_set_dir: options.scenarioSetDir,
    generated_at: new Date().toISOString(),
    ...queue.stats
  };
  fs.writeFileSync(`${outPath}.provenance.json`, `${JSON.stringify(sidecar, null, 2)}\n`);
  return sidecar;
}

function parseArgs(argv) {
  const args = {
    runsDir: "runs",
    scenarioSetDir: null,
    trialsPerScenario: 1,
    maxScenarios: 0,
    seed: 1,
    out: path.join("annotations", "step-label-queue.jsonl")
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = () => argv[++i];
    if (flag === "--help" || flag === "-h") return { help: true };
    else if (flag === "--runs-dir") args.runsDir = next();
    else if (flag === "--scenario-set-dir") args.scenarioSetDir = next();
    else if (flag === "--trials-per-scenario") args.trialsPerScenario = Number(next());
    else if (flag === "--max-scenarios") args.maxScenarios = Number(next());
    else if (flag === "--seed") args.seed = Number(next());
    else if (flag === "--out") args.out = next();
    else throw new Error(`Unknown flag: ${flag}`);
  }
  if (!args.scenarioSetDir) throw new Error("--scenario-set-dir is required");
  return args;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(String(error.message ?? error));
    console.error(USAGE);
    process.exit(1);
  }
  if (args.help) {
    console.log(USAGE);
    process.exit(0);
  }
  const queue = buildQueue(args);
  const sidecar = writeQueue(args.out, queue, args);
  console.log(
    `Wrote ${sidecar.item_count} items from ${sidecar.sampled_trial_count} trials ` +
      `across ${sidecar.scenario_count} scenarios to ${args.out}`
  );
}
