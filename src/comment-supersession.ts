/** Rerun-attempt supersession guard for the upserted PR comment.
 *
 *  `rerun_failed_jobs` re-executes the same workflow run with an incremented
 *  `run_attempt`. Each attempt publishes its own durable report (the receipt
 *  embeds head SHA + run id + run attempt) and then upserts the single
 *  marker comment. Deliveries can arrive out of order — a network retry from
 *  attempt 1 may land after attempt 2 already published its verdict — and an
 *  unguarded upsert would then overwrite the newer verdict with the stale one.
 *
 *  The comment therefore records which attempt wrote it, and the upsert
 *  refuses to overwrite a comment written by a LATER attempt of the SAME run.
 *  Attempts are only ordered within one run id; a different run id is a
 *  different workflow run whose delivery always supersedes. */

export type RunAttemptReceipt = {
  runId: string;
  runAttempt: string;
};

const RUN_ATTEMPT_RECEIPT_PATTERN = /<!-- styleproof-run-id:(\d+) run-attempt:(\d+) -->/;

/** Hidden marker the comment body carries so a later delivery can tell which
 *  attempt published the comment it is about to overwrite. */
export function formatRunAttemptReceiptMarker(receipt: RunAttemptReceipt): string {
  return `<!-- styleproof-run-id:${receipt.runId} run-attempt:${receipt.runAttempt} -->`;
}

/** The attempt receipt recorded in an existing comment body, or null when the
 *  comment predates the receipt (or was not written by this action). */
export function parseRunAttemptReceiptMarker(commentBody: string): RunAttemptReceipt | null {
  const match = commentBody.match(RUN_ATTEMPT_RECEIPT_PATTERN);
  if (!match) return null;
  return { runId: match[1], runAttempt: match[2] };
}

/** True when this delivery may overwrite the existing comment. False only for
 *  the stale case: the existing comment was written by a strictly greater
 *  attempt of the SAME run. Missing/legacy receipts, equal attempts
 *  (idempotent re-delivery), and other run ids all overwrite. */
export function shouldSupersedeExistingComment(options: {
  existingCommentBody: string | null | undefined;
  runId: string;
  runAttempt: string;
}): boolean {
  if (!options.existingCommentBody) return true;
  const existingReceipt = parseRunAttemptReceiptMarker(options.existingCommentBody);
  if (existingReceipt === null) return true;
  if (existingReceipt.runId !== options.runId) return true;
  const existingAttemptNumber = Number(existingReceipt.runAttempt);
  const deliveryAttemptNumber = Number(options.runAttempt);
  if (!Number.isFinite(existingAttemptNumber) || !Number.isFinite(deliveryAttemptNumber)) return true;
  return existingAttemptNumber <= deliveryAttemptNumber;
}
