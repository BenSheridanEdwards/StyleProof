import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { trackScriptReach } from '../dist/capture/script-reach.js';
import { scriptReachFixture } from './script-reach-fixture.mjs';
import { readSiblingMap, MapReadTimeout } from '../dist/capture/script-map-resources.js';
import { MAX_MAP_BYTES } from '../dist/script-reach-limits.js';

const map = {
  version: 3,
  file: '0.js',
  sources: ['src/a.js'],
  sourcesContent: ['x'],
  mappings: 'AAAA',
};

async function capture(options) {
  const f = scriptReachFixture(options);
  const tracker = await trackScriptReach(f.page);
  f.navigate();
  return { ...f, evidence: await tracker.stop() };
}

test('a hidden sibling map is measured without a directive', async () => {
  const { evidence } = await capture({ mapUrl: '', maps: [map] });
  assert.equal(evidence.scripts[0].status, 'mapped');
});

test('HAR routing with no sibling entry stays source map absent', async () => {
  const { evidence, calls } = await capture({ mapUrl: '', har: true, blocked: true });
  assert.equal(evidence.scripts[0].status, 'unmeasured');
  assert.equal(evidence.scripts[0].reason, 'source map absent');
  assert.equal(
    calls.some(([name]) => name === 'Network.loadNetworkResource'),
    false,
  );
});

test('a file page reads a sibling map from disk', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sibling-map-'));
  try {
    const script = join(directory, '0.js');
    await writeFile(script, 'x');
    await writeFile(join(directory, '0.js.map'), JSON.stringify(map));
    const url = pathToFileURL(script).href;
    const f = scriptReachFixture({
      entries: [
        {
          scriptId: '0',
          url,
          functions: [{ isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: 1, count: 1 }] }],
        },
      ],
      mapUrl: '',
    });
    const tracker = await trackScriptReach(f.page, { projectRoot: directory });
    f.navigate();
    const evidence = await tracker.stop();
    assert.equal(evidence.scripts[0].status, 'mapped');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('an already spent map-read budget does not start a sibling probe', async () => {
  const f = scriptReachFixture({ mapUrl: '' });
  let probed = false;
  const original = f.client.send;
  f.client.send = async (method, args) => {
    if (method === 'Network.loadNetworkResource') probed = true;
    return original(method, args);
  };
  await assert.rejects(readSiblingMap(f.page, f.client, 'https://app.test/0.js', performance.now() - 1), (error) => {
    assert.ok(error instanceof MapReadTimeout);
    assert.match(error.message, /budget exhausted/);
    return true;
  });
  assert.equal(probed, false);
});

test('an oversized sibling map stays a size-limit failure, not absence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sibling-map-size-'));
  try {
    const script = join(directory, '0.js');
    await writeFile(script, 'x');
    await writeFile(join(directory, '0.js.map'), ' '.repeat(MAX_MAP_BYTES + 1));
    const url = pathToFileURL(script).href;
    const { evidence } = await capture({
      entries: [
        {
          scriptId: '0',
          url,
          functions: [{ isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: 1, count: 1 }] }],
        },
      ],
      mapUrl: '',
    });
    assert.equal(evidence.scripts[0].status, 'unknown');
    assert.match(evidence.scripts[0].reason, /size limit/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a document URL does not start a sibling probe', async () => {
  const f = scriptReachFixture({ mapUrl: '' });
  let probed;
  const original = f.client.send;
  f.client.send = async (method, args) => {
    if (method === 'Network.loadNetworkResource') probed = true;
    return original(method, args);
  };
  for (const scriptUrl of ['https://app.test/', 'https://app.test/index.html', 'https://app.test/page.htm']) {
    probed = false;
    assert.equal(await readSiblingMap(f.page, f.client, scriptUrl, performance.now() + 1_000), undefined);
    assert.equal(probed, false, scriptUrl);
  }
});
