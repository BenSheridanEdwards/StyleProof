# Report delivery contract

StyleProof delivers one reviewable evidence package, not two independently rendered reports. The committed report is authoritative. The pull-request comment is a bounded summary and a commit-bound link to that report.

## Committed artifacts

The Action publishes one `pr-<number>/` directory to the configured orphan report branch through the GitHub git-data API. The advertised URL pins the resulting report-branch commit SHA rather than the moving branch name.

A complete publication contains:

- `report.md`, the human review surface;
- `report.json`, the machine-readable report;
- crop and annotation images referenced by relative paths from `report.md`.

Publication succeeds only after the publisher reads the advertised commit back and verifies the run receipt embedded in `report.md`, which names the source head SHA, run ID and run attempt, and confirms `report.json` parses with no duplicate keys. The Markdown, JSON, and crop paths remain one committed evidence package.

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

## Approval binding

The separate default-branch approval workflow treats the report comment as untrusted input. A tick can turn the `StyleProof` status green only after GitHub read APIs prove all of the following still agree:

- the edited comment is the one current marker comment authored by `github-actions[bot]`;
- its source-head, run ID, run attempt, pull-request number, repository, and publication commit identities are singular and canonical;
- the newest `StyleProof` status in GitHub's newest 100 commit-status records for the current pull-request head was created by `github-actions[bot]`, is the exact pending `STYLE_REVIEW_REQUIRED` status, and targets that publication; if that bounded read cannot find it, approval fails closed;
- `report.md` and `report.json` are readable at the immutable publication commit, the JSON parses, and the publisher's receipt in Markdown exactly matches the comment's source head, run ID, and run attempt, the immutable JSON records the canonical `STYLE_REVIEW_REQUIRED` machine verdict;
- a final comment, status, and pull-request read immediately before mutation shows that no rerun, superseding publication, or push changed those facts.

Missing, malformed, stale, mismatched, superseded, or non-approvable evidence produces no success status. Human-readable status descriptions never establish approvability by themselves: even after an untick or refused self-approval, the immutable published `report.json` must still record `actionTrustState: STYLE_REVIEW_REQUIRED`. Unticking remains fail-safe: it can set the current source commit red without publication readback.

Private-repository rollout is **BLOCKED** until `styleproof-approve.yml` is explicitly granted `contents: read`; this patch does not change permissions. The report workflow's `contents: write` grant does not carry into the separate `issue_comment` workflow. Without that future grant, immutable publication readback fails loudly rather than trusting comment markers alone. The approval workflow retains `pull-requests: read`, `statuses: write`, and `issues: write` for its existing identity, gate, and refusal paths.

The report link is delivery evidence. A green job, an existing `dist/` directory, or a generated URL string without publication readback is not.
