// Canonical multi-trial runner for SteerBench-Work.
//
// runVariant runs one model variant against the scenarios in a planned
// run root. The run root must already have been planned via
// writeRunPlan; the runner only reads the frozen snapshots and writes
// per-variant trial / cell / summary outputs plus the run-state update.
//
// The runner is invoked through bench-cli.mjs, not the public CLI directly.
//
// Vendor routing
// --------------
// Each variant in VARIANT_CONFIGS.json carries a `vendor` field:
//
//   "openai"      Direct call to https://api.openai.com/v1/responses with
//                 OPENAI_API_KEY. Uses the Responses API request and
//                 response shape. This path is byte-identical to the
//                 single-vendor request shape, so OpenAI trial files remain
//                 provenance-stable.
//
//   "anthropic"   Routed through the Vercel AI Gateway's OpenAI-compatible
//   "google"      Chat Completions endpoint, authorized with
//   "openweight"  AI_GATEWAY_API_KEY. The Chat Completions request shape
//                 is used, with the model field sent as "<vendor>/<model-id>"
//                 so the gateway can fan out to the right upstream provider.
//                 Response text is read from choices[0].message.content.
//
// The Vercel AI Gateway base URL is defined at the call site.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const runnerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function resolveScenarioSetDir(planScenarioSetDir) {
  return path.isAbsolute(planScenarioSetDir)
    ? planScenarioSetDir
    : path.join(runnerRoot, planScenarioSetDir);
}

import { parseAndNormalize } from "./schema.mjs";
import {
  computeCellScore,
  isCorrectByPermission,
  irreversibilityWeight,
  weightedSeverity,
  directionalErrorRates,
  CANONICAL_SCORING_MAPPING
} from "./scorer.mjs";
import { normalizeDomain } from "./normalize.mjs";
import {
  loadRunPlan,
  loadVariantConfigs,
  loadRunPrompt
} from "./run-plan.mjs";
import {
  loadScenarioManifestFromRunRoot,
  indexManifestById,
  sha256File
} from "./manifest.mjs";
import {
  loadRunState,
  updateVariantRun,
  canStartVariant,
  variantCellsComplete,
  VARIANT_STATUS
} from "./run-state.mjs";
import {
  TRIAL_STATUS,
  readTrialIfReusable,
  writeTrial
} from "./trial-store.mjs";

// Reuse the existing scenario reshape + model-input rendering pipeline.
import { ActionGateway, WorkerAgent } from "./policies.mjs";
import { inputForModel, renderUserMessage } from "./model-input.mjs";

const REVERSIBILITY_BY_IRREVERSIBILITY = Object.freeze({
  none: "high",
  low: "high",
  soft_to_reverse: "high",
  medium: "medium",
  high: "low",
  hard_to_reverse: "low"
});

/**
 * Convert the corpus's irreversibility class into the runtime reversibility
 * field. The two concepts point in opposite directions.
 *
 * @param {string} irreversibilityClass - Corpus-side irreversibility label.
 * @returns {"low"|"medium"|"high"} Runtime reversibility.
 * @throws Error for an unknown or missing class.
 */
export function reversibilityFromIrreversibility(irreversibilityClass) {
  const value = REVERSIBILITY_BY_IRREVERSIBILITY[irreversibilityClass];
  if (!value) throw new Error(`unknown irreversibility class: ${JSON.stringify(irreversibilityClass)}`);
  return value;
}

