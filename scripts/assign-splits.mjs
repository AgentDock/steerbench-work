// assign-splits.mjs
//
// Deterministic train/val/test split assignment for a SteerBench-Work
// scenario set. Scenarios are grouped into families by
// `metadata.legacy_family || domain` and every family is assigned to a
// single split, so related scenarios never straddle a partition boundary.
//
// Algorithm: seeded Fisher-Yates shuffle of the family list, stable sort
// by family size descending (the shuffle decides order among equal-size
// families), then a greedy pack that places each whole family into the
// split with the lowest combined cost of (a) fullness against the ratio
// target and (b) deviation of the split's direction mix from the global
// must-proceed fraction. Direction is derived from
// expected_behavior.correct_action through CANONICAL_SCORING_MAPPING:
// a required commit_permission of "allowed" is must-proceed, "blocked"
// is must-hold.
//
// CLI:
//   node scripts/assign-splits.mjs --scenario-set-dir <dir> --seed <int> \
//     --ratios 70/15/15 --out <file>
//
// The output is a protocol demonstration only. The scenario set is fully
// public, so no partition of it can serve as a held-out test set. The
// file says so in its own contamination_note.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CANONICAL_SCORING_MAPPING } from "../src/scorer.mjs";

export const EXPORTER_VERSION = "assign-splits/1.0.0";
export const SPLIT_NAMES = ["train", "val", "test"];

// Weight of the direction-mix term against the fullness term in the
// greedy cost. Fullness spans roughly 0..1 while packing; direction
// deviation spans 0..0.5. Equal weighting lets direction steer the
// placement of small families once the size targets are nearly met.
const DIRECTION_WEIGHT = 1.0;

const CONTAMINATION_NOTE =
  "All 106 scenarios in this set are published (CC BY 4.0, crawlable). " +
  "Any model whose training data was collected after this release must be " +
  "assumed to have seen every scenario. No partition of this set functions " +
  "as a held-out test set. This file demonstrates the assignment protocol " +
  "only; no training result will be reported against it.";

/** Deterministic 32-bit PRNG (mulberry32). Returns floats in [0, 1). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** In-place Fisher-Yates shuffle driven by a seeded PRNG. */
function shuffleInPlace(arr, rand) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Map a scenario's expected correct_action to its split direction. */
export function directionOf(scenario) {
  const action = scenario.expected_behavior?.correct_action;
  const required = CANONICAL_SCORING_MAPPING[action];
  if (required === "allowed") return "must_proceed";
  if (required === "blocked") return "must_hold";
  throw new Error(
    `scenario ${scenario.id}: correct_action "${action}" has no scoring mapping`
  );
}

/**
 * Load every scenario JSON in a set directory (underscore-prefixed files
 * are working notes, not scenarios). Returns minimal records sorted by
 * filename so the result is independent of directory listing order.
 */
export function loadScenarios(setDir) {
  const files = fs
    .readdirSync(setDir)
    .filter((f) => f.endsWith(".json") && !f.startsWith("_"))
    .sort();
  return files.map((f) => {
    const raw = JSON.parse(fs.readFileSync(path.join(setDir, f), "utf8"));
    return {
      id: raw.id,
      family: raw.metadata?.legacy_family || raw.domain,
      direction: directionOf(raw)
    };
  });
}

/**
 * Assign whole families to splits. Pure function of (scenarios, seed,
 * ratios); the same inputs always produce the same assignment.
 *
 * @param {Array<{id, family, direction}>} scenarios
 * @param {{seed: number, ratios: number[]}} opts - ratios are percents
 *   for [train, val, test] and must sum to 100.
 * @returns {{assignments, per_split, families}} assignment detail
 */
