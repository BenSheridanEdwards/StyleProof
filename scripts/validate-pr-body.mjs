// Machine validation for the PR title + body against .github/PULL_REQUEST_TEMPLATE.md.
// Runs in CI on pull_request (see .github/workflows/pr-body.yml). The body and title
// arrive via env (never interpolated into the command), so a hostile PR body cannot
// inject shell. `validatePullRequest` is pure so test/validate-pr-body.test.mjs can
// exercise every rule without a live PR.
import { fileURLToPath } from 'node:url';

// The four template sections, in the order the template lays them out.
export const REQUIRED_SECTIONS = [
  'Why does this feature exist?',
  'What changed?',
  'Behavioural Proof (with video and screenshots)',
  'Verification Summary',
];

// Conventional Commits subject: type(optional-scope)!: summary.
const CONVENTIONAL_TITLE = /^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(\([^)]+\))?!?: .+/;

// A line that carries no real content: blank, an HTML comment, or a bare list
// bullet / checkbox with nothing after it (the template's placeholder shape).
function isPlaceholderLine(line) {
  const trimmed = line.trim();
  if (trimmed === '') return true;
  if (trimmed.startsWith('<!--') || trimmed.startsWith('-->')) return true;
  if (/^-\s*$/.test(trimmed)) return true;
  if (/^-\s*\[[ x]\]\s*$/i.test(trimmed)) return true;
  return false;
}

// Split the body into { heading -> content lines } for every `#`/`##` heading.
function sectionsByHeading(body) {
  const sections = new Map();
  let current = null;
  for (const rawLine of body.split(/\r?\n/)) {
    const headingMatch = rawLine.match(/^#{1,6}\s+(.*?)\s*$/);
    if (headingMatch) {
      current = headingMatch[1];
      sections.set(current, []);
    } else if (current !== null) {
      sections.get(current).push(rawLine);
    }
  }
  return sections;
}

const PROOF_SECTION = 'Behavioural Proof (with video and screenshots)';

function titleErrors(title) {
  if (CONVENTIONAL_TITLE.test(title)) return [];
  return [`PR title must use Conventional Commits (type(scope): summary). Got: "${title}"`];
}

// Required sections must be present AND appear in the template order.
function sectionPresenceErrors(sections) {
  const errors = [];
  const headingOrder = [...sections.keys()];
  let lastIndex = -1;
  for (const required of REQUIRED_SECTIONS) {
    const index = headingOrder.indexOf(required);
    if (index === -1) {
      errors.push(`Missing required section: "${required}"`);
      continue;
    }
    if (index < lastIndex) {
      errors.push(`Section out of order: "${required}" must follow the template order`);
    }
    lastIndex = Math.max(lastIndex, index);
  }
  return errors;
}

// No required section may be empty or placeholder-only.
function placeholderErrors(sections) {
  const errors = [];
  for (const required of REQUIRED_SECTIONS) {
    if (!sections.has(required)) continue;
    const hasContent = sections.get(required).some((line) => !isPlaceholderLine(line));
    if (!hasContent) {
      errors.push(`Section "${required}" is empty or contains only template placeholders`);
    }
  }
  return errors;
}

// Behavioural Proof must carry an inline image (`![`) or an explicit `Not applicable`.
function proofErrors(sections) {
  if (!sections.has(PROOF_SECTION)) return [];
  const proof = sections.get(PROOF_SECTION).join('\n');
  if (proof.includes('![') || /not applicable/i.test(proof)) return [];
  return ['Behavioural Proof must embed a screenshot with `![` or state `Not applicable` with a reason'];
}

export function validatePullRequest({ title, body }) {
  const safeTitle = typeof title === 'string' ? title.trim() : '';
  const safeBody = typeof body === 'string' ? body : '';
  const sections = sectionsByHeading(safeBody);

  const errors = [
    ...titleErrors(safeTitle),
    ...sectionPresenceErrors(sections),
    ...placeholderErrors(sections),
    ...proofErrors(sections),
  ];

  return { valid: errors.length === 0, errors };
}

function main() {
  const title = process.env.PR_TITLE ?? '';
  const body = process.env.PR_BODY ?? '';
  const { valid, errors } = validatePullRequest({ title, body });
  if (!valid) {
    console.error('PR body validation failed:');
    for (const error of errors) console.error(`  ✖ ${error}`);
    process.exit(1);
  }
  console.log('PR body validation passed.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
