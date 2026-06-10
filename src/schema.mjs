// Structured-output schema for SteerBench-Work model responses.
//
// Every model in the benchmark grid is asked to emit a JSON object that
// includes a fixed set of fields. This module is the single place that
// names those fields, lists their allowed values, and turns a raw response
// string into a validated, normalized object that the scorer and the
// runner consume.
//
// Centralizing the schema here means:
//   - The runner does not interpret model output in-line.
//   - The scorer does not re-parse anything.
//   - Any future change to the schema lives in one file.

export const ALLOWED_POLICY_ACTIONS = [
  "continue",
  "show_progress",
  "ask_clarification",
  "request_approval",
  "escalate"
];

export const ALLOWED_COMMIT_PERMISSION = ["allowed", "blocked"];

export const ALLOWED_CLARIFICATION_MODE = [
  "none",
  "answer_then_commit",
  "refuse_pending_auth"
];

// The scored field. Only this field controls modal-of-N and pass^N.
export const SCORED_FIELD = "commit_permission";

/**
 * Extract the model's response text from an OpenAI Responses API payload.
 * Some payloads expose `output_text` directly; others nest text under
 * `output[].content[].text`. Walk both.
 */
export function extractResponseText(apiResponseJson) {
  if (!apiResponseJson) return "";
  if (typeof apiResponseJson.output_text === "string") {
    return apiResponseJson.output_text;
  }
  const chunks = [];
  for (const item of apiResponseJson.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === "string") chunks.push(content.text);
    }
  }
  return chunks.join("\n");
}

function parseJson(value) {
  try { return JSON.parse(value); } catch { return null; }
}

/**
 * Convert raw response text into a structured object that matches the
 * schema. Tries strict JSON.parse first; falls back to the first {...}
 * block; falls back further to per-field regex extraction.
 *
 * Returns the parsed object plus a _parse_recovered flag if a fallback
 * had to be used. Returns null if no field could be extracted at all.
 */
export function extractStructured(rawText) {
  if (typeof rawText !== "string" || !rawText) return null;
  let obj = parseJson(rawText);
  if (!obj) {
    const m = rawText.match(/\{[\s\S]*\}/);
    if (m) obj = parseJson(m[0]);
  }
  if (!obj) {
    const pa = rawText.match(/"policy_action"\s*:\s*"([a-z_]+)"/);
    const cp = rawText.match(/"commit_permission"\s*:\s*"([a-z]+)"/);
    const hr = rawText.match(/"human_required"\s*:\s*(true|false)/);
    const cm = rawText.match(/"clarification_mode"\s*:\s*"([a-z_]+)"/);
    const conf = rawText.match(/"confidence"\s*:\s*([0-9.]+)/);
    const reason = rawText.match(/"reason"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (!pa && !cp) return null;
    obj = {
      policy_action: pa?.[1],
      commit_permission: cp?.[1],
      human_required: hr ? hr[1] === "true" : undefined,
      clarification_mode: cm?.[1],
      confidence: conf ? Number(conf[1]) : 0,
      reason: reason?.[1] || null,
      _parse_recovered: true
    };
  }
  return obj;
}

/**
 * Infer commit_permission from policy_action when the model omitted the
 * gate-state field. continue/show_progress -> allowed; request_approval
 * /escalate -> blocked. ask_clarification is intentionally not mapped
 * because its commit intent is ambiguous without the dedicated field.
 */
function inferCommitPermission(policy_action) {
  if (policy_action === "continue" || policy_action === "show_progress") {
    return "allowed";
  }
  if (policy_action === "request_approval" || policy_action === "escalate") {
    return "blocked";
  }
  return null;
}

/**
 * Take a raw response object and normalize it to the canonical shape.
 * Validates that commit_permission and clarification_mode use allowed
 * enum values. Falls back to inferring commit_permission from
 * policy_action only when the dedicated field is missing or invalid.
 *
 * Returns:
 *   {
 *     policy_action,
 *     commit_permission,         // allowed | blocked | null
 *     human_required,            // boolean | null
 *     clarification_mode,        // one of ALLOWED_CLARIFICATION_MODE | null
 *     confidence,                // number | null
 *     reason,                    // string | null
 *     parse_recovered,           // true if any fallback was used
 *     parse_failed,              // true if no scored field could be derived
 *     normalization_warnings     // list of normalization decisions
 *   }
 */
export function normalize(parsed) {
  const warnings = [];
  if (!parsed) {
    return {
      policy_action: null,
      commit_permission: null,
      human_required: null,
      clarification_mode: null,
      confidence: null,
      reason: null,
      parse_recovered: false,
      parse_failed: true,
      normalization_warnings: ["no parseable response object"]
    };
  }
  const pa = parsed.policy_action ?? null;
  if (pa && !ALLOWED_POLICY_ACTIONS.includes(pa)) {
    warnings.push(`policy_action "${pa}" not in allowed set`);
  }
  let cp = parsed.commit_permission ?? null;
  let cpInferred = false;
  if (!cp || !ALLOWED_COMMIT_PERMISSION.includes(cp)) {
    const fallback = inferCommitPermission(pa);
    if (fallback) {
      cp = fallback;
      cpInferred = true;
      warnings.push(`commit_permission inferred from policy_action "${pa}"`);
    } else {
      cp = null;
    }
  }
  let cm = parsed.clarification_mode ?? null;
  if (cm && !ALLOWED_CLARIFICATION_MODE.includes(cm)) {
    warnings.push(`clarification_mode "${cm}" not in allowed set`);
    cm = null;
  }
  return {
    policy_action: pa,
    commit_permission: cp,
    human_required: typeof parsed.human_required === "boolean" ? parsed.human_required : null,
    clarification_mode: cm,
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : null,
    reason: parsed.reason || null,
    parse_recovered: Boolean(parsed._parse_recovered) || cpInferred,
    parse_failed: !cp && !pa,
    normalization_warnings: warnings
  };
}

/**
 * One-shot helper: take a raw response text, return the normalized
 * structured object. Saves the runner and validators from chaining
 * extractStructured + normalize manually.
 */
export function parseAndNormalize(rawText) {
  return normalize(extractStructured(rawText));
}

/**
 * Validate that a normalized object is usable for scoring. Returns
 * { valid: boolean, reasons: [...] }. A valid record has a non-null
 * commit_permission within the allowed enum.
 */
export function validateForScoring(normalized) {
  const reasons = [];
  if (!normalized) {
    reasons.push("normalized object is null");
    return { valid: false, reasons };
  }
  if (!normalized.commit_permission) {
    reasons.push("commit_permission missing");
  } else if (!ALLOWED_COMMIT_PERMISSION.includes(normalized.commit_permission)) {
    reasons.push(`commit_permission "${normalized.commit_permission}" not in allowed set`);
  }
  return { valid: reasons.length === 0, reasons };
}
