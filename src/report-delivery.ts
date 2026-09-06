export type StyleProofTrustState =
  | 'NO_REVIEWABLE_STYLE_CHANGES'
  | 'STYLE_REVIEW_REQUIRED'
  | 'DATA_RESIDUE_UNACKNOWLEDGED'
  | 'INVENTORY_REMOVAL_UNACKNOWLEDGED'
  | 'CERTIFICATION_FAILED'
  | 'PARTIAL_BASELINE'
  | 'DEGRADED_BASELINE'
  | 'REPORT_PUBLICATION_FAILED';

type ReportDecisionCopy = Readonly<{
  decision: 'BLOCKED' | 'REVIEW REQUIRED' | 'CLEAN';
  reason: string;
  nextAction: string;
}>;

export type BuildReportDecisionOptions = Readonly<{
  trustState: StyleProofTrustState;
  baseSha: string;
  headSha: string;
}>;

export type RepositoryVisibility = 'public' | 'private';

export type ReportDelivery = Readonly<{
  mode: 'linked-report';
  cropDelivery: 'relative-paths-in-committed-report';
  access: 'public-github-view' | 'authenticated-github-view';
  url: string;
  markdown: string;
}>;

export type BuildReportDeliveryOptions = {
  repository: string;
  publicationSha: string;
  prNumber: number;
  reportUrl: string;
  repositoryVisibility: RepositoryVisibility;
};

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

const REPORT_DECISIONS: Readonly<Record<StyleProofTrustState, ReportDecisionCopy>> = Object.freeze({
  NO_REVIEWABLE_STYLE_CHANGES: {
    decision: 'CLEAN',
    reason: 'The classified trust state found no reviewable computed-style changes.',
    nextAction: 'None.',
  },
  STYLE_REVIEW_REQUIRED: {
    decision: 'REVIEW REQUIRED',
    reason: 'Changed or new surfaces need human review; reviewer approval can clear this review gate.',
    nextAction: 'Inspect the side-by-side evidence, then approve only if every change is intentional.',
  },
  DATA_RESIDUE_UNACKNOWLEDGED: {
    decision: 'BLOCKED',
    reason: 'Captured data fallbacks are unacknowledged; reviewer approval cannot clear this block.',
    nextAction: 'Fix or fixture the named endpoints, then rerun StyleProof.',
  },
  INVENTORY_REMOVAL_UNACKNOWLEDGED: {
    decision: 'BLOCKED',
    reason: 'A navigable affordance was removed without acknowledgement; reviewer approval cannot clear this block.',
    nextAction: 'Restore the affordance or add a bounded acknowledgement, then rerun StyleProof.',
  },
  CERTIFICATION_FAILED: {
    decision: 'BLOCKED',
    reason: 'Certification evidence is incomplete or contradictory; reviewer approval cannot clear this block.',
    nextAction:
      'Repair the named capture, coverage, determinism, confidence, or report-consistency failure, then rerun StyleProof.',
  },
  PARTIAL_BASELINE: {
    decision: 'BLOCKED',
    reason: 'One or more required baseline surfaces are missing; reviewer approval cannot clear this block.',
    nextAction: 'Repair baseline capture on the base branch, then rerun StyleProof.',
  },
  DEGRADED_BASELINE: {
    decision: 'BLOCKED',
    reason: 'The base capture failed, so this is head-only evidence; reviewer approval cannot clear this block.',
    nextAction: 'Repair the base capture, then rerun StyleProof.',
  },
  REPORT_PUBLICATION_FAILED: {
    decision: 'BLOCKED',
    reason: 'The durable report was not published or verified; reviewer approval cannot clear this block.',
    nextAction: 'Repair report publication or delivery, then rerun StyleProof.',
  },
});

const STYLEPROOF_REPORT_HEADING = '## 🗺️ StyleProof report';

function failDecision(reason: string): never {
  throw new Error(`StyleProof report decision: ${reason}`);
}

export function buildReportDecision(options: BuildReportDecisionOptions): string {
  const copy = REPORT_DECISIONS[options.trustState];
  if (!copy) failDecision('trust state is missing or unknown');
  if (!COMMIT_SHA_PATTERN.test(options.baseSha) || !COMMIT_SHA_PATTERN.test(options.headSha)) {
    failDecision('base/head identity is missing or malformed');
  }
  return [
    `## StyleProof decision: ${copy.decision}`,
    '',
    `**Reason:** ${copy.reason}`,
    '',
    `**Next action:** ${copy.nextAction}`,
    '',
    `**Compared:** \`${options.baseSha}\` → \`${options.headSha}\``,
    '',
    '**Report revision:** unavailable until publication (the publication commit cannot contain its own identity).',
  ].join('\n');
}

export function bindReportDecision(reportMarkdown: string, options: BuildReportDecisionOptions): string {
  if (!reportMarkdown.startsWith(STYLEPROOF_REPORT_HEADING)) failDecision('generated Markdown is missing its heading');
  return `${buildReportDecision(options)}\n\n${reportMarkdown}`;
}

function fail(reason: string): never {
  throw new Error(`StyleProof report delivery: ${reason}`);
}

export function buildReportDelivery(options: BuildReportDeliveryOptions): ReportDelivery {
  const { repository, publicationSha, prNumber, reportUrl, repositoryVisibility } = options;
  if (!REPOSITORY_PATTERN.test(repository)) fail('repository identity is malformed');
  if (!COMMIT_SHA_PATTERN.test(publicationSha)) fail('publication commit identity is malformed');
  if (!Number.isSafeInteger(prNumber) || prNumber < 1) fail('pull-request identity is malformed');
  if (repositoryVisibility !== 'public' && repositoryVisibility !== 'private') {
    fail('repository visibility is unknown');
  }

  const canonicalUrl = `https://github.com/${repository}/blob/${publicationSha}/pr-${prNumber}/report.md`;
  if (reportUrl !== canonicalUrl) fail('publication URL is not the canonical report for this pull request');

  const markdown = `### 📊 [**View the side-by-side visual report →**](${canonicalUrl})`;
  return Object.freeze({
    mode: 'linked-report',
    cropDelivery: 'relative-paths-in-committed-report',
    access: repositoryVisibility === 'private' ? 'authenticated-github-view' : 'public-github-view',
    url: canonicalUrl,
    markdown,
  });
}
