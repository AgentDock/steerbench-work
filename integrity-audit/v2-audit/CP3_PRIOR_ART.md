# Checkpoint 3 scientific grounding

This is the pinned claim-to-source record for the Checkpoint 3 instrument
design. It records what each source supports and, equally importantly, what it
does not establish. The governing implementation remains `VALIDATION_PLAN.md`.

The exact SteerBench warning names, JSON schemas, trace grammar, 90% blocking
threshold, majority-lookup classifier, and leave-one-family-out implementation
are benchmark-specific frozen design choices. No paper below is cited as an
industry standard for those choices. The papers support the diagnostic
principles; committed code, fixtures, and receipts must validate the local
implementation.

## Shortcut and partial-input diagnostics

1. **Geirhos et al., “Shortcut Learning in Deep Neural Networks.”** Nature
   Machine Intelligence 2, 665–673 (2020), DOI
   `10.1038/s42256-020-00257-z`; pinned open manuscript
   `arXiv:2004.07780v5` (2023-11-21),
   <https://arxiv.org/abs/2004.07780v5>.
   Supports: a shortcut is a decision rule that performs well under ordinary
   benchmark conditions but fails under a deliberately changed test condition;
   out-of-distribution checks can expose reliance on unintended features.
   Does not establish: SteerBench's feature registry, classifier, threshold, or
   remediation rule.

2. **Gururangan et al., “Annotation Artifacts in Natural Language Inference
   Data.”** NAACL-HLT 2018, ACL Anthology `N18-2017`, DOI
   `10.18653/v1/N18-2017`, <https://aclanthology.org/N18-2017/>.
   Supports: annotation procedures can leave label-predictive clues; a model
   given only part of the intended input can exploit them and overstate task
   performance.
   Does not establish: that every predictive metadata field is necessarily an
   artifact or that removal is always the correct repair.

3. **Poliak et al., “Hypothesis Only Baselines in Natural Language
   Inference.”** *SEM 2018, ACL Anthology `S18-2023`, DOI
   `10.18653/v1/S18-2023`, <https://aclanthology.org/S18-2023/>.
   Supports: a deliberately information-starved baseline can diagnose
   statistical irregularities when it beats a majority baseline without the
   information the intended task requires.
   Does not establish: that one partial-input baseline is a sufficient audit.

4. **Kaushik and Lipton, “How Much Reading Does Reading Comprehension
   Require? A Critical Investigation of Popular Benchmarks.”** EMNLP 2018,
   ACL Anthology `D18-1546`, DOI `10.18653/v1/D18-1546`,
   <https://aclanthology.org/D18-1546/>.
   Supports: question-only and passage-only controls can reveal that a
   benchmark answer is recoverable without all information the intended task
   supposedly requires. This supports testing several prespecified restricted
   views rather than relying on a single nuisance view.
   Does not establish: which SteerBench metadata views or combinations are
   sufficient.

5. **Feng, Wallace, and Boyd-Graber, “Misleading Failures of Partial-input
   Baselines.”** ACL 2019, ACL Anthology `P19-1554`, DOI
   `10.18653/v1/P19-1554`, <https://aclanthology.org/P19-1554/>.
   Supports: success of a partial-input baseline shows a dataset is cheatable,
   but failure of that baseline does not prove the dataset artifact-free;
   trivial full-input patterns can evade it.
   Consequence here: the shortcut gate scans a frozen registry of individual
   and paired structured features and is only one necessary gate, not proof that
   the benchmark is shortcut-free.

6. **Le Bras et al., “Adversarial Filters of Dataset Biases.”** ICML 2020,
   PMLR 119:1078–1088, stable proceeding ID `pmlr-v119-bras20a`,
   <https://proceedings.mlr.press/v119/bras20a.html>.
   Supports: simple predictive models can measure spurious dataset biases and
   help diagnose overestimated benchmark performance.
   Does not establish: permission to delete hard rows or fabricate balancing
   evidence. SteerBench instead blocks and requires source-grounded repair.

