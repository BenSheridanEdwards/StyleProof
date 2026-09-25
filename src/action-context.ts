export type ActionContextInput = {
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

export async function resolveActionContext({
  eventName,
  payload,
  repo,
  github,
}: ActionContextInput): Promise<ActionContextResult> {
  let prNumber = payload.pull_request?.number;
  let baseSha = payload.pull_request?.base?.sha;
  let headSha = payload.pull_request?.head?.sha;

  if (eventName === 'workflow_run') {
    ({ prNumber, baseSha, headSha } = await resolveWorkflowRunContext(payload, repo, github));
  }

  return prNumber && isFullCommitSha(baseSha) && isFullCommitSha(headSha)
    ? { prNumber: String(prNumber), baseSha, headSha, untrustedCapture: isUntrustedCapture(eventName, payload, repo) }
    : { prNumber: '', baseSha: '', headSha: '', untrustedCapture: false };
}
