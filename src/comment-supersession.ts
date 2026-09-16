/**
 * Rerun-attempt supersession guard for the upserted PR comment: deliveries can
 * land out of order, so the comment records which attempt wrote it and the
 * upsert refuses to overwrite a LATER attempt of the SAME run. A different run
 * id always supersedes.
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
