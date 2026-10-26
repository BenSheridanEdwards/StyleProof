import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const VENDOR = 'vendor/anti-slop';
const METADATA = new Set(['README.md', 'UPSTREAM.sha256', 'UPSTREAM.prefixes']);

function readManifest(root, name, pattern) {
  const seen = new Set();
  return readFileSync(join(root, VENDOR, name), 'utf8')
    .split('\n')
    .flatMap((line, index) => {
      if (!line.trim()) return [];
      const match = line.match(pattern);
      const path = match?.at(-1);
      const location = `${VENDOR}/${name}:${index + 1}`;
      if (!path || path.split('/').some((part) => ['', '.', '..'].includes(part))) {
        throw new Error(`${location}: invalid manifest entry`);
      }
      if (name === 'UPSTREAM.sha256' && seen.has(path)) throw new Error(`${location}: duplicate path`);
      seen.add(path);
      return [match.slice(1)];
    });
}

function listFiles(root, directory = VENDOR) {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return listFiles(root, path);
    return directory === VENDOR && METADATA.has(entry.name) ? [] : [{ path, regular: entry.isFile() }];
  });
}

/** Return provenance violations without importing or executing vendored code. */
export function checkAntiSlopVendor(root) {
  try {
    const whole = new Map(
      readManifest(root, 'UPSTREAM.sha256', /^([a-f0-9]{64}) {2}(vendor\/anti-slop\/\S+)$/).map(([hash, path]) => [
        path,
        hash,
      ]),
    );
    const prefixes = readManifest(
      root,
      'UPSTREAM.prefixes',
      /^([a-f0-9]{64}) {2}([1-9]\d*) {2}(vendor\/anti-slop\/\S+)$/,
    );
    const wired = existsSync(join(root, '.oxlintrc.json'));
    const files = listFiles(root);
    const present = new Set(files.map(({ path }) => path));
    const missing = wired
      ? [...whole.keys()].filter((path) => !present.has(path)).map((path) => `${path}: missing file`)
      : [];
    return missing.concat(
      files.flatMap(({ path, regular }) => {
        if (!regular) return [`${path}: expected regular file`];
        if (!whole.has(path)) return [`${path}: unlisted file`];
        const bytes = readFileSync(join(root, path));
        const hash = createHash('sha256').update(bytes).digest('hex');
        const prefix =
          !wired &&
          bytes.at(-1) === 10 &&
          prefixes.some(
            ([expected, lines, source]) =>
              source === path && expected === hash && bytes.toString('utf8').split('\n').length - 1 === Number(lines),
          );
        return hash === whole.get(path) || prefix ? [] : [`${path}: hash mismatch`];
      }),
    );
  } catch (error) {
    return [error.message];
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const errors = checkAntiSlopVendor(process.cwd());
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else {
    console.log('OK: anti-slop vendored files match upstream hashes.');
  }
}
