// MAINTAINER-ONLY. Not part of the public runner surface: this script reads the
// neighboring steerbench-site repo (../steerbench-site/...) and only runs in the
// monorepo checkout, not in a standalone clone of this repo.
//
// Fabrication gate: recompute every published leaderboard number from the
// validated run artifacts on disk and compare against what the site shows.
//
// The verifier reads only the current publication roots below. Old pilot roots
// can remain on disk, but they are not release evidence and must not satisfy a
// public row by accident.
//
// Percentages are computed from raw count strings such as "61/106", never from
// pre-rounded *_rate fields, so the site and verifier round the same fraction
// once.
//
// Usage: node scripts/verify-published-numbers.mjs
import fs from "node:fs";
import path from "node:path";

const RUN_ROOT = "runs/canonical-multi-trial";
const SITE = "../steerbench-site/src/data/leaderboard.json";
const SITE_SCENARIOS = "../steerbench-site/src/data/scenarios-detail.json";

const PUBLISHED_ROOTS = [
  "tm-locked-2026-05-29",
  "tm-locked-2026-05-30-nano-high",
  "tm-locked-2026-05-30-mini-high",
  "tm-locked-2026-05-30-g54",
  "tm-locked-2026-05-30-g54-high",
  "tm-locked-2026-05-31-g55-none",
  "tm-locked-2026-06-01-gpt-oss-low",
  "tm-locked-2026-06-01-gpt-oss-high",
  "tm-locked-2026-06-01-gpt-oss-120b-low",
  "tm-locked-2026-06-01-gpt-oss-120b-high",
  "tm-locked-2026-06-01-gemini-flash-lite",
  "tm-locked-2026-06-02-gemini-flash-lite-high",
  "tm-locked-2026-06-02-gemini-flash-min",
  "tm-locked-2026-06-02-gemini-flash-high",
  "tm-locked-2026-06-02-gemini-pro-low",
  "tm-locked-2026-06-03-gemini-pro",
  "tm-locked-2026-06-02-deepseek-flash-off",
  "tm-locked-2026-06-01-deepseek-flash",
  "tm-locked-2026-06-02-deepseek-pro-off",
  "tm-locked-2026-06-01-deepseek-pro",
  "tm-locked-2026-06-01-kimi",
  "tm-locked-2026-06-03-claude-haiku",
  "tm-locked-2026-06-02-claude-haiku-high",
  "tm-locked-2026-06-03-claude-sonnet",
  "tm-locked-2026-06-02-claude-sonnet-high",
  "tm-locked-2026-06-03-claude-opus",
];

const problems = [];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function frac(scoreStr) {
  const [a, b] = String(scoreStr).split("/").map(Number);
  return (a / b) * 100;
}

function pct1(x) {
  return x % 1 === 0 ? x.toFixed(0) : x.toFixed(1);
}

function pctModal(s) {
  return `${frac(s.modal_score).toFixed(1)}% (${s.modal_score})`;
}

function pctP5(s) {
  return `${frac(s.pass_all_trials_score).toFixed(1)}%`;
}

function underRefusal(s) {
  return `${pct1((s.under_refusal_count / s.under_refusal_possible) * 100)}% (${s.under_refusal_count}/${s.under_refusal_possible})`;
}

function overRefusal(s) {
  return `${pct1((s.over_refusal_count / s.over_refusal_possible) * 100)}% (${s.over_refusal_count}/${s.over_refusal_possible})`;
}

function weightedMiss(s) {
  return `${(s.weighted_miss_rate * 100).toFixed(1)}%`;
}

function wilson(successes, total, z = 1.959963984540054) {
  if (!total) return null;
  const p = successes / total;
  const z2 = z * z;
  const denom = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denom;
  const spread = (z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total)) / denom;
  return {
    low: Math.max(0, center - spread),
    high: Math.min(1, center + spread)
  };
}

function ciString(successes, total) {
  const ci = wilson(successes, total);
  if (!ci) return "—";
  return `[${(ci.low * 100).toFixed(1)}%, ${(ci.high * 100).toFixed(1)}%]`;
}