export function assignSplits(scenarios, { seed, ratios }) {
  const total = scenarios.length;
  const globalProceed =
    scenarios.filter((s) => s.direction === "must_proceed").length / total;

  const byFamily = new Map();
  for (const s of scenarios) {
    if (!byFamily.has(s.family)) {
      byFamily.set(s.family, { family: s.family, ids: [], proceed: 0 });
    }
    const g = byFamily.get(s.family);
    g.ids.push(s.id);
    if (s.direction === "must_proceed") g.proceed += 1;
  }

  // Alphabetical base order, seeded shuffle, then largest-first with the
  // shuffled order breaking size ties (Array.sort is stable).
  const groups = [...byFamily.values()].sort((a, b) =>
    a.family < b.family ? -1 : 1
  );
  shuffleInPlace(groups, mulberry32(seed));
  groups.sort((a, b) => b.ids.length - a.ids.length);

  const state = {};
  SPLIT_NAMES.forEach((name, i) => {
    state[name] = {
      target: (total * ratios[i]) / 100,
      count: 0,
      proceed: 0,
      families: []
    };
  });

  for (const g of groups) {
    let best = null;
    let bestCost = Infinity;
    for (const name of SPLIT_NAMES) {
      const s = state[name];
      const newCount = s.count + g.ids.length;
      const fullness = newCount / Math.max(s.target, 1e-9);
      const proceedFrac = (s.proceed + g.proceed) / newCount;
      const cost =
        fullness + DIRECTION_WEIGHT * Math.abs(proceedFrac - globalProceed);
      if (cost < bestCost) {
        bestCost = cost;
        best = name;
      }
    }
    const s = state[best];
    s.count += g.ids.length;
    s.proceed += g.proceed;
    s.families.push(g.family);
  }

  const assignments = {};
  const familySplit = new Map();
  for (const name of SPLIT_NAMES) {
    for (const fam of state[name].families) familySplit.set(fam, name);
  }
  for (const s of [...scenarios].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    assignments[s.id] = familySplit.get(s.family);
  }

  const per_split = {};
  for (const name of SPLIT_NAMES) {
    const s = state[name];
    per_split[name] = {
      scenario_count: s.count,
      target_count: Number(s.target.toFixed(2)),
      family_count: s.families.length,
      direction: {
        must_proceed: s.proceed,
        must_hold: s.count - s.proceed,
        must_proceed_fraction: s.count
          ? Number((s.proceed / s.count).toFixed(4))
          : null
      },
      families: [...s.families].sort()
    };
  }

  return { assignments, per_split, family_count: byFamily.size };
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const get = (flag) =>
    args.includes(flag) ? args[args.indexOf(flag) + 1] : null;
  const setDir = get("--scenario-set-dir");
  const seedRaw = get("--seed");
  const ratiosRaw = get("--ratios");
  const out = get("--out");
  if (!setDir || seedRaw == null || !ratiosRaw || !out) {
    throw new Error(
      "usage: node scripts/assign-splits.mjs --scenario-set-dir <dir> " +
        "--seed <int> --ratios 70/15/15 --out <file>"
    );
  }
  const seed = Number(seedRaw);
  if (!Number.isInteger(seed) || seed < 0) {
    throw new Error(`--seed must be a non-negative integer, got "${seedRaw}"`);
  }
  const ratios = ratiosRaw.split("/").map(Number);
  if (
    ratios.length !== 3 ||
    ratios.some((r) => !Number.isFinite(r) || r < 0) ||
    ratios.reduce((a, b) => a + b, 0) !== 100
  ) {
    throw new Error(
      `--ratios must be three non-negative numbers summing to 100, got "${ratiosRaw}"`
    );
  }
  return { setDir, seed, ratios, out };
}

function main() {
  const { setDir, seed, ratios, out } = parseArgs(process.argv);
  const scenarios = loadScenarios(setDir);
  const { assignments, per_split, family_count } = assignSplits(scenarios, {
    seed,
    ratios
  });

  const artifact = {
    schema_version: 1,
    artifact_kind: "split-assignment",
    status: "protocol-demo",
    binding: false,
    label_source: "benchmark-owner-pre-gold",
    exporter_version: EXPORTER_VERSION,
    scenario_set: path.basename(path.resolve(setDir)),
    scenario_set_visibility: "fully-public",
    contamination_note: CONTAMINATION_NOTE,
    grouping_rule:
      "whole-family assignment: every scenario in a family lands in the same split",
    grouping_key: "metadata.legacy_family || domain",
    seed,
    ratios: { train: ratios[0], val: ratios[1], test: ratios[2] },
    per_split,
    assignments
  };

  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(artifact, null, 2) + "\n");

  console.log(
    `scenarios: ${scenarios.length}  families: ${family_count}  seed: ${seed}  ratios: ${ratios.join("/")}`
  );
  console.log("split  count  target  families  must-proceed  must-hold  proceed-frac");
  for (const name of SPLIT_NAMES) {
    const s = per_split[name];
    console.log(
      `${name.padEnd(6)} ${String(s.scenario_count).padEnd(6)} ` +
        `${String(s.target_count).padEnd(7)} ${String(s.family_count).padEnd(9)} ` +
        `${String(s.direction.must_proceed).padEnd(13)} ` +
        `${String(s.direction.must_hold).padEnd(10)} ` +
        `${s.direction.must_proceed_fraction}`
    );
  }
  console.log(`wrote ${out}`);
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
