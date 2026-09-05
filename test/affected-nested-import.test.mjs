import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkTmp, rmTmp } from './helpers.mjs';

const AFFECTED = fileURLToPath(new URL('../bin/styleproof-affected.mjs', import.meta.url));

test('styleproof-affected: nested computed imports include modules and scoped dependency changes', () => {
  const dir = mkTmp('styleproof-nested-import-');
  const sources = {
    'pages/Dynamic.tsx': 'import(`../components/${name}`)',
    'pages/Static.tsx': 'import "../components/nested/Card"; import "../components-extra/Other";',
    'components/nested/Card.tsx': 'import "./Card.module.css";',
    'components/nested/Card.module.css': '.card { color: red; }',
    'components-extra/Other.tsx': 'export default 1;',
  };
  const dependencies = {
    'pages/Static.tsx': ['components/nested/Card.tsx', 'components-extra/Other.tsx'],
    'components/nested/Card.tsx': ['components/nested/Card.module.css'],
  };
  try {
    for (const [file, text] of Object.entries(sources)) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), text);
    }
    fs.writeFileSync(
      path.join(dir, 'graph.json'),
      JSON.stringify({
        modules: Object.keys(sources).map((source) => ({
          source,
          dependencies: (dependencies[source] ?? []).map((resolved) => ({ resolved })),
        })),
      }),
    );
    for (const [changed, recapture, reuse] of [
      ['components/nested/Card.tsx', ['dynamic', 'static'], []],
      ['components/nested/Card.module.css', ['dynamic', 'static'], []],
      ['components-extra/Other.tsx', ['static'], ['dynamic']],
    ]) {
      const res = spawnSync(
        process.execPath,
        [
          AFFECTED,
          '--graph',
          'graph.json',
          '--surface',
          'dynamic=pages/Dynamic.tsx',
          '--surface',
          'static=pages/Static.tsx',
          '--changed',
          changed,
          '--json',
        ],
        { cwd: dir, encoding: 'utf8' },
      );
      assert.equal(res.status, 0, res.stderr);
      const verdict = JSON.parse(res.stdout);
      assert.deepEqual(verdict.recapture, recapture, changed);
      assert.deepEqual(verdict.reuse, reuse, changed);
      for (const key of recapture) assert.ok(res.stderr.includes(`↻ ${key} (re-capture`), res.stderr);
      for (const key of reuse) assert.ok(res.stderr.includes(`✓ ${key} (reuse base map`), res.stderr);
    }
  } finally {
    rmTmp(dir);
  }
});
