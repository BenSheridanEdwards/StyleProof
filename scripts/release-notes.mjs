import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function hasUnsafeTitleCodePoint(value) {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) || codePoint === 0x2028 || codePoint === 0x2029
    );
  });
}

export function extractReleaseNotes(changelog, version) {
  if (!VERSION.test(version)) throw new Error(`invalid release version: ${version}`);
  const heading = `## [${version}]`;
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith(heading));
  if (start === -1) return { body: '', title: `v${version}` };
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].startsWith('## ')) {
      end = index;
      break;
    }
  }
  const body = lines
    .slice(start + 1, end)
    .join('\n')
    .trim();
  const titleLine = body.split(/\r?\n/).find((line) => line.startsWith('> **'));
  const titleMatch = titleLine?.match(/^> \*\*([\s\S]+)\*\*$/u);
  if (titleLine && !titleMatch) {
    throw new Error('release title must be one safe line of at most 160 UTF-8 bytes');
  }
  const title = titleMatch?.[1]?.trim() || `v${version}`;
  const titleBytes = Buffer.byteLength(title, 'utf8');
  if (titleBytes === 0 || titleBytes > 160 || hasUnsafeTitleCodePoint(title)) {
    throw new Error('release title must be one safe line of at most 160 UTF-8 bytes');
  }
  return { body, title };
}

function main() {
  const args = process.argv.slice(2);
  const versionIndex = args.indexOf('--version');
  const outIndex = args.indexOf('--out');
  const version = versionIndex >= 0 ? args[versionIndex + 1] : undefined;
  const output = outIndex >= 0 ? args[outIndex + 1] : undefined;
  if (!version || !output) {
    console.error('usage: release-notes --version <semver> --out <path>');
    process.exit(2);
  }
  const changelog = fs.existsSync('CHANGELOG.md') ? fs.readFileSync('CHANGELOG.md', 'utf8') : '';
  const notes = extractReleaseNotes(changelog, version);
  fs.writeFileSync(output, notes.body ? `${notes.body}\n` : '');
  process.stdout.write(notes.title);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
