// Reported-run configuration for the SteerBench-Work benchmark grid.
//
// One file defines the scenario set, the trial count, the scoring field,
// the prompt hash, the output roots, and the model variant list with
// per-variant API parameters. The runner and the validator both read
// from here.
//
// Any change in this file changes the benchmark protocol.
//
// Tier placement is by measured capability, not by a vendor's product name.
//
// Reasoning conditions. Every model is measured at a FLOOR (the lowest
// reasoning it supports) and a HIGH condition, each set EXPLICITLY. Reasoning
// control is provider-specific:
//   OpenAI direct (Responses):  reasoning.effort = "none" | "high"
//   OpenAI-oss + DeepSeek (GW): reasoning_effort  = "none" | "low" | "high"
//                               (DeepSeek "none" disables thinking)
//   Google (GW):                provider_options.google.thinkingConfig.thinkingLevel
//                               = "minimal" | "low" | "high"
//                               (Gemini ignores reasoning_effort through the GW)
//   Anthropic (GW):             provider_options.anthropic.thinking
//                               = {type:"adaptive", effort:"high"}  (Sonnet 4.6, Opus 4.8)
//                               or {type:"enabled", budgetTokens:N} (Haiku 4.5, no adaptive)
//                               floor = no thinking block (Claude does not think by default)
//   Moonshot Kimi (GW):         provider_options.moonshotai.thinking
//                               = {type:"disabled"} disables thinking (verified:
//                               reasoning_tokens drop to 0). No field = reasons by
//                               default (the on row). Top-level thinking,
//                               reasoning.effort, and chat_template_kwargs do NOT
//                               disable it through the gateway.
//
// A provider DEFAULT (no reasoning field sent) is reused as a labeled condition
// only when it lands on a usable endpoint (off/none, the lowest supported, or
// high):
//   - OpenAI nano/mini/gpt-5.4 floor: default emits 0 reasoning tokens = off.
//   - Claude floor: default = no thinking = off (0 reasoning).
//   - Gemini Flash-Lite floor: default thinkingLevel = minimal (0 reasoning).
//   - Gemini 3.1 Pro: default thinkingLevel = high -> reused as HIGH.
//   - DeepSeek: default = thinking on -> reused as the ON condition.
//   Gemini 3.5 Flash default = medium (an in-between level) and is NOT reused;
//   Flash is run explicitly at minimal and high.
//
// Pricing is per-million-token list price from the gateway /v1/models endpoint
// (OpenAI rows match OpenAI's own published API pricing). These list rates can
// drift; the authoritative cost in every run is measured input/output tokens
// times these rates, recorded per cell. Re-verify against /v1/models before a
// fresh cost claim. gpt-5.4 and gpt-5.5 carry context-tiered rates on the
// gateway; our calls sit in the base tier, so the flat figures below apply.

import { createHash } from "node:crypto";
import { STEERBENCH_STEERING_SYSTEM_PROMPT } from "../src/prompts.mjs";

const promptSha256 = createHash("sha256")
  .update(STEERBENCH_STEERING_SYSTEM_PROMPT)
  .digest("hex");