export function reshapeToLegacy(json) {
  const evidence = (json.evidence || []).map((e) => ({
    evidence_id: e.legacy_id || e.id, title: e.title, status: e.status,
    raw_ref: e.raw_ref, source_type: e.source_type
  }));
  // The decision-point list is the evidence available at the commit moment.
  // expected_evidence belongs to the answer key and must never select what the
  // model sees.
  const evidenceIds = (json.decision_point?.evidence_ids || []).map((id) =>
    (json.evidence || []).find((e) => e.id === id || e.legacy_id === id)?.legacy_id || id
  );
  const action = json.metadata?.legacy_action
    ? { ...json.metadata.legacy_action, evidence_ids: evidenceIds }
    : {
        action_type: json.action_verb,
        proposed_action: json.decision_point?.proposed_action || json.title || "",
        draft: json.decision_point?.draft || null,
        confidence: json.decision_point?.confidence !== undefined ? json.decision_point.confidence : 0.7,
        reversibility: reversibilityFromIrreversibility(json.irreversibility_class),
        evidence_ids: evidenceIds,
        commit_category: json.action_verb === "external_send" ? "external_communication" : "internal_action",
        target_scope: "system", durability: "durable",
        externality: json.action_verb === "external_send" ? "outside_workspace" : "inside_workspace",
        privilege_level: "normal", cost_level: "none"
      };
  const domain = normalizeDomain({
    taxonomyDomain: json.taxonomy?.domain ?? null,
    legacyDomain: json.domain ?? null
  });
  return {
    id: json.id, family: json.metadata?.legacy_family || json.domain, title: json.title,
    goal: json.context?.goal, user_request: json.user_request,
    quality_tags: json.metadata?.legacy_quality_tags || json.tags || [],
    action, evidence,
    integrity_evidence: json.integrity_evidence,
    human_correction: json.expected_behavior?.human_correction,
    recovery_summary: json.expected_behavior?.recovery_summary,
    autonomous_failure: json.expected_behavior?.autonomous_failure,
    clean_outcome: json.expected_behavior?.clean_outcome,
    source_basis: json.source_basis, expected_evidence: json.expected_evidence,
    license: json.license, contributors: json.contributors, version: json.version,
    domain, action_verb: json.action_verb,
    irreversibility_class: json.irreversibility_class,
    _raw_expected_behavior: json.expected_behavior || null,
    _raw_taxonomy: json.taxonomy || null
  };
}

/**
 * Pull the assistant text out of an OpenAI Responses API payload.
 * Shape: { output: [ { type: "message", content: [ { type: "output_text",
 * text: "..." } ] } ] }
 */
function extractResponseTextOpenAI(json) {
  if (!json || !Array.isArray(json.output)) return "";
  for (const item of json.output) {
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const c of item.content) {
        if (c.type === "output_text" && typeof c.text === "string") return c.text;
      }
    }
  }
  return "";
}

/**
 * Pull the assistant text out of an OpenAI Chat Completions payload. This
 * is the shape the Vercel AI Gateway returns for non-OpenAI vendors when
 * called through the /v1/chat/completions OpenAI-compatible endpoint.
 * Shape: { choices: [ { message: { content: "..." } } ] }
 *
 * Some Gateway providers (notably Anthropic-style upstreams) may return
 * `content` as an array of parts instead of a string; tolerate both.
 */
function extractResponseTextChat(json) {
  if (!json || !Array.isArray(json.choices) || json.choices.length === 0) return "";
  const message = json.choices[0]?.message;
  if (!message) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    let buf = "";
    for (const part of content) {
      if (typeof part === "string") buf += part;
      else if (part && typeof part.text === "string") buf += part.text;
    }
    return buf;
  }
  return "";
}

/**
 * Vendor-aware dispatch for response text extraction.
 */
function extractResponseText(json, vendor) {
  if (vendor === "openai") return extractResponseTextOpenAI(json);
  return extractResponseTextChat(json);
}

/**
 * Translate a Chat Completions usage block into the Responses API usage
 * shape the runner already aggregates. Chat returns
 * { prompt_tokens, completion_tokens, total_tokens } and may carry a
 * provider-specific reasoning counter under
 * completion_tokens_details.reasoning_tokens. Responses uses
 * { input_tokens, output_tokens, output_tokens_details.reasoning_tokens }.
 */
function normalizeUsageChat(usage) {
  if (!usage) return null;
  const inputTokens = usage.input_tokens ?? usage.prompt_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? usage.completion_tokens ?? 0;
  const reasoning = usage.output_tokens_details?.reasoning_tokens
    ?? usage.completion_tokens_details?.reasoning_tokens
    ?? null;
  const normalized = { input_tokens: inputTokens, output_tokens: outputTokens };
  if (reasoning !== null) {
    normalized.output_tokens_details = { reasoning_tokens: reasoning };
  }
  return normalized;
}

/**
 * Build the canonical model-facing scenario body.
 *
 * @param {object} scenario - Reshaped scenario record.
 * @param {object} [options] - Structural-render overrides.
 * @param {(scenarioId: string) => string} [options.scenarioIdFor]
 *   Optional scenario-reference renderer used only by offline validators.
 * @param {(scenarioId: string, evidenceId: string) => string} [options.evidenceIdFor]
 *   Optional evidence-reference renderer used only by offline validators.
 * @returns {{model_input: string, integrity_flags: string[]}} Rendered body and flags.
 */
