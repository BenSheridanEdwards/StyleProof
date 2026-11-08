/** One raw+patch diff and one binary-safe cat-file batch, independent of path count. */
import { spawnSync } from 'node:child_process';
import { devNull } from 'node:os';
import { compareSourceKeys } from './script-join.js';

export type ScriptGitFile = {
  path: string;
  base: string;
  head: string;
  baseMode: string;
  headMode: string;
  patch: string;
  reason?: string;
};

export type ScriptBlob = { content?: Buffer; reason?: string };

export const SCRIPT_GIT_TIMEOUT_MS = 60_000;
const gitOptions = (cwd: string) => ({ cwd, timeout: SCRIPT_GIT_TIMEOUT_MS, maxBuffer: 1 << 28 });

export function scriptGitTimedOut(error: Error | undefined): boolean {
  return Boolean(error && 'code' in error && error.code === 'ETIMEDOUT');
}

export function readScriptGitDiff(repository: string, base: string, head: string): ScriptGitFile[] {
  const result = spawnSync(
    'git',
    [
      '-c',
      'core.quotePath=true',
      'diff',
      '--raw',
      '--patch',
      '--no-abbrev',
      '--no-renames',
      '--no-ext-diff',
      '--no-textconv',
      '--no-color',
      '--submodule=short',
      '--ignore-submodules=none',
      '--diff-algorithm=myers',
      '--no-indent-heuristic',
      '--unified=0',
      '--inter-hunk-context=0',
      '--no-relative',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      '--line-prefix=',
      '--output-indicator-new=+',
      '--output-indicator-old=-',
      '--output-indicator-context= ',
      '--word-diff=none',
      '-O',
      devNull,
      '-z',
      base,
      head,
      '--',
    ],
    gitOptions(repository),
  );

  if (result.status !== 0)
    throw new Error(
      scriptGitTimedOut(result.error) ? 'git source diff timed out after 60 s' : 'git source diff unavailable',
    );
  const text = result.stdout.toString('utf8');
  const files: ScriptGitFile[] = [];
  let cursor = 0;

  while (text[cursor] === ':') {
    const headerEnd = text.indexOf('\0', cursor),
      pathEnd = text.indexOf('\0', headerEnd + 1);

    if (headerEnd < 0 || pathEnd < 0) throw new Error('git raw diff truncated');
    const [baseMode, headMode, base, head] = text.slice(cursor + 1, headerEnd).split(' ');
    files.push({ path: text.slice(headerEnd + 1, pathEnd), base, head, baseMode, headMode, patch: '' });
    cursor = pathEnd + 1;
  }

  return pairScriptPatches(files, text.slice(cursor).replace(/^\0/, '')).sort((a, b) =>
    compareSourceKeys(a.path, b.path),
  );
}

/** Match Git's C-quoted header spelling without decoding or splitting paths on spaces. */
function quotedGitPath(value: string): string {
  const escapes: Record<number, string> = {
    7: '\\a',
    8: '\\b',
    9: '\\t',
    10: '\\n',
    11: '\\v',
    12: '\\f',
    13: '\\r',
    34: '\\"',
    92: '\\\\',
  };
  let quoted = false;
  const text = [...Buffer.from(value)]
    .map((byte) => {
      if (escapes[byte]) {
        quoted = true;
        return escapes[byte];
      }
      if (byte < 32 || byte >= 127) {
        quoted = true;
        return '\\' + byte.toString(8).padStart(3, '0');
      }
      return String.fromCharCode(byte);
    })
    .join('');
  return quoted ? '"' + text + '"' : text;
}

/** Type changes have two sections for one raw path. CR in source text is never a line boundary here. */
function pairScriptPatches(files: ScriptGitFile[], patch: string): ScriptGitFile[] {
  const byHeader = new Map(
    files.map((file) => [`diff --git ${quotedGitPath('a/' + file.path)} ${quotedGitPath('b/' + file.path)}`, file]),
  );
  const sections = new Map<ScriptGitFile, string[]>();
  let current: ScriptGitFile | undefined;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = byHeader.get(line);
      if (current && !sections.has(current)) sections.set(current, []);
    }
    if (current) sections.get(current)!.push(line);
  }
  return files.map((file) =>
    sections.has(file)
      ? { ...file, patch: sections.get(file)!.join('\n') }
      : { ...file, reason: 'git patch unavailable for this changed path; source ranges unmeasured' },
  );
}

/** A missing/truncated object affects only its consumers, never already-read siblings. */
export function readScriptGitBlobs(repository: string, objectIds: string[]): Map<string, ScriptBlob> {
  const blobs = new Map<string, ScriptBlob>();

  if (!objectIds.length) return blobs;

  const result = spawnSync('git', ['cat-file', '--batch'], {
    ...gitOptions(repository),
    input: objectIds.join('\n') + '\n',
  });

  const output = result.stdout ?? Buffer.alloc(0);
  let cursor = 0;

  for (const expected of objectIds) {
    const record = blobRecordAt(output, cursor, expected);

    if (!record) break;
    blobs.set(expected, record.blob);
    cursor = record.next;
  }

  const reason = scriptGitTimedOut(result.error)
    ? 'git blob batch timed out after 60 s'
    : 'git blob batch unavailable or truncated';
  for (const oid of objectIds) if (!blobs.has(oid)) blobs.set(oid, { reason });

  return blobs;
}

type BlobRecord = { blob: ScriptBlob; next: number };

function blobRecordAt(output: Buffer, cursor: number, expected: string): BlobRecord | undefined {
  const end = output.indexOf(10, cursor);

  if (end < 0) return undefined;
  const [oid, type, sizeText] = output.subarray(cursor, end).toString('ascii').split(' ');

  if (oid !== expected) return undefined;

  if (type === 'missing') return { blob: { reason: 'git blob missing' }, next: end + 1 };
  const size = Number(sizeText);

  if (!Number.isSafeInteger(size) || size < 0 || end + 1 + size >= output.length) return undefined;
  const content = output.subarray(end + 1, end + 1 + size);

  return { blob: type === 'blob' ? { content } : { reason: 'git object is not a blob' }, next: end + size + 2 };
}
