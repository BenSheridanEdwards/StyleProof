export type ActionContextInput = {
  eventName: string;
  payload: {
    pull_request?: { number?: number; head?: { sha?: string } };
    workflow_run?: { head_sha?: string; pull_requests?: { number?: number }[] };
  };
  repo: Record<string, string>;
  github: {
    rest: {
      repos: {
        listPullRequestsAssociatedWithCommit: (args: Record<string, string>) => Promise<{
          data: { state?: string; number?: number; head?: { sha?: string } }[];
        }>;
      };
    };
  };
};

export type ActionContextResult = { prNumber: string; headSha: string };

export async function resolveActionContext({
  eventName,
  payload,
  repo,
  github,
}: ActionContextInput): Promise<ActionContextResult> {
  let prNumber = payload.pull_request?.number;
  let headSha = payload.pull_request?.head?.sha;

  if (eventName === 'workflow_run') {
    const run = payload.workflow_run;
    headSha = run?.head_sha;
    prNumber = run?.pull_requests?.[0]?.number;

    if (headSha && !prNumber) {
      const { data } = await github.rest.repos.listPullRequestsAssociatedWithCommit({
        ...repo,
        commit_sha: headSha,
      });
      prNumber = data.find((pr) => pr.state === 'open' && pr.head?.sha === headSha)?.number;
    }
  }

  return prNumber && headSha ? { prNumber: String(prNumber), headSha } : { prNumber: '', headSha: '' };
}
