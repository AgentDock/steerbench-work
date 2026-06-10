// Public benchmark CLI for SteerBench-Work.
//
// One command surface for the canonical multi-trial benchmark:
//
//   bench plan       create a planned run root with frozen snapshots
//   bench smoke      one variant + one scenario, output to smoke tree
//   bench run        one variant against an existing planned run root
//   bench status     print run-state + per-variant lifecycle
//   bench validate   run validator against an existing run root
//   bench aggregate  reshape a validated run into publish artifacts
//
// Conventions:
//   - reported runs:  runs/canonical-multi-trial/<run-id>/
//   - smoke runs:     runs/smoke/<run-id>/
//   - explicit path:  --run-dir <path> overrides the run-id mapping
//
// Invocation:
//   node src/bench-cli.mjs <subcommand> [flags]
//   npm run bench -- <subcommand> [flags]

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { REPORTED_RUN_CONFIG } from "../configs/reported-run.mjs";
import { STEERBENCH_STEERING_SYSTEM_PROMPT } from "./prompts.mjs";
import { writeRunPlan, defaultRunId, loadRunPlan } from "./run-plan.mjs";
import { initRunState, loadRunState } from "./run-state.mjs";
import { runVariant, CANONICAL_SCORING_MAPPING } from "./canonical-runner.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const runnerRoot = path.resolve(here, "..");