export function buildModelInputFor(scenario, { scenarioIdFor, evidenceIdFor } = {}) {
  const runId = `${scenario.id}-canonical-${Date.now()}`;
  const worker = new WorkerAgent({ scenario });
  const gateway = new ActionGateway({
    scenario,
    runId,
    mode: "structured_steering",
    scenarioIdFor,
    evidenceIdFor
  });
  const action = worker.proposeAction();
  const preflight = gateway.preflight({ action, timeMs: 132000 });
  return {
    model_input: inputForModel({
      scenario, event: preflight.event,
      evidence: preflight.evidence, mode: "structured_steering", evidenceIdFor
    }),
    integrity_flags: preflight.event.integrity_evidence?.integrity_flags || []
  };
}

// === API call with bounded retry on transient failures ===

const TRANSIENT_HTTP_CODES = new Set([408, 429, 500, 502, 503, 504]);
const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_BACKOFF_BASE_MS = 1500;

// Vercel AI Gateway exposes an OpenAI-compatible Chat Completions endpoint at
// this base URL.
const VERCEL_AI_GATEWAY_CHAT_URL = "https://ai-gateway.vercel.sh/v1/chat/completions";

/**
 * Build the OpenAI Responses API request body. Used only for vendor="openai".
 */
function buildOpenAIRequestBody({ variantConfig, modelInput, prompt, scenarioId }) {
  const body = {
    model: variantConfig.model,
    input: [
      { role: "system", content: prompt },
      { role: "user", content: renderUserMessage({ scenarioId, modelInput }) }
    ],
    max_output_tokens: variantConfig.max_output_tokens
  };
  if (variantConfig.reasoning_effort) {
    body.reasoning = { effort: variantConfig.reasoning_effort };
  }
  return body;
}

/**
 * Build the OpenAI-compatible Chat Completions request body the Vercel AI
 * Gateway accepts. The model field is prefixed with "<vendor>/<model-id>"
 * so the gateway can dispatch to the upstream provider.
 */
function buildGatewayChatRequestBody({ variantConfig, modelInput, prompt, scenarioId }) {
  const body = {
    // gateway_model, when set, is the exact provider/model slug to send and
    // overrides the vendor/model join. This decouples the gateway slug from the
    // vendor routing key, so a model whose gateway slug is "openai/..." (e.g.
    // openai/gpt-oss-20b, an open-weight model served through the Gateway, not
    // OpenAI's direct API) can route through the Gateway with a non-"openai"
    // vendor while still sending the correct "openai/"-prefixed slug.
    model: variantConfig.gateway_model || `${variantConfig.vendor}/${variantConfig.model}`,
    messages: [
      { role: "system", content: prompt },
      { role: "user", content: renderUserMessage({ scenarioId, modelInput }) }
    ],
    max_tokens: variantConfig.max_output_tokens
  };
  // reasoning_effort is the OpenAI-compatible reasoning knob. Measured per
  // vendor through the Gateway: OpenAI-oss and DeepSeek honor it (DeepSeek
  // "none" turns thinking off); Gemini ignores it entirely (it needs
  // thinkingLevel, set via provider_options below); Anthropic needs its own
  // thinking block (also provider_options).
  if (variantConfig.reasoning_effort) {
    body.reasoning_effort = variantConfig.reasoning_effort;
  }
  // provider_options carries the exact provider-specific reasoning control the
  // Gateway forwards upstream, for vendors not driven by reasoning_effort:
  //   google:    { google: { thinkingConfig: { thinkingLevel } } }
  //   anthropic: { anthropic: { thinking: { type, effort | budgetTokens } } }
  if (variantConfig.provider_options) {
    body.providerOptions = variantConfig.provider_options;
  }
  return body;
}

// Human-readable reasoning setting for logs, cell records, and summaries.
// Prefers the explicit semantic label; falls back to the raw effort string,
// then "off" when no reasoning control was sent.
function reasoningLabelOf(variantConfig) {
  return variantConfig.reasoning_label || variantConfig.reasoning_effort || "off";
}

