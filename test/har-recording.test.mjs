import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordLoadHar } from '../dist/runner/har-recording.js';

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-har-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let handler;
  const file = path.join(directory, 'load.har');

  const stop = await recordLoadHar(
    {
      route: async (_, callback) => {
        handler = callback;
      },
      unroute: async (_, callback) => {
        assert.equal(callback, handler);
      },
    },
    '**/api/**',
    file,
  );

  const route = {
    request: () => ({
      url: () => 'https://app.test/api/load',
      method: () => 'POST',
      headersArray: async () => [],
      headers: () => ({}),
      postDataBuffer: () => Buffer.from([0, 255]),
    }),
    fetch: async (options) => {
      assert.deepEqual(options, { maxRedirects: 0 });

      return {
        body: async () => Buffer.from('ok'),
        status: () => 200,
        headersArray: () => [],
        dispose: async () => {},
      };
    },
    fulfill: async () => {},
    abort: async () => {},
  };

  return {
    file,
    stop,
    route,
    run: () => handler(route),
    entries: () => JSON.parse(fs.readFileSync(file, 'utf8')).log.entries,
  };
}

for (const abortFails of [false, true])
  test(`failed fetch is omitted; abort failure=${abortFails}`, async (t) => {
    const f = await fixture(t);
    let aborted = false;
    f.route.fetch = async () => {
      throw new Error('connection reset');
    };

    f.route.abort = async () => {
      aborted = true;

      if (abortFails) throw new Error('Target closed');
    };

    await f.run();
    await f.stop();
    assert.equal(aborted, true);
    assert.deepEqual(f.entries(), []);
  });

test('cancelled fulfill keeps the entry without failing capture', async (t) => {
  const f = await fixture(t);
  f.route.fulfill = async () => {
    throw new Error('Route is already handled');
  };

  await f.run();
  await f.stop();
  assert.equal(f.entries().length, 1);
  assert.deepEqual(Buffer.from(f.entries()[0].request.postData.text, 'base64'), Buffer.from([0, 255]));
  await f.stop();
});

test('stop bounds a slow fetch and late completion still fulfills without changing HAR', async (t) => {
  const f = await fixture(t);
  let release;
  let fulfilled = false;
  const fetch = f.route.fetch;
  f.route.fetch = async (options) => {
    await new Promise((resolve) => {
      release = resolve;
    });

    return fetch(options);
  };

  f.route.fulfill = async () => {
    fulfilled = true;
  };

  const work = f.run();

  const finished = await Promise.race([
    f.stop().then(() => true),
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 4_000);
      t.after(() => clearTimeout(timer));
    }),
  ]);

  const before = fs.existsSync(f.file) ? fs.readFileSync(f.file, 'utf8') : undefined;
  release();
  await work;
  await f.stop();
  assert.equal(finished, true);
  assert.deepEqual(JSON.parse(before).log.entries, []);
  assert.equal(fulfilled, true);
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
});
