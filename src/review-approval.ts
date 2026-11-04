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
): Promise<number> {
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
    return -1;
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

  // Use the oldest receipt in the run window: a later carry-forward must not
  // masquerade as a new approval after an intervening withdrawal.
  const original = statuses.reduce((previous, status, index) => {
    const created = Date.parse(status.created_at ?? '');

    return canonicalReviewStatus(status) &&
      status.context === approval.context &&
      status.state === 'success' &&
      status.description === approval.description &&
      Number.isFinite(created) &&
      created >= start &&
      created <= end + 5000
      ? index
      : previous;
  }, -1);

  return bound ? original : -1;
}

function approvalStatus(status: ReviewApprovalStatus): boolean {
  return (
    canonicalReviewStatus(status) &&
    status.state === 'success' &&
    APPROVAL_DESCRIPTION.test(status.description ?? '') &&
    Number.isFinite(Date.parse(status.created_at ?? ''))
  );
}

async function newestApproval(
  input: ReviewApprovalInput,
  statuses: ReviewApprovalStatus[],
  boundary: number,
): Promise<ReviewApproval | undefined> {
  const receipts = new Map<string, number>();
  let original = boundary;

  // Stop at the newest proven original: older history cannot revoke it. Each
  // copied approval above it still needs its own workflow and digest proof.
  for (let index = 0; index < original; index += 1) {
    const status = statuses[index];

    if (runningReviewStatus(status)) continue;
    const description = status.description!;
    let receipt = receipts.get(description);

    if (receipt === undefined) {
      receipt = await validateApprovalReceipt(input, statuses, status, description.match(APPROVAL_DESCRIPTION)!);
      receipts.set(description, receipt);
    }

    if (receipt < 0) return undefined;
    original = Math.min(original, receipt);
  }

  if (original === boundary) return undefined;
  const match = statuses[original].description!.match(APPROVAL_DESCRIPTION)!;

  return { approved: true, approver: match[1], description: match[0], withdrawn: false };
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
      (status) =>
        status.context === input.statusContext &&
        (input.ignoredStatusIdentifier === undefined || status.id !== input.ignoredStatusIdentifier),
    );

    const boundary = statuses.findIndex((status) => !runningReviewStatus(status) && !approvalStatus(status));
    const interruption = statuses[boundary];

    const withdrawn =
      interruption?.state === 'failure' && /^Approval withdrawn by @/.test(interruption.description ?? '');

    return (
      (await newestApproval(input, statuses, boundary < 0 ? statuses.length : boundary)) ?? { ...unapproved, withdrawn }
    );
  } catch {
    return unapproved;
  }
}
