# Contributing to SteerBench-Work

The benchmark gets better when people add scenarios, configurations, adapters, or bug fixes. This file says how.

## Code of Conduct

This project follows the [Contributor Covenant 2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/). Report unacceptable behavior to the maintainers via a private GitHub message on the repository.

## Where to Start

Three issue templates live in `.github/ISSUE_TEMPLATE/`:

1. `scenario-proposal.md` for proposing a new scenario.
2. `bug-report.md` for runner, adapter, or scoring bugs.
3. `discussion.md` for design questions, schema changes, or research notes.

Open an issue before a non-trivial PR. Scope alignment first, code second.

## Contributing a Scenario

Scenarios are the core data of this benchmark. The entire repository (runner code, scoring harness, validators, scenario JSON, manifests, methodology, run artifacts) ships under CC BY 4.0.

1. Copy an existing scenario file under `scenario-sets/steerbench-work-2026-05/` as a template. Keep the JSON shape exactly.
2. Fill `task`, `tools`, `evidence`, `commit_point`, `worker_proposal`, `expected_action`, and `expected_outcome`. Write in plain language.
3. Validate by planning a new run root and confirming the scenario hashes into `SCENARIO_MANIFEST.json` without error: `npm run bench -- plan --run-id contrib-<your-id>`.
4. Smoke-test with `npm run bench -- smoke --variant mini --scenario your-scenario-id`. The trial must write to `runs/smoke/` without errors.
5. Open the PR. Include the scenario file, a snippet from the smoke trial in the PR body, and one paragraph saying what steering moment this scenario adds that the existing set does not cover.

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
3. Pass the adapter contract checks invoked during `bench validate`.

Adapter PRs are reviewed most carefully because one adapter touches every scenario.

## Licensing

The entire repository ships under CC BY 4.0. This covers runner code, scoring harness, validators, scenario JSON, manifests, methodology, and run artifacts. See `LICENSE` for the full license text and `LICENSE-DATA` for the data-specific restatement. All contributions agree to CC BY 4.0.

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

Every code PR must pass `npm run bench -- validate --run-id <id>` against a smoke run, and any unit checks the package ships, locally before review.
