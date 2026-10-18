import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The dorny filter file every browser and dogfood workflow passes to dorny/paths-filter. */
export const PATH_FILTERS_FILE = '.github/path-filters.yml';

/**
 * Safe-path globs parsed from PATH_FILTERS_FILE. The file must be exactly one
 * `lanes:` filter whose first pattern is '**' and whose other patterns are
 * negations; anything else throws rather than guessing.
 */
export function readSafeGlobs(
  text = fs.readFileSync(fileURLToPath(new URL(`../${PATH_FILTERS_FILE}`, import.meta.url)), 'utf8'),
) {
  const lines = text.split('\n').filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'));
  const patterns = lines.slice(1).map((line) => line.match(/^ {2}- '([^']+)'$/)?.[1]);
  if (lines[0] !== 'lanes:' || patterns[0] !== '**' || patterns.slice(1).some((p) => !p?.startsWith('!'))) {
    throw new Error(`${PATH_FILTERS_FILE} must be one 'lanes:' filter: '**' then '!<safe glob>' lines`);
  }
  return patterns.slice(1).map((p) => p.slice(1));
}

const SAFE_GLOBS = readSafeGlobs();

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
  return SAFE_GLOBS.some((glob) => matchesOneGlob(normalized, glob));
}

/** True when any changed file is not safe: the `lanes` verdict dorny computes from PATH_FILTERS_FILE. */
export function needsBrowserLanes(files) {
  return files.some((file) => !isSafePath(file));
}
