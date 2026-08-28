export type ActionContextInput = {
  eventName: string;
  payload: {
    pull_request?: { number?: number; base?: { sha?: string }; head?: { sha?: string } };
    workflow_run?: {
      head_sha?: string;
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

export type ActionContextResult = { prNumber: string; baseSha: string; headSha: string };

function isFullCommitSha(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value);
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
    const run = payload.workflow_run;
    const associated = run?.pull_requests?.[0];
    headSha = run?.head_sha;
    prNumber = associated?.number;
    baseSha = associated?.base?.sha;

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
  }

  return prNumber && isFullCommitSha(baseSha) && isFullCommitSha(headSha)
    ? { prNumber: String(prNumber), baseSha, headSha }
    : { prNumber: '', baseSha: '', headSha: '' };
}
