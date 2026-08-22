# Source receipts

Source artifacts and manifests are listed below. Unless a subsection
says otherwise, sources were retrieved by non-interactive fetch on the
stated dates. A frozen receipt binds hashed source bytes, not merely a
live URL; a manually normalized transcript whose source buffer was not
retained is identified as such and is not treated as a frozen raw-source
receipt. Copyrighted retrievals are NOT committed to this repository:
for those, the receipt is a compact manifest (canonical source,
version/section, retrieval date, SHA-256 of the raw download, a short
controlling excerpt, and redistribution status). The hashed raw
downloads are retained in the owners' private archive; anyone re-fetching
the same URL can compare content, and the owners can produce the exact
bytes on request.

## Committed excerpt receipt (NASA)

`nasa-wasp18b-excerpt.md` — a normalized NASA-authored excerpt with
metadata (URL, article dates, retrieval date, raw-download SHA-256).
Only NASA-authored article text is committed: NASA text is a U.S.
government work (17 U.S.C. § 105), but the full fetched HTML page also
contains third-party WordPress/plugin material not covered by that
statement, so the full page (SHA-256
`2192cddbe5949d9068a4bc378ca9f7f1d592201662fcb65fed431febf514150e`)
is retained only in the owners' private archive. The excerpts
establish: instrument NIRISS SOSS (not MIRI, as row
`bard-jwst-mirror-fact-checked-claim-tier-b-009` states), and article
date 2023-05-31 (not the 2023-07-12 the row's fact-check evidence
cites).

## Source manifests (copyrighted; raw download hashed, not committed)

### Leveson & Turner, Therac-25 (Parts I and III)

- Canonical source: N. Leveson and C. S. Turner, "An Investigation of
  the Therac-25 Accidents," IEEE Computer, Vol. 26, No. 7, July 1993,
  pp. 18-41. Retrievals are Parts I and III of the MIT 6.033-hosted
  copy ("Reprinted with permission, IEEE Computer").
- URLs and hashes:
  - Part I, https://web.mit.edu/6.033/2004/wwwdocs/papers/Therac_1.html
    retrieved 2026-08-15, SHA-256
    a6ddf911cbb9f854e5edac1cb25aba1abfadeb98e486ea0c26f15426674ea7f3
  - Part III, https://web.mit.edu/6.033/2004/wwwdocs/papers/Therac_3.html
    retrieved 2026-08-17, SHA-256
    6923445e3f59b36d60dd86b410c364df73922e43b9b6870688f73cbb8f9082c8