async function callModelOnce({ apiKey, variantConfig, modelInput, prompt, scenarioId }) {
  const vendor = variantConfig.vendor || "openai";
  const isOpenAI = vendor === "openai";
  const endpoint = isOpenAI
    ? "https://api.openai.com/v1/responses"
    : VERCEL_AI_GATEWAY_CHAT_URL;
  const body = isOpenAI
    ? buildOpenAIRequestBody({ variantConfig, modelInput, prompt, scenarioId })
    : buildGatewayChatRequestBody({ variantConfig, modelInput, prompt, scenarioId });
  const t0 = Date.now();
  let resp;
  try {
    resp = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body)
    });
  } catch (networkErr) {
    return {
      ok: false, request_body: body, transient: true,
      http_status: null, response_body_raw: null,
      wall_ms: Date.now() - t0,
      error: `network error: ${networkErr.message}`
    };
  }
  const respText = await resp.text();
  const wallMs = Date.now() - t0;
  if (!resp.ok) {
    return {
      ok: false, request_body: body,
      transient: TRANSIENT_HTTP_CODES.has(resp.status),
      http_status: resp.status, response_body_raw: respText, wall_ms: wallMs,
      error: `HTTP ${resp.status}: ${respText.slice(0, 400)}`
    };
  }
  let json;
  try { json = JSON.parse(respText); } catch (e) {
    return {
      ok: false, request_body: body, transient: false,
      http_status: resp.status, response_body_raw: respText, wall_ms: wallMs,
      error: `response not JSON: ${e.message}`
    };
  }
  const rawText = extractResponseText(json, vendor);
  const norm = parseAndNormalize(rawText);

  // Truncation detection is vendor-specific. OpenAI Responses exposes
  // status="incomplete" + incomplete_details.reason. Chat Completions
  // exposes choices[0].finish_reason; "length" means the model hit
  // max_tokens before finishing.
  let responseStatus = null;
  let incompleteReason = null;
  let truncated = false;
  if (isOpenAI) {
    responseStatus = json.status || null;
    incompleteReason = json.incomplete_details?.reason || null;
    truncated = responseStatus === "incomplete" || incompleteReason === "max_output_tokens";
  } else {
    const finishReason = json.choices?.[0]?.finish_reason || null;
    responseStatus = finishReason;
    incompleteReason = finishReason === "length" ? "max_output_tokens" : null;
    truncated = finishReason === "length";
  }

  // Normalize usage into the Responses-shaped record the rest of the
  // runner aggregates against. OpenAI Responses already uses that shape.
  const usage = isOpenAI ? (json.usage || null) : normalizeUsageChat(json.usage);

  return {
    ok: true, request_body: body, http_status: resp.status,
    response_body_raw: respText, response_body_parsed: json,
    raw_text: rawText, wall_ms: wallMs, norm,
    response_status: responseStatus, incomplete_reason: incompleteReason, truncated,
    usage, response_id: json.id || null
  };
}

/**
 * Call the model with bounded retry on transient HTTP/network failures.
 * Returns the same shape as `callModelOnce` plus `attempts` and, on
 * exhaustion, `transient_attempts_exhausted: true`.
 */
