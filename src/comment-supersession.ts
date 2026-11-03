/**
 * Rerun-attempt supersession guard for the upserted PR comment: deliveries can
 * land out of order, so the comment records which attempt wrote it and the
 * upsert refuses to overwrite a later attempt of the same run or a later run
 * for the same head commit. Split-layout certify statuses additionally order their
 * capture run against GitHub's runs for the same workflow and head commit.
 */

export type RunAttemptReceipt = {
  runId: string;
  runAttempt: string;
};

const RUN_ATTEMPT_RECEIPT_PATTERN = /<!-- styleproof-run-id:(\d+) run-attempt:(\d+) -->/;

/** Hidden marker the comment body carries. */
export function formatRunAttemptReceiptMarker(receipt: RunAttemptReceipt): string {
  return `<!-- styleproof-run-id:${receipt.runId} run-attempt:${receipt.runAttempt} -->`;
}

/** The receipt in an existing comment body, or null when it predates the receipt. */
export function parseRunAttemptReceiptMarker(commentBody: string): RunAttemptReceipt | null {
  const match = commentBody.match(RUN_ATTEMPT_RECEIPT_PATTERN);
  if (!match) return null;
  return { runId: match[1], runAttempt: match[2] };
}

/** Keep later attempts of this run, and later runs when the same head is proven. */
export function shouldSupersedeExistingComment(options: {
  existingCommentBody: string | null | undefined;
  runId: string;
  runAttempt: string;
  headSha?: string;
}): boolean {
  const existing = options.existingCommentBody ? parseRunAttemptReceiptMarker(options.existingCommentBody) : null;
  if (existing === null) return true;
  if (existing.runId !== options.runId) {
    const sameHead =
      options.headSha && options.existingCommentBody?.includes(`<!-- styleproof-sha:${options.headSha} -->`);
    return !sameHead || !/^\d+$/.test(options.runId) || BigInt(existing.runId) <= BigInt(options.runId);
  }
  const existingAttempt = Number(existing.runAttempt);
  const deliveryAttempt = Number(options.runAttempt);
  if (!Number.isFinite(existingAttempt) || !Number.isFinite(deliveryAttempt)) return true;
  return existingAttempt <= deliveryAttempt;
}

/** Accept cross-run receipts only from GitHub Actions; same-run receipts also trust verified writers. */
export async function findLaterAttemptReceipt(options: {
  github: {
    rest: {
      repos: {
        getCollaboratorPermissionLevel(parameters: {
          owner: string;
          repo: string;
          username: string;
        }): Promise<{ data: { permission: string } }>;
      };
    };
  };
  repo: { owner: string; repo: string };
  comments: readonly { body?: string | null; user?: { type?: string; login?: string } | null }[];
  runId: string;
  runAttempt: string;
  headSha?: string;
}): Promise<boolean> {
  const permissions = new Map<string, boolean>();

  const laterComments = options.comments
    .filter((comment) => !shouldSupersedeExistingComment({ ...options, existingCommentBody: comment.body }))
    .filter(
      (comment) =>
        parseRunAttemptReceiptMarker(comment.body ?? '')?.runId === options.runId ||
        comment.user?.login === 'github-actions[bot]',
    );

  for (const comment of laterComments) {
    if (comment.user?.type === 'Bot') return true;
    const login = comment.user?.login;

    if (!login) continue;
    const key = login.toLowerCase();

    if (!permissions.has(key)) {
      try {
        const { data } = await options.github.rest.repos.getCollaboratorPermissionLevel({
          ...options.repo,
          username: login,
        });

        permissions.set(key, ['write', 'maintain', 'admin'].includes(data.permission));
      } catch {
        permissions.set(key, false);
      }
    }

    if (permissions.get(key)) return true;
  }

  return false;
}

export type CaptureRunIdentity = {
  id: number;
  run_attempt: number;
  created_at: string;
  event?: string;
  status?: string;
  conclusion?: string | null;
};

function captureRunCreatedAt(capture: CaptureRunIdentity): number {
  const created = typeof capture.created_at === 'string' ? Date.parse(capture.created_at) : NaN;
  if (
    !Number.isInteger(capture.id) ||
    capture.id <= 0 ||
    !Number.isInteger(capture.run_attempt) ||
    capture.run_attempt <= 0 ||
    !Number.isFinite(created)
  ) {
    throw new Error('StyleProof: the capture run identity cannot prove delivery order');
  }
  return created;
}

