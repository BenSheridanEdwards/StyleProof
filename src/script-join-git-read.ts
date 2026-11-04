/** One raw+patch diff and one binary-safe cat-file batch, independent of path count. */
import { spawnSync } from 'node:child_process';

export type ScriptGitFile = {
  path: string;
  base: string;
  head: string;
  baseMode: string;
  headMode: string;
  patch: string;
};

export type ScriptBlob = { content?: Buffer; reason?: string };

const gitOptions = (cwd: string) => ({ cwd, timeout: 10_000, maxBuffer: 1 << 28 });

export function readScriptGitDiff(repository: string, base: string, head: string): ScriptGitFile[] {
  const result = spawnSync(
    'git',
    [
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
      '-z',
      base,
      head,
      '--',
    ],
    gitOptions(repository),
  );

  if (result.status !== 0) throw new Error('git source diff unavailable');
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

  const patches = text
    .slice(cursor)
    .replace(/^\0/, '')
    .split(/(?=^diff --git )/m)
    .filter(Boolean);

  if (patches.length !== files.length) throw new Error('git patch paths cannot be paired with raw records');

  return files.map((file, index) => ({ ...file, patch: patches[index] }));
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

  for (const oid of objectIds)
    if (!blobs.has(oid)) blobs.set(oid, { reason: 'git blob batch unavailable or truncated' });

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
