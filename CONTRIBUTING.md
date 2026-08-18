# Contributing to SteerBench-Work

The benchmark gets better when people add scenarios, configurations, adapters, or bug fixes. This file says how.

## Code of Conduct

This project follows the [Contributor Covenant 2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/). Report unacceptable behavior to the maintainers at oguz@agentdock.ai or via GitHub's report-content flow.

## Where to Start

Three issue templates live in `.github/ISSUE_TEMPLATE/`:

1. `scenario-proposal.md` for proposing a new scenario.
2. `bug-report.md` for runner, adapter, or scoring bugs.
3. `discussion.md` for design questions, schema changes, or research notes.

Open an issue before a non-trivial PR. Scope alignment first, code second.

## Contributing a Scenario

Scenarios are the core data of this benchmark. The data assets (scenario JSON, manifests, results bundles) ship under CC BY 4.0 (`LICENSE-DATA`); the runner code, scoring harness, and validators ship under MIT (`LICENSE`).

1. Copy an existing scenario file under `scenario-sets/steerbench-work-2026-05/` as a template (`refund-policy-001.json` carries the full standard shape). Keep the JSON shape exactly.
2. Fill the identity fields: `id`, `version`, `domain`, `action_verb`, `irreversibility_class`, `title`, and `user_request`. Then write `context.goal`, `tools_available`, and the author-only rationale in `context.hidden_trap`. That annotation must never enter model-visible bytes or detector features. Write in plain language.
3. Describe the commit moment in `decision_point`: `proposed_action`, `draft`, `confidence`, and `evidence_ids`. `decision_point.evidence_ids` is the only selector for evidence shown to the model at that moment. Each `evidence[]` entry carries `id`, `source_type`, `title`, `status`, and `raw_ref`. List the ids a careful worker should consult in `expected_evidence`; that field belongs to the answer key and never selects model-visible input.
4. Fill `expected_behavior`. `correct_action` is the scored label and must be one of `continue`, `proceed`, `block`, `request_approval`, `escalate`, or `ask_clarification`. Add `human_correction`, `recovery_summary`, `clean_outcome`, and `autonomous_failure`, then finish with `tags` and `license`.
5. Validate the fields with `node scripts/validate-scenarios.mjs --scenario-set-dir <your set>`. For the release set, regenerate and review `ID_MAP.json` with `node scripts/generate-id-map.mjs`; an unmapped scenario or evidence join key fails closed. Then confirm the scenario hashes into `SCENARIO_MANIFEST.json` without error: `npm run bench -- plan --run-id contrib-<your-id>`.
6. Smoke-test with `npm run bench -- smoke --variant mini --scenario your-scenario-id`. The trial must write to `runs/smoke/` without errors.
7. Open the PR. Include the scenario file, a snippet from the smoke trial in the PR body, and one paragraph saying what steering moment this scenario adds that the existing set does not cover.

Scenarios must be reproducible from fixtures. Scenarios that require a live API stay out of the public set.

## Contributing a Configuration

Configurations are the per-variant model parameters used by the canonical runner (model id, reasoning effort, structured output mode, pricing).

1. Add your variant entry to `configs/reported-run.mjs`. Keep the contract: every variant produces a stable `variant_config_hash` so resume and validation work.
2. Plan a fresh run root that includes the new variant and confirm it appears in `VARIANT_CONFIGS.json` and `RUN_PLAN.variant_config_hashes`.
3. Smoke-test the variant on a single scenario before requesting review.

## Contributing an Adapter

Adapters connect a worker runtime to the benchmark. A new adapter must:

1. Emit a structured response carrying the `commit_permission` field defined in `src/schema.mjs`.
2. Attach an integrity-evidence record using the `steerbench.integrity_evidence.v1` shape documented in `src/integrity-evidence.mjs`.
3. Smoke-test the adapter on one scenario and confirm the resulting trial passes `bench validate` (schema parse, provenance fields, prompt hash).

Adapter PRs are reviewed most carefully because one adapter touches every scenario.

## Licensing

Two licenses cover this repository. Runner code, scoring harness, and validators ship under MIT (`LICENSE`). Data assets — scenario JSON, manifests, results bundles, annotation and validation reports — ship under CC BY 4.0 (`LICENSE-DATA`). Code contributions agree to MIT; scenario and fixture contributions agree to CC BY 4.0.

## Review SLA

| Contribution type | First response | Decision target |
|-------------------|----------------|-----------------|
| Scenario          | 3 business days | 7 business days |
| Configuration     | 3 business days | 10 business days |
| Adapter           | 5 business days | 14 business days |
| Bug fix           | 2 business days | 5 business days |
| Docs              | 2 business days | 5 business days |

## Maintainers

PRs are reviewed by the project maintainers. Tag a maintainer on your PR; if you are unsure who to tag, leave it unassigned and a maintainer will pick it up.

## Style

- No em-dashes in docs, READMEs, or commit messages. Use periods, commas, colons, or parentheses.
- Imperative subject lines for commits ("Add x"). Max 72 characters.
- Numbers up front. Direct register. Cut marketing language.

## Tests

Every code PR must pass `npm run bench -- validate --run-id <id> --mode smoke` against a smoke run, and any unit checks the package ships, locally before review.
