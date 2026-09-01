# Report delivery contract

StyleProof delivers one reviewable evidence package, not two independently rendered reports. The committed report is authoritative. The pull-request comment is a bounded summary and a commit-bound link to that report.

## Committed artifacts

The Action publishes one `pr-<number>/` directory to the configured orphan report branch through the GitHub git-data API. The advertised URL pins the resulting report-branch commit SHA rather than the moving branch name.

A complete publication contains:

- `report.md`, the human review surface;
- `report.json`, the machine-readable report;
- `styleproof-release-confidence.json`, the canonical Release Confidence sidecar;
- crop and annotation images referenced by relative paths from `report.md`.

Publication succeeds only after the publisher reads the advertised commit back and verifies the source head SHA, run ID, run attempt, report digest, and Release Confidence digest. The Markdown, JSON, sidecar, and crop paths remain one committed evidence package.

## Pull-request comment

The Action upserts one comment identified by `<!-- styleproof-report -->`. It contains:

- the bounded report summary;
- the approval checkbox when review-gate mode requires one;
- one `https://github.com/<owner>/<repo>/blob/<publication-sha>/pr-<number>/report.md` link;
- the exact source-head and run-attempt receipt markers.

The comment does not duplicate crops or per-element tables. This prevents a separately rendered comment from drifting away from the committed report.

## Public and private access

Public and private repositories use the same linked-comment shape.

- Public viewers open the GitHub blob URL directly.
- Private viewers need repository access and an authenticated GitHub session.
- Crops use relative paths inside the committed report. StyleProof does not route private images through anonymous `raw.githubusercontent.com` or GitHub Camo fetches.

`buildReportDelivery` constructs the only legal URL from the trusted repository, current pull request number, and verified publication SHA. It rejects every input that is not byte-identical to that canonical URL, as well as malformed identity or unknown repository visibility.

## Required permissions

The generated trusted report workflow requests only the capabilities used by delivery:

- `actions: read` to retrieve the untrusted capture artifact;
- `contents: write` to publish the report-branch commit;
- `pull-requests: write` to create or update the report comment;
- `statuses: write` to set the optional review-gate commit status.

The capture workflow remains read-only and never receives report-publication credentials.

## Action outputs

The composite Action exposes:

- `changed`, whether style review is required;
- `report-url`, the verified commit-bound GitHub blob URL;
- `trust-state`, the terminal machine classification, including `REPORT_PUBLICATION_FAILED`;
- `content-changes`, the advisory content/structure count;
- `data-residue-keys`, the unacknowledged residue identities.

`report-url` is meaningful only after the publish step has emitted and verified its publication receipt.

## Failure semantics

No publication receipt means no new delivery claim for that run.

- A failed publish produces no new comment and terminal state `REPORT_PUBLICATION_FAILED`.
- A failed comment or review-status update after publication also produces `REPORT_PUBLICATION_FAILED`.
- A skipped or cancelled publish caused by an earlier evidence failure preserves the earlier bounded trust verdict when available; otherwise it reports `CERTIFICATION_FAILED`.
- A late earlier run attempt cannot overwrite the comment or status from a newer attempt.
- A prior valid report or approval for the same immutable source commit is not described as newly delivered by the failed run.

The report link is delivery evidence. A green job, an existing `dist/` directory, or a generated URL string without publication readback is not.
