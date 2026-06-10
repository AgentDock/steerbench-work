// Trial store module for SteerBench-Work.
//
// Trial files are append-only, provenance-bearing JSON records. A trial
// may only be reused on resume if every provenance field matches the
// run plan and the per-trial context. Any mismatch invalidates the
// trial and forces a fresh call.
//
// Trial status values:
//   ok                      successful API call, scoring fields parsed
//   parse_failed            successful API call, response did not parse
//                           against the structured schema
//   truncated               successful API call, model hit output cap;
//                           commit_permission may still be present
//   infrastructure_failed   API call exhausted retries on transient
//                           HTTP / rate-limit / network failure; the
//                           model never produced a final output
//   provider_filtered       provider's own content filter rejected the
//                           request deterministically (e.g. an HTTP 400
//                           with a content-policy code); the model never
//                           reasoned about the scenario. This is a
//                           recorded benchmark outcome, NOT an infra
//                           failure: re-running yields the same refusal,
//                           so the trial is terminal and reusable.
//
// Only `ok` (and `truncated` if commit_permission is populated) count
// as scorable. `parse_failed` is scored as wrong. `infrastructure_failed`
// invalidates the run until rerun. `provider_filtered` is excluded from
// the scored denominator and reported separately.

import fs from "node:fs";

export const TRIAL_STATUS = Object.freeze({
  OK: "ok",
  PARSE_FAILED: "parse_failed",
  TRUNCATED: "truncated",
  INFRASTRUCTURE_FAILED: "infrastructure_failed",
  PROVIDER_FILTERED: "provider_filtered"
});

/**
 * Provenance fields that must match between the saved trial and the
 * current run plan for the trial to be reused on resume.
 */
const REQUIRED_PROVENANCE_FIELDS = [
  "run_id",
  "scenario_id",
  "scenario_sha256",
  "variant_key",
  "variant_config_hash",
  "prompt_sha256",
  "trial",
  "expected_action"
];

/**
 * Decide whether a saved trial file may be reused as-is.
 *
 * Inputs:
 *   trialPath            file path on disk
 *   expectedProvenance   { run_id, scenario_id, scenario_sha256,
 *                         variant_key, variant_config_hash,
 *                         prompt_sha256, trial, expected_action }
 *
 * Returns:
 *   { reusable: bool, reason: string, trial: object|null }
 *
 * Reuse rules:
 *   - File must exist and parse as JSON.
 *   - Every provenance field must match exactly.
 *   - Trial status must be one of `ok`, `parse_failed`, `truncated`, or
 *     `provider_filtered`. `infrastructure_failed` trials are always
 *     re-run; `provider_filtered` is terminal (deterministic provider
 *     refusal) and reused like a scored outcome.
 */
export function readTrialIfReusable(trialPath, expectedProvenance) {
  if (!fs.existsSync(trialPath)) {
    return { reusable: false, reason: "file missing", trial: null };
  }
  let trial;
  try {
    trial = JSON.parse(fs.readFileSync(trialPath, "utf8"));
  } catch (e) {
    return { reusable: false, reason: `parse error: ${e.message}`, trial: null };
  }
  for (const f of REQUIRED_PROVENANCE_FIELDS) {
    if (trial[f] === undefined || trial[f] === null) {
      return { reusable: false, reason: `missing provenance field "${f}"`, trial: null };
    }
    if (trial[f] !== expectedProvenance[f]) {
      return {
        reusable: false,
        reason: `provenance drift on "${f}": file=${JSON.stringify(trial[f])} expected=${JSON.stringify(expectedProvenance[f])}`,
        trial: null
      };
    }
  }
  if (trial.status === TRIAL_STATUS.INFRASTRUCTURE_FAILED) {
    return { reusable: false, reason: "infrastructure_failed: must be re-run", trial: null };
  }
  if (![
    TRIAL_STATUS.OK,
    TRIAL_STATUS.PARSE_FAILED,
    TRIAL_STATUS.TRUNCATED,
    TRIAL_STATUS.PROVIDER_FILTERED
  ].includes(trial.status)) {
    return { reusable: false, reason: `unknown trial status: ${trial.status}`, trial: null };
  }
  return { reusable: true, reason: "all provenance matches", trial };
}

/**
 * Write a trial record. Caller is responsible for assembling the full
 * shape; this helper just enforces presence of provenance and writes
 * pretty-printed JSON.
 */
export function writeTrial(trialPath, trial) {
  for (const f of REQUIRED_PROVENANCE_FIELDS) {
    if (trial[f] === undefined || trial[f] === null) {
      throw new Error(`Cannot write trial without provenance field "${f}"`);
    }
  }
  if (!Object.values(TRIAL_STATUS).includes(trial.status)) {
    throw new Error(`Invalid trial status: ${trial.status}`);
  }
  fs.writeFileSync(trialPath, JSON.stringify(trial, null, 2));
}
