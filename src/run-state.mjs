// Run-state lifecycle module for SteerBench-Work.
//
// One run-state.json file lives in every run root. It tracks the
// lifecycle of every planned variant and computes the run-level
// overall status from the per-variant states.
//
// Per-variant status values:
//   not_started        no trial files written for the variant yet
//   in_progress        the runner is mid-flight on the variant
//   completed          every manifest scenario has its full trial set
//   partial            the run covered only a subset of the manifest;
//                      more scenarios must be filled before it can be
//                      a final reported result
//   infra_failed       at least one trial in scope is recorded as
//                      infrastructure_failed (retries exhausted on
//                      transient HTTP / rate-limit / network failure)
//   interrupted        the runner received SIGINT or SIGTERM mid-flight
//
// Overall run status:
//   in_progress                  any variant is not_started or in_progress
//   completed                    every planned variant is completed
//   incomplete_infra_failures    at least one variant is infra_failed
//                                and no variant is in_progress
//   interrupted                  the runner caught a signal mid-flight
//
// Resume rules:
//   completed     -> refused (cannot overwrite final results)
//   partial       -> allowed; resuming fills the remaining scenarios
//   infra_failed  -> allowed; resuming retries the failed trials
//   interrupted   -> allowed; resuming continues the variant
//   in_progress   -> allowed but warned (could be a parallel run)
//   not_started   -> allowed (fresh run on the variant)

import fs from "node:fs";
import path from "node:path";

const RUN_STATE_FILE = "run-state.json";

export const VARIANT_STATUS = Object.freeze({
  NOT_STARTED: "not_started",
  IN_PROGRESS: "in_progress",
  COMPLETED: "completed",
  PARTIAL: "partial",
  INFRA_FAILED: "infra_failed",
  INTERRUPTED: "interrupted"
});

export const OVERALL_STATUS = Object.freeze({
  IN_PROGRESS: "in_progress",
  COMPLETED: "completed",
  INCOMPLETE_INFRA_FAILURES: "incomplete_infra_failures",
  INTERRUPTED: "interrupted"
});

function runStatePath(runRoot) {
  return path.join(runRoot, RUN_STATE_FILE);
}

/**
 * Initialize run-state.json for a planned run. Refuses to overwrite an
 * existing file; callers should call `loadRunState` first when resuming.
 */
export function initRunState({ runRoot, runId, mode, plannedVariants }) {
  const p = runStatePath(runRoot);
  if (fs.existsSync(p)) {
    throw new Error(`run-state.json already exists at ${p}; refusing to overwrite`);
  }
  const now = new Date().toISOString();
  const variantRuns = {};
  for (const v of plannedVariants) {
    variantRuns[v] = {
      status: VARIANT_STATUS.NOT_STARTED,
      started_at: null,
      finished_at: null,
      resume_count: 0,
      interrupt_signal: null,
      n_calls_made: 0,
      n_trials_reused: 0,
      n_errors: 0,
      n_truncated: 0,
      n_parse_failed: 0,
      n_infrastructure_failed: 0
    };
  }
  const state = {
    schema_version: "steerbench.run_state.v1",
    run_id: runId,
    mode,
    created_at: now,
    updated_at: now,
    planned_variants: plannedVariants,
    variant_runs: variantRuns,
    overall_status: OVERALL_STATUS.IN_PROGRESS
  };
  fs.writeFileSync(p, JSON.stringify(state, null, 2));
  return state;
}

