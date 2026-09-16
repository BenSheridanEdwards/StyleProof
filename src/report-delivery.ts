export type RepositoryVisibility = 'public' | 'private';

export type ReportDelivery = Readonly<{
  mode: 'linked-report' | 'workflow-artifact';
  cropDelivery: 'relative-paths-in-committed-report' | 'inside-workflow-artifact';
  access: 'public-github-view' | 'authenticated-github-view' | 'authenticated-artifact-download';
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

export type BuildArtifactReportDeliveryOptions = {
  repository: string;
  /** The report artifact's entry, or the run page that lists it. */
  reportUrl: string;
};

/**
 * Artifact-mode report delivery (#587): the rendered report is a workflow
 * artifact on the run that produced it — nothing is written to the adopter's
 * git history and retention is bounded by the artifact's lifetime. The comment
 * links the artifact entry (or the run page that lists it); the URL must stay
 * inside this repository's own run so a tampered or cross-repo link fails
 * closed instead of pointing reviewers at foreign evidence.
 */
export function buildArtifactReportDelivery(options: BuildArtifactReportDeliveryOptions): ReportDelivery {
  const { repository, reportUrl } = options;
  if (!REPOSITORY_PATTERN.test(repository)) fail('repository identity is malformed');
  const runPrefix = `https://github.com/${repository}/actions/runs/`;
  const suffix = reportUrl.startsWith(runPrefix) ? reportUrl.slice(runPrefix.length) : '';
  if (!/^[0-9]+(\/artifacts\/[0-9]+)?$/.test(suffix)) {
    fail('artifact report URL does not resolve inside this repository’s own workflow run');
  }

  const markdown = `### 📊 [**Download the visual report artifact →**](${reportUrl})`;
  return Object.freeze({
    mode: 'workflow-artifact',
    cropDelivery: 'inside-workflow-artifact',
    access: 'authenticated-artifact-download',
    url: reportUrl,
    markdown,
  });
}
