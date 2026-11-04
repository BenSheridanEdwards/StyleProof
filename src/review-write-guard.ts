import {
  findLaterAttemptReceipt,
  formatRunAttemptReceiptMarker,
  parseRunAttemptReceiptMarker,
  reviewRunSuperseded,
  shouldSupersedeExistingComment,
} from './comment-supersession.js';
import { readReviewApproval, type ReviewApproval } from './review-approval.js';

type ReviewPublicationInput = Parameters<typeof reviewRunSuperseded>[0];

type ReviewCommentRoute = ReviewPublicationInput['github']['rest']['issues']['listComments'];

type ReviewWriteInput = Omit<ReviewPublicationInput, 'github'> & {
  github: Omit<ReviewPublicationInput['github'], 'paginate'> &
    Parameters<typeof findLaterAttemptReceipt>[0]['github'] & {
      rest: {
        pulls: {
          get(parameters: { owner: string; repo: string; pull_number: number }): Promise<{
            data: { head: { sha: string } };
          }>;
        };
      };
      paginate(
        method: ReviewCommentRoute,
        parameters: { owner: string; repo: string; issue_number: number; per_page: number },
      ): Promise<
        {
          id?: number;
          body?: string | null;
          user?: { type?: string; login?: string } | null;
        }[]
      >;
    };
  core: { info(message: string): void; warning(message: string): void };
  comment?: { identifier?: number; claimExisting?: boolean };
  approvalToRemove?: Parameters<typeof readReviewApproval>[0];
  approvalToGrant?: Parameters<typeof readReviewApproval>[0];
  allowNonGreenStatus?: boolean;
};

type ReviewWriteDecision = { allowed: boolean; approval?: ReviewApproval; headMoved?: boolean };

async function validateReviewWrite(input: ReviewWriteInput): Promise<ReviewWriteDecision> {
  const skip = (reason: string, headChanged = false) => {
    input.core.info(`StyleProof: ${reason} — review write skipped.`);

    return { allowed: false, headMoved: headChanged };
  };

  const headMoved = async () => {
    if (!input.comment) return false;
    const { data } = await input.github.rest.pulls.get({ ...input.repo, pull_number: input.prNumber });

    return data.head.sha !== input.headSha;
  };

  if (await headMoved()) return skip('the PR head moved', true);

  const ownershipInput = {
    ...input,
    onReadError: (): never => {
      throw new Error('StyleProof delivery ownership is unavailable');
    },
  };

  if (await reviewRunSuperseded(ownershipInput)) return skip('a newer delivery owns this head');

  const comments = await input.github.paginate(input.github.rest.issues.listComments, {
    ...input.repo,
    issue_number: input.prNumber,
    per_page: 100,
  });

  if (
    await findLaterAttemptReceipt({
      ...ownershipInput,
      comments: comments.filter((comment) => comment.body?.includes(input.commentMarker)),
    })
  ) {
    return skip('a later report receipt owns this head');
  }

  if (input.comment?.identifier !== undefined) {
    const current = comments.find((comment) => comment.id === input.comment!.identifier);

    if (!current?.body?.includes(input.commentMarker)) return skip('the report comment is missing');
    const receipt = parseRunAttemptReceiptMarker(current.body);

    if (
      receipt &&
      !current.body.includes(formatRunAttemptReceiptMarker(input)) &&
      !(input.comment.claimExisting && shouldSupersedeExistingComment({ ...input, existingCommentBody: current.body }))
    ) {
      return skip('the comment belongs to another delivery');
    }
  }

  const preservedApproval = input.approvalToRemove ? await readReviewApproval(input.approvalToRemove) : undefined;

  if (preservedApproval?.approved) {
    skip('approval now stands');

    return { allowed: false, approval: preservedApproval };
  }

  const approval = input.approvalToGrant ? await readReviewApproval(input.approvalToGrant) : undefined;

  if (approval?.approved === false) return skip('approval no longer stands');

  if (await headMoved()) return skip('the PR head moved', true);

  return { allowed: true, approval };
}

/** One guard for every review publication; GitHub cannot make its last read and the write atomic. */
export async function guardReviewWrite(input: ReviewWriteInput): Promise<ReviewWriteDecision> {
  try {
    return await validateReviewWrite(input);
  } catch {
    input.core.warning('StyleProof: delivery ownership could not be proven — approval-granting writes skipped.');

    if (!input.allowNonGreenStatus || input.comment) return { allowed: false };
    const approval = input.approvalToRemove ? await readReviewApproval(input.approvalToRemove) : undefined;

    return approval?.approved ? { allowed: false, approval } : { allowed: true };
  }
}
