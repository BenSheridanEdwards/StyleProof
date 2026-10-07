/**
 * Canonical eight-section PR body contract for Ben’s repos.
 * StyleProof’s validate-pr-body.mjs (and sibling repos) should require these
 * headings in order. One-line North Star name lives inside Why prose per repo.
 */
export const EIGHT_SECTION_HEADINGS = Object.freeze([
  'Why',
  'What changed',
  'Reviewer view',
  'Proof',
  'Behaviour changes',
  'Not asked for',
  'Review guide',
  'Verification summary',
]);

/** @param {string} body */
export function missingEightSections(body) {
  const found = new Set();
  for (const line of String(body ?? '').split(/\r?\n/)) {
    const m = line.match(/^#{1,6}\s+(.*?)\s*$/);
    if (m) found.add(m[1]);
  }
  return EIGHT_SECTION_HEADINGS.filter((h) => !found.has(h));
}
