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
};

type ReviewWriteDecision = {
  allowed: boolean;
  approval?: ReviewApproval;
  headMoved?: boolean;
  superseded?: boolean;
  unavailable?: boolean;
  commentBody?: string;
};

async function validateReviewWrite(input: ReviewWriteInput): Promise<ReviewWriteDecision> {
  const skip = (reason: string, kind: 'head-moved' | 'superseded' | 'unavailable' | 'unapproved') => {
    input.core.info(`StyleProof: ${reason} — review write skipped.`);

    return {
      allowed: false,
      headMoved: kind === 'head-moved',
      superseded: kind === 'superseded',
      unavailable: kind === 'unavailable',
    };
  };

  const headMoved = async () => {
    if (!input.comment) return false;
    const { data } = await input.github.rest.pulls.get({ ...input.repo, pull_number: input.prNumber });

    return data.head.sha !== input.headSha;
  };

  if (await headMoved()) return skip('the PR head moved', 'head-moved');

  const ownershipInput = {
    ...input,
    onReadError: (): never => {
      throw new Error('StyleProof delivery ownership is unavailable');
    },
  };

  if (await reviewRunSuperseded(ownershipInput)) return skip('a newer delivery owns this head', 'superseded');

  const comments = await input.github.paginate(input.github.rest.issues.listComments, {
    ...input.repo,
    issue_number: input.prNumber,
    per_page: 100,
  });

  if (
    await findLaterAttemptReceipt({
      ...input,
      comments: comments.filter((comment) => comment.body?.includes(input.commentMarker)),
    })
  ) {
    return skip('a later report receipt owns this head', 'superseded');
  }

  let commentBody: string | undefined;

  if (input.comment?.identifier !== undefined) {
    const current = comments.find((comment) => comment.id === input.comment!.identifier);

    if (!current?.body?.includes(input.commentMarker)) return skip('the report comment is missing', 'unavailable');
    const receipt = parseRunAttemptReceiptMarker(current.body);

    if (
      receipt &&
      !current.body.includes(formatRunAttemptReceiptMarker(input)) &&
      !(input.comment.claimExisting && shouldSupersedeExistingComment({ ...input, existingCommentBody: current.body }))
    ) {
      return skip('the comment belongs to another delivery', 'unavailable');
    }

    commentBody = current.body;
  }

  const preservedApproval = input.approvalToRemove ? await readReviewApproval(input.approvalToRemove) : undefined;

  if (preservedApproval?.approved) {
    input.core.info('StyleProof: approval now stands — review write skipped.');

    return { allowed: false, approval: preservedApproval };
  }

  const approval = input.approvalToGrant ? await readReviewApproval(input.approvalToGrant) : undefined;

  if (approval?.approved === false) return skip('approval no longer stands', 'unapproved');

  if (await headMoved()) return skip('the PR head moved', 'head-moved');

  return { allowed: true, approval, commentBody };
}

/** One guard for every review publication; GitHub cannot make its last read and the write atomic. */
export async function guardReviewWrite(input: ReviewWriteInput): Promise<ReviewWriteDecision> {
  try {
    return await validateReviewWrite(input);
  } catch {
    input.core.warning('StyleProof: delivery ownership could not be proven — approval-granting writes skipped.');

    const superseded = await reviewRunSuperseded(input);

    return { allowed: false, superseded, unavailable: !superseded };
  }
}
