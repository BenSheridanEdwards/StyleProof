# Report delivery contract

StyleProof delivers one reviewable evidence package, not two independently rendered reports. The published report is authoritative. The pull-request comment is a bounded summary and a receipt-bound link to that report.

## Report storage

`report-storage` selects where the rendered report lives:

- `artifact` (default) — the Action uploads the report directory as a workflow artifact on the run that produced it. Nothing is written to the adopter's git history; retention is bounded by `report-retention-days` (a required positive integer — `0` is rejected because it selects the repository default; GitHub bounds it to 90 days unless repository settings allow more) and the artifact cannot be replaced once uploaded. The advertised URL is the artifact entry `https://github.com/<owner>/<repo>/actions/runs/<run-id>/artifacts/<artifact-id>`, or the run page that lists it.
- `branch` — the Action publishes one `pr-<number>/` directory to the configured orphan report branch through the GitHub git-data API. The advertised URL pins the resulting report-branch commit SHA rather than the moving branch name: `https://github.com/<owner>/<repo>/blob/<publication-sha>/pr-<number>/report.md`. Branch storage keeps the report rendered in-browser, including crop images, at the cost of evidence living in repository history until the generated prune jobs remove it.

A complete publication contains:

- `report.md`, the human review surface;
- `report.json`, the machine-readable report;
- crop and annotation images referenced by relative paths from `report.md`.

Branch publication succeeds only after the publisher reads the advertised commit back and verifies the run receipt embedded in `report.md`, which names the source head SHA, run ID and run attempt, and confirms `report.json` parses with no duplicate keys. Artifact publication succeeds only after the upload step completes; `if-no-files-found: error` makes an empty report directory a publication failure rather than a silent no-op. The Markdown, JSON, and crop paths remain one published evidence package in either mode.

Artifact names are immutable per workflow run, so the upload sets `overwrite: true`: re-running the job in the same run replaces the earlier report artifact instead of failing on the name, and the comment and status always link the newest artifact.

## Pull-request comment

The Action upserts one comment identified by `<!-- styleproof-report -->`. It contains:

- the bounded report summary;
- the approval checkbox when review-gate mode requires one;
- one canonical link — the commit-bound blob URL in branch mode, the run/artifact URL in artifact mode;
- the exact source-head and run-attempt receipt markers.

The comment does not duplicate crops or per-element tables. This prevents a separately rendered comment from drifting away from the published report.

## Public and private access

Public and private repositories use the same linked-comment shape.

- Branch mode: public viewers open the GitHub blob URL directly; private viewers need repository access and an authenticated GitHub session. Crops use relative paths inside the committed report.
- Artifact mode: viewers follow the artifact entry or run page and download the report — GitHub always authenticates artifact downloads, so the link works identically for public and private repositories, and crops travel inside the artifact.

StyleProof does not route private images through anonymous `raw.githubusercontent.com` or GitHub Camo fetches.

`buildReportDelivery` constructs the only legal branch-mode URL from the trusted repository, current pull request number, and verified publication SHA. `buildArtifactReportDelivery` accepts only a URL inside the repository's own workflow run. Each rejects every input outside its canonical shape, as well as malformed identity or unknown repository visibility.

## Required permissions

The generated trusted report workflow requests only the capabilities used by delivery:

- `actions: read` to retrieve the untrusted capture artifact;
- `contents: write` only in branch mode, to publish the report-branch commit — artifact mode runs `contents: read`;
- `pull-requests: write` to create or update the report comment;
- `statuses: write` to set the optional review-gate commit status.

The capture workflow remains read-only and never receives report-publication credentials.

The generated approval caller grants the reusable approval workflow:

- `statuses: write` to flip the gate;
- `pull-requests: read` to resolve the PR head and author;
- `issues: write` for refusal replies;
- `contents: read` to verify branch-published reports at the publication commit;
- `actions: read` to verify artifact-published reports inside the run's report artifact.

## Action outputs

The composite Action exposes:

- `changed`, whether style review is required;
- `report-url`, the verified publication receipt — the commit-bound blob URL in branch mode, the artifact entry or run page in artifact mode;
- `trust-state`, the terminal machine classification, including `REPORT_PUBLICATION_FAILED`;
- `content-changes`, the advisory content/structure count;
- `data-residue-keys`, the unacknowledged residue identities.

`report-url` is meaningful only after the selected publication step has emitted and verified its publication receipt.

## Failure semantics

No publication receipt means no new delivery claim for that run.

- A failed publish or artifact upload produces no new comment and terminal state `REPORT_PUBLICATION_FAILED`.
- A failed comment or review-status update after publication also produces `REPORT_PUBLICATION_FAILED`.
- A skipped or cancelled publish caused by an earlier evidence failure preserves the earlier bounded trust verdict when available; otherwise it reports `CERTIFICATION_FAILED`.
- A late earlier run attempt cannot overwrite the comment or status from a newer attempt.
- A prior valid report or approval for the same immutable source commit is not described as newly delivered by the failed run.

## Approval binding

The separate default-branch approval workflow treats the report comment as untrusted input. A tick can turn the `StyleProof` status green only after GitHub read APIs prove all of the following still agree:

- the edited comment is the one current marker comment authored by `github-actions[bot]`;
- its source-head, run ID, run attempt, pull-request number, repository, and publication identities are singular and canonical — the publication is either the commit-bound blob URL or the run/artifact URL, and an artifact link's run must equal the run named by the comment's receipt markers;
- the newest `StyleProof` status in GitHub's newest 100 commit-status records for the current pull-request head was created by `github-actions[bot]`, is the exact pending `STYLE_REVIEW_REQUIRED` status, and targets that publication; if that bounded read cannot find it, approval fails closed;
- `report.md` and `report.json` are readable from the immutable publication — the publication commit in branch mode, or the run's `styleproof-report-pr-<number>` artifact zip in artifact mode (the artifact name follows `comment-marker`, so only the canonical marker produces this name) — the JSON parses, and the publisher's receipt in Markdown exactly matches the comment's source head, run ID, and run attempt, and the immutable JSON records the canonical `STYLE_REVIEW_REQUIRED` machine verdict;
- a final comment, status, and pull-request read immediately before mutation shows that no rerun, superseding publication, or push changed those facts.

Missing, malformed, stale, mismatched, superseded, or non-approvable evidence produces no success status. Human-readable status descriptions never establish approvability by themselves: even after an untick or refused self-approval, the immutable published `report.json` must still record `actionTrustState: STYLE_REVIEW_REQUIRED`. Unticking remains fail-safe: it can set the current source commit red without publication readback.

Artifact retention bounds the approval window in artifact mode: an expired report artifact cannot be read back, so a tick after expiry fails closed instead of approving unverifiable evidence.

The report link is delivery evidence. A green job, an existing `dist/` directory, or a generated URL string without publication readback is not.
