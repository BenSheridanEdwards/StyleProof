/** Stable marker for StyleProof's own evaluations and init scripts, excluded from app evidence. */
export const STYLEPROOF_SCRIPT_URL = 'styleproof://capture/forced-states';

export function captureExpression(expression: string): string {
  return `${expression}\n//# sourceURL=${STYLEPROOF_SCRIPT_URL}\n`;
}