7. **McCoy, Pavlick, and Linzen, “Right for the Wrong Reasons: Diagnosing
   Syntactic Heuristics in Natural Language Inference.”** ACL 2019, ACL
   Anthology `P19-1334`, DOI `10.18653/v1/P19-1334`,
   <https://aclanthology.org/P19-1334/>.
   Supports: controlled examples on which a fallible heuristic and the intended
   reasoning diverge can reveal a system that is right for the wrong reason.
   This motivates the three-row warning regression as a discriminating
   control, not as three independent demonstrations of validity.
   Does not establish: any SteerBench row fact or reference decision.

8. **Koh et al., “WILDS: A Benchmark of in-the-Wild Distribution Shifts.”**
   ICML 2021; pinned manuscript `arXiv:2012.07421v3` (2021-07-16),
   <https://arxiv.org/abs/2012.07421v3>.
   Supports: performance can drop under meaningful domain/group shifts and
   evaluation should explicitly represent such shifts.
   Does not establish: SteerBench's particular family ledger or
   leave-one-family-out estimator. Those remain local, predeclared choices.

9. **Roberts et al., “Cross-validation strategies for data with temporal,
   spatial, hierarchical, or phylogenetic structure.”** Ecography 40 (2017),
   913–929, DOI `10.1111/ecog.02881`,
   <https://doi.org/10.1111/ecog.02881>.
   Supports: random row splits can give misleadingly optimistic estimates when
   observations are dependent, and blocks should be chosen to match the actual
   dependence structure and prediction goal.
   Consequence here: a family fold is defensible only if the frozen ledger puts
   every dependent variant in the same fold; a topic label alone is not enough.

10. **Liu, Van Niekerk, and Rue, “Leave-group-out cross-validation for latent
    Gaussian models.”** Pinned manuscript `arXiv:2210.04482v6` (2025-07-02),
    journal reference SORT 49(1), 121–146 (2025), DOI
    `10.57645/20.8080.02.25`,
    <https://arxiv.org/abs/2210.04482v6>.
    Supports: leaving out a dependency group can better emulate prediction on
    dependent observations than ordinary leave-one-out evaluation.
    Does not establish: SteerBench's family construction, lookup classifier,
    or threshold. Those must be validated locally and remain owner choices.

## Provenance and contamination claims

11. **Bender and Friedman, “Data Statements for Natural Language Processing:
   Toward Mitigating System Bias and Enabling Better Science.”** TACL 6
   (2018), 587–604, ACL Anthology `Q18-1041`, DOI
   `10.1162/tacl_a_00041`, <https://aclanthology.org/Q18-1041/>.
   Supports: explicit dataset documentation improves the precision of
   scientific claims and makes provenance and intended use inspectable.
   Does not establish: that a provenance statement proves the truth of its own
   contents; SteerBench still requires frozen primary-source receipts.

12. **Fu et al., “Does Data Contamination Detection Work (Well) for LLMs? A
   Survey and Evaluation on Detection Assumptions.”** Findings of NAACL 2025;
   pinned manuscript `arXiv:2410.18966v3` (2025-05-09),
   <https://arxiv.org/abs/2410.18966v3>.
   Supports: contamination can distort evaluation, and contamination detectors
   depend on assumptions that must be stated and empirically tested rather than
   treated as universally valid.
   Consequence here: `evaluation_evidence_provenance_risk` can be generated only
   from explicit, source-recertified structured provenance. A hidden note,
   keyword, identifier, or filename is not contamination evidence.
   Does not establish: SteerBench's row-level evidence-provenance signal or
   that any SteerBench row is contaminated. The paper concerns overlap between
   model training data and evaluation material, not this local warning schema.

