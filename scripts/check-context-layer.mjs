// Fail when the agent context layer drifts from what its docs promise (ADR 0007):
// CLAUDE.md → AGENTS.md → .agents/README.md stay short pointers, the project
// docs exist, relative links resolve, no doc repeats a section, and ADR numbers
// are unique. Nothing else fails when one of these files is renamed, emptied,
// or regrown by a tool such as `gitnexus analyze`.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const START_HERE = '.agents/README.md';
const POINTER_MAX_LINES = 12;
const START_HERE_MIN_LINES = 20;
const DECISIONS = '.agents/decisions';
const PROJECT_DOCS = [
  'ARCHITECTURE.md',
  'CONVENTIONS.md',
  'DEFINITION_OF_DONE.md',
  'GLOSSARY.md',
  'PR_QUALITY.md',
  'QUALITY_GATES.md',
  'TECH_STACK.md',
].map((name) => `.agents/project/${name}`);

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const LINK = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/**
 * Root Markdown, everything under .agents/, and the skills: the docs an agent
 * reads. CHANGELOG.md is release history; each release repeats its headings.
 */
export function isContextDoc(file) {
  if (file === 'CHANGELOG.md' || !file.endsWith('.md')) return false;
  return !file.includes('/') || file.startsWith('.agents/') || file.startsWith('.claude/skills/');
}

const nonEmptyLines = (text) => text.split('\n').filter((line) => line.trim()).length;

/** The text's lines with front matter and fenced code blanked, so neither is read as prose. */
export function proseLines(text) {
  const lines = text.split(/\r?\n/);
  const frontMatterEnd = lines[0] === '---' ? lines.indexOf('---', 1) + 1 : 0;
  let fence = null;
  return lines.map((line, index) => {
    if (index < frontMatterEnd) return '';
    const marker = FENCE.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = null;
      return '';
    }
    if (marker) fence = marker;
    return fence ? '' : line;
  });
}

/** Each section that appears twice under the same parent heading, outermost copy only. */
export function duplicateSections(text) {
  const seen = new Map();
  const ancestors = [];
  proseLines(text).forEach((line, index) => {
    const match = HEADING.exec(line);
    if (!match) return;
    const level = match[1].length;
    const heading = `${match[1]} ${match[2]}`;
    while (ancestors.length && ancestors[ancestors.length - 1].level >= level) ancestors.pop();
    const key = [...ancestors.map((a) => a.heading), heading].join('\n');
    if (!seen.has(key)) seen.set(key, { key, heading, lines: [] });
    seen.get(key).lines.push(index + 1);
    ancestors.push({ level, heading });
  });
  const repeated = [...seen.values()].filter((section) => section.lines.length > 1);
  return repeated.filter((section) => !repeated.some((outer) => section.key.startsWith(`${outer.key}\n`)));
}

/** Relative link targets in prose that do not exist on disk. */
export function brokenLinks(root, file, text) {
  const broken = [];
  proseLines(text).forEach((line, index) => {
    for (const [, href] of line.replace(/`[^`]*`/g, '').matchAll(LINK)) {
      if (/^([a-z][a-z0-9+.-]*:|#|\/)/i.test(href)) continue;
      const target = decodeURI(href.split('#')[0]);
      if (!fs.existsSync(path.join(root, path.dirname(file), target))) broken.push({ line: index + 1, href });
    }
  });
  return broken;
}

function regularFile(root, file, errors) {
  let stat;
  try {
    stat = fs.lstatSync(path.join(root, file));
  } catch {
    errors.push(`${file} is missing; the context layer requires it.`);
    return false;
  }
  if (stat.isSymbolicLink()) errors.push(`${file} is a symlink; make it a regular file so the diff shows its content.`);
  else if (!stat.isFile()) errors.push(`${file} is not a regular file.`);
  return stat.isFile();
}

function checkPointers(root, errors) {
  const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
  if (regularFile(root, 'AGENTS.md', errors) && !read('AGENTS.md').includes(START_HERE)) {
    errors.push(`AGENTS.md must point to ${START_HERE}, where every agent doc lives.`);
  }
  if (regularFile(root, 'CLAUDE.md', errors)) {
    const header = read('CLAUDE.md').split('\n').slice(0, 10).join('\n');
    if (!/AGENTS\.md/.test(header)) errors.push('CLAUDE.md must defer to AGENTS.md within its first 10 lines.');
  }
  for (const file of ['AGENTS.md', 'CLAUDE.md']) {
    if (!fs.existsSync(path.join(root, file))) continue;
    const count = nonEmptyLines(read(file));
    if (count > POINTER_MAX_LINES) {
      errors.push(
        `${file} has ${count} non-empty lines (max ${POINTER_MAX_LINES}); it only points to ${START_HERE}. ` +
          'Move the content there (a GitNexus block belongs in .agents/GITNEXUS.md; re-index with --skip-agents-md).',
      );
    }
  }
  if (regularFile(root, START_HERE, errors) && nonEmptyLines(read(START_HERE)) < START_HERE_MIN_LINES) {
    errors.push(`${START_HERE} has under ${START_HERE_MIN_LINES} non-empty lines; it is the operating contract.`);
  }
}

/** ADR number from the first line: `# 7. Title` or `# ADR 0007: Title`. */
const titleNumber = (text) => Number(/^# (?:ADR )?(\d+)[.:]/.exec(text.replace(/^\uFEFF/, ''))?.[1]);

function checkDecisions(root, errors) {
  const dir = path.join(root, DECISIONS);
  if (!fs.existsSync(dir)) return errors.push(`${DECISIONS}/ is missing; ADRs live there.`);
  const byNumber = new Map();
  for (const name of fs
    .readdirSync(dir)
    .filter((entry) => entry.endsWith('.md'))
    .sort()) {
    const file = `${DECISIONS}/${name}`;
    const match = /^(\d{4})-[^/]+\.md$/.exec(name);
    if (!match) {
      errors.push(`${file} must be named NNNN-slug.md like the other ADRs.`);
      continue;
    }
    const number = Number(match[1]);
    if (titleNumber(fs.readFileSync(path.join(dir, name), 'utf8')) !== number) {
      errors.push(`${file} must start with \`# ADR ${match[1]}: <title>\` to match its file name.`);
    }
    byNumber.set(number, [...(byNumber.get(number) ?? []), file]);
  }
  const highest = Math.max(0, ...byNumber.keys());
  for (const [number, files] of byNumber) {
    if (files.length < 2) continue;
    errors.push(
      `ADR ${number} is used by ${files.join(' and ')}. Renumber the one your branch added above ${highest}, ` +
        'then update its title and every link to it.',
    );
  }
}

/** Every context-layer violation in `root`, given its tracked files. */
export function checkContextLayer(root, files) {
  const errors = [];
  checkPointers(root, errors);
  for (const file of PROJECT_DOCS) regularFile(root, file, errors);
  for (const file of files.filter(isContextDoc)) {
    if (!fs.existsSync(path.join(root, file))) continue;
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    for (const { heading, lines } of duplicateSections(text)) {
      errors.push(
        `${file} has the section "${heading}" ${lines.length} times (lines ${lines.join(', ')}); keep one copy.`,
      );
    }
    for (const { line, href } of brokenLinks(root, file, text))
      errors.push(`${file}:${line} links to missing ${href}.`);
  }
  checkDecisions(root, errors);
  return errors;
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  const errors = checkContextLayer(root, files);
  if (errors.length) {
    for (const error of errors) console.error(`check-context-layer: ${error}`);
    process.exit(1);
  }
  console.log(`check-context-layer: ${files.filter(isContextDoc).length} context doc(s) OK`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
