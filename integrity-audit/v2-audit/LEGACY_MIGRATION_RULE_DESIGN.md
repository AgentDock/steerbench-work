# CP4 legacy migration-rule design ruling

Status: frozen implementation design; scientific-owner rule approval remains pending

Design request message: `d91282ce`

Coordinator ruling message: `d11a26cc-250d-4e56-be21-fb40a7f0cd5d`

This file records the complete, untruncated semantics of the design request and
coordinator ruling that govern the CP4 legacy migration-rule implementation.
Only the superseded approval-quotation phrases were privacy-normalized under the
2026-08-22 ruling recorded below; no A, B, C, D, process, or exclusion term was
removed.
It authorizes no live scenario edit, evidence or gold recertification, final
CP4 signature, model or API call, spend, publication, push, or scientific
claim. The final rule will not become governing until `VALIDATION_PLAN.md`
records that the `scientific_owner` approved the rule's exact raw SHA-256 on a
calendar date. The approval statement remains in the private session record and
is not copied into this repository.

## Complete design request

> NEXT WORKSTREAM — legacy migration-rule design rulings required before edits.
> Read-only map complete; HEAD/origin ebb07ca, worktree clean.
>
> Grounded blocker: current LEGACY_MIGRATION_RULE_DRAFT.json is 9,200 bytes /
> e618e307...d13812c but literally declares
> draft_pending_owner_recertification, non_governing:true,
> governance_effect:none, and CP4 source_receipts=raw row only. It therefore
> cannot coherently be approved as governing and conflicts with
> CP4_SIGNING_BOUNDARY_AUDIT.md's requirement that all 11 completed legacy
> records bind the approved rule raw hash. All 61 old src strings (39 used + 22
> missing) resolve to zero committed files, so rule approval cannot imply
> source/fact recertification.
>
> Local precedents support: hash-pinned owner approval recorded in
> VALIDATION_PLAN.md; supporting drafts stay unsigned/non-governing; no
> per-row/rule-bundle signature; all 11 completed records bind the rule receipt;
> the single final 106-row CP4 envelope transitively signs those receipts.
>
> Please rule A/B/D (recommendations first):
>
> A — final artifact lifecycle (RECOMMEND): preserve both current review
> artifacts unchanged; add self-contained LEGACY_MIGRATION_RULE.json with schema
> `steerbench.cp4_legacy_migration_rule.v1`. It must not self-claim approval.
> Freeze an activation contract saying its exact raw bytes become governing only
> when VALIDATION_PLAN.md records that the scientific owner approved the raw SHA
> on a calendar date; no separate signature_envelope; requested changes create a
> new hash.
> Alternative: governing wrapper around the draft (more indirection). Confirm
> exact approach and whether lifecycle field name/value may be
> `activation: owner_approval_of_exact_raw_sha256_required_before_use`.
>
> B — receipt placement (RECOMMEND): every exact legacy-cohort CP4 record must
> include both its own authored-row raw receipt and exact
> LEGACY_MIGRATION_RULE.json receipt in record.source_receipts; rule receipt
> forbidden outside the 11. Additional factual receipts remain nested/top-level
> as required. Complete-CP4 validation enforces path+hash+cohort; pending blank
> shells remain valid. Confirm.
>
> C — approval scope (RECOMMEND/please affirm): approve mapping mechanics only.
> It does NOT certify the 38 current statuses, Workday suspect proposal, any used
> fact or missing reason, evidence IDs/source types, labels, row edits, CP4,
> model calls, spend/publication/push. Remaining six owner-decision categories
> stay unresolved for row work/final CP4.
>
> D — structured destination (RECOMMEND): governing rule requires an
> owner-approved per-entry choice among the CURRENT renderable
> EVIDENCE_RENDER_SCHEMA fields, backed by source receipts and consistent with
> assigned source_type. No content may live only in CP4
> model_visible_evidence.facts because that field does not render. No schema
> extension; tool_call_result only for actual tool-call payloads; filename/title/
> raw_ref never evidence. Do not hard-map every document to `value`, because
> current schema has typed fields and source semantics vary. Confirm this
> constrained per-entry choice.
>
> After ruling I will implement deterministic generator/validator, new rule
> artifact, exact tests, complete-CP4 cohort receipt enforcement, Finding-5 red
> fixtures, package allowlist, regenerated CP3/CP4 receipts, full tests, and
> hostile review. I will not touch live scenarios/ID_MAP/completed CP4 rows or
> request owner approval until the candidate is hash-frozen and independently
> reproduced.

## Complete coordinator ruling

