export type ComparisonBase = 'pull-request-base' | 'merge-base';

export type ActionContextInput = {
  comparisonBase?: ComparisonBase;
  eventName: string;
  payload: {
    pull_request?: {
      number?: number;
      base?: { sha?: string };
      head?: { sha?: string; repo?: { full_name?: string } | null };
    };
    workflow_run?: {
      head_sha?: string;
      head_repository?: { full_name?: string } | null;
      pull_requests?: { number?: number; base?: { sha?: string }; head?: { sha?: string } }[];
    };
  };
  repo: Record<string, string>;
  github: {
    request?: (
      route: 'GET /repos/{owner}/{repo}/compare/{basehead}',
      args: { owner: string; repo: string; basehead: string; page: number; per_page: number },
    ) => Promise<{ data?: { base_commit?: { sha?: unknown }; merge_base_commit?: { sha?: unknown } } }>;
    rest: {
      repos: {
        listPullRequestsAssociatedWithCommit: (args: Record<string, string>) => Promise<{
          data: { state?: string; number?: number; base?: { sha?: string }; head?: { sha?: string } }[];
        }>;
      };
    };
  };
};

export type ActionContextResult = {
  prNumber: string;
  baseSha: string;
  /** Present only for opt-in resolution; the default result shape stays unchanged. */
  baseTipSha?: string;
  comparisonBase?: ComparisonBase;
  headSha: string;
  /**
   * True when the captured PR head lives in another repository (a fork): the capture
   * job ran that fork's code, so its maps — base AND head — are untrusted input.
   */
  untrustedCapture: boolean;
};

function isFullCommitSha(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value);
}

const sameRepository = (fullName: string | undefined, repo: ActionContextInput['repo']): boolean =>
  typeof fullName === 'string' && fullName.toLowerCase() === `${repo.owner}/${repo.repo}`.toLowerCase();

/** Fork detection from the trusted event payload. A workflow_run without a head
 *  repository fails closed (untrusted); a pull_request payload only flags a named fork. */
function isUntrustedCapture(
  eventName: string,
  payload: ActionContextInput['payload'],
  repo: ActionContextInput['repo'],
): boolean {
  if (eventName === 'workflow_run') return !sameRepository(payload.workflow_run?.head_repository?.full_name, repo);
  const headRepository = payload.pull_request?.head?.repo?.full_name;
  return headRepository !== undefined && !sameRepository(headRepository, repo);
}

async function resolveWorkflowRunContext(
  payload: ActionContextInput['payload'],
  repo: ActionContextInput['repo'],
  github: ActionContextInput['github'],
): Promise<{ prNumber?: number; baseSha?: string; headSha?: string }> {
  const run = payload.workflow_run;
  const headSha = run?.head_sha;
  const associated = run?.pull_requests?.[0];
  const corresponding = associated?.head?.sha === headSha ? associated : undefined;
  let prNumber = corresponding?.number;
  let baseSha = corresponding?.base?.sha;

  if (headSha && (!prNumber || !baseSha)) {
    const { data } = await github.rest.repos.listPullRequestsAssociatedWithCommit({
      ...repo,
      commit_sha: headSha,
    });
    const matchingPullRequest = data.find(
      (pr) => pr.state === 'open' && pr.head?.sha === headSha && (prNumber === undefined || pr.number === prNumber),
    );
    prNumber ??= matchingPullRequest?.number;
    baseSha ??= matchingPullRequest?.base?.sha;
  }

  return { prNumber, baseSha, headSha };
}

const isLowercaseCommitSha = (value: unknown): value is string =>
  typeof value === 'string' && value.length === 40 && /^[0-9a-f]{40}$/.test(value);

const isRepositoryPart = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value !== '.' && value !== '..' && !/[^A-Za-z0-9_.-]/.test(value);

async function resolveMergeBase(
  baseTipSha: string | undefined,
  headSha: string | undefined,
  repo: ActionContextInput['repo'],
  github: ActionContextInput['github'],
): Promise<string> {
  if (!isLowercaseCommitSha(baseTipSha) || !isLowercaseCommitSha(headSha)) {
    throw new Error('merge-base requires full lowercase trusted base/head SHAs');
  }
  if (!isRepositoryPart(repo.owner) || !isRepositoryPart(repo.repo)) {
    throw new Error('merge-base requires a trusted repository owner and name');
  }
  if (!github.request) throw new Error('merge-base requires the GitHub comparison client');
  const response = await github.request('GET /repos/{owner}/{repo}/compare/{basehead}', {
    owner: repo.owner,
    repo: repo.repo,
    basehead: `${baseTipSha}...${headSha}`,
    page: 1,
    per_page: 1,
  });
  const data = response?.data;
  if (data?.base_commit?.sha !== baseTipSha || !isLowercaseCommitSha(data?.merge_base_commit?.sha)) {
    throw new Error('GitHub comparison must return the trusted base tip and a full lowercase merge-base SHA');
  }
  return data.merge_base_commit.sha;
}

export async function resolveActionContext({
  comparisonBase = 'pull-request-base',
  eventName,
  payload,
  repo,
  github,
}: ActionContextInput): Promise<ActionContextResult> {
  if (comparisonBase !== 'pull-request-base' && comparisonBase !== 'merge-base') {
    throw new Error('comparison-base must be pull-request-base or merge-base');
  }
  let prNumber = payload.pull_request?.number;
  let baseSha = payload.pull_request?.base?.sha;
  let headSha = payload.pull_request?.head?.sha;

  if (eventName === 'workflow_run') {
    ({ prNumber, baseSha, headSha } = await resolveWorkflowRunContext(payload, repo, github));
  }

  if (comparisonBase === 'merge-base') {
    if (!Number.isSafeInteger(prNumber) || !prNumber || prNumber < 1) {
      throw new Error('merge-base requires a trusted PR association');
    }
    const selectedBase = await resolveMergeBase(baseSha, headSha, repo, github);
    return {
      prNumber: String(prNumber),
      baseSha: selectedBase,
      baseTipSha: baseSha,
      comparisonBase,
      headSha: headSha!,
      untrustedCapture: isUntrustedCapture(eventName, payload, repo),
    };
  }

  return prNumber && isFullCommitSha(baseSha) && isFullCommitSha(headSha)
    ? { prNumber: String(prNumber), baseSha, headSha, untrustedCapture: isUntrustedCapture(eventName, payload, repo) }
    : { prNumber: '', baseSha: '', headSha: '', untrustedCapture: false };
}
