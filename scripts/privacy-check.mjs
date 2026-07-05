import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TEXT_EXT = new Set([
  '.css',
  '.html',
  '.js',
  '.json',
  '.jsonc',
  '.md',
  '.mjs',
  '.sh',
  '.ts',
  '.txt',
  '.yaml',
  '.yml',
]);
const ALLOWED_GITHUB = new Set([
  'github.com/bensheridanedwards/styleproof',
  'raw.githubusercontent.com/bensheridanedwards/styleproof',
]);

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

function addRegexFindings(out, file, text, rule, regex) {
  for (const match of text.matchAll(regex)) {
    out.push({ file, line: lineOf(text, match.index ?? 0), rule, match: match[0].trim() });
  }
}

function githubUrlFindings(out, file, text) {
  const urlRe = /https?:\/\/(?:github\.com|raw\.githubusercontent\.com)\/[^\s)"'<>]+/gi;
  for (const match of text.matchAll(urlRe)) {
    const value = match[0];
    if (value.includes('${')) continue;
    const bits = value.replace(/^https?:\/\//i, '').split('/');
    bits[2] = (bits[2] ?? '').replace(/(?:\.git)?(?:[#?].*)?$/, '');
    const repo = bits.slice(0, 3).join('/').toLowerCase();
    if (!ALLOWED_GITHUB.has(repo)) {
      out.push({ file, line: lineOf(text, match.index ?? 0), rule: 'github url outside allowlist', match: value });
    }
  }
}

export function findPrivacyFindings(entries, denylist = []) {
  const out = [];
  for (const { file, text } of entries) {
    addRegexFindings(
      out,
      file,
      text,
      'absolute local path',
      /(?:^|[\s"'(=])(?:\/Users\/|\/private\/|\/home\/[^/\s]+\/|\/var\/folders\/|[A-Za-z]:\\Users\\)[^\s)"'<>]*/g,
    );
    addRegexFindings(out, file, text, 'file url', /\bfile:\/\/[^\s)"'<>]+/g);
    addRegexFindings(
      out,
      file,
      text,
      'private network url',
      /\bhttps?:\/\/(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)[^\s)"'<>]*/g,
    );
    addRegexFindings(
      out,
      file,
      text,
      'internal hostname',
      /\bhttps?:\/\/[A-Za-z0-9.-]+\.(?:corp|internal|lan|private)(?::\d+)?(?:\/[^\s)"'<>]*)?/gi,
    );
    githubUrlFindings(out, file, text);

    for (const token of denylist) {
      const at = text.indexOf(token);
      if (at !== -1) out.push({ file, line: lineOf(text, at), rule: 'denylist token', match: token });
    }
  }
  return out;
}

function textFile(file) {
  return TEXT_EXT.has(path.extname(file).toLowerCase());
}

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(file));
    else out.push(file);
  }
  return out;
}

function npmPackFiles(root) {
  const pack = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8' });
  if (pack.status !== 0) throw new Error(pack.stderr || pack.stdout || 'npm pack --dry-run failed');
  return JSON.parse(pack.stdout)[0].files.map((file) => file.path);
}

function publicFiles(root) {
  const files = new Set(npmPackFiles(root).filter(textFile));
  for (const rel of ['action.yml', 'CHANGELOG.md', 'README.md']) files.add(rel);
  for (const dir of ['.github/workflows', 'docs', 'example']) {
    for (const file of walk(path.join(root, dir))) {
      const rel = path.relative(root, file);
      if (textFile(rel)) files.add(rel);
    }
  }
  return [...files].sort();
}

export function denylist(root) {
  const values = [];
  if (process.env.STYLEPROOF_PRIVACY_DENYLIST) values.push(...process.env.STYLEPROOF_PRIVACY_DENYLIST.split(/[,\n]/));
  const file = path.join(root, '.styleproof-privacy-denylist');
  if (fs.existsSync(file)) values.push(...fs.readFileSync(file, 'utf8').split('\n'));
  return values.map((v) => v.trim()).filter((v) => v.length >= 3 && !v.startsWith('#'));
}

function main() {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const repo = path.resolve(root, '..');
  const files = publicFiles(repo);
  const entries = files.map((file) => ({ file, text: fs.readFileSync(path.join(repo, file), 'utf8') }));
  const findings = findPrivacyFindings(entries, denylist(repo));
  if (findings.length) {
    for (const f of findings) console.error(`${f.file}:${f.line}: ${f.rule}: ${f.match}`);
    process.exit(1);
  }
  console.log(`privacy-check: scanned ${entries.length} public text file(s)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
