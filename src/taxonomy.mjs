// Shared vocabulary for the steering taxonomy: the action types that mark a
// commit point, and the risk flags that count as materially risky. Risk
// detection and steering policy both read from these lists so the two stay
// in sync from a single source.

export const COMMIT_POINT_FLAG = "commit_point";

export const COMMIT_ACTION_TYPES = [
  "external_send",
  "publish",
  "durable_write",
  "destructive_write",
  "cost_action",
  "privileged_tool_call",
  "final_claim"
];

export const MATERIAL_RISK_FLAGS = [
  "conflicting_policy_versions",
  "possible_data_leakage",
  "protected_path_change",
  "medium_or_low_confidence",
  "cost_action_requires_review",
  "sensitive_privilege",
  "low_reversibility_external",
  "success_criterion_change",
  "changed_judge_without_product_fix",
  "hidden_eval_data_access",
  "protected_surface_change",
  "broad_unrelated_diff",
  "destructive_change",
  "sensitive_surface_access",
  "suspect_evidence_used",
  "secret_exposure_risk"
];

/**
 * Whether a risk flag is in the material-risk set that can trigger a human gate.
 *
 * @param {string} flag - Risk flag name.
 * @returns {boolean} True when the flag is materially risky.
 */
export function isMaterialRisk(flag) {
  return MATERIAL_RISK_FLAGS.includes(flag);
}
