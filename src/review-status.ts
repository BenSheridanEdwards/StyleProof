/**
 * The review-gate commit-status decision, shared by the Action's comment and status
 * steps so the approval box and the status can never disagree.
 *
 * Untrusted capture (a fork PR in the capture/report split): both the base and the
 * head maps were produced by a job that ran the fork's code, so the fork controls the
 * verdict — identical maps would read as "no changes". Such a verdict is advisory:
 * the status is never set to success automatically, only by a maintainer's approval.
 */

export const UNTRUSTED_CAPTURE_STATUS_DESCRIPTION =
  'Fork PR — maps captured in an untrusted job; maintainer approval required';

export type ReviewStatusInput = {
  /** The canonical trust state from the verdict step. */
  trustState: string;
  /** A canonical approval (success by github-actions[bot]) already exists for this head SHA. */
  approved: boolean;
  /** Advisory mode: same-repo verdicts never block. */
  advisoryMode: boolean;
  /** The maps were captured by a job that ran untrusted (fork) code. */
  untrustedCapture: boolean;
};

export type ReviewStatusDecision = {
  state: 'success' | 'failure' | 'pending';
  /** A reviewer tick can turn this run green, so the comment carries the approval box. */
  approvable: boolean;
  /** Pending only because the capture is untrusted: use the fork description. */
  awaitingMaintainer: boolean;
};

export function decideReviewStatus({
  trustState,
  approved,
  advisoryMode,
  untrustedCapture,
}: ReviewStatusInput): ReviewStatusDecision {
  if (!untrustedCapture) {
    const approvable = trustState === 'STYLE_REVIEW_REQUIRED';
    const green = advisoryMode || trustState === 'NO_REVIEWABLE_STYLE_CHANGES' || (approvable && approved);
    return { state: green ? 'success' : 'failure', approvable, awaitingMaintainer: false };
  }
  // A clean fork verdict is only the fork's own claim, so it needs sign-off too.
  const approvable = trustState === 'STYLE_REVIEW_REQUIRED' || trustState === 'NO_REVIEWABLE_STYLE_CHANGES';
  if (approvable && approved) return { state: 'success', approvable, awaitingMaintainer: false };
  if (approvable) return { state: 'pending', approvable, awaitingMaintainer: true };
  // Certification failures stay red; advisory mode never blocks, so it waits instead.
  return { state: advisoryMode ? 'pending' : 'failure', approvable, awaitingMaintainer: false };
}