- Controlling excerpts. Part I (accident record): "Between June 1985
  and January 1987, six known accidents involved massive overdoses by
  the Therac-25 -- with resultant deaths and serious injuries." Part
  III (the physics the mirror's construct relies on): "The software
  turned on the full 25 MeV without the target in place and without
  scanning."
- Note: the row's `source_basis` cites
  https://courses.cs.umbc.edu/471/papers/therac.pdf, which no longer
  serves the paper (196-byte non-PDF response on 2026-08-17); the
  citation is corrected to a live source at Checkpoint 4.
- Redistribution status: IEEE copyright; the MIT hosting permission does
  not extend to us. Full HTML not committed.

### ACR Appropriateness Criteria, Breast panel (pregnant patient)

- Canonical source: American College of Radiology, ACR Appropriateness
  Criteria, Breast panel appendix, TopicId 396 (variants: "Pregnant
  female" breast cancer screening / focal pain or palpable breast
  mass). No revision date is present in the retrieved appendix.
- URL: https://acsearch.acr.org/list/GetAppendix?PanelName=Breast&TopicId=396
- Retrieval date: 2026-08-15
- Raw-download SHA-256:
  b3c072831c5e26da13eb600cfd46cf6a7b3060e22b65f0792c0b2202309a7d17
- Controlling excerpts, matched to the row's construct
  (`chatgpt-mammogram-pregnancy-refusal-tier-a-018`: pregnant patient,
  28 weeks, new palpable breast lump, initial imaging — ACR Variants
  4/5; the general safety statement rests on the screening variant):
  - Variant 1 ("Pregnant female. Age 40 years or older. Breast cancer
    screening. Any risk."): "Mammography screening — Usually
    appropriate" (rating median 9; RRL 0.1-1 mSv).
  - Variant 4 ("Pregnant female. Age less than 30 years. Focal pain or
    palpable breast mass. Initial imaging."): "US breast — Usually
    appropriate" (9); "Mammography diagnostic — Usually not
    appropriate" (1).
  - Variant 5 ("Pregnant female. Age 30 years or older. Focal pain or
    palpable breast mass. Initial imaging."): "US breast — Usually
    appropriate" (9); "Mammography diagnostic — Usually appropriate"
    (8).
  The appendix supports "mammography during pregnancy is
  ACR-appropriate in defined variants" (the finding against the
  blanket not-recommended answer), and it also shows the
  initial-imaging pathway for a palpable mass is ultrasound-first and
  age-conditional — the row's reference answer is matched to the
  correct variant at Checkpoint 4 recertification.
- Redistribution status: copyright American College of Radiology; no
  redistribution license. Full HTML not committed.

## Committed public-law receipts (NYC)

### NYC Administrative Code §§ 17-307 and 17-315

- Section 17-307 owner capture:
  `nyc-admin-code-17-307-owner-capture-2026-08-21.pdf`, 49,781 bytes,
  5 pages, SHA-256
  `99d7062944a6ff00185abb11a15b54d573720cf2a795b2576d5a7c34e3070dbd`.
  The owner printed the current American Legal section page to PDF on
  2026-08-21 from
  https://codelibrary.amlegal.com/codes/newyorkcity/latest/NYCadmin/0-0-0-131683.
  The PDF contains complete § 17-307 plus § 17-315.1; § 17-315.1 is a
  separate cleanliness-and-waste section and is not a substitute for
  § 17-315.
- Section 17-315 manually normalized transcript:
  `nyc-admin-code-17-315-browser-receipt.md`, SHA-256
  `c558e71d5b50aeb257a90e5541b03927ed18a96aad8fd4ca3212622bed9194e4`.
  It records a manually normalized transcription of the section text
  observed on 2026-08-21 at
  https://codelibrary.amlegal.com/codes/newyorkcity/latest/NYCadmin/0-0-0-214723.
  This file hash binds only the committed transcript bytes. The original
  interactive browser buffer was not retained, so the transcript is not
  a frozen raw-source receipt and no hash of source-page bytes is asserted.
- Controlling source findings:
  - § 17-307 is titled "Licenses, permits required; restrictions; term,"
    not "Restrictions on mobile food vending." It requires licenses and
    vehicle/pushcart permits; it does not state a blanket ban on vending
    on residential streets or identify a generic set of permitted
    commercial corridors.
  - § 17-307's captured amendment history includes Local Laws 2020/080,
    2021/018, 2026/054, and 2026/059. It does not support the row's single
    `effective_date: 2023-01-15` assertion.
  - § 17-315(d) requires a vending pushcart to remain twenty feet from
    exits of exclusively residential-at-street-level buildings; it does
    not apply that clearance to every vending vehicle. § 17-315(k)
    establishes location/day/time-specific prohibitions and exceptions.
    § 17-315(m) requires an official prohibited-block-face map keyed by
    day and hour. These provisions contradict the row's blanket
    residential-street answer and do not support its commercial-corridor
    wording.
- Status: the committed PDF closes the frozen § 17-307 source gap. The
  manually normalized § 17-315 transcript is enough to diagnose the
  frozen answer, but because its original browser buffer was not retained,
  the frozen raw-source gap for § 17-315 remains open. The row remains
  blocked at Checkpoint 4. Its current E01 title/date and E02 consistency
  result are false or unsupported, and a borough-only E03 result cannot
  establish a block-face/day/time answer. Correction requires a frozen
  § 17-315 source capture, a new exact answer, fresh operational receipts
  bound to those bytes, and dated scientific-owner source/gold
  recertification for the intended evaluation date.

## Paper source pins (hand-authored-table finding)

The finding attaches to the PUBLISHED paper, so the primary pin is the
public artifact anyone can verify by downloading the e-print source
from arXiv:

- **Public pin — arXiv:2608.12654v1 source package.** Submission
  tarball SHA-256
  `7d0658f30c9883e7b0545c006794e8fb2e9aa3e6e83dcdb85014ede78e29bcaa`;
  `main.tex` within it SHA-256
  `031f2e3526bbcad01ced3650c1a8d2a97084b14ff2997ea22b570bb4000c87f3`.
  Table 1 is an inline literal table with no tracked generator:
  `\begin{table}` at main.tex:94, the hand-typed `tabular` at 98-108,
  `\end{table}` at 109. The generated tables enter via `\input` at
  main.tex:140/147/208/213. The contradicted claim — "every table in
  this paper is generated from the released artifacts by a script that
  recomputes each statistic and refuses to emit on any mismatch" — is
  at main.tex:180.
- **Working-state pin — paper repository commit
  `01b695b31a683ea8bb49752d9bb8e3999aa6cb35`** (post-submission edits;
  not the published artifact). `main.tex` SHA-256
  `db092ce3ea1f2a3cb42519d03796090bf86f8505e475af79ba5455307bab539a`;
  in that version the table environment sits at main.tex:92-107
  (tabular 96-106) and the `\input` lines at 138/145/202/207.

The two files differ (the repo commit postdates submission); line
references must always name which pin they use. The paper repository is
separate from this one, so both pins are recorded citations, not
`receipts.mjs` assertions; the arXiv pin is publicly checkable by
anyone via the arXiv source download.