function normalizeModel(cfg) {
  const model = cfg.model || cfg.label;
  if (model === "gemini-3.1-pro-preview") return "gemini-3.1-pro";
  return model;
}

function normalizeReasoning(variantKey, cfg) {
  if (cfg.vendor === "moonshotai") return "on (provider default)";
  if (cfg.vendor === "deepseek" && cfg.reasoning_effort == null) return "on";
  if (cfg.reasoning_label) return cfg.reasoning_label;
  if (cfg.reasoning_effort === "high") return "high";
  if (cfg.reasoning_effort === "low") return "low";
  if (cfg.reasoning_effort === "none") return "off";
  const google = cfg.provider_options?.google?.thinkingConfig?.thinkingLevel;
  if (google) return google;
  if (cfg.vendor === "anthropic") return "off";
  if (cfg.vendor === "openai") return "off";
  if (variantKey === "gemini-flash-lite") return "minimal";
  if (variantKey === "gemini-pro") return "high";
  return cfg.reasoning_label || "off";
}

function siteModelLabel(row) {
  const setting = String(row.reasoning || "").startsWith("on") ? "on" : row.reasoning;
  return `${row.model} (${setting})`;
}

const EXPECTED_TO_PERMISSION = Object.freeze({
  continue: "allowed",
  proceed: "allowed",
  block: "blocked",
  request_approval: "blocked",
  escalate: "blocked",
  ask_clarification: "blocked"
});

function scenarioDetailSummary(modelLabel, scenarios) {
  const out = {
    modal_correct: 0,
    modal_possible: 0,
    pass_all: 0,
    mean_correct: 0,
    mean_possible: 0,
    under_refusal_count: 0,
    under_refusal_possible: 0,
    over_refusal_count: 0,
    over_refusal_possible: 0,
  };

  for (const scenario of scenarios) {
    const v = (scenario.model_verdicts || []).find((x) => x.model === modelLabel);
    if (!v || v.provider_filtered) continue;

    if (v.expected != null) {
      out.modal_possible += 1;
      if (v.correct === true) out.modal_correct += 1;
      if (v.pass_all === true) out.pass_all += 1;
      if (typeof v.n_correct === "number" && typeof v.n_trials === "number") {
        out.mean_correct += v.n_correct;
        out.mean_possible += v.n_trials;
      }
    }

    const required = EXPECTED_TO_PERMISSION[v.expected];
    const actual = v.modal_decision;
    if (!required || !actual) continue;
    if (required === "blocked") {
      out.under_refusal_possible += 1;
      if (actual === "allowed") out.under_refusal_count += 1;
    } else if (required === "allowed") {
      out.over_refusal_possible += 1;
      if (actual === "blocked") out.over_refusal_count += 1;
    }
  }

  return out;
}

function loadPublishedSummaries() {
  const byKey = new Map();
  for (const rootName of PUBLISHED_ROOTS) {
    const root = path.join(RUN_ROOT, rootName);
    const reportPath = path.join(root, "validator-report.json");
    if (!fs.existsSync(reportPath)) {
      problems.push(`${rootName}: missing validator-report.json`);
      continue;
    }
    const report = readJson(reportPath);
    if (report.pass !== true || (report.errors || []).length !== 0) {
      problems.push(`${rootName}: validator did not pass cleanly`);
      continue;
    }
    const configs = readJson(path.join(root, "VARIANT_CONFIGS.json")).variants || {};
    for (const [variantKey, cfg] of Object.entries(configs)) {
      const summaryPath = path.join(root, variantKey, "summary.json");
      if (!fs.existsSync(summaryPath)) {
        problems.push(`${rootName}/${variantKey}: missing summary.json`);
        continue;
      }
      const key = `${normalizeModel(cfg)}|${normalizeReasoning(variantKey, cfg)}`;
      if (byKey.has(key)) {
        problems.push(`duplicate published key ${key}: ${byKey.get(key).summaryPath} and ${summaryPath}`);
        continue;
      }
      byKey.set(key, { summary: readJson(summaryPath), summaryPath });
    }
  }
  return byKey;
}

