import { createHash } from 'node:crypto';

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
  identityKind?: 'commit' | 'capture-map';
  reportArtifactRevision: string;
}>;

export type BindReportDecisionOptions = Readonly<
  Omit<BuildReportDecisionOptions, 'reportArtifactRevision'> & {
    /** Strict ceiling for the final decision-bound report, measured as UTF-8 bytes. */
    maxReportBytes?: number;
  }
>;

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
const REPORT_ARTIFACT_REVISION_PATTERN = /^[0-9a-f]{64}$/;
const REPORT_ARTIFACT_REVISION_PLACEHOLDER = '0'.repeat(64);
const REPORT_ARTIFACT_REVISION_LABEL = '**Linked report artifact revision (SHA-256):**';

const REPORT_DECISIONS: Readonly<Record<StyleProofTrustState, ReportDecisionCopy>> = Object.freeze({
  NO_REVIEWABLE_STYLE_CHANGES: {
    decision: 'CLEAN',
    reason: 'The classified trust state found no reviewable computed-style changes.',
    nextAction: 'None.',
  },
  STYLE_REVIEW_REQUIRED: {
    decision: 'REVIEW REQUIRED',
    reason: 'Changed or new surfaces need human review; reviewer approval can clear this review gate.',
    nextAction:
      'Inspect the side-by-side evidence, then approve only if every change is intentional; write access required, and not the pull request author.',
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

export const DEFAULT_MAX_REPORT_BYTES = 400_000;

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
  if (!REPORT_ARTIFACT_REVISION_PATTERN.test(options.reportArtifactRevision)) {
    failDecision('report artifact revision is missing or malformed');
  }
  const identityLabel = options.identityKind ?? 'commit';
  if (identityLabel !== 'commit' && identityLabel !== 'capture-map') {
    failDecision('identity kind is unknown');
  }
  const compared = identityLabel === 'commit' ? 'Compared commits' : 'Compared capture maps';
  return [
    `## StyleProof decision: ${copy.decision}`,
    '',
    `**Reason:** ${copy.reason}`,
    '',
    `**Next action:** ${copy.nextAction}`,
    '',
    `**${compared}:** base \`${options.baseSha}\` → head \`${options.headSha}\``,
    '',
    `${REPORT_ARTIFACT_REVISION_LABEL} \`${options.reportArtifactRevision}\``,
    '',
    "_Canonical bytes are the linked report's exact UTF-8 bytes with only that 64-hex value replaced by 64 ASCII zeroes._",
  ].join('\n');
}

function bindWithRevisionPlaceholder(reportMarkdown: string, options: BindReportDecisionOptions): string {
  return `${buildReportDecision({
    ...options,
    reportArtifactRevision: REPORT_ARTIFACT_REVISION_PLACEHOLDER,
  })}

${reportMarkdown}`;
}

function reportByteLength(markdown: string): number {
  return Buffer.byteLength(markdown, 'utf8');
}

const MAX_REPORT_DECISION_BYTES = Math.max(
  ...(Object.keys(REPORT_DECISIONS) as StyleProofTrustState[]).flatMap((trustState) =>
    (['commit', 'capture-map'] as const).map((identityKind) =>
      reportByteLength(
        buildReportDecision({
          trustState,
          baseSha: '0'.repeat(40),
          headSha: '0'.repeat(40),
          identityKind,
          reportArtifactRevision: REPORT_ARTIFACT_REVISION_PLACEHOLDER,
        }),
      ),
    ),
  ),
);
const REPORT_BINDING_SEPARATOR_BYTES = reportByteLength('\n\n');
const MIN_REPORT_PAYLOAD_BYTES = reportByteLength(STYLEPROOF_REPORT_HEADING);

function validateReportByteBudget(maxReportBytes: number): void {
  if (maxReportBytes === Infinity) return;
  if (!Number.isSafeInteger(maxReportBytes) || maxReportBytes < 0) {
    failDecision('maxReportBytes must be a non-negative safe integer or Infinity');
  }
}

/** Returns the maximum generator payload budget that leaves room for every valid
 * decision/identity header. The bound is derived from all trust states and both
 * exact 40-hex identity labels, so Action callers do not need to predict state. */
export function reportPayloadByteBudget(maxFinalReportBytes = DEFAULT_MAX_REPORT_BYTES): number {
  validateReportByteBudget(maxFinalReportBytes);
  if (maxFinalReportBytes === Infinity) return Infinity;
  const payloadBytes = maxFinalReportBytes - MAX_REPORT_DECISION_BYTES - REPORT_BINDING_SEPARATOR_BYTES;
  if (payloadBytes < MIN_REPORT_PAYLOAD_BYTES) {
    failDecision(
      `${maxFinalReportBytes}-byte maxReportBytes cannot fit the largest canonical decision and report heading ` +
        `(minimum ${MAX_REPORT_DECISION_BYTES + REPORT_BINDING_SEPARATOR_BYTES + MIN_REPORT_PAYLOAD_BYTES} UTF-8 bytes)`,
    );
  }
  return payloadBytes;
}

function artifactRevisionForCanonicalReport(canonicalReport: string): string {
  return createHash('sha256').update(Buffer.from(canonicalReport, 'utf8')).digest('hex');
}

/** Independently verifies the immutable report identity without publication state.
 * Canonicalization replaces only the single rendered revision value with 64 ASCII
 * zeroes; every other UTF-8 byte, including the decision and evidence, is bound. */
export function verifyReportArtifactRevision(reportMarkdown: string): boolean {
  const revisionPattern = /\*\*Linked report artifact revision \(SHA-256\):\*\* `([0-9a-f]{64})`/g;
  const matches = [...reportMarkdown.matchAll(revisionPattern)];
  if (matches.length !== 1) return false;
  const renderedRevision = matches[0]?.[1];
  if (!renderedRevision) return false;
  const canonicalReport = reportMarkdown.replace(renderedRevision, REPORT_ARTIFACT_REVISION_PLACEHOLDER);
  return artifactRevisionForCanonicalReport(canonicalReport) === renderedRevision;
}

export function bindReportDecision(reportMarkdown: string, options: BindReportDecisionOptions): string {
  if (!reportMarkdown.startsWith(STYLEPROOF_REPORT_HEADING)) failDecision('generated Markdown is missing its heading');
  if (reportMarkdown.includes(REPORT_ARTIFACT_REVISION_LABEL)) {
    failDecision('generated Markdown already contains a report artifact revision');
  }
  const maxReportBytes = options.maxReportBytes ?? DEFAULT_MAX_REPORT_BYTES;
  validateReportByteBudget(maxReportBytes);
  const canonicalReport = bindWithRevisionPlaceholder(reportMarkdown, options);
  const finalBytes = reportByteLength(canonicalReport);
  if (finalBytes > maxReportBytes) {
    failDecision(
      `${finalBytes}-byte final report exceeds the ${maxReportBytes}-byte ceiling; ` +
        'generate the payload with reportPayloadByteBudget(maxReportBytes) so visible diagnostics are compacted safely',
    );
  }
  const reportArtifactRevision = artifactRevisionForCanonicalReport(canonicalReport);
  return canonicalReport.replace(
    `${REPORT_ARTIFACT_REVISION_LABEL} \`${REPORT_ARTIFACT_REVISION_PLACEHOLDER}\``,
    `${REPORT_ARTIFACT_REVISION_LABEL} \`${reportArtifactRevision}\``,
  );
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
