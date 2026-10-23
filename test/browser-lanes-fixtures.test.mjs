import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { contentCases, createContentFixture, fileChangeCase } from './helpers/browser-lanes-fixtures.mjs';

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