export const REPORTED_RUN_CONFIG = Object.freeze({
  // Frozen scenario set the reported run uses.
  // Set identity is a release name; count and hashes live in the
  // per-run SCENARIO_MANIFEST.json snapshot, not in the folder name.
  scenario_set: "steerbench-work-2026-05",
  scenario_set_dir: "scenario-sets/steerbench-work-2026-05",

  // Number of trials per (model, scenario) cell. modal-of-N and pass^N
  // are computed at this N.
  n_trials_per_cell: 5,

  // Output location for canonical runs the rest of the pipeline consumes.
  output_root: "runs/canonical-multi-trial",

  // Output location for smoke runs. Smoke artifacts cannot be loaded as
  // canonical results because they live in a separate tree.
  smoke_output_root: "runs/smoke",

  // The only field commit decisions are scored against.
  scoring_field: "commit_permission",

  // Canonical steering prompt fingerprint. Used by the validator to
  // confirm every trial was produced under the same prompt bytes.
  prompt_sha256: promptSha256,

  // Reliability metrics computed per cell.
  pass_k_levels: [1, 3, 5],

  // Model variants in the reported grid. Each variant carries its own
  // API parameters and a vendor tag the runner uses to route the call.
  //
  // vendor values:
  //   "openai"      Direct call to https://api.openai.com/v1/responses,
  //                 authorized with OPENAI_API_KEY. Responses API shape.
  //   any other     The Vercel AI Gateway provider slug ("anthropic",
  //                 "google", "deepseek", "moonshotai", "openai-oss"). Routed
  //                 through the Gateway's OpenAI-compatible Chat Completions
  //                 endpoint with AI_GATEWAY_API_KEY. The model field is sent
  //                 as "<vendor>/<model-id>" (or gateway_model when set).
  //
  // The roster is four vendor ladders so the over-refusal regression can be
  // read small -> large within each family and across families:
  //   OpenAI:      nano -> mini -> gpt-5.4 -> gpt-5.5
  //   Anthropic:   Haiku 4.5 -> Sonnet 4.6 -> Opus 4.8
  //   Google:      Gemini 3.1 Flash Lite -> Gemini 3.5 Flash -> Gemini 3.1 Pro
  //   Open-weight: DeepSeek V4 Flash (AA 47) -> DeepSeek V4 Pro (AA 52) ->
  //                Kimi K2.6 (AA 54, #1 open)
  //
  // reasoning_label is the human-readable setting shown in logs and on the
  // board. It does not affect the cell hash; provider_options and
  // reasoning_effort do.
  variants: Object.freeze({
    // ===== OpenAI ladder (direct, OPENAI_API_KEY, Responses API) =====
    // Floor is the model's minimum reasoning. nano/mini/gpt-5.4 floors emit 0
    // reasoning tokens (true off); gpt-5.5 floor is the explicit
    // reasoning_effort "none". High is constant cross-vendor.
    "nano": {
      vendor: "openai",
      label: "gpt-5.4-nano",
      model: "gpt-5.4-nano",
      reasoning_effort: null,
      reasoning_label: "off",
      max_output_tokens: 8000,
      pricing: { input: 0.20, output: 1.25 }
    },
    "nano-high": {
      vendor: "openai",
      label: "gpt-5.4-nano (r=high)",
      model: "gpt-5.4-nano",
      reasoning_effort: "high",
      reasoning_label: "high",
      max_output_tokens: 16000,
      pricing: { input: 0.20, output: 1.25 }
    },
    "mini": {
      vendor: "openai",
      label: "gpt-5.4-mini",
      model: "gpt-5.4-mini",
      reasoning_effort: null,
      reasoning_label: "off",
      max_output_tokens: 8000,
      pricing: { input: 0.75, output: 4.50 }
    },
    "mini-high": {
      vendor: "openai",
      label: "gpt-5.4-mini (r=high)",
      model: "gpt-5.4-mini",
      reasoning_effort: "high",
      reasoning_label: "high",
      max_output_tokens: 16000,
      pricing: { input: 0.75, output: 4.50 }
    },
    "g54": {
      vendor: "openai",
      label: "gpt-5.4",
      model: "gpt-5.4",
      reasoning_effort: null,
      reasoning_label: "off",
      max_output_tokens: 16000,
      pricing: { input: 2.5, output: 15.0 }
    },
    "g54-high": {
      vendor: "openai",
      label: "gpt-5.4 (r=high)",
      model: "gpt-5.4",
      reasoning_effort: "high",
      reasoning_label: "high",
      max_output_tokens: 32000,
      pricing: { input: 2.5, output: 15.0 }
    },
    "g55-none": {
      vendor: "openai",
      label: "gpt-5.5 (r=none)",
      model: "gpt-5.5",
      reasoning_effort: "none",
      reasoning_label: "off",
      max_output_tokens: 8000,
      pricing: { input: 5.0, output: 30.0 }
    },
    // High-cost frontier condition.
    "g55-high": {
      vendor: "openai",
      label: "gpt-5.5 (r=high)",
      model: "gpt-5.5",
      reasoning_effort: "high",
      reasoning_label: "high",
      max_output_tokens: 32000,
      pricing: { input: 5.0, output: 30.0 }
    },

    // ===== OpenAI open-weight (gpt-oss via Gateway, NOT OpenAI direct) =====
    // vendor "openai-oss" takes the Gateway path; gateway_model carries the
    // exact "openai/gpt-oss-*" slug. reasoning_effort low/high is honored.
    "gpt-oss-high": {
      vendor: "openai-oss",
      gateway_model: "openai/gpt-oss-20b",
      label: "gpt-oss-20b-high",
      model: "gpt-oss-20b",
      reasoning_effort: "high",
      reasoning_label: "high",
      max_output_tokens: 8000,
      pricing: { input: 0.05, output: 0.20 }
    },
    "gpt-oss-low": {
      vendor: "openai-oss",
      gateway_model: "openai/gpt-oss-20b",
      label: "gpt-oss-20b-low",
      model: "gpt-oss-20b",
      reasoning_effort: "low",
      reasoning_label: "low",
      max_output_tokens: 8000,
      pricing: { input: 0.05, output: 0.20 }
    },
    // gpt-oss-120b: larger sibling (117B/5.1B active vs 21B/3.6B). 20b + 120b
    // form a within-family size ladder.
    "gpt-oss-120b-high": {
      vendor: "openai-oss",
      gateway_model: "openai/gpt-oss-120b",
      label: "gpt-oss-120b-high",
      model: "gpt-oss-120b",
      reasoning_effort: "high",
      reasoning_label: "high",
      max_output_tokens: 8000,
      pricing: { input: 0.35, output: 0.75 }
    },
    "gpt-oss-120b-low": {
      vendor: "openai-oss",
      gateway_model: "openai/gpt-oss-120b",
      label: "gpt-oss-120b-low",
      model: "gpt-oss-120b",
      reasoning_effort: "low",
      reasoning_label: "low",
      max_output_tokens: 8000,
      pricing: { input: 0.35, output: 0.75 }
    },

    // ===== Anthropic ladder (Gateway) =====
    // Floor = no thinking block (Claude does not think by default, 0 reasoning).
    // High = provider_options.anthropic.thinking. Sonnet 4.6 and Opus 4.8 use
    // adaptive effort:high; Haiku 4.5 has no adaptive mode and uses an enabled
    // token budget.
    "claude-haiku": {
      vendor: "anthropic",
      label: "claude-haiku-4.5",
      model: "claude-haiku-4.5",
      reasoning_effort: null,
      reasoning_label: "off",
      max_output_tokens: 8000,
      pricing: { input: 1.0, output: 5.0 }
    },
    "claude-haiku-high": {
      vendor: "anthropic",
      label: "claude-haiku-4.5 (r=high)",
      model: "claude-haiku-4.5",
      provider_options: { anthropic: { thinking: { type: "enabled", budgetTokens: 8000 } } },
      reasoning_label: "high",
      max_output_tokens: 16000,
      pricing: { input: 1.0, output: 5.0 }
    },
    "claude-sonnet": {
      vendor: "anthropic",
      label: "claude-sonnet-4.6",
      model: "claude-sonnet-4.6",
      reasoning_effort: null,
      reasoning_label: "off",
      max_output_tokens: 8000,
      pricing: { input: 3.0, output: 15.0 }
    },
    "claude-sonnet-high": {
      vendor: "anthropic",
      label: "claude-sonnet-4.6 (r=high)",
      model: "claude-sonnet-4.6",
      provider_options: { anthropic: { thinking: { type: "adaptive", effort: "high" } } },
      reasoning_label: "high",
      max_output_tokens: 16000,
      pricing: { input: 3.0, output: 15.0 }
    },
    "claude-opus": {
      vendor: "anthropic",
      label: "claude-opus-4.8",
      model: "claude-opus-4.8",
      reasoning_effort: null,
      reasoning_label: "off",
      max_output_tokens: 8000,
      pricing: { input: 5.0, output: 25.0 }
    },
    // High-cost frontier condition.
    "claude-opus-high": {
      vendor: "anthropic",
      label: "claude-opus-4.8 (r=high)",
      model: "claude-opus-4.8",
      provider_options: { anthropic: { thinking: { type: "adaptive", effort: "high" } } },
      reasoning_label: "high",
      max_output_tokens: 16000,
      pricing: { input: 5.0, output: 25.0 }
    },

    // ===== Google ladder (Gateway) =====
    // Control = thinkingLevel via provider_options (Gemini ignores
    // reasoning_effort through the Gateway). Flash-Lite and 3.5-Flash floor =
    // minimal; 3.1-Pro floor = low (minimal unsupported). 3.1-Pro default = high
    // (reused as HIGH). 3.5-Flash default = medium (in-between), so Flash is run
    // explicitly at minimal and high.
    "gemini-flash-lite": {
      vendor: "google",
      label: "gemini-3.1-flash-lite",
      model: "gemini-3.1-flash-lite",
      reasoning_effort: null,
      reasoning_label: "minimal",
      max_output_tokens: 8000,
      pricing: { input: 0.25, output: 1.50 }
    },
    "gemini-flash-lite-high": {
      vendor: "google",
      label: "gemini-3.1-flash-lite (r=high)",
      model: "gemini-3.1-flash-lite",
      provider_options: { google: { thinkingConfig: { thinkingLevel: "high" } } },
      reasoning_label: "high",
      max_output_tokens: 16000,
      pricing: { input: 0.25, output: 1.50 }
    },
    "gemini-flash-min": {
      vendor: "google",
      label: "gemini-3.5-flash (r=minimal)",
      model: "gemini-3.5-flash",
      provider_options: { google: { thinkingConfig: { thinkingLevel: "minimal" } } },
      reasoning_label: "minimal",
      max_output_tokens: 8000,
      pricing: { input: 1.50, output: 9.00 }
    },
    "gemini-flash-high": {
      vendor: "google",
      label: "gemini-3.5-flash (r=high)",
      model: "gemini-3.5-flash",
      provider_options: { google: { thinkingConfig: { thinkingLevel: "high" } } },
      reasoning_label: "high",
      max_output_tokens: 16000,
      pricing: { input: 1.50, output: 9.00 }
    },
    "gemini-pro": {
      vendor: "google",
      label: "gemini-3.1-pro-preview",
      model: "gemini-3.1-pro-preview",
      reasoning_effort: null,
      reasoning_label: "high",
      max_output_tokens: 8000,
      pricing: { input: 2.0, output: 12.0 }
    },
    "gemini-pro-low": {
      vendor: "google",
      label: "gemini-3.1-pro-preview (r=low)",
      model: "gemini-3.1-pro-preview",
      provider_options: { google: { thinkingConfig: { thinkingLevel: "low" } } },
      reasoning_label: "low",
      max_output_tokens: 8000,
      pricing: { input: 2.0, output: 12.0 }
    },

    // ===== Open-weight ladder (Gateway) =====
    // DeepSeek: reasoning_effort "none" disables thinking; ON is the provider
    // default (full reasoning). Kimi: provider-namespaced
    // provider_options.moonshotai.thinking={type:"disabled"} disables thinking
    // through the same Gateway transport as the provider-default ON row.
    "deepseek-flash": {
      vendor: "deepseek",
      label: "deepseek-v4-flash",
      model: "deepseek-v4-flash",
      reasoning_effort: null,
      reasoning_label: "on",
      max_output_tokens: 8000,
      pricing: { input: 0.14, output: 0.28 }
    },
    "deepseek-flash-off": {
      vendor: "deepseek",
      label: "deepseek-v4-flash (r=off)",
      model: "deepseek-v4-flash",
      reasoning_effort: "none",
      reasoning_label: "off",
      max_output_tokens: 8000,
      pricing: { input: 0.14, output: 0.28 }
    },
    "deepseek-pro": {
      vendor: "deepseek",
      label: "deepseek-v4-pro",
      model: "deepseek-v4-pro",
      reasoning_effort: null,
      reasoning_label: "on",
      max_output_tokens: 8000,
      pricing: { input: 0.435, output: 0.87 }
    },
    "deepseek-pro-off": {
      vendor: "deepseek",
      label: "deepseek-v4-pro (r=off)",
      model: "deepseek-v4-pro",
      reasoning_effort: "none",
      reasoning_label: "off",
      max_output_tokens: 8000,
      pricing: { input: 0.435, output: 0.87 }
    },
    "kimi": {
      vendor: "moonshotai",
      label: "kimi-k2.6",
      model: "kimi-k2.6",
      reasoning_effort: null,
      reasoning_label: "on (provider default)",
      max_output_tokens: 8000,
      pricing: { input: 0.95, output: 4.0 }
    },
    "kimi-off": {
      // Kimi K2.6 with thinking disabled, via the SAME gateway transport as the
      // `kimi` (on) row, so the on/off contrast isolates reasoning, not API path.
      // The gateway disables Moonshot thinking only via the provider-namespaced
      // option below (verified: reasoning_tokens drop to 0; top-level `thinking`,
      // `reasoning.effort=none`, and `chat_template_kwargs` do NOT disable it).
      vendor: "moonshotai",
      label: "kimi-k2.6",
      model: "kimi-k2.6",
      reasoning_effort: null,
      reasoning_label: "off",
      provider_options: { moonshotai: { thinking: { type: "disabled" } } },
      max_output_tokens: 8000,
      pricing: { input: 0.95, output: 4.0 }
    }
  })
});

