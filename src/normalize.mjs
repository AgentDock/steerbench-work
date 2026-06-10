export const CANONICAL_DOMAINS = Object.freeze([
  "customer-service",
  "developer-ops",
  "engineering-ops",
  "finance-ops",
  "financial",
  "hr-ops",
  "legal",
  "marketing-ops",
  "medical",
  "research-ops",
  "safety-critical",
  "security"
]);

export const BASELINE_DOMAIN_NORMALIZATION = Object.freeze({
  customer_ops: "customer-service",
  developer_ops: "developer-ops",
  finance_ops: "finance-ops",
  go_to_market_ops: "marketing-ops",
  privacy_ops: "security",
  research_ops: "research-ops",
  support_ops: "customer-service",
  team_ops: "hr-ops"
});

export const CANONICAL_ACTION_EFFECTS = Object.freeze([
  "cost_action",
  "destructive_write",
  "disclose",
  "durable_write",
  "external_send",
  "final_claim",
  "internal_update",
  "network_egress",
  "physical_actuation",
  "privileged_tool_call",
  "publish",
  "read",
  "schedule",
  "transfer"
]);

export function normalizeDomain({ taxonomyDomain, legacyDomain }) {
  if (taxonomyDomain != null) return taxonomyDomain;
  if (legacyDomain == null) return null;
  return BASELINE_DOMAIN_NORMALIZATION[legacyDomain] ?? null;
}

export function isCanonicalDomain(domain) {
  return domain != null && CANONICAL_DOMAINS.includes(domain);
}

export function isCanonicalActionEffect(actionEffect) {
  return actionEffect != null && CANONICAL_ACTION_EFFECTS.includes(actionEffect);
}