/** True when newer pull_request captures completed successfully; throws when ordering or their delivery is unproven. */
export function isSupersededCaptureRun(capture: CaptureRunIdentity, runs: readonly CaptureRunIdentity[]): boolean {
  const created = captureRunCreatedAt(capture);
  const newerRuns = runs.filter((run) => {
    if (run.event !== 'pull_request') return false;
    const candidateCreated = captureRunCreatedAt(run);
    if (run.id === capture.id) return run.run_attempt > capture.run_attempt;
    return candidateCreated > created || (candidateCreated === created && run.id > capture.id);
  });
  // Only successful captures trigger the report workflow. A failed, cancelled,
  // unfinished or unknown newer run cannot be trusted to replace an old green.
  if (newerRuns.some((run) => run.status !== 'completed' || run.conclusion !== 'success')) {
    throw new Error('StyleProof: a newer capture run has not completed successfully; status must fail closed');
  }
  return newerRuns.length > 0;
}

type CaptureWorkflowRun = CaptureRunIdentity & { workflow_id: number; head_sha: string };

function captureWorkflowRun(workflowRun: unknown): CaptureWorkflowRun {
  const capture = workflowRun as Partial<CaptureWorkflowRun> | null;
  if (
    !capture ||
    !Number.isInteger(capture.workflow_id) ||
    Number(capture.workflow_id) <= 0 ||
    typeof capture.head_sha !== 'string' ||
    capture.head_sha.trim() === ''
  ) {
    throw new Error('StyleProof: the workflow_run payload cannot order this capture run');
  }
  return capture as CaptureWorkflowRun;
}

/** Read this capture workflow's runs for the head commit and order this delivery against them. */
export async function captureRunSuperseded(options: {
  github: {
    rest: {
      actions: {
        listWorkflowRuns(parameters: {
          owner: string;
          repo: string;
          workflow_id: number;
          head_sha: string;
          per_page: number;
        }): Promise<{ data: { total_count: number; workflow_runs: CaptureRunIdentity[] } }>;
      };
    };
  };
  repo: { owner: string; repo: string };
  workflowRun: unknown;
}): Promise<boolean> {
  const capture = captureWorkflowRun(options.workflowRun);
  const { data } = await options.github.rest.actions.listWorkflowRuns({
    ...options.repo,
    workflow_id: capture.workflow_id,
    head_sha: capture.head_sha,
    per_page: 100,
  });
  if (
    !Number.isInteger(data.total_count) ||
    data.total_count < 0 ||
    !Array.isArray(data.workflow_runs) ||
    data.total_count > data.workflow_runs.length
  ) {
    throw new Error('StyleProof: the capture run list is incomplete; delivery order cannot be proven');
  }
  return isSupersededCaptureRun(capture, data.workflow_runs);
}

/** Skip a failure write only when a trusted receipt proves a later run took this head. */
export async function reviewRunSuperseded(options: {
  github: {
    rest: {
      repos: {
        listCommitStatusesForRef(parameters: {
          owner: string;
          repo: string;
          ref: string;
          per_page: number;
        }): Promise<{ data: { context: string; target_url?: string | null }[] }>;
      };
      issues: { listComments: unknown };
    };
    paginate(
      method: unknown,
      parameters: {
        owner: string;
        repo: string;
        issue_number: number;
        per_page: number;
      },
    ): Promise<{ body?: string | null; user?: { type?: string; login?: string } | null }[]>;
  };
  repo: { owner: string; repo: string };
  headSha: string;
  prNumber: number;
  runId: string;
  runAttempt: string;
  statusContext: string;
  commentMarker: string;
}): Promise<boolean> {
  if (!/^\d+$/.test(options.runId)) return false;
  try {
    const { data } = await options.github.rest.repos.listCommitStatusesForRef({
      ...options.repo,
      ref: options.headSha,
      per_page: 100,
    });
    const latest = data.find((status) => status.context === options.statusContext);
    const prefix = `https://github.com/${options.repo.owner}/${options.repo.repo}/actions/runs/`;
    const runPath = latest?.target_url?.startsWith(prefix) ? latest.target_url.slice(prefix.length) : '';
    const runId = runPath?.match(/^(\d+)(?:\/(?:artifacts|attempts)\/\d+)?\/?$/)?.[1];
    if (runId && BigInt(runId) > BigInt(options.runId)) return true;
  } catch {
    // A missing status receipt cannot prove supersession. Try the comment too.
  }
  try {
    const comments = await options.github.paginate(options.github.rest.issues.listComments, {
      ...options.repo,
      issue_number: options.prNumber,
      per_page: 100,
    });
    return comments.some((comment) => {
      if (comment.user?.type !== 'Bot' || !comment.body?.includes(options.commentMarker)) return false;
      const receipt = parseRunAttemptReceiptMarker(comment.body);
      return (
        receipt !== null &&
        (receipt.runId === options.runId || comment.user?.login === 'github-actions[bot]') &&
        !shouldSupersedeExistingComment({
          existingCommentBody: comment.body,
          runId: options.runId,
          runAttempt: options.runAttempt,
          headSha: options.headSha,
        })
      );
    });
  } catch {
    // Unknown ordering must replace any earlier green with failure.
    return false;
  }
}
