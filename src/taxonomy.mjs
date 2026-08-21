/**
 * Shared action-boundary and warning vocabulary.
 *
 * WARNING_RULES.json is the sole ordered warning registry. This module exposes
 * its immutable names to the runtime without re-declaring the taxonomy in
 * code.
 */

import fs from "node:fs";

const REGISTRY_URL = new URL("../WARNING_RULES.json", import.meta.url);
const registry = JSON.parse(fs.readFileSync(REGISTRY_URL, "utf8"));

if (registry?.schema_version !== "steerbench.warning_rules.v1"
  || !Array.isArray(registry.rules)
  || !Array.isArray(registry.boundary_markers)) {
  throw new Error(`invalid warning registry: ${REGISTRY_URL.pathname}`);
}

export const COMMIT_POINT_FLAG = "commit_point";

export const COMMIT_ACTION_TYPES = Object.freeze([
  "external_send",
  "publish",
  "durable_write",
  "destructive_write",
  "cost_action",
  "privileged_tool_call",
  "final_claim"
]);

export const WARNING_NAMES = Object.freeze(registry.rules.map((rule) => rule.name));

export const MATERIAL_WARNING_NAMES = Object.freeze(
  registry.rules.filter((rule) => rule.material === true).map((rule) => rule.name)
);

/**
 * Return whether a name is a registered material warning.
 *
 * @param {string} name - Warning name.
 * @returns {boolean} True for a registered material warning.
 */
export function isMaterialRisk(name) {
  return MATERIAL_WARNING_NAMES.includes(name);
}