export function loadRunState(runRoot) {
  const p = runStatePath(runRoot);
  if (!fs.existsSync(p)) {
    throw new Error(`run-state.json missing at ${p}`);
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

/**
 * Compute the overall status from per-variant states. Pure function.
 */
export function computeOverallStatus(variantRuns, plannedVariants) {
  const states = plannedVariants.map((v) => variantRuns[v]?.status ?? VARIANT_STATUS.NOT_STARTED);
  if (states.some((s) => s === VARIANT_STATUS.INTERRUPTED)) {
    return OVERALL_STATUS.INTERRUPTED;
  }
  if (states.some((s) =>
    s === VARIANT_STATUS.IN_PROGRESS ||
    s === VARIANT_STATUS.NOT_STARTED ||
    s === VARIANT_STATUS.PARTIAL)) {
    return OVERALL_STATUS.IN_PROGRESS;
  }
  if (states.some((s) => s === VARIANT_STATUS.INFRA_FAILED)) {
    return OVERALL_STATUS.INCOMPLETE_INFRA_FAILURES;
  }
  if (states.every((s) => s === VARIANT_STATUS.COMPLETED)) {
    return OVERALL_STATUS.COMPLETED;
  }
  return OVERALL_STATUS.IN_PROGRESS;
}

/**
 * Atomically update one variant's record and recompute overall_status.
 * `patch` is a partial object merged into the existing variant record.
 */
export function updateVariantRun(runRoot, variantKey, patch) {
  const state = loadRunState(runRoot);
  if (!state.variant_runs[variantKey]) {
    throw new Error(`Variant ${variantKey} is not in run plan; cannot update`);
  }
  state.variant_runs[variantKey] = {
    ...state.variant_runs[variantKey],
    ...patch
  };
  state.overall_status = computeOverallStatus(state.variant_runs, state.planned_variants);
  state.updated_at = new Date().toISOString();
  fs.writeFileSync(runStatePath(runRoot), JSON.stringify(state, null, 2));
  return state;
}

/**
 * Disk-based completeness check for a variant. A variant is complete only
 * when every scenario in the manifest has a cell.json plus its full set of
 * trial-N.json files under the variant directory. Used to decide whether a
 * run (which may have covered only a subset of scenarios) may be marked
 * COMPLETED, or must stay PARTIAL.
 *
 * Returns { complete: boolean, present: number, missing: string[] }.
 */
export function variantCellsComplete(runRoot, variantKey, manifest, nTrialsPerCell) {
  const variantDir = path.join(runRoot, variantKey);
  const missing = [];
  let present = 0;
  for (const s of manifest.scenarios) {
    const cellDir = path.join(variantDir, s.id);
    const cellJson = path.join(cellDir, "cell.json");
    if (!fs.existsSync(cellJson)) { missing.push(s.id); continue; }
    let trialsOk = true;
    for (let t = 1; t <= nTrialsPerCell; t += 1) {
      if (!fs.existsSync(path.join(cellDir, `trial-${t}.json`))) { trialsOk = false; break; }
    }
    if (!trialsOk) { missing.push(s.id); continue; }
    present += 1;
  }
  return { complete: missing.length === 0, present, missing };
}

/**
 * Decide whether a fresh variant run may proceed against an existing
 * per-variant record.
 *
 * @param {object} variantRun - The variant record, read for its status.
 * @returns {{allowed: boolean, reason: string, isResume: boolean}}
 */
export function canStartVariant(variantRun) {
  const s = variantRun.status;
  if (s === VARIANT_STATUS.COMPLETED) {
    return { allowed: false, reason: "variant already completed; refusing to overwrite", isResume: false };
  }
  if (s === VARIANT_STATUS.NOT_STARTED) {
    return { allowed: true, reason: "fresh start", isResume: false };
  }
  if (s === VARIANT_STATUS.IN_PROGRESS) {
    return { allowed: true, reason: "resuming an in-progress variant (could be a parallel run)", isResume: true };
  }
  if (s === VARIANT_STATUS.PARTIAL) {
    return { allowed: true, reason: "resuming a partial run; remaining scenarios will be filled", isResume: true };
  }
  if (s === VARIANT_STATUS.INFRA_FAILED) {
    return { allowed: true, reason: "resuming after infrastructure failures; previously failed trials will be retried", isResume: true };
  }
  if (s === VARIANT_STATUS.INTERRUPTED) {
    return { allowed: true, reason: "resuming after interrupt", isResume: true };
  }
  return { allowed: false, reason: `unknown status: ${s}`, isResume: false };
}
