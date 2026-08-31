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
