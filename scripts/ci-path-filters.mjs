/**
 * The one CI path classifier. Every workflow that can skip a browser or dogfood
 * lane embeds dornyFilterLines(); test/ci-path-filters.test.mjs pins each copy.
 *
 * Fail-closed: a path runs every lane unless it matches a SAFE_PATHS entry. An
 * entry earns its place only when nothing a browser or dogfood lane executes or
 * reads can load it. src/** never qualifies: bin/styleproof.mjs spawns every CLI
 * by computed name, so the e2e lane can reach all of src.
 */
export const SAFE_PATHS = [
  { glob: '*.md', why: 'Top-level prose (README, CHANGELOG, AGENTS); no CLI or lane reads it.' },
  { glob: 'LICENSE', why: 'License text; shipped in the package, read by nothing.' },
  { glob: 'docs/**', why: 'Documentation and committed proof assets; the build job checks docs/demo freshness.' },
  { glob: '.agents/**', why: 'Agent context documents; nothing in CI loads them.' },
  { glob: '.claude/**', why: 'Local agent tooling (skills, hooks, settings); never run in CI.' },
  { glob: '.github/ISSUE_TEMPLATE/**', why: 'Issue forms rendered by GitHub only.' },
  { glob: '.github/PULL_REQUEST_TEMPLATE.md', why: 'PR body template rendered by GitHub only.' },
  { glob: '.fallow/**', why: 'Fallow health baseline read only by fallow.yml.' },
  { glob: '.fallowrc.jsonc', why: 'Fallow configuration read only by fallow.yml.' },
  { glob: '.mcp.json', why: 'Local MCP server list for agent sessions.' },
  { glob: 'skills-lock.json', why: 'Pin file for vendored agent skills under .claude/.' },
  { glob: 'eslint.config.js', why: 'Lint rules; the build job runs lint and they never reach dist/.' },
  { glob: 'commitlint.config.js', why: 'Commit message rules for the local hook.' },
  { glob: '.prettierrc.json', why: 'Formatter settings; the build job runs format:check.' },
  { glob: '.prettierignore', why: 'Formatter ignore list; the build job runs format:check.' },
  { glob: 'test/*.test.mjs', why: 'Node unit tests; the build job runs them and no browser lane imports one.' },
  { glob: 'scripts/check-coverage.mjs', why: 'Unit coverage floor for the build job.' },
  { glob: 'scripts/privacy-check.mjs', why: 'Privacy scan run by the build job.' },
  { glob: 'scripts/validate-pr-body.mjs', why: 'PR body validator run by pr-body.yml.' },
  { glob: 'scripts/eight-section-pr-body.mjs', why: 'PR body headings shared with the PR body validator.' },
  { glob: 'scripts/release-notes.mjs', why: 'Release note extraction run by release.yml.' },
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

export function isSafePath(file) {
  const normalized = normalizePath(file);
  return SAFE_PATHS.some(({ glob }) => matchesOneGlob(normalized, glob));
}

/** dorny's verdict for the same file list: true when any changed file is not safe. */
export function needsBrowserLanes(files) {
  return files.some((file) => !isSafePath(file));
}

/** The dorny filter body (with predicate-quantifier `every`) each workflow embeds. */
export function dornyFilterLines(output) {
  return [`${output}:`, "  - '**'", ...SAFE_PATHS.map(({ glob }) => `  - '!${glob}'`)];
}