> LEGACY RULE DESIGN RULINGS — A/B/C/D
>
> Grounding re-verified by me: draft e618e307 self-declares
> draft_pending/non_governing/effect-none (so approving it as governing would be
> self-contradictory), and EVIDENCE_RENDER_SCHEMA has exactly 12 render-true keys
> (value, tool_call_result, status, source_type, amount_usd,
> approval_threshold_usd, supervisor_approval_threshold_months, effective_from,
> effective_until, timezone, protected_path_match, evaluation_provenance) with
> id/legacy_id/title/raw_ref suppressed. Your premises hold.
>
> A — RULED as recommended: new self-contained LEGACY_MIGRATION_RULE.json
> (schema steerbench.cp4_legacy_migration_rule.v1), no self-claimed approval, no
> signature_envelope. Activation contract: exact raw bytes become governing ONLY
> when VALIDATION_PLAN.md records that the scientific owner approved the raw SHA
> on a calendar date — the privacy-minimized successor to the 2026-08-19 and
> 2026-08-21 mechanisms. Any change =
> new hash = new plan record. REJECT the wrapper alternative: wrapping the draft
> would carry its self-descriptions into governing bytes.
>
> B — CONFIRMED, with one strengthening: the complete-CP4 validator enforces
> BOTH directions against the exact 11-ID cohort set — every cohort record
> carries its authored-row receipt AND the exact rule receipt; zero non-cohort
> records carry the rule receipt (check membership by ID set, not by count).
> Pending blank shells stay valid.
>
> C — AFFIRMED: owner approval covers mapping mechanics only; it certifies none
> of the 38 statuses, the Workday suspect proposal, any used fact/missing reason,
> evidence IDs/source types, labels, row edits, CP4 itself, model calls, spend,
> publication, or push. Put the full exclusion list in the artifact; keep the
> sentence the owner actually types SHORT (operator preference, on record).
>
> D — CONFIRMED: per-entry destination must be an owner-approved choice among
> the CURRENT 12 renderable keys, type-consistent (typed fields for typed
> content; value only where no typed field fits; tool_call_result strictly for
> genuine tool-call payloads with source_type tool_call). Nothing may live solely
> in non-rendering locations; no schema extension; id/legacy_id/title/raw_ref
> never carry evidence content.
>
> PROCESS REQUIREMENT: your ruling request reached me truncated in three places
> (A's alternative, D's tail, the implementation list). Materialize the FULL
> untruncated request + these rulings into a hash-pinned design file the
> implementation will follow, and explicitly flag ANY point where the truncated
> portions diverge from my rulings BEFORE building on it. Then implement;
> candidate review as usual.

## Superseding owner-words minimization ruling

Coordinator message `1df1f41a-ba73-4df6-ae1b-0e07daeac313` records the
operator's 2026-08-22 privacy ruling. It supersedes only the earlier approval
recording ceremony, not rulings A, B, C, or D:

- Repository artifacts record that approval happened; they do not retain the
  approval statement, owner name, owner identifier, initials, attestation text,
  or free-text signature.
- The rule has no signature envelope. Its activation is mechanically proven by
  exactly one full-line neutral record in `VALIDATION_PLAN.md` with this grammar:
  `approval_record artifact=LEGACY_MIGRATION_RULE.json sha256=<64 lowercase hex> approved_on=YYYY-MM-DD role=scientific_owner`.
- The activation validator must bind the exact raw rule SHA-256, require the
  literal role token `scientific_owner`, validate a real Gregorian calendar
  date, and reject a missing, malformed, mismatched, or duplicate record.
- The approval statement stays in the private session record. The repository
  contains no paraphrase presented as the owner's words.
- The existing review artifacts remain byte-preserved. This design file and the
  generated candidate change hash because the superseding privacy ruling changes
  their activation contract; neither change activates the rule.

## Truncation reconciliation

There is no divergence between the complete request and the coordinator ruling.
The three truncated portions reconcile as follows:

1. **A's alternative.** The complete request disclosed a governing wrapper as
   the alternative to the recommended self-contained artifact. The ruling
   explicitly rejects that alternative and selects the recommendation. The
   implementation must create `LEGACY_MIGRATION_RULE.json`, preserve both review
   artifacts unchanged, and add no wrapper.
2. **D's tail.** The complete request prohibited schema extension, restricted
   `tool_call_result` to genuine tool-call payloads, prohibited filenames,
   titles, and raw references as evidence, and rejected a universal mapping to
   `value`. The ruling confirms all four points and strengthens them by naming
   the exact twelve currently renderable keys and the typed-field-first rule.
3. **Implementation list.** The complete request enumerated the generator,
   validator, artifact, exact tests, complete-CP4 cohort receipt enforcement,
   Finding-5 red fixtures, package allowlist, regenerated CP3/CP4 receipts, full
   tests, and hostile review. The ruling says to implement after this design
   record and requests the usual candidate review. No listed implementation
   step conflicts with A, B, C, or D; all remain required.

## Frozen implementation consequences

- The governing candidate is a new self-contained
  `LEGACY_MIGRATION_RULE.json`; the existing draft rule and row-draft bundle
  remain byte-preserved, unsigned, and non-governing review history.
- The final rule has no `signature_envelope` and makes no claim that owner
  approval has already occurred. Its activation value is
  `owner_approval_of_exact_raw_sha256_required_before_use`.
- Complete-CP4 validation may use the rule only after mechanically finding the
  exact neutral approval record defined above in `VALIDATION_PLAN.md`.
- Rule approval covers only field-by-field mapping mechanics. The artifact must
  enumerate the entire exclusion scope from ruling C.
- The rule freezes the exact twelve renderable keys from the current
  `EVIDENCE_RENDER_SCHEMA.json`. Per-entry choices must be source-receipted,
  owner-approved, source-type-consistent, and typed-field-first. `value` is a
  last fit, and `tool_call_result` is allowed only for a genuine tool-call
  payload whose `source_type` is `tool_call`.
- A complete CP4 artifact must prove both receipt directions by exact scenario
  ID membership: each of the eleven legacy records contains its own authored
  row receipt and the exact final-rule receipt; no other record contains the
  rule receipt. Pending blank shells remain valid.
- No live scenario, ID map, completed CP4 record, source fact, evidence status,
  missing-evidence disposition, reference label, or owner approval is created
  while building or reviewing the rule candidate.
- An approval request is presented only after two independent raw-hash
  reproductions and hostile review. The response remains in the private session
  record; only the neutral activation record is added to this plan after
  approval.
