/** Git/manifest adapter for J2. Classification remains in the pure script-join module. */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { readMapManifest } from './map-store/manifest.js';
import { runGit, sha256 } from './node-util.js';
import { resolveScriptProjectRoot } from './capture/script-project-root.js';
import { compareScriptRanges, scriptJoinGap, type ScriptChange, type ScriptJoinGap } from './script-join.js';

export type ScriptChanges = { changes: ScriptChange[]; gaps: ScriptJoinGap[] };

const sourceLines = (text: string): string[] => text.split(/\r\n|[\n\r\u2028\u2029]/);

/** Include the lexical token's mapping start without pulling in another expression on the line. */
function tokenRange(line: string, start: number, end: number): [number, number] {
  // Unknown/multiline syntax retains line scope and therefore remains an uncorroborated value.
  const tokens =
    /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|[\p{ID_Start}_$][\p{ID_Continue}$]*|\d+(?:\.\d+)?/gu;

  let from = start,
    to = end;

  for (const token of line.matchAll(tokens)) {
    const right = token.index + token[0].length;

    if ((token.index < end && start < right) || (start === end && token.index <= start && start < right)) {
      from = Math.min(from, token.index);
      to = Math.max(to, right);
    }
  }

  return [from, to];
}

function changedColumns(before: string, after: string) {
  let start = 0;

  while (start < Math.min(before.length, after.length) && before[start] === after[start]) start++;

  let baseEnd = before.length,
    headEnd = after.length;

  while (baseEnd > start && headEnd > start && before[baseEnd - 1] === after[headEnd - 1]) {
    baseEnd--;
    headEnd--;
  }

  return { base: tokenRange(before, start, baseEnd), head: tokenRange(after, start, headEnd) };
}

type SourceTexts = { base: string; head: string };

type PreparedSource = { lines: { base: string[]; head: string[] }; hashes: SourceTexts };

function hunkChanges(hunk: RegExpMatchArray, { lines, hashes }: PreparedSource, sourceKey: string): ScriptChange[] {
  const starts = { base: +hunk[1], head: +hunk[3] };
  const counts = { base: hunk[2] === undefined ? 1 : +hunk[2], head: hunk[4] === undefined ? 1 : +hunk[4] };

  return Array.from({ length: Math.max(counts.base, counts.head) }, (_, index) => index).flatMap((index) => {
    const columns =
      counts.base === counts.head
        ? changedColumns(lines.base[starts.base + index - 1] ?? '', lines.head[starts.head + index - 1] ?? '')
        : undefined;

    return (['base', 'head'] as const).flatMap((side) => {
      if (index >= counts[side]) return [];
      const line = starts[side] + index;
      const text = lines[side][line - 1] ?? '';
      const [start, end] = columns?.[side] ?? [0, text.length];

      return {
        sourceKey,
        side,
        range: { start: { line, column: start }, end: { line, column: end } },
        contentHash: hashes[side],
        text,
      };
    });
  });
}

export function changedScriptRanges(patch: string, texts: SourceTexts, sourceKey: string): ScriptChange[] {
  const prepared = {
    lines: { base: sourceLines(texts.base), head: sourceLines(texts.head) },
    hashes: { base: sha256(texts.base), head: sha256(texts.head) },
  };

  return [...patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].flatMap((hunk) =>
    hunkChanges(hunk, prepared, sourceKey),
  );
}

function manifestSha(dir: string, side: 'base' | 'head'): string {
  const manifest = readMapManifest(dir);

  if (!manifest || manifest.dirty || !/^[0-9a-f]{7,40}$/i.test(manifest.sha))
    throw new Error(`${side} map SHA unavailable or dirty`);

  return manifest.sha;
}

