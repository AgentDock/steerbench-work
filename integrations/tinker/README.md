# Tinker reward adapter for SteerBench-Work

`steerbench_env.py` makes the SteerBench-Work scorer usable as a Tinker cookbook RL
reward: `SteerBenchProblemEnv` exposes the `ProblemEnv` surface from
`tinker_cookbook/rl/problem_env.py` for each of the 106 scenarios in the 2026-05 set.

Inputs are pre-rendered by the Node pipeline into `parity-vectors.json` via
`node scripts/generate-parity-vectors.mjs`, with the scoring vocabulary, the canonical
expected_action to commit_permission mapping, and 260 response parity cases scored by
the real Node scorer. Python holds no rendering logic and no policy table of its own.
All labels carry `label_source: benchmark-owner-pre-gold`.

Usage sketch: `envs = list(steerbench_env.iter_envs())`; hand each env to a
`tinker_cookbook` problem-env group builder with `env.system_prompt` as the system
message. Verify: `python3 steerbench_env.py` and `node --test test/parity-vectors.test.mjs`. Training runs are future work; no training happened here.
