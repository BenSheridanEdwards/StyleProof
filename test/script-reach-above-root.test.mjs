import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { trackScriptReach } from '../dist/capture/script-reach.js';
import { scriptReachFixture } from './script-reach-fixture.mjs';

async function capture(sources, sourcesContent, mapUrl = 'https://app.test/app.js.map') {
  const fixture = scriptReachFixture({
    maps: [{ version: 3, sources, sourcesContent, mappings: 'AAAA' }],
    mapUrl,
  });
  const tracker = await trackScriptReach(fixture.page);
  try {
    fixture.navigate();
    return (await tracker.stop()).scripts[0];
  } finally {
    await tracker.dispose();
  }
}

for (const [source, mapUrl] of [
  ['../src/app.ts', 'https://app.test/app.js.map'],
  ['../../src/app.ts', 'https://app.test/assets/app.js.map'],
]) {
  test(`relative above-root source with embedded content maps: ${source}`, async () => {
    const script = await capture([source], ['x'], mapUrl);
    assert.equal(script.status, 'mapped');
    assert.equal(script.files[0].sourceKey, 'src/app.ts');
    assert.equal(script.files[0].contentHash, createHash('sha256').update('x').digest('hex'));
    assert.ok(script.files[0].executed.length > 0);
  });
}

for (const content of [undefined, [null], []]) {
  test(`relative above-root source without its own content stays unknown: ${JSON.stringify(content)}`, async () => {
    const script = await capture(['../src/app.ts'], content);
    assert.equal(script.status, 'unknown');
    assert.match(script.reason, /source path escapes URL root/);
  });
}

test('clipped source keys still collide within a map', async () => {
  const script = await capture(['../src/app.ts', '../../src/app.ts'], ['x', 'x']);
  assert.equal(script.status, 'unknown');
  assert.equal(script.reason, 'source key collision');
});

for (const source of ['webpack://_N_E/../shared/x.ts', 'webpack:///../home/Home.tsx', 'custom:///../src/app.ts']) {
  test(`scheme-prefixed traversal with embedded content stays unknown: ${source}`, async () => {
    const script = await capture([source], ['x']);
    assert.equal(script.status, 'unknown');
    assert.match(script.reason, /source path escapes URL root/);
  });
}