13. **Sainz et al., “NLP Evaluation in trouble: On the Need to Measure LLM
    Data Contamination for each Benchmark.”** Findings of EMNLP 2023, ACL
    Anthology `2023.findings-emnlp.722`, DOI
    `10.18653/v1/2023.findings-emnlp.722`,
    <https://aclanthology.org/2023.findings-emnlp.722/>.
    Supports: evaluation on contaminated test material can overestimate model
    performance and compromise scientific conclusions, while the extent of
    contamination is often difficult to establish.
    Does not establish: that `eval-leakage-001` is contaminated. That local
    provenance fact still requires its frozen source receipt.

14. **Oren et al., “Proving Test Set Contamination in Black Box Language
    Models.”** Pinned manuscript `arXiv:2310.17623v2` (2023-11-24),
    <https://arxiv.org/abs/2310.17623v2>.
    Supports: suspected exposure and statistically supported proof are
    different claims; proving contamination requires a stated test and its
    assumptions, not a suggestive filename or note.
    Does not establish: SteerBench's evidence-provenance warning rule or any
    local row fact.

## Proposed action, executed action, and structured traces

The following are contemporary arXiv precedents, not peer-reviewed standards.
They supplement the older peer-reviewed grounding above and are version-pinned
so their claims cannot silently drift.

15. **Mohammadmirzaei and Flanigan, “OSGuard: A Benchmark for Safety in
   Computer-Use Agents.”** `arXiv:2606.15034v1` (2026-06-13),
   <https://arxiv.org/abs/2606.15034v1>.
   Supports: proposed actions can be evaluated relative to the original
   instruction and current state, while executed tasks require separate
   state-based safety invariants. This supports prospective warning language
   and the separation of a proposal from an execution claim.

16. **Zhang et al., “PrivacyPeek: Auditing What LLM-Based Agents Acquire, Not
    Just What They Say.”** `arXiv:2606.00152v2` (2026-08-06),
    <https://arxiv.org/abs/2606.00152v2>.
    Supports: actual information acquisition is audited from tool-call
    trajectories and the data received, not merely from words in a prompt or
    final answer. This supports keeping runtime reads distinct from proposed
    access.

17. **Hu et al., “ToolPrivacyBench: Benchmarking Purpose-Bound Privacy in
    Tool-Using LLM Agents.”** `arXiv:2606.28061v1` (2026-06-26),
    <https://arxiv.org/abs/2606.28061v1>.
    Supports: purpose-bound privacy can be checked by comparing recorded tool
    arguments and backend audit logs with an explicit policy knowledge base;
    successful task completion does not by itself prove appropriate data use.
    This supports structured, traceable operational facts and scoped
    authorization rather than keyword inference.

18. **Liu et al., “AgentAbstain: Do LLM Agents Know When Not to Act?”**
    `arXiv:2607.10059v1` (2026-07-11),
    <https://arxiv.org/abs/2607.10059v1>.
    Supports: controlled should-act/should-abstain pairs and deterministic
    execution evidence can distinguish a pre-action judgment from post-hoc
    abstention after an irreversible action.
    Does not establish: the reference decisions of the three SteerBench rows;
    those require the source/gold recertification receipts reserved to the
    scientific owners.

## Resulting claim ceiling

These sources justify testing for shortcut predictors, documenting evidence
provenance, separating proposed from executed actions, and binding warnings to
structured operational facts. They do not validate any SteerBench label,
threshold, warning name, or source assertion. Those claims remain blocked until
the plan's executable tests and owner-signed recertification records exist.

Predictability must be named precisely. A highly predictive model-visible
irrelevant cue is a shortcut opportunity; a highly predictive legitimate
partial task view shows insufficient counterbalancing; and predictive
author-only construction metadata shows corpus-construction imbalance, not a
cue available to the evaluated model. Passing the restricted-view gate is
non-exonerating, and no gate result by itself proves model reliance.

The ban on the two authored SteerBench input-confidence fields is a
conservative local opacity decision supported by their measured separability
in this corpus. The literature on annotation artifacts motivates checking the
channel; it does not establish that every operational confidence value is a
label leak.
