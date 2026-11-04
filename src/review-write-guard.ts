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
  core: { info(message: string): void };
  comment?: { identifier?: number; claimExisting?: boolean };
  approvalToRemove?: Parameters<typeof readReviewApproval>[0];
};

/** One guard for every review publication; GitHub cannot make its last read and the write atomic. */
export async function guardReviewWrite(
  input: ReviewWriteInput,
): Promise<{ allowed: boolean; approval?: ReviewApproval; headMoved?: boolean }> {
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

  if (await reviewRunSuperseded(input)) return skip('a newer delivery owns this head');

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

  if (input.approvalToRemove) {
    const approval = await readReviewApproval(input.approvalToRemove);

    if (approval.approved) {
      skip('approval now stands');

      return { allowed: false, approval };
    }
  }

  if (await headMoved()) return skip('the PR head moved', true);

  return { allowed: true };
}