const published = loadPublishedSummaries();
const lb = readJson(SITE);
const scenarioDetail = readJson(SITE_SCENARIOS);
const live = (lb.rows || []).filter((r) => !r.archived);
const detailModels = new Set(scenarioDetail.models || []);

for (const row of live) {
  const key = `${row.model}|${row.reasoning}`;
  const found = published.get(key);
  if (!found) {
    problems.push(`no published run root for ${key}`);
    continue;
  }
  const s = found.summary;
  const checks = [
    ["modal_accuracy", row.modal_accuracy, pctModal(s)],
    ["pass5", row.pass5, pctP5(s)],
    ["under_refusal", row.under_refusal, underRefusal(s)],
    ["over_refusal", row.over_refusal, overRefusal(s)],
    ["weighted_miss", row.weighted_miss, weightedMiss(s)],
  ];
  for (const [field, publishedValue, realValue] of checks) {
    if (String(publishedValue) !== String(realValue)) {
      problems.push(`${key} ${field}: published "${publishedValue}" != disk "${realValue}" (${found.summaryPath})`);
    }
  }
  if ("cost" in row || "cost_usd_estimate" in row) {
    problems.push(`${key} has a public cost field`);
  }

  const detailLabel = siteModelLabel(row);
  if (!detailModels.has(detailLabel)) {
    problems.push(`scenario-detail missing model ${detailLabel} for leaderboard row ${key}`);
  } else {
    const d = scenarioDetailSummary(detailLabel, scenarioDetail.scenarios || []);
    const detailChecks = [
      ["scenario-detail modal_accuracy", `${(d.modal_correct / d.modal_possible * 100).toFixed(1)}% (${d.modal_correct}/${d.modal_possible})`, pctModal(s)],
      ["scenario-detail pass5", `${(d.pass_all / d.modal_possible * 100).toFixed(1)}%`, pctP5(s)],
      ["scenario-detail under_refusal", `${pct1((d.under_refusal_count / d.under_refusal_possible) * 100)}% (${d.under_refusal_count}/${d.under_refusal_possible})`, underRefusal(s)],
      ["scenario-detail over_refusal", `${pct1((d.over_refusal_count / d.over_refusal_possible) * 100)}% (${d.over_refusal_count}/${d.over_refusal_possible})`, overRefusal(s)],
      ["mean_trial_accuracy", row.mean_trial_accuracy, `${(d.mean_correct / d.mean_possible * 100).toFixed(1)}%`],
      ["mean_trial_accuracy_ci95", row.mean_trial_accuracy_ci95, ciString(d.mean_correct, d.mean_possible)],
      ["modal_accuracy_ci95", row.modal_accuracy_ci95, ciString(d.modal_correct, d.modal_possible)],
      ["pass5_ci95", row.pass5_ci95, ciString(d.pass_all, d.modal_possible)],
    ];
    for (const [field, detailValue, realValue] of detailChecks) {
      if (String(detailValue) !== String(realValue)) {
        problems.push(`${key} ${field}: scenario-detail "${detailValue}" != disk "${realValue}"`);
      }
    }
  }
}

for (const model of detailModels) {
  if (!live.some((row) => siteModelLabel(row) === model)) {
    problems.push(`scenario-detail model ${model} is not represented on the site leaderboard`);
  }
}

for (const key of published.keys()) {
  if (!live.some((row) => `${row.model}|${row.reasoning}` === key)) {
    problems.push(`published root ${key} is not represented on the site leaderboard`);
  }
}

if (problems.length) {
  console.log(`FABRICATION GATE FAILED. ${problems.length} mismatch(es):`);
  for (const p of problems) console.log(`  x ${p}`);
  process.exit(1);
}

console.log(`FABRICATION GATE PASSED: ${live.length} live rows match disk and no public cost fields were found.`);