// === arg parsing ===

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a.startsWith("--")) {
      if (a.includes("=")) {
        const [k, v] = a.split("=", 2);
        flags[k.slice(2)] = v;
      } else {
        const next = args[i + 1];
        if (next === undefined || next.startsWith("--")) {
          flags[a.slice(2)] = true;
        } else {
          flags[a.slice(2)] = next;
          i += 1;
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function resolveRunRoot({ runId, mode, runDirFlag }) {
  if (runDirFlag) {
    return path.isAbsolute(runDirFlag) ? runDirFlag : path.resolve(process.cwd(), runDirFlag);
  }
  if (!runId) throw new Error("either --run-id or --run-dir is required");
  const base = mode === "smoke"
    ? REPORTED_RUN_CONFIG.smoke_output_root
    : REPORTED_RUN_CONFIG.output_root;
  return path.join(runnerRoot, base, runId);
}

/**
 * Pick the API key for a variant based on its vendor.
 *
 * vendor="openai"     -> OPENAI_API_KEY (direct call to api.openai.com)
 * vendor=anything else -> AI_GATEWAY_API_KEY (routed through Vercel AI
 *                        Gateway's OpenAI-compatible Chat Completions
 *                        endpoint)
 *
 * variantKey is required so the error message can point at the offending
 * row in VARIANT_CONFIGS.json instead of just "missing key".
 */
function readApiKeyForVariant(variantKey) {
  const variantConfig = REPORTED_RUN_CONFIG.variants[variantKey];
  if (!variantConfig) {
    throw new Error(`Unknown variant: ${variantKey}. Available: ${Object.keys(REPORTED_RUN_CONFIG.variants).join(", ")}`);
  }
  const vendor = variantConfig.vendor || "openai";
  if (vendor === "openai") {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error(`Variant ${variantKey} requires OPENAI_API_KEY in the environment (vendor=openai)`);
    return key;
  }
  const key = process.env.AI_GATEWAY_API_KEY;
  if (!key) throw new Error(`Variant ${variantKey} requires AI_GATEWAY_API_KEY in the environment (vendor=${vendor}, routed through Vercel AI Gateway)`);
  return key;
}

// === subcommands ===

function cmdPlan(args) {
  const { flags } = parseFlags(args);
  const mode = flags.mode || "reported-run";
  if (mode !== "reported-run" && mode !== "smoke") {
    throw new Error(`Invalid --mode "${mode}"; expected "reported-run" or "smoke"`);
  }
  const runId = flags["run-id"] || defaultRunId(mode === "smoke" ? "smoke" : "tm");
  const runRoot = resolveRunRoot({ runId, mode, runDirFlag: flags["run-dir"] });
  if (fs.existsSync(runRoot) && fs.existsSync(path.join(runRoot, "RUN_PLAN.json"))) {
    throw new Error(`Run root already planned at ${runRoot}; pick a fresh --run-id`);
  }
  const variantsArg = flags.variants;
  const plannedVariants = variantsArg
    ? variantsArg.split(",").map((s) => s.trim()).filter(Boolean)
    : Object.keys(REPORTED_RUN_CONFIG.variants);
  for (const v of plannedVariants) {
    if (!REPORTED_RUN_CONFIG.variants[v]) {
      throw new Error(`Unknown variant: ${v}. Available: ${Object.keys(REPORTED_RUN_CONFIG.variants).join(", ")}`);
    }
  }

  const scenarioSetDir = flags["scenario-set-dir"]
    || REPORTED_RUN_CONFIG.scenario_set_dir;

  fs.mkdirSync(runRoot, { recursive: true });
  const plan = writeRunPlan({
    runRoot,
    runId,
    scenarioSet: REPORTED_RUN_CONFIG.scenario_set,
    scenarioSetDir,
    scenarioSetDirAbsolute: path.isAbsolute(scenarioSetDir)
      ? scenarioSetDir
      : path.join(runnerRoot, scenarioSetDir),
    plannedVariants,
    variants: REPORTED_RUN_CONFIG.variants,
    prompt: STEERBENCH_STEERING_SYSTEM_PROMPT,
    nTrialsPerCell: REPORTED_RUN_CONFIG.n_trials_per_cell,
    scoringField: REPORTED_RUN_CONFIG.scoring_field,
    passKLevels: [REPORTED_RUN_CONFIG.n_trials_per_cell],
    mode,
    scoringMapping: { ...CANONICAL_SCORING_MAPPING }
  });
  initRunState({
    runRoot,
    runId,
    mode,
    plannedVariants
  });

  console.log("Plan written.");
  console.log(`  run_id:             ${plan.run_id}`);
  console.log(`  run_root:           ${runRoot}`);
  console.log(`  mode:               ${plan.mode}`);
  console.log(`  scenario_set:       ${plan.scenario_set} (${plan.scenario_count} scenarios)`);
  console.log(`  n_trials_per_cell:  ${plan.n_trials_per_cell}`);
  console.log(`  planned_variants:   ${plan.planned_variants.join(", ")}`);
  console.log(`  prompt_sha256:      ${plan.prompt_sha256}`);
}

async function cmdRun(args) {
  const { flags } = parseFlags(args);
  const variant = flags.variant;
  if (!variant) throw new Error("--variant is required");
  const runRoot = resolveRunRoot({
    runId: flags["run-id"],
    mode: flags.mode || "reported-run",
    runDirFlag: flags["run-dir"]
  });
  if (!fs.existsSync(path.join(runRoot, "RUN_PLAN.json"))) {
    throw new Error(`No plan found at ${runRoot}. Run "bench plan --run-id ${flags["run-id"]}" first.`);
  }
  // Refuse a fresh full-grid run unless --confirm is present
  const plan = loadRunPlan(runRoot);
  if (plan.mode === "reported-run" && !flags.confirm) {
    throw new Error(`Reported-run variant requires --confirm. Re-run with --confirm to launch ${plan.scenario_count} scenarios x ${plan.n_trials_per_cell} trials for variant ${variant}.`);
  }
  const scenarioFilter = parseScenarioSubset(flags);
  if (scenarioFilter) {
    console.log(`Subset run: ${scenarioFilter.size} scenario(s). The variant stays partial until all ${plan.scenario_count} scenarios have full cells; aggregate is refused until then.`);
  }
  const apiKey = readApiKeyForVariant(variant);
  const resume = flags["no-resume"] !== true;
  const result = await runVariant({
    runRoot,
    variantKey: variant,
    scenarioFilter,
    apiKey,
    resume,
    log: (msg) => console.log(msg)
  });
  if (result.n_infra_failed > 0) {
    console.error(`\nVariant ${variant} finished with ${result.n_infra_failed} infrastructure failures. Re-run with the same command to retry the failed trials.`);
    process.exit(2);
  }
}

/**
 * Parse a scenario subset from either --scenario <id> (single) or
 * --scenarios id1,id2,id3 (comma-separated). Returns a Set or null.
 */
function parseScenarioSubset(flags) {
  const ids = [];
  if (typeof flags.scenario === "string") ids.push(flags.scenario);
  if (typeof flags.scenarios === "string") {
    for (const part of flags.scenarios.split(",").map((s) => s.trim()).filter(Boolean)) {
      ids.push(part);
    }
  }
  return ids.length > 0 ? new Set(ids) : null;
}

async function cmdSmoke(args) {
  const { flags } = parseFlags(args);
  const variant = flags.variant;
  if (!variant) throw new Error("--variant is required");
  const subset = parseScenarioSubset(flags);
  if (!subset) throw new Error("--scenario <id> or --scenarios id1,id2,... is required");
  const runId = flags["run-id"] || defaultRunId("smoke");
  const runRoot = resolveRunRoot({ runId, mode: "smoke", runDirFlag: flags["run-dir"] });

  // Plan inline. The smoke manifest is filtered to exactly the requested
  // scenarios, so smoke output is self-contained dev/test material and is
  // never mistaken for a full reported run.
  if (!fs.existsSync(path.join(runRoot, "RUN_PLAN.json"))) {
    fs.mkdirSync(runRoot, { recursive: true });
    writeRunPlan({
      runRoot,
      runId,
      scenarioSet: REPORTED_RUN_CONFIG.scenario_set,
      scenarioSetDir: REPORTED_RUN_CONFIG.scenario_set_dir,
      scenarioSetDirAbsolute: path.join(runnerRoot, REPORTED_RUN_CONFIG.scenario_set_dir),
      scenarioFilter: subset,
      plannedVariants: [variant],
      variants: REPORTED_RUN_CONFIG.variants,
      prompt: STEERBENCH_STEERING_SYSTEM_PROMPT,
      nTrialsPerCell: REPORTED_RUN_CONFIG.n_trials_per_cell,
      scoringField: REPORTED_RUN_CONFIG.scoring_field,
      passKLevels: [REPORTED_RUN_CONFIG.n_trials_per_cell],
      mode: "smoke",
      scoringMapping: { ...CANONICAL_SCORING_MAPPING }
    });
    initRunState({ runRoot, runId, mode: "smoke", plannedVariants: [variant] });
  }
  const apiKey = readApiKeyForVariant(variant);
  const result = await runVariant({
    runRoot,
    variantKey: variant,
    scenarioFilter: subset,
    apiKey,
    resume: flags["no-resume"] !== true,
    log: (msg) => console.log(msg)
  });
  if (result.n_infra_failed > 0) {
    console.error(`\nSmoke run finished with ${result.n_infra_failed} infrastructure failures.`);
    process.exit(2);
  }
}

function cmdStatus(args) {
  const { flags } = parseFlags(args);
  const runRoot = resolveRunRoot({
    runId: flags["run-id"],
    mode: flags.mode || "reported-run",
    runDirFlag: flags["run-dir"]
  });
  if (!fs.existsSync(path.join(runRoot, "RUN_PLAN.json"))) {
    throw new Error(`No plan found at ${runRoot}`);
  }
  const plan = loadRunPlan(runRoot);
  const state = loadRunState(runRoot);
  console.log(`run_id:           ${plan.run_id}`);
  console.log(`run_root:         ${runRoot}`);
  console.log(`mode:             ${plan.mode}`);
  console.log(`overall_status:   ${state.overall_status}`);
  console.log(`scenario_count:   ${plan.scenario_count}`);
  console.log(`n_trials_per_cell:${plan.n_trials_per_cell}`);
  console.log(`planned_variants: ${plan.planned_variants.join(", ")}`);
  console.log("");
  console.log("per-variant lifecycle:");
  for (const v of plan.planned_variants) {
    const r = state.variant_runs[v];
    console.log(`  ${v.padEnd(12)} status=${r.status.padEnd(14)} calls=${String(r.n_calls_made).padStart(4)} reused=${String(r.n_trials_reused).padStart(4)} infra=${String(r.n_infrastructure_failed).padStart(2)} parse=${String(r.n_parse_failed).padStart(2)} trunc=${String(r.n_truncated).padStart(2)}`);
  }
}

function cmdValidate(args) {
  const { flags } = parseFlags(args);
  const runRoot = resolveRunRoot({
    runId: flags["run-id"],
    mode: flags.mode || "reported-run",
    runDirFlag: flags["run-dir"]
  });
  const scriptArgs = ["scripts/validate-run.mjs", "--run", runRoot];
  if (flags.variant) scriptArgs.push("--variant", flags.variant);
  if (flags.quiet) scriptArgs.push("--quiet");
  if (flags["allow-incomplete"]) scriptArgs.push("--allow-incomplete");
  const r = spawnSync("node", scriptArgs, { cwd: runnerRoot, stdio: "inherit" });
  process.exit(r.status ?? 1);
}

function cmdAggregate(args) {
  const { flags } = parseFlags(args);
  const runRoot = resolveRunRoot({
    runId: flags["run-id"],
    mode: flags.mode || "reported-run",
    runDirFlag: flags["run-dir"]
  });
  const scriptArgs = ["scripts/aggregate-canonical.mjs", "--run", runRoot];
  if (flags["force-without-validator"]) scriptArgs.push("--force-without-validator");
  const r = spawnSync("node", scriptArgs, { cwd: runnerRoot, stdio: "inherit" });
  process.exit(r.status ?? 1);
}

function cmdHelp() {
  console.log(`
bench - SteerBench-Work canonical multi-trial benchmark CLI

Usage:
  bench <subcommand> [flags]

Subcommands:
  plan          Create a planned run root with frozen protocol snapshots.
                Flags: --run-id <id>      (optional; defaults to fresh tm- timestamp)
                       --mode <m>          reported-run | smoke (default reported-run)
                       --variants <list>   comma-separated subset (default: all)
                       --scenario-set-dir  override scenario directory

  smoke         One variant against a scenario subset, written to
                runs/smoke/<run-id>/. The smoke manifest is filtered to
                exactly the requested scenarios, so smoke output is dev/test
                material, never a full reported run. Plans inline if needed.
                Flags: --variant <v> (--scenario <id> | --scenarios id1,id2,...)
                       [--run-id <id>] [--no-resume]

  run           Run one variant against an existing planned run root.
                Flags: --run-id <id> --variant <v> [--confirm] [--no-resume]
                       [--scenario <id> | --scenarios id1,id2,...]
                --confirm required for reported-run mode. A scenario subset
                executes only those cells and leaves the variant "partial";
                the variant is "completed" only when every planned scenario
                has a full cell, and aggregate is refused until then.

  status        Print run-state + per-variant lifecycle for a planned run root.
                Flags: --run-id <id> [--mode <m>]

  validate      Run validator-report against a planned run root.
                Flags: --run-id <id> [--variant <v>] [--quiet] [--allow-incomplete]

  aggregate     Reshape a validated run into publish artifacts.
                Flags: --run-id <id> [--force-without-validator]

Run-root resolution:
  Reported runs:  runs/canonical-multi-trial/<run-id>/
  Smoke runs:     runs/smoke/<run-id>/
  Override:       --run-dir <path>

Environment:
  OPENAI_API_KEY      required for "run" and "smoke" when the variant's
                      vendor is "openai" (direct call to api.openai.com).
  AI_GATEWAY_API_KEY  required for "run" and "smoke" when the variant's
                      vendor is anything other than "openai" (anthropic, google, openai-oss, deepseek, moonshotai)
                      (routed through the Vercel AI Gateway).
`);
}

async function main() {
  const argv = process.argv.slice(2);
  const sub = argv[0];
  const rest = argv.slice(1);
  try {
    switch (sub) {
      case "plan":      return cmdPlan(rest);
      case "smoke":     return await cmdSmoke(rest);
      case "run":       return await cmdRun(rest);
      case "status":    return cmdStatus(rest);
      case "validate":  return cmdValidate(rest);
      case "aggregate": return cmdAggregate(rest);
      case undefined:
      case "help":
      case "--help":
      case "-h":
        return cmdHelp();
      default:
        console.error(`Unknown subcommand: ${sub}`);
        cmdHelp();
        process.exit(1);
    }
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}

main();
