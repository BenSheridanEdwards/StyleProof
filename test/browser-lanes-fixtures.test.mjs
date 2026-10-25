import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  contentCases,
  createContentFixture,
  fileChangeCase,
  trackedBrowserCases,
} from './helpers/browser-lanes-fixtures.mjs';

function mockTrackedInputs(t, files, untracked = []) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const entries = new Map([
    ['test/helpers.mjs', ''],
    ['test/phase1-foundation-harness-lib.ts', ''],
    ['bench/detection-rate.mjs', ''],
    ...Object.entries(files),
  ]);
  t.mock.method(childProcess, 'spawnSync', (command, args) => {
    assert.equal(command, 'git');
    assert.deepEqual(args, ['ls-files', '-z']);
    return { status: 0, stdout: [...entries.keys()].filter((name) => !untracked.includes(name)).join('\0') };
  });
  t.mock.method(fs, 'existsSync', (file) => entries.has(path.relative(root, file)));
  t.mock.method(fs, 'readFileSync', (file, encoding) => {
    const name = path.relative(root, file);
    assert.ok(entries.has(name), `fixture contains ${name}`);
    return encoding ? entries.get(name) : Buffer.from(entries.get(name));
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
}

test('tracked browser imports use source files without a built dist', (t) => {
  mockTrackedInputs(t, {
    'test/tracked.e2e.spec.ts': [
      "import { capture } from '../dist/index.js';",
      "import { runner } from '../dist/runner/capture.js';",
      "import { shared } from '../dist/report/shared.js';",
      "import { support } from './support.js';",
    ].join('\n'),
    'src/index.ts': 'export const capture = 1;',
    'src/runner/capture.ts': 'export const runner = 2;',
    'src/report/shared.ts': 'export const shared = 3;',
    'test/support.ts': 'export const support = 4;',
  });
  const { imports } = trackedBrowserCases();
  assert.deepEqual(
    imports.map(({ name }) => name),
    ['src/index.ts', 'src/report/shared.ts', 'src/runner/capture.ts', 'test/support.ts'],
  );
  assert.equal(imports[0].before.toString(), 'export const capture = 1;');
});

test('tracked browser imports reject existing files that are not tracked', (t) => {
  mockTrackedInputs(
    t,
    {
      'test/tracked.e2e.spec.ts': "import { ignored } from './ignored.mjs';",
      'test/ignored.mjs': 'export const ignored = true;',
    },
    ['test/ignored.mjs'],
  );
  assert.throws(() => trackedBrowserCases(), /test\/tracked\.e2e\.spec\.ts imports tracked test\/ignored\.mjs/);
});

test('prepared content fixtures keep independent objects, refs, config and index', (t) => {
  const first = createContentFixture(t, contentCases[0]);
  const second = createContentFixture(t, contentCases[0]);
  assert.equal(first.baseTree, second.baseTree);
  assert.equal(first.headTree, second.headTree);
  first.setEntry('isolated.css', '100644', 'body { color: green }');
  first.git(['config', 'user.name', 'Changed fixture']);
  first.git(['update-ref', 'refs/heads/fixture-head', first.base]);
  assert.notEqual(first.git(['write-tree']), first.headTree);
  assert.equal(second.git(['write-tree']), second.headTree);
  assert.equal(second.git(['config', 'user.name']), 'Tree fixture');
  assert.equal(second.git(['rev-parse', 'fixture-head']), second.head);
  assert.equal(fs.existsSync(path.join(second.directory, '.git/objects/info/alternates')), false);
  const pack = fs.readdirSync(path.join(first.directory, '.git/objects/pack')).find((file) => file.endsWith('.pack'));
  assert.ok(pack, 'prepared objects were written by fast-import');
  // A write through a hardlink would corrupt the other fixture's object store.
  fs.chmodSync(path.join(first.directory, '.git/objects/pack', pack), 0o644);
  fs.writeFileSync(path.join(first.directory, '.git/objects/pack', pack), 'invalid pack');
  assert.equal(second.git(['rev-parse', `${second.head}^{tree}`]), second.headTree);
  const third = createContentFixture(t, contentCases[0]);
  assert.equal(third.headTree, second.headTree);
  assert.equal(third.git(['config', 'user.name']), 'Tree fixture');
  assert.equal(third.git(['write-tree']), third.headTree);
});

test('unprepared content rows construct their own objects and real merge', (t) => {
  const row = fileChangeCase('uncached', 'new/unprepared-fixture.css');
  const fixture = createContentFixture(t, row);
  assert.notEqual(fixture.baseTree, fixture.headTree);
  assert.equal(fixture.git(['show', `${fixture.base}:${row.name}`]), row.before.trim());
  assert.equal(fixture.git(['show', `${fixture.head}:${row.name}`]), row.after.trim());
  assert.equal(fixture.git(['rev-parse', 'HEAD^{tree}']), fixture.headTree);
  const parents = fixture.git(['show', '-s', '--format=%P', 'HEAD']).split(' ');
  assert.deepEqual(parents, [fixture.base, fixture.head]);
});