async function callModelWithRetry(args, { maxAttempts = DEFAULT_MAX_ATTEMPTS, backoffBaseMs = DEFAULT_BACKOFF_BASE_MS } = {}) {
  let lastResult = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await callModelOnce(args);
    if (result.ok) return { ...result, attempts: attempt };
    if (!result.transient) return { ...result, attempts: attempt };
    lastResult = result;
    if (attempt < maxAttempts) {
      const wait = backoffBaseMs * Math.pow(2, attempt - 1);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  return { ...lastResult, attempts: maxAttempts, transient_attempts_exhausted: true };
}

// === Trial assembly ===

/**
 * Detect a deterministic provider content-filter refusal.
 *
 * The provider's own safety layer rejects the request before the model
 * reasons about it, returning an HTTP 400 whose error body carries a
 * content-policy code (e.g. OpenAI's `"code": "cyber_policy"`). This is a
 * terminal, reproducible outcome, not a transient infrastructure failure,
 * so it is recorded as provider_filtered and excluded from the scored
 * denominator. Detection reads only the saved failure fields (http_status
 * plus the raw error/body text), so it works identically on a live call
 * result and on a re-read trial record.
 *
 * @param {{ http_status: (number|null), error: (string|null), response_body_raw: (string|null) }} call
 * @returns {boolean}
 */
function isProviderContentFilter(call) {
  if (!call || call.http_status !== 400) return false;
  const haystack = `${call.error || ""}\n${call.response_body_raw || ""}`;
  return /"code"\s*:\s*"cyber_policy"/.test(haystack);
}

function trialRecordFromCall({ call, provenance }) {
  if (!call.ok) {
    // Provider content-filter refusal: the provider's own safety layer
    // rejected the request deterministically (HTTP 400 with a
    // content-policy code) before the model reasoned about the scenario.
    // Re-running yields the same refusal, so this is a terminal, recorded
    // benchmark outcome (provider_filtered), excluded from the scored
    // denominator, NOT an infrastructure failure that invalidates the run.
    const status = isProviderContentFilter(call)
      ? TRIAL_STATUS.PROVIDER_FILTERED
      : TRIAL_STATUS.INFRASTRUCTURE_FAILED;
    return {
      ...provenance,
      status,
      commit_permission: null,
      policy_action: null, human_required: null,
      clarification_mode: null, confidence: null, reason: null,
      correct: null,
      truncated: false, parse_failed: false,
      normalization_warnings: [],
      error: call.error,
      http_status: call.http_status,
      attempts: call.attempts || 1,
      transient_attempts_exhausted: Boolean(call.transient_attempts_exhausted),
      usage: null,
      wall_ms: call.wall_ms || 0,
      response_id: null,
      request_body: call.request_body,
      response_body_raw: call.response_body_raw,
      response_body_parsed: null,
      raw_text: null
    };
  }
  // Successful API call. Classify by parse outcome and truncation.
  const norm = call.norm;
  let status;
  if (norm.parse_failed) status = TRIAL_STATUS.PARSE_FAILED;
  else if (call.truncated) status = TRIAL_STATUS.TRUNCATED;
  else status = TRIAL_STATUS.OK;
  const correct = isCorrectByPermission(provenance.expected_action, norm.commit_permission);
  return {
    ...provenance,
    status,
    commit_permission: norm.commit_permission,
    policy_action: norm.policy_action,
    human_required: norm.human_required,
    clarification_mode: norm.clarification_mode,
    confidence: norm.confidence,
    reason: norm.reason,
    correct,
    truncated: call.truncated || false,
    parse_recovered: norm.parse_recovered,
    parse_failed: norm.parse_failed,
    normalization_warnings: norm.normalization_warnings || [],
    error: null,
    http_status: call.http_status,
    attempts: call.attempts,
    usage: call.usage || null,
    wall_ms: call.wall_ms || 0,
    response_id: call.response_id || null,
    request_body: call.request_body,
    response_body_raw: call.response_body_raw,
    response_body_parsed: call.response_body_parsed,
    raw_text: call.raw_text
  };
}

// === Public entry point ===

/**
 * Run one variant against the scenarios in a planned run root.
 *
 * Inputs:
 *   runRoot          absolute path to a planned run root
 *   variantKey       variant to run; must be in plan.planned_variants
 *   scenarioFilter   optional Set<string> of scenario ids to restrict to
 *                    (used by smoke mode); when null, runs every scenario
 *                    in the manifest
 *   apiKey           API key for the variant's vendor. For
 *                    vendor="openai" this is OPENAI_API_KEY; for any
 *                    other vendor this is AI_GATEWAY_API_KEY. The CLI
 *                    selects the right key based on variantConfig.vendor.
 *   resume           when true, reusable trials on disk are kept;
 *                    when false, every trial is re-run from scratch
 *   log              function(msg) for human-readable progress
 *   retryOptions     { maxAttempts, backoffBaseMs }
 *
 * Returns:
 *   { variantKey, summary, n_infra_failed, status }
 *
 * Side effects:
 *   - Writes trial-N.json, cell.json, summary.json, cells.json under
 *     <runRoot>/<variantKey>/
 *   - Updates <runRoot>/run-state.json with per-variant lifecycle and
 *     recomputes overall_status
 */
export async function runVariant({
  runRoot, variantKey, scenarioFilter = null,
  apiKey, resume = true, log = () => {}, retryOptions
}) {
  if (!apiKey) throw new Error("apiKey is required");

  const plan = loadRunPlan(runRoot);
  if (!plan.planned_variants.includes(variantKey)) {
    throw new Error(`Variant ${variantKey} is not in planned_variants (${plan.planned_variants.join(", ")})`);
  }
  const variantConfigsSnapshot = loadVariantConfigs(runRoot);
  const variantConfig = variantConfigsSnapshot.variants[variantKey];
  if (!variantConfig) {
    throw new Error(`Variant ${variantKey} missing from VARIANT_CONFIGS.json`);
  }
  if (variantConfig.config_hash !== plan.variant_config_hashes[variantKey]) {
    throw new Error(`Internal inconsistency: variant_config_hash for ${variantKey} differs between RUN_PLAN.json and VARIANT_CONFIGS.json`);
  }

  const prompt = loadRunPrompt(runRoot);
  const promptShaLive = createHash("sha256").update(prompt).digest("hex");
  if (promptShaLive !== plan.prompt_sha256) {
    throw new Error(`Internal inconsistency: PROMPT.txt hash (${promptShaLive}) differs from RUN_PLAN.prompt_sha256 (${plan.prompt_sha256})`);
  }

  const manifest = loadScenarioManifestFromRunRoot(runRoot);
  indexManifestById(manifest); // sanity build; not used directly here

  const runState = loadRunState(runRoot);
  const variantRun = runState.variant_runs[variantKey];
  const gate = canStartVariant(variantRun);
  if (!gate.allowed) {
    throw new Error(`Cannot start variant ${variantKey}: ${gate.reason}`);
  }
  const startedAtIso = variantRun.started_at || new Date().toISOString();
  updateVariantRun(runRoot, variantKey, {
    status: VARIANT_STATUS.IN_PROGRESS,
    started_at: startedAtIso,
    finished_at: null,
    interrupt_signal: null,
    resume_count: gate.isResume ? (variantRun.resume_count || 0) + 1 : variantRun.resume_count || 0
  });
  log(`runVariant ${variantKey}: ${gate.reason}`);

  // Signal handler so the variant cleanly records interrupt status
  let interrupted = false;
  const onSignal = (sig) => {
    interrupted = true;
    try {
      updateVariantRun(runRoot, variantKey, {
        status: VARIANT_STATUS.INTERRUPTED,
        interrupt_signal: sig,
        finished_at: new Date().toISOString()
      });
    } catch { /* best-effort flush before exit */ }
    process.exit(130);
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  const variantDir = path.join(runRoot, variantKey);
  fs.mkdirSync(variantDir, { recursive: true });

  // Scenario set
  const scenarioEntries = manifest.scenarios.filter(
    (s) => scenarioFilter === null || scenarioFilter.has(s.id)
  );
  if (scenarioFilter !== null && scenarioEntries.length === 0) {
    throw new Error(`scenarioFilter matched no scenarios in the manifest`);
  }

  log(`\n=== Variant: ${variantKey} (${variantConfig.label}) ===`);
  log(`  Model: ${variantConfig.model}, reasoning: ${reasoningLabelOf(variantConfig)}, max_output_tokens: ${variantConfig.max_output_tokens}`);
  log(`  Scenarios: ${scenarioEntries.length}, trials per cell: ${plan.n_trials_per_cell}, resume: ${resume ? "on" : "off"}`);

  const cells = [];
  let totalCalls = 0, totalReused = 0, totalInfra = 0;
  let totalErrors = 0, totalTruncated = 0, totalParseFailed = 0;
  let totalIn = 0, totalOut = 0, totalRsn = 0, totalWall = 0;

  let i = 0;
  for (const sEntry of scenarioEntries) {
    if (interrupted) break;
    i += 1;
    const scenarioFilePath = path.join(resolveScenarioSetDir(plan.scenario_set_dir), sEntry.file);
    const liveSha = sha256File(scenarioFilePath);
    if (liveSha !== sEntry.sha256) {
      throw new Error(`Scenario ${sEntry.id} drifted from manifest (file=${liveSha}, manifest=${sEntry.sha256})`);
    }
    const scenarioJson = JSON.parse(fs.readFileSync(scenarioFilePath, "utf8"));
    const scenario = reshapeToLegacy(scenarioJson);
    const { model_input, integrity_flags } = buildModelInputFor(scenario);
    const expected = sEntry.expected_action;

    const scenarioDir = path.join(variantDir, sEntry.id);
    fs.mkdirSync(scenarioDir, { recursive: true });

    const trials = [];
    let cellReused = 0;
    for (let t = 1; t <= plan.n_trials_per_cell; t += 1) {
      if (interrupted) break;
      const trialPath = path.join(scenarioDir, `trial-${t}.json`);
      const provenance = {
        run_id: plan.run_id,
        scenario_id: sEntry.id,
        scenario_sha256: sEntry.sha256,
        variant_key: variantKey,
        variant_config_hash: variantConfig.config_hash,
        prompt_sha256: plan.prompt_sha256,
        trial: t,
        expected_action: expected
      };

      let trialRec = null;
      if (resume) {
        const check = readTrialIfReusable(trialPath, provenance);
        if (check.reusable) {
          trialRec = check.trial;
          cellReused += 1;
          totalReused += 1;
          if (trialRec.usage) {
            totalIn += trialRec.usage.input_tokens || 0;
            totalOut += trialRec.usage.output_tokens || 0;
            totalRsn += trialRec.usage.output_tokens_details?.reasoning_tokens || 0;
          }
          totalWall += trialRec.wall_ms || 0;
          if (trialRec.status === TRIAL_STATUS.TRUNCATED) totalTruncated += 1;
          if (trialRec.status === TRIAL_STATUS.PARSE_FAILED) totalParseFailed += 1;
        }
      }
      if (!trialRec) {
        totalCalls += 1;
        const call = await callModelWithRetry(
          { apiKey, variantConfig, modelInput: model_input, prompt, scenarioId: sEntry.id },
          retryOptions
        );
        trialRec = trialRecordFromCall({ call, provenance });
        writeTrial(trialPath, trialRec);
        if (trialRec.status === TRIAL_STATUS.INFRASTRUCTURE_FAILED) {
          totalInfra += 1; totalErrors += 1;
        } else if (trialRec.status === TRIAL_STATUS.TRUNCATED) {
          totalTruncated += 1;
        } else if (trialRec.status === TRIAL_STATUS.PARSE_FAILED) {
          totalParseFailed += 1;
        }
        if (call.usage) {
          totalIn += call.usage.input_tokens || 0;
          totalOut += call.usage.output_tokens || 0;
          totalRsn += call.usage.output_tokens_details?.reasoning_tokens || 0;
        }
        totalWall += call.wall_ms || 0;
      }
      trials.push(trialRec);
    }

    if (interrupted) break;

    const score = computeCellScore(trials, expected);
    // A cell is provider-filtered when every trial was refused by the
    // provider's content filter (terminal, not an infra failure). Such
    // cells produced no steering decision and are excluded from the
    // scored denominator, reported separately as n_provider_filtered.
    const cellProviderFiltered =
      trials.length > 0 &&
      trials.every((t) => t.status === TRIAL_STATUS.PROVIDER_FILTERED);
    const cellRec = {
      run_id: plan.run_id,
      variant: variantKey,
      model: variantConfig.model,
      reasoning_effort: variantConfig.reasoning_effort,
      reasoning_label: reasoningLabelOf(variantConfig),
      variant_config_hash: variantConfig.config_hash,
      scenario_id: sEntry.id,
      scenario_sha256: sEntry.sha256,
      expected_action: expected,
      direction: sEntry.direction,
      functional_category: sEntry.functional_category,
      domain: sEntry.domain,
      source_provenance: sEntry.source_provenance,
      irreversibility_class: sEntry.irreversibility_class,
      irreversibility_weight: irreversibilityWeight(sEntry.irreversibility_class),
      action_effect: sEntry.action_verb ?? null,
      integrity_flags,
      provider_filtered: cellProviderFiltered,
      ...score
    };
    fs.writeFileSync(path.join(scenarioDir, "cell.json"), JSON.stringify(cellRec, null, 2));
    cells.push(cellRec);

    const reuseTag = cellReused > 0 ? ` (resumed ${cellReused}/${plan.n_trials_per_cell})` : "";
    const tag = expected == null ? "(no expected)" :
      cellRec.modal_correct === true ? `OK[${cellRec.n_correct_trials}/${plan.n_trials_per_cell}]` :
      cellRec.modal_correct === false ? `MISS[${cellRec.n_correct_trials}/${plan.n_trials_per_cell}]` :
      "(unscored)";
    log(`  [${i}/${scenarioEntries.length}] ${sEntry.id.slice(0, 55).padEnd(55)} exp=${(expected ?? "-").padEnd(10)} modal=${(cellRec.modal_commit_permission ?? "-").padEnd(8)} ${tag}${reuseTag}`);
  }

  // Write variant aggregates. Provider-filtered cells (the provider's own
  // content filter refused the request, so the model never made a steering
  // decision) are excluded from the scored denominator and reported
  // separately as n_provider_filtered.
  const scored = cells.filter((c) => c.expected_action != null && c.provider_filtered !== true);
  const nProviderFiltered = cells.filter((c) => c.provider_filtered === true).length;
  const correctModal = scored.filter((c) => c.modal_correct === true).length;
  const correctPassAll = scored.filter((c) => c.pass_all_trials === true).length;
  const total = scored.length;
  const severity = weightedSeverity(scored);
  const tradeoff = directionalErrorRates(scored);
  const round4 = (x) => (x == null ? null : Number(x.toFixed(4)));
  const pricing = variantConfig.pricing || { input: 0, output: 0 };
  const costEstimate = (totalIn / 1e6) * pricing.input + (totalOut / 1e6) * pricing.output;

  const summary = {
    run_id: plan.run_id,
    variant: variantKey,
    label: variantConfig.label,
    reasoning_label: reasoningLabelOf(variantConfig),
    finished_at: new Date().toISOString(),
    n_trials_per_cell: plan.n_trials_per_cell,
    n_scenarios: scenarioEntries.length,
    n_calls_made_this_run: totalCalls,
    n_trials_reused: totalReused,
    n_errors: totalErrors,
    n_truncated: totalTruncated,
    n_parse_failed: totalParseFailed,
    n_infrastructure_failed: totalInfra,
    n_provider_filtered: nProviderFiltered,
    modal_score: `${correctModal}/${total}`,
    modal_accuracy: total > 0 ? Number((correctModal / total).toFixed(4)) : null,
    pass_all_trials_score: `${correctPassAll}/${total}`,
    pass_all_trials_rate: total > 0 ? Number((correctPassAll / total).toFixed(4)) : null,
    weighted_possible_total: severity.weighted_possible_total,
    weighted_miss_total: severity.weighted_miss_total,
    weighted_miss_rate: round4(severity.weighted_miss_rate),
    weighted_modal_accuracy: round4(severity.weighted_modal_accuracy),
    under_refusal_count: tradeoff.under_refusal_count,
    under_refusal_possible: tradeoff.under_refusal_possible,
    under_refusal_rate: round4(tradeoff.under_refusal_rate),
    over_refusal_count: tradeoff.over_refusal_count,
    over_refusal_possible: tradeoff.over_refusal_possible,
    over_refusal_rate: round4(tradeoff.over_refusal_rate),
    input_tokens_total: totalIn,
    output_tokens_total: totalOut,
    reasoning_tokens_total: totalRsn,
    wall_ms_total: totalWall,
    cost_usd_estimate: Number(costEstimate.toFixed(4))
  };
  fs.writeFileSync(path.join(variantDir, "summary.json"), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(variantDir, "cells.json"), JSON.stringify(cells, null, 2));

  // Determine variant terminal status. A variant is COMPLETED only when
  // every manifest scenario has a full cell on disk, so a subset run can
  // never be recorded as a finished reported result. A subset run stays
  // PARTIAL and is resumable; a full run with infra failures is
  // INFRA_FAILED; a full clean run is COMPLETED.
  const coverage = variantCellsComplete(runRoot, variantKey, manifest, plan.n_trials_per_cell);
  let terminalStatus;
  if (!coverage.complete) terminalStatus = VARIANT_STATUS.PARTIAL;
  else if (totalInfra > 0) terminalStatus = VARIANT_STATUS.INFRA_FAILED;
  else terminalStatus = VARIANT_STATUS.COMPLETED;
  if (terminalStatus === VARIANT_STATUS.PARTIAL) {
    log(`  Partial run: ${coverage.present}/${manifest.scenarios.length} scenarios have full cells. Variant stays partial until the rest are filled.`);
  }

  updateVariantRun(runRoot, variantKey, {
    status: terminalStatus,
    finished_at: new Date().toISOString(),
    n_calls_made: (variantRun.n_calls_made || 0) + totalCalls,
    n_trials_reused: (variantRun.n_trials_reused || 0) + totalReused,
    n_errors: totalErrors,
    n_truncated: totalTruncated,
    n_parse_failed: totalParseFailed,
    n_infrastructure_failed: totalInfra
  });

  log("");
  log(`  Variant ${variantKey} done.`);
  log(`    modal score: ${summary.modal_score} (${total > 0 ? (summary.modal_accuracy * 100).toFixed(1) : "0.0"}%)`);
  log(`    pass_all_trials: ${summary.pass_all_trials_score} (${total > 0 ? (summary.pass_all_trials_rate * 100).toFixed(1) : "0.0"}%)`);
  log(`    fresh calls: ${totalCalls}, reused: ${totalReused}, errors: ${totalErrors}, truncated: ${totalTruncated}, parse_failed: ${totalParseFailed}, infra_failed: ${totalInfra}`);
  log(`    cost: $${costEstimate.toFixed(4)} wall: ${(totalWall / 1000).toFixed(1)}s`);

  return {
    variantKey,
    summary,
    n_infra_failed: totalInfra,
    status: terminalStatus
  };
}

export { CANONICAL_SCORING_MAPPING };
