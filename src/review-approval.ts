/** Live approval receipts shared by the Action's gate, comment and status writes. */
export type ReviewApprovalStatus = {
  id?: number;
  context?: string;
  state?: string;
  description?: string | null;
  created_at?: string;
  creator?: { type?: string; login?: string } | null;
};

type ReviewApprovalInput = {
  github: {
    rest: {
      repos: {
        listCommitStatusesForRef(parameters: {
          owner: string;
          repo: string;
          ref: string;
          per_page: number;
        }): Promise<{ data: ReviewApprovalStatus[] }>;
      };
      actions: {
        getWorkflowRun(parameters: { owner: string; repo: string; run_id: string }): Promise<{
          data: {
            status?: string;
            conclusion?: string | null;
            event?: string;
            head_branch?: string | null;
            triggering_actor?: { login?: string } | null;
            run_started_at?: string;
            updated_at?: string;
          };
        }>;
        listWorkflowRunArtifacts(parameters: {
          owner: string;
          repo: string;
          run_id: string;
          per_page: number;
        }): Promise<{ data: { artifacts: { name: string; expired: boolean }[] } }>;
      };
    };
  };
  repository: { owner: string; repo: string };
  headCommit: string;
  pullRequestNumber: number;
  statusContext: string;
  defaultBranch: string;
  reviewDigest: string;
  /** Exclude only the success being checked, so it cannot hide an intervening withdrawal. */
  ignoredStatusIdentifier?: number;
};

export type ReviewApproval = {
  approved: boolean;
  approver: string;
  description: string;
  withdrawn: boolean;
};

const APPROVAL_DESCRIPTION = /^Approved by @([A-Za-z0-9_-]+) \(run ([1-9][0-9]*)\)$/;

function canonicalReviewStatus(status: ReviewApprovalStatus): boolean {
  return status.creator?.type === 'Bot' && status.creator.login === 'github-actions[bot]';
}

function runningReviewStatus(status: ReviewApprovalStatus): boolean {
  return (
    canonicalReviewStatus(status) &&
    status.state === 'pending' &&
    status.description === 'StyleProof report running — no verdict yet'
  );
}

async function validateApprovalReceipt(
  input: ReviewApprovalInput,
  statuses: ReviewApprovalStatus[],
  approval: ReviewApprovalStatus,
  match: RegExpMatchArray,
): Promise<boolean> {
  const { github, repository } = input;
  const { data: workflowRun } = await github.rest.actions.getWorkflowRun({ ...repository, run_id: match[2] });
  const start = Date.parse(workflowRun.run_started_at ?? '');
  const end = Date.parse(workflowRun.updated_at ?? '');

  if (
    !canonicalReviewStatus(approval) ||
    workflowRun.status !== 'completed' ||
    workflowRun.conclusion !== 'success' ||
    workflowRun.event !== 'issue_comment' ||
    !input.defaultBranch ||
    workflowRun.head_branch !== input.defaultBranch ||
    workflowRun.triggering_actor?.login?.toLowerCase() !== match[1].toLowerCase() ||
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    end < start
  ) {
    return false;
  }

  const { data: artifacts } = await github.rest.actions.listWorkflowRunArtifacts({
    ...repository,
    run_id: match[2],
    per_page: 100,
  });

  const bound = artifacts.artifacts.some(
    (artifact) =>
      !artifact.expired &&
      artifact.name === `styleproof-approval-${input.pullRequestNumber}-${input.headCommit}-${input.reviewDigest}`,
  );

  const original = statuses.findIndex((status) => {
    const created = Date.parse(status.created_at ?? '');

    return (
      canonicalReviewStatus(status) &&
      status.context === approval.context &&
      status.state === 'success' &&
      status.description === approval.description &&
      Number.isFinite(created) &&
      created >= start &&
      created <= end + 5000
    );
  });

  // Carry-forward still needs the original receipt on this head, with no intervening revocation.
  return (
    bound &&
    original >= 0 &&
    statuses
      .slice(0, original)
      .every(
        (status) =>
          status.context !== approval.context ||
          (canonicalReviewStatus(status) &&
            ((status.state === 'success' && status.description === approval.description) ||
              runningReviewStatus(status))),
      )
  );
}

/** Read newest-first statuses, accepting a new valid re-tick after a withdrawal. Fail closed on missing receipts. */
export async function readReviewApproval(input: ReviewApprovalInput): Promise<ReviewApproval> {
  const unapproved: ReviewApproval = { approved: false, approver: '', description: '', withdrawn: false };

  if (!/^[0-9a-f]{64}$/.test(input.reviewDigest)) return unapproved;

  try {
    const { data } = await input.github.rest.repos.listCommitStatusesForRef({
      ...input.repository,
      ref: input.headCommit,
      per_page: 100,
    });

    const statuses = data.filter(
      (status) => input.ignoredStatusIdentifier === undefined || status.id !== input.ignoredStatusIdentifier,
    );

    const approval = statuses.find((status) => status.context === input.statusContext && !runningReviewStatus(status));
    const withdrawn = approval?.state === 'failure' && /^Approval withdrawn by @/.test(approval.description ?? '');
    const rejected = { ...unapproved, withdrawn };
    const match = approval?.description?.match(APPROVAL_DESCRIPTION);

    if (
      !approval ||
      approval.state !== 'success' ||
      !match ||
      !Number.isFinite(Date.parse(approval.created_at ?? ''))
    ) {
      return rejected;
    }

    if (!(await validateApprovalReceipt(input, statuses, approval, match))) return rejected;

    return { approved: true, approver: match[1], description: match[0], withdrawn: false };
  } catch {
    return unapproved;
  }
}
