// Fail on a suppression comment that does not say why (ADR 0007). Neither tool
// can hold this itself: the comment silences the report that would flag it.
// - An inline ESLint disable names its rules and ends in `-- <reason>`.
// - Inline ESLint rule config or globals comments move to eslint.config.js.
// - A type suppression is `@ts-expect-error <reason>`, which fails once fixed;
//   `@ts-ignore` and `@ts-nocheck` never do.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCES = ['*.ts', '*.tsx', '*.mts', '*.cts', '*.js', '*.mjs', '*.cjs'];
// Inputs for tests and generated pages, not source: ESLint ignores them too.
const SKIPPED = ['test/fixtures/', 'docs/'];
const MIN_REASON = 10;

const ESLINT_DISABLE = /(?:\/\/|\/\*)\s*eslint-disable(?:-next-line|-line)?(?=[\s*]|$)(.*)$/;
const ESLINT_CONFIG = /\/\*\s*(?:eslint|global|globals)\s+[\w@/-]+/;
const TS_DIRECTIVE = /\/\/\s*@ts-(ignore|nocheck|expect-error)\b(.*)$/;

export const MESSAGES = {
  'eslint-rules': 'disables every ESLint rule; name the rules it turns off.',
  'eslint-reason': 'has no reason; end it with `-- <why this line is the exception>`.',
  'eslint-config': 'configures ESLint inline; move the exception to eslint.config.js with its reason.',
  'ts-ignore': 'is `@ts-ignore`; use `@ts-expect-error <reason>`, which fails once the error is fixed.',
  'ts-nocheck': 'turns off type checking for the file; fix the types instead.',
  'ts-reason': 'has no reason; write `@ts-expect-error <why this line is the exception>`.',
};

const hasReason = (text) =>
  text
    .replace(/^[\s:-]+/, '')
    .replace(/\*\/\s*$/, '')
    .trim().length >= MIN_REASON;

function eslintKind(rest) {
  const [rules, reason] = rest.replace(/\*\/.*$/, '').split(/\s--\s|\s--$/);
  if (!rules.trim()) return 'eslint-rules';
  return reason !== undefined && hasReason(reason) ? undefined : 'eslint-reason';
}

function kindOf(line) {
  const disable = ESLINT_DISABLE.exec(line);
  if (disable) return eslintKind(disable[1]);
  if (ESLINT_CONFIG.test(line)) return 'eslint-config';
  const directive = TS_DIRECTIVE.exec(line);
  if (!directive) return undefined;
  if (directive[1] !== 'expect-error') return `ts-${directive[1]}`;
  return hasReason(directive[2]) ? undefined : 'ts-reason';
}

/** Each `{ line, kind }` in `text` that suppresses a check without saying why. */
export function findSuppressions(text) {
  return text
    .split('\n')
    .map((line, index) => ({ line: index + 1, kind: kindOf(line) }))
    .filter(({ kind }) => kind);
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const files = execFileSync('git', ['ls-files', '-z', '--', ...SOURCES], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter((file) => file && !SKIPPED.some((prefix) => file.startsWith(prefix)));
  const failures = files.flatMap((file) =>
    findSuppressions(fs.readFileSync(path.join(root, file), 'utf8')).map(
      ({ line, kind }) => `${file}:${line}: ${MESSAGES[kind]}`,
    ),
  );
  if (failures.length) {
    for (const failure of failures) console.error(`check-suppressions: ${failure}`);
    process.exit(1);
  }
  console.log(`check-suppressions: ${files.length} source file(s) OK`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
