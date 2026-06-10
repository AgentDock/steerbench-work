"""SteerBench-Work reward adapter for Tinker cookbook RL.

SteerBenchProblemEnv exposes the four-method ProblemEnv surface that
tinker_cookbook/rl/problem_env.py expects (get_question, check_answer,
check_format, get_reference_answer) without importing tinker_cookbook, so
this file is usable standalone and trivially wrappable from the cookbook.

Everything scenario-specific is read from parity-vectors.json, which the
Node exporter (scripts/generate-parity-vectors.mjs) renders with the same
pipeline the benchmark runner uses. This file holds no rendering logic and
no policy table of its own: the allowed commit_permission enum and the
expected_action -> required commit_permission mapping both come from the
vectors file. The only logic ported from the Node scorer is the strict
parse plus the binary comparison.

Reward contract: a response earns format credit only when it is a top-level
JSON object whose commit_permission field is a string in the allowed enum,
and answer credit only when that value equals the required gate state for
the scenario. This is stricter than the benchmark trial extractor, which
recovers fenced JSON and infers the field from policy_action; a policy
being trained should not be rewarded for output that needs rescuing.

Labels in parity-vectors.json carry label_source "benchmark-owner-pre-gold":
they are the benchmark owner's pre-gold labels, not human-adjudicated gold.

Run `python3 steerbench_env.py` to replay the exporter's parity cases
against this implementation; it exits nonzero on any divergence.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

DEFAULT_VECTORS_PATH = Path(__file__).resolve().parent / "parity-vectors.json"

EXPECTED_LABEL_SOURCE = "benchmark-owner-pre-gold"


def load_vectors(vectors_path=DEFAULT_VECTORS_PATH):
    """Load and sanity-check the parity vectors file once; reuse the dict
    across many env instances to avoid re-reading ~320 KiB per scenario."""
    with open(vectors_path, "r", encoding="utf-8") as fh:
        vectors = json.load(fh)
    if vectors.get("label_source") != EXPECTED_LABEL_SOURCE:
        raise ValueError(
            "parity vectors label_source is %r, expected %r"
            % (vectors.get("label_source"), EXPECTED_LABEL_SOURCE)
        )
    for key in ("system_prompt", "allowed_commit_permission",
                "canonical_scoring_mapping", "scenarios", "exporter_version"):
        if key not in vectors:
            raise ValueError("parity vectors file is missing %r" % key)
    return vectors


class SteerBenchProblemEnv:
    """One scenario's steering decision as a Tinker-style problem env."""

    def __init__(self, scenario_id, vectors=None, vectors_path=DEFAULT_VECTORS_PATH):
        if vectors is None:
            vectors = load_vectors(vectors_path)
        scenario = None
        for entry in vectors["scenarios"]:
            if entry["id"] == scenario_id:
                scenario = entry
                break
        if scenario is None:
            raise KeyError("scenario %r not found in parity vectors" % scenario_id)

        mapping = vectors["canonical_scoring_mapping"]
        required = mapping.get(scenario["expected_action"])
        if required is None:
            raise ValueError(
                "scenario %r expected_action %r has no scoring mapping"
                % (scenario_id, scenario["expected_action"])
            )

        self.scenario_id = scenario_id
        self.expected_action = scenario["expected_action"]
        self.system_prompt = vectors["system_prompt"]
        self._user_input = scenario["user_input"]
        self._required = required
        self._allowed = list(vectors["allowed_commit_permission"])

    def get_question(self):
        """The rendered model input, byte-identical to the user message the
        benchmark runner sends. Pair it with `system_prompt` when building
        the conversation."""
        return self._user_input

    def check_format(self, response_str):
        """True when the response is a top-level JSON object whose
        commit_permission is a string in the allowed enum."""
        return self._parse_commit_permission(response_str) is not None

    def check_answer(self, response_str):
        """True when the response passes the format gate and its
        commit_permission equals the required gate state. Mirrors the Node
        scorer's isCorrectByPermission: exact string comparison against the
        canonical mapping, nothing else."""
        value = self._parse_commit_permission(response_str)
        return value is not None and value == self._required

    def get_reference_answer(self):
        return json.dumps({"commit_permission": self._required})

    def _parse_commit_permission(self, response_str):
        """Strict reward-contract parse. Mirrors strictCommitPermission in
        scripts/generate-parity-vectors.mjs: no fenced-block recovery, no
        inference from policy_action."""
        if not isinstance(response_str, str):
            return None
        try:
            obj = json.loads(response_str)
        except ValueError:
            return None
        if not isinstance(obj, dict):
            return None
        value = obj.get("commit_permission")
        if not isinstance(value, str) or value not in self._allowed:
            return None
        return value


def iter_envs(vectors_path=DEFAULT_VECTORS_PATH):
    """Yield one SteerBenchProblemEnv per scenario, sharing a single loaded
    vectors dict."""
    vectors = load_vectors(vectors_path)
    for entry in vectors["scenarios"]:
        yield SteerBenchProblemEnv(entry["id"], vectors=vectors)


def _self_test():
    """Replay every response parity case from the vectors file against this
    implementation. The expected values were computed by the real Node
    scorer; any mismatch means the Python port has drifted."""
    vectors = load_vectors()
    envs = {}
    failures = []
    for case in vectors["response_cases"]:
        sid = case["scenario_id"]
        if sid not in envs:
            envs[sid] = SteerBenchProblemEnv(sid, vectors=vectors)
        env = envs[sid]
        got_format = env.check_format(case["response"])
        got_correct = env.check_answer(case["response"])
        if got_format != case["expected_format_ok"] or got_correct != case["expected_correct"]:
            failures.append(
                "%s: format %s/%s correct %s/%s"
                % (case["case_id"], got_format, case["expected_format_ok"],
                   got_correct, case["expected_correct"])
            )

    n_envs = sum(1 for _ in iter_envs())
    print("steerbench_env self-test")
    print("  vectors: %s (%s)" % (vectors["scenario_set"], vectors["exporter_version"]))
    print("  label_source: %s" % vectors["label_source"])
    print("  envs constructed: %d" % n_envs)
    print("  parity cases replayed: %d" % len(vectors["response_cases"]))
    if failures:
        print("  FAILURES: %d" % len(failures))
        for line in failures[:20]:
            print("    " + line)
        return 1
    print("  all cases match the Node scorer")
    return 0


if __name__ == "__main__":
    sys.exit(_self_test())
