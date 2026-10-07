/**
 * Path filters for StyleProof CI lean gates.
 * Mirror scripts/pre-push-e2e.mjs for capture surfaces, then broaden for
 * dogfood (example/, action.yml) and shrink e2e/detection when those
 * surfaces are untouched.
 *
 * Docs-only / changelog-only / pure unit-test PRs (#788, #790, #800, #809)
 * should skip dogfood and browser e2e while keeping build + unit + pr-body.
 */

/** Live capture / diff / report / runner — same idea as pre-push-e2e.mjs. */
export const CAPTURE_ENGINE_GLOBS = ['src/capture/**', 'src/diff.ts', 'src/report/**', 'src/runner/**'];

/** Paths that should schedule dogfood workflows (product / adopter surfaces). */
export const DOGFOOD_PATH_GLOBS = [
  ...CAPTURE_ENGINE_GLOBS,
  'src/**',
  'action.yml',
  'bin/**',
  'example/**',
  'bench/**',
  'styleproof.config.ts',
  'scripts/action-dogfood-fixtures.mjs',
  'scripts/demo-report.mjs',
  'package.json',
  'package-lock.json',
  '.github/workflows/styleproof-dogfood.yml',
  '.github/workflows/action-dogfood.yml',
  '.github/workflows/store-dogfood.yml',
  '.github/workflows/phase1-advisory-dogfood.yml',
];

/** Paths that should schedule Playwright e2e shards + detection corpus. */
export const E2E_PATH_GLOBS = [
  ...CAPTURE_ENGINE_GLOBS,
  'src/**',
  'test/**/*.e2e.spec.ts',
  'test/helpers.mjs',
  'test/fixtures/**',
  'playwright.ci.config.ts',
  'playwright.config.ts',
  'bench/**',
  'package.json',
  'package-lock.json',
  '.github/workflows/ci.yml',
  'scripts/verify-e2e-shards.mjs',
];

function normalizePath(file) {
  return String(file).split('\\').join('/');
}

function matchesDoubleStarDir(normalized, glob) {
  const dir = glob.slice(0, -3);
  return normalized === dir || normalized.startsWith(`${dir}/`);
}

function globToRegExp(glob) {
  let i = 0;
  let re = '^';
  while (i < glob.length) {
    if (glob.startsWith('**/', i)) {
      re += '(?:.*/)?';
      i += 3;
      continue;
    }
    if (glob.startsWith('**', i)) {
      re += '.*';
      i += 2;
      continue;
    }
    if (glob[i] === '*') {
      re += '[^/]*';
      i += 1;
      continue;
    }
    const ch = glob[i];
    re += '.+^${}()|[]\\'.includes(ch) ? `\\${ch}` : ch;
    i += 1;
  }
  return new RegExp(`${re}$`);
}

function matchesOneGlob(normalized, glob) {
  if (glob.endsWith('/**')) return matchesDoubleStarDir(normalized, glob);
  if (glob.includes('*')) return globToRegExp(glob).test(normalized);
  return normalized === glob;
}

/** True when dorny-style globs should treat a changed path as matching. */
export function pathMatchesGlobs(file, globs) {
  const normalized = normalizePath(file);
  return globs.some((glob) => matchesOneGlob(normalized, glob));
}

export function shouldRunDogfood(files) {
  return files.some((f) => pathMatchesGlobs(f, DOGFOOD_PATH_GLOBS));
}

export function shouldRunE2e(files) {
  return files.some((f) => pathMatchesGlobs(f, E2E_PATH_GLOBS));
}
