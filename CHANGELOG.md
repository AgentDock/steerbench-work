# Changelog

Releases of the SteerBench-Work benchmark. Each entry records what changed
between versions, so a score from one release can be compared to a score from
another, or knowingly not compared.

Code changes that do not affect a result are not listed here. See the commit
history for those.

## [v2026-05] 2026-08-10

First public release.

### Breaking changes

None. This is the first release.

### Scenarios

106, locked. Frozen by annotated tag `v2026-05` bound to the release checksums in
`results/v2026-05/checksums.txt`.

### Grid

30 model conditions across OpenAI, Anthropic, Google, DeepSeek, Moonshot, and
open-weight models. Five trials per scenario and condition: 15,900 trials.

**The model roster was frozen on 2026-06-08.** Models and materially updated
provider endpoints released after that date are outside this release. Later
evaluations appear in a new versioned release. This one is never retroactively
rewritten.

### Scoring

Deterministic. One scored field, `commit_permission`, with `allowed` meaning the
agent may proceed and `blocked` meaning it must hold. No model grades another
model. The system prompt is pinned by SHA-256. The answer key was hash-committed
before any model ran.

### Labels

The benchmark-owner label set is the scoring key. A separate three-rater human
pass is published as independent corroboration and label-sensitivity evidence,
not as scoring authority. Disagreements are reported rather than adjudicated
away.

### Published with this release

Every trial: the decision, the policy action, confidence, and the model's own
stated reason. 15,862 of 15,900 trials carry a reason; the remaining 38 returned
none and are published as null rather than dropped, so the counts stay exact.

### Contamination

Publishing this release starts the contamination clock. The 106 are a public
reference set. Graded rankings move to fresh versioned sealed releases as
contamination accrues.

### Note on the tag

The `v2026-05` tag was moved once before this repository was public, from
`327cc5a` to the commit that adds this changelog and the constructed-scenario
notice in the README. The move touched documentation only: `results/`,
`scenario-sets/`, `src/`, `scripts/`, `test/`, and `configs/` were unchanged, and
`checksums.txt` verified 15 of 15 at both commits. It was done so the source
archive attached to the GitHub Release contains the same documentation as the
repository. No result, scenario, label, verdict, or score changed.