/** Recorded map SHAs, never a PR merge base. No worktree contents are used as source evidence. */
export function readScriptChanges(
  beforeDir: string,
  afterDir: string,
  options: { cwd?: string; projectRoot?: string; sourceKeys?: readonly string[] } = {},
): ScriptChanges {
  const changes: ScriptChange[] = [];
  const gaps: ScriptJoinGap[] = [];
  let base: string, head: string;

  try {
    base = manifestSha(beforeDir, 'base');
  } catch {
    gaps.push(scriptJoinGap('base map SHA unavailable or dirty; changed source ranges cannot be listed', 'base'));
  }

  try {
    head = manifestSha(afterDir, 'head');
  } catch {
    gaps.push(scriptJoinGap('head map SHA unavailable or dirty; changed source ranges cannot be listed', 'head'));
  }

  if (gaps.length) return { changes, gaps };
  const cwd = options.cwd ?? process.cwd();
  let gitDirectory = cwd;

  const git = (args: string[]): string => {
    const result = runGit(gitDirectory, args, { timeout: 10_000 });

    if (result.status !== 0)
      throw new Error('git source diff unavailable; retain both captured revisions in the checkout');

    return result.stdout;
  };

  try {
    const repository = fs.realpathSync(git(['rev-parse', '--show-toplevel']).trim());
    gitDirectory = repository;
    const project = fs.realpathSync(options.projectRoot ?? resolveScriptProjectRoot(cwd));
    const prefix = path.relative(repository, project).replaceAll('\\', '/');

    if (prefix === '..' || prefix.startsWith('../') || path.isAbsolute(prefix))
      throw new Error('project root is outside git; source keys cannot be joined');

    const paths = git(['diff', '--no-ext-diff', '--no-renames', '--name-only', '-z', base!, head!, '--'])
      .split('\0')
      .filter(Boolean)
      .sort();

    const scriptPaths = paths.filter(
      (gitPath) =>
        /\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/i.test(gitPath) ||
        options.sourceKeys?.includes(path.posix.relative(prefix || '.', gitPath)),
    );

    for (const gitPath of scriptPaths) {
      const result = changesForPath(gitPath, repository, prefix, git, { base: base!, head: head! });
      changes.push(...result.changes);
      gaps.push(...result.gaps);
    }
  } catch {
    return {
      changes: [],
      gaps: [
        scriptJoinGap(
          'git source diff unavailable; retain both captured revisions and a project root inside the checkout',
        ),
      ],
    };
  }

  return { changes: changes.sort(compareScriptRanges), gaps };
}

type GitReader = (args: string[]) => string;

function textsAtPath(gitPath: string, repository: string, git: GitReader, shas: SourceTexts) {
  const texts = { base: '', head: '' };
  const hashes = { base: sha256(''), head: sha256('') };

  for (const side of ['base', 'head'] as const) {
    if (!git(['ls-tree', '-z', shas[side], '--', `:(literal)${gitPath}`])) continue;

    const blob = spawnSync('git', ['show', `${shas[side]}:${gitPath}`], {
      cwd: repository,
      timeout: 10_000,
      maxBuffer: 1 << 28,
    });

    if (blob.status !== 0) throw new Error('git blob unavailable');
    texts[side] = blob.stdout.toString('utf8');
    hashes[side] = sha256(blob.stdout);
  }

  return { texts, hashes };
}

function changesForPath(
  gitPath: string,
  repository: string,
  prefix: string,
  git: GitReader,
  shas: SourceTexts,
): ScriptChanges {
  const sourceKey = path.posix.relative(prefix || '.', gitPath);

  const patch = git([
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--no-renames',
    '--no-color',
    '--diff-algorithm=myers',
    '--no-indent-heuristic',
    '--unified=0',
    shas.base,
    shas.head,
    '--',
    `:(literal)${gitPath}`,
  ]);

  if (!/^@@ /m.test(patch))
    return {
      changes: [],
      gaps: [scriptJoinGap(`${sourceKey}: changed script has no text hunks; execution cannot be attributed`)],
    };
  const { texts, hashes } = textsAtPath(gitPath, repository, git, shas);

  const changes = changedScriptRanges(patch, texts, sourceKey).map((change) => ({
    ...change,
    contentHash: hashes[change.side],
  }));

  return { changes, gaps: [] };
}
