# Checkpoint-4 signing-boundary audit

Status: blocker confirmed; activation-contract repair in progress

Audited commit: `4d84710c8b204331a1c8f5681d7948f30a31658f`

Audit date: 2026-08-21

This report identifies the exact Checkpoint-4 signing surfaces that existed at
the audited commit. It distinguishes review fingerprints from owner-signable
payloads. It authorizes no corpus change, owner signature, model call, spend,
publication, or push.

## Governing 106-row CP4 payload

The owner-bound payload is exactly the five top-level fields `records`,
`scenario_count`, `scenario_ids_sha256`, `schema_version`, and `status`. The
entire `signature_envelope` is excluded. Object keys are recursively sorted by
Unicode code point, array order and primitive types are preserved, and the
result is compact UTF-8 JSON without a trailing newline. The lowercase SHA-256
of those bytes is the digest named by the envelope.

At the audited commit:

- the pending canonical payload is 57,242 bytes with SHA-256
  `cc55886b9569a919f1771a12b719aa7ca6f855995f572039b5dc6558f8adace1`;
- the canonical whole artifact without its final newline is 57,268 bytes with
  SHA-256
  `04ce73090bd331700109142f0c947b34ff1d51cb7a7cc8d35044703267744a41`;
- the committed file is 57,269 bytes with SHA-256
  `e7ce45529dc62ea8cf7e563235d59620fa2761407c38fbb41ce4d395a1fbada7`;
- the exact 106-ID JSON array is 4,448 bytes with SHA-256
  `549af6d6d7b63e18720d90e7446fde0d4399b7d3766e34e1212017ee667c62fc`.

None of those current hashes is a valid final signing target. The artifact is
`pending_owner_recertification`; its signature envelope must therefore remain
null, and its 106 records are incomplete. Completing the records and changing
the status necessarily changes the owner-bound payload hash.

One final CP4 envelope covers the complete ordered array of all 106 records.
That includes the seven authority reviews, five adaptation reviews, three
provisional reviews, factual repairs, legacy rebuild results, source receipts,
and every per-row dependency claim. There are no per-record signature
envelopes. The owner presentation must not claim a final CP4 hash until the
complete artifact validates and two independent calculations reproduce it.

## Dependency-ledger activation gap

At the audited commit, `SHORTCUT_DEPENDENCY_SPEC.json` is 1,584 bytes with raw
SHA-256
`a6f79ef1df99f2c117e3a7c0850128d3500c7c9ddfdd12c60d1fa1fbec7c7f5e`.
Its ledger is pending and is not signable.

The current review-only dependency drafts are:

- `integrity-audit/v2-audit/cp4-drafts/dependency-claims-draft.json`, raw
  SHA-256
  `d9463c92f64ce7299f078fb5edb6f738391cc37a12a79044d4a6bfe7d470ba3b`;
- `integrity-audit/v2-audit/cp4-drafts/dependency-pair-source-receipt-draft.json`,
  raw SHA-256
  `3d6ee038f0742f800f4bc71af1bfc81f28be73224434e3b0d96513f844cf3bc6`.

Overlaying those draft claims on the pending CP4 shell deterministically yields
three edges and 103 connected components. The compact candidate is 10,178
bytes with SHA-256
`e9dcca178f89b0fb5f50f104442b2077bbb6536381c8596c602eb0b8bd540fbe`.
That digest is a review fingerprint only. The claims are not owner-recertified,
and the candidate may change when the outstanding dependency decisions are
resolved.

The audited production activation path does not bind an owner action to the
activated ledger bytes. It accepts `status: "owner_recertified"`, any non-empty
`owner_signature` and `recertified_at`, and structurally valid ledger arrays.
It does not validate the governing CP4 signature envelope, regenerate the
ledger from the signed CP4 dependency claims, call
`assertDependencyLedgerMatches`, resolve edge-receipt bytes, validate the
timestamp as a real UTC instant, or compare a canonical ledger digest to a
digest named by the owner. `assertDependencyLedgerMatches` has test and audit
callers but no production caller.

