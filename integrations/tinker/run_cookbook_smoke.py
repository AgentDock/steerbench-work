"""Replayable smoke test: load this repo's exports through the official
tinker-cookbook dataset builders.

Environment setup (one time):

    python3.13 -m venv /tmp/tinker-venv
    /tmp/tinker-venv/bin/pip install tinker blobfile chz datasets torch \
        "transformers<=5.5.3" pillow tiktoken
    git clone --depth 1 \
        https://github.com/thinking-machines-lab/tinker-cookbook /tmp/tinker-cookbook
    /tmp/tinker-venv/bin/pip install --no-deps -e /tmp/tinker-cookbook

Inputs (regenerate from the repo root):

    node scripts/export-sft.mjs --scenario-set-dir scenario-sets/steerbench-work-2026-05 \
        --out /tmp/accept-sft
    node scripts/export-preferences.mjs --runs-dir runs \
        --scenario-set-dir scenario-sets/steerbench-work-2026-05 \
        --max-pairs-per-scenario 6 --seed 1 --out /tmp/accept-pref

Run from the repo root:

    /tmp/tinker-venv/bin/python integrations/tinker/run_cookbook_smoke.py

No Tinker account or API key is used and no training run is started. The
deepest step builds one tokenized datum in memory; the only network fetch
is the public Qwen tokenizer from Hugging Face.
"""

import json
import sys

SFT_FULL = "/tmp/accept-sft/sft.jsonl"
SFT_SAMPLE = "sample-artifacts/training-views-sample/sft.sample.jsonl"
PAIRS = "/tmp/accept-pref/all.jsonl"

results = []


def record(status, name, detail):
    results.append((status, name, detail))
    print(f"{status}  {name}: {detail}")


def main():
    from tinker_cookbook.exceptions import DataFormatError
    from tinker_cookbook.supervised.data import FromConversationFileBuilder
    from tinker_cookbook.supervised.types import ChatDatasetBuilderCommonConfig

    cfg = ChatDatasetBuilderCommonConfig(
        model_name_for_tokenizer="Qwen/Qwen3-8B",
        renderer_name="qwen3",
        max_length=4096,
        batch_size=4,
    )

    def sft_load(path):
        builder = FromConversationFileBuilder(
            file_path=path, common_config=cfg, shuffle_seed=0
        )
        train, _test = builder()
        return train

    # 1. Official SFT loader accepts the full export and the committed sample.
    try:
        train = sft_load(SFT_FULL)
        n = len(train.hf_dataset) if hasattr(train, "hf_dataset") else "n/a"
        record("PASS", "SFT full export via FromConversationFileBuilder", f"{n} rows")
    except Exception as e:  # noqa: BLE001
        record("FAIL", "SFT full export", f"{type(e).__name__}: {e}")

    try:
        sft_load(SFT_SAMPLE)
        record("PASS", "Committed 12-row sample via FromConversationFileBuilder", "accepted")
    except Exception as e:  # noqa: BLE001
        record("FAIL", "12-row sample", f"{type(e).__name__}: {e}")

    # 2. Negative control: the official validation must reject a bad line.
    bad = "/tmp/cookbook-smoke-bad.jsonl"
    with open(bad, "w") as f:
        f.write(json.dumps({"not_messages": []}) + "\n")
    try:
        sft_load(bad)
        record("FAIL", "Negative control", "malformed line was accepted")
    except DataFormatError:
        record("PASS", "Negative control", "official DataFormatError raised")

    # 3. One tokenized datum through the official renderer + tokenizer.
    try:
        train = sft_load(SFT_SAMPLE)
        datum = train.get_batch(0)[0]
        tokens = (
            len(datum.model_input.to_ints())
            if hasattr(datum.model_input, "to_ints")
            else "n/a"
        )
        record("PASS", "Tokenized Datum via renderer qwen3", f"model_input tokens: {tokens}")
    except Exception as e:  # noqa: BLE001
        record("FAIL", "Datum build", f"{type(e).__name__}: {str(e)[:200]}")

    # 4. Official preference objects and JSONL loader on our pairs.
    try:
        from tinker_cookbook.preference.preference_datasets import (
            ComparisonBuilderFromJsonl,
        )
        from tinker_cookbook.preference.types import Comparison, LabeledComparison

        rows = [json.loads(line) for line in open(PAIRS)][:25]
        for row in rows:
            comparison = Comparison(
                prompt_conversation=row["comparison"]["prompt_conversation"],
                completion_A=row["comparison"]["completion_A"],
                completion_B=row["comparison"]["completion_B"],
            )
            labeled = LabeledComparison(comparison=comparison, label=row["label"])
            assert labeled.label in ("A", "B")
        record("PASS", "Comparison/LabeledComparison objects", f"{len(rows)} rows constructed")

        builder = ComparisonBuilderFromJsonl(train_path=PAIRS)
        train_ds, _ = builder.get_train_and_test_datasets()
        labels = {
            builder.example_to_labeled_comparison(train_ds[i]).label
            for i in range(min(50, len(train_ds)))
        }
        assert labels <= {"A", "B"}, f"unexpected labels: {labels}"
        record(
            "PASS",
            "ComparisonBuilderFromJsonl",
            f"{len(train_ds)} rows loaded, labels {sorted(labels)} only",
        )
    except Exception as e:  # noqa: BLE001
        record("FAIL", "preference loader", f"{type(e).__name__}: {str(e)[:200]}")

    # 5. Reward adapter implements the official ProblemEnv method surface.
    try:
        from tinker_cookbook.rl.problem_env import ProblemEnv

        required = [
            m
            for m in ("get_question", "check_answer", "check_format")
            if hasattr(ProblemEnv, m)
        ]
        sys.path.insert(0, "integrations/tinker")
        import steerbench_env as se

        env_cls = next(
            getattr(se, name)
            for name in dir(se)
            if "Env" in name
            and not name.startswith("_")
            and isinstance(getattr(se, name), type)
        )
        missing = [m for m in required if not hasattr(env_cls, m)]
        if missing:
            record("FAIL", "ProblemEnv contract", f"missing methods: {missing}")
        else:
            record("PASS", "ProblemEnv contract", f"adapter implements {required}")
    except Exception as e:  # noqa: BLE001
        record("FAIL", "ProblemEnv contract", f"{type(e).__name__}: {str(e)[:200]}")

    passed = sum(1 for s, _, _ in results if s == "PASS")
    failed = sum(1 for s, _, _ in results if s == "FAIL")
    print(f"\nSUMMARY: {passed} pass / {failed} fail")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
