/** The existing approval box line, shared by publication and live reconciliation. */
export function formatReviewApprovalLine({ approved, approver }: { approved: boolean; approver: string }): string {
  const approvedBy = approved && approver ? ` — _approved by @${approver}_` : '';

  return `- [${approved ? 'x' : ' '}] **Approve all changes**${approvedBy}`;
}