Therefore the audited dependency surface has no scientifically defensible
exact payload hash that can be placed in an owner signature request. A
non-empty string is not a payload binding.

The independently confirmed repair ruling is:

1. The dependency activation envelope names both the final canonical CP4
   payload SHA-256 and the final canonical dependency-ledger payload SHA-256.
2. Production activation validates the complete governing CP4 artifact and
   recomputes its owner-bound digest.
3. Production regenerates the dependency ledger from the signed CP4 per-row
   claims and compares it byte-for-byte with the committed ledger.
4. Production recomputes the canonical committed-ledger digest and requires
   equality with the envelope.
5. `recertified_at` and the envelope's `signed_at` must each be a strict, real
   UTC RFC3339 `Z` timestamp and must be exactly equal.
6. Every failure is fail-closed.
7. The envelope is a tamper-evident payload-hash binding, not cryptographic
   authentication. First-hand owner approval recorded in chat and bound in Git
   remains the trust boundary.

The plan already requires an owner-recertified exact edge list and freezes the
seed, permitted dependency kinds, and fold construction. This repair
strengthens previously unspecified activation mechanics and changes none of
those scientific choices.

Before a final dependency payload can be computed, the scientific owner must
accept or reject the three proposed incident-pair IDs, confirm the five unique
upstream example IDs, provide exact generating-template lineage receipts or
affirm none, resolve the ten unlisted mirror rows without inferring
independence from absent metadata, settle all three claim arrays for every row,
and resolve any endpoint pair produced by multiple claims.

## Legacy migration rule

`LEGACY_MIGRATION_RULE_DRAFT.json` has raw SHA-256
`e618e3071e4bf8d98dd7caa48d7fab9133fd66ec621f646ba522102e6d13812c`.
It explicitly declares `draft_pending_owner_recertification`,
`non_governing: true`, `governance_effect: "none"`, and
`signature_envelope: null`. It requires the owner to approve or replace the
frozen field-by-field migration rule before live row changes and separately
requires signing only a completed governing CP4 artifact.

The current hash is therefore a pre-build approval surface, not a final CP4
signature target. Before asking for that approval, the governing migration-rule
artifact and its receipt semantics must be frozen. The eleven completed CP4
records must then bind the approved rule's exact raw-file hash so that the one
final CP4 envelope also binds the resulting migration inputs and decisions.

## Inputs that do not need separate signatures

Authority and factual draft packets, the legacy-row draft bundle, the
dependency pair receipt, and the adaptation wrappers are non-governing review
inputs. Their exact receipts and accepted decisions belong inside the final
CP4 payload. The three provisional rows are also covered by the one final CP4
envelope.

The adaptation wrappers must retain `signature_envelope: null`:

- `sources/cp4/xstest-adaptation-source-receipt.json` has raw SHA-256
  `cc7bf718dbb18199acbedaa897e8fc92cd1a189d362d9b7f6d827752354d36cf`;
- `sources/cp4/or-bench-adaptation-source-receipt.json` has raw SHA-256
  `6ad2305b4788029cff1dd6d733a29beec3988e1d273dfbf4c2b60484e2a8f514`.

Their bytes are transitively bound when their raw hashes appear in the
completed, signed CP4 records. No additional wrapper signature is required or
permitted by the current contract.

## Owner-presentation boundary

The eventual presentation must include this rule:

> The plain-language presentation is non-normative; the named canonical
> payload bytes and hashes govern. Any requested change creates a new draft
> and new hash; nothing is edited under signature.

No owner signature should be requested until the dependency activation repair
is complete, the governing legacy rule is frozen and approved, all 106 CP4
records validate as complete, the final ledger is derived from those exact
records, and every final digest is independently reproduced.
