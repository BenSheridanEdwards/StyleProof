import assert from 'node:assert/strict';
import { isUtf8 } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('every tracked proof text file is free of machine paths, including logs and Markdown code spans', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const files = execFileSync('git', ['ls-files', '-z', '--', 'docs/proof'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
  assert.ok(
    files.some((file) => file.endsWith('.log')),
    'proof logs must participate',
  );
  const machinePath =
    /(?:^|[\s`"'(=])(?:\/(?:Users|private|home|var|tmp|opt|Volumes|Applications|Library|usr)\/|~[/\\]|[A-Za-z]:\\Users\\)|\bfile:\/\/\//m;
  const findings = [];
  for (const file of files) {
    const bytes = fs.readFileSync(path.join(root, file));
    if (!isUtf8(bytes) || bytes.includes(0)) continue;
    for (const [line, text] of bytes.toString('utf8').split('\n').entries()) {
      if (machinePath.test(text)) findings.push(`${file}:${line + 1}`);
    }
  }
  assert.deepEqual(findings, [], 'proof must use repository-relative paths or portable artifact names');
});