// Wall-time hint per variant in seconds per API call. Used by the
// runner's cost-and-time summary. Not part of the canonical protocol.
export const VARIANT_WALL_HINT_SEC_PER_CALL = Object.freeze({
  "nano":                    3,
  "nano-high":               6,
  "mini":                    3,
  "mini-high":               6,
  "g54":                     6,
  "g54-high":                15,
  "g55-none":                5,
  "g55-high":                30,
  "gpt-oss-high":            5,
  "gpt-oss-low":             4,
  "gpt-oss-120b-high":       6,
  "gpt-oss-120b-low":        5,
  "claude-haiku":            4,
  "claude-haiku-high":       8,
  "claude-sonnet":           6,
  "claude-sonnet-high":      12,
  "claude-opus":             8,
  "claude-opus-high":        16,
  "gemini-flash-lite":       4,
  "gemini-flash-lite-high":  6,
  "gemini-flash-min":        4,
  "gemini-flash-high":       8,
  "gemini-pro":              6,
  "gemini-pro-low":          6,
  "deepseek-flash":          6,
  "deepseek-flash-off":      4,
  "deepseek-pro":            8,
  "deepseek-pro-off":        5,
  "kimi":                    12
});

// Per-call cost hint per variant in USD. Same use as the wall hints above.
// Derived from ~5K input + ~200 output tokens per call at the verified
// per-million-token prices above; high/on conditions bill hidden reasoning
// tokens at the output rate, so their real cost runs higher.
export const VARIANT_COST_HINT_PER_CALL = Object.freeze({
  "nano":                    0.000085,
  "nano-high":               0.0015,
  "mini":                    0.000396,
  "mini-high":               0.0073,
  "g54":                     0.0145,
  "g54-high":                0.0300,
  "g55-none":                0.031,
  "g55-high":                0.060,
  "gpt-oss-high":            0.0006,
  "gpt-oss-low":             0.0004,
  "gpt-oss-120b-high":       0.0018,
  "gpt-oss-120b-low":        0.0012,
  "claude-haiku":            0.006,
  "claude-haiku-high":       0.012,
  "claude-sonnet":           0.018,
  "claude-sonnet-high":      0.030,
  "claude-opus":             0.030,
  "claude-opus-high":        0.050,
  "gemini-flash-lite":       0.0015,
  "gemini-flash-lite-high":  0.0035,
  "gemini-flash-min":        0.0020,
  "gemini-flash-high":       0.0093,
  "gemini-pro":              0.0124,
  "gemini-pro-low":          0.0090,
  "deepseek-flash":          0.00076,
  "deepseek-flash-off":      0.00030,
  "deepseek-pro":            0.0023,
  "deepseek-pro-off":        0.0010,
  "kimi":                    0.0056
});
