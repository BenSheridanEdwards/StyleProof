/**
 * Rerun-attempt supersession guard for the upserted PR comment: deliveries can
 * land out of order, so the comment records which attempt wrote it and the
 * upsert refuses to overwrite a LATER attempt of the SAME run. A different run
 * id always supersedes. Split-layout certify statuses additionally order their
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

/** True when this delivery may overwrite the existing comment; false only when a strictly greater attempt of the SAME run wrote it. */
export function shouldSupersedeExistingComment(options: {
  existingCommentBody: string | null | undefined;
  runId: string;
  runAttempt: string;
}): boolean {
  const existing = options.existingCommentBody ? parseRunAttemptReceiptMarker(options.existingCommentBody) : null;
  if (existing === null || existing.runId !== options.runId) return true;
  const existingAttempt = Number(existing.runAttempt);
  const deliveryAttempt = Number(options.runAttempt);
  if (!Number.isFinite(existingAttempt) || !Number.isFinite(deliveryAttempt)) return true;
  return existingAttempt <= deliveryAttempt;
}

export type CaptureRunIdentity = {
  id: number;
  run_attempt: number;
  created_at: string;
  event?: string;
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

/** True when a newer pull_request capture run or attempt exists; throws when order cannot be proven. */
export function isSupersededCaptureRun(capture: CaptureRunIdentity, runs: readonly CaptureRunIdentity[]): boolean {
  const created = captureRunCreatedAt(capture);
  return runs.some((run) => {
    if (run.event !== 'pull_request') return false;
    const candidateCreated = captureRunCreatedAt(run);
    if (run.id === capture.id) return run.run_attempt > capture.run_attempt;
    return candidateCreated > created || (candidateCreated === created && run.id > capture.id);
  });
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
