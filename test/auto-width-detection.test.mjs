import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { captureSurface, detectSurfaceWidths } from '../dist/runner/surface-capture.js';

const VIEWPORT = { width: 1280, height: 720 };
const REPLAY_URL = '**/api/**';

function fixture(t, { recordings = [], replay = true, viewport = { width: 720, height: 800 } } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-auto-width-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outDir = path.join(root, 'head');
  const replayFrom = path.join(root, 'base');
  fs.mkdirSync(outDir);
  fs.mkdirSync(replayFrom);
  for (const name of recordings) fs.writeFileSync(path.join(replayFrom, name), '{}');
  const calls = [];
  const warnings = t.mock.method(console, 'warn', () => {});
  const page = Object.assign(new EventEmitter(), {
    viewportSize: () => viewport,
    async emulateMedia(options) {
      calls.push(['emulateMedia', options]);
    },
    async setViewportSize(size) {
      viewport = size;
      calls.push(['setViewportSize', size]);
    },
    async routeFromHAR(file, options) {
      calls.push(['routeFromHAR', file, options]);
    },
    async route(url) {
      calls.push(['route', url]);
    },
    async unroute(url) {
      calls.push(['unroute', url]);
    },
    clock: {
      async setFixedTime(time) {
        calls.push(['setFixedTime', time]);
      },
    },
    async evaluate() {
      calls.push(['evaluate']);
      // The review's head-only band mounts only above the base's widest (720px) capture.
      return {
        mediaTexts: ['(min-width: 720px)', ...(viewport?.width >= 1000 ? ['(min-width: 1100px)'] : [])],
        unreadable: [],
      };
    },
  });
  const surface = {
    key: 'widget',
    async go() {
      calls.push(['go']);
    },
  };
  const settings = {
    outDir,
    replayFrom: replay ? replayFrom : undefined,
    replayUrl: REPLAY_URL,
    freezeClock: true,
    clockTime: 0,
    surfaceTimeoutMs: 1000,
  };
  return { page, surface, settings, calls, warnings };
}

test('replay detects a head-only band at the fixed viewport using its own recording', async (t) => {
  const { page, surface, settings, calls } = fixture(t, {
    recordings: ['widget@auto-1280x720.har', 'widget@720.har', 'widget@360.har'],
  });
  assert.deepEqual(await detectSurfaceWidths(page, surface, settings, VIEWPORT), [360, 720, 1100]);
  assert.deepEqual(calls, [
    ['emulateMedia', { reducedMotion: 'reduce' }],
    ['setViewportSize', VIEWPORT],
    ['unroute', REPLAY_URL],
    [
      'routeFromHAR',
      path.join(settings.replayFrom, 'widget@auto-1280x720.har'),
      { url: REPLAY_URL, update: false, notFound: 'abort' },
    ],
    ['route', REPLAY_URL],
    ['setFixedTime', new Date(0)],
    ['go'],
    ['evaluate'],
    ['unroute', REPLAY_URL],
  ]);
});

test('missing or mismatched detection recordings warn and detect live without narrowing', async (t) => {
  for (const recordings of [
    ['widget@720.har', 'widget@360.har'],
    ['widget@auto-1280x800.har', 'widget@auto-720x720.har'],
  ]) {
    const { page, surface, settings, calls, warnings } = fixture(t, { recordings });
    assert.deepEqual(await detectSurfaceWidths(page, surface, settings, VIEWPORT), [360, 720, 1100]);
    assert.deepEqual(
      calls.filter(([name]) => name === 'setViewportSize'),
      [['setViewportSize', VIEWPORT]],
    );
    assert.equal(
      calls.some(([name]) => name === 'routeFromHAR'),
      false,
    );
    assert.ok(calls.findIndex(([name]) => name === 'unroute') < calls.findIndex(([name]) => name === 'go'));
    assert.deepEqual(calls.at(-1), ['unroute', REPLAY_URL]);
    assert.match(warnings.mock.calls.at(-1).arguments[0], /no replay HAR.*widget@auto-1280x720.har.*NON-deterministic/);
  }
});

test('record mode pins the detection load at the fixed viewport', async (t) => {
  const { page, surface, settings, calls } = fixture(t, { replay: false });
  assert.deepEqual(await detectSurfaceWidths(page, surface, settings, VIEWPORT), [360, 720, 1100]);
  assert.deepEqual(
    calls.find(([name]) => name === 'routeFromHAR'),
    [
      'routeFromHAR',
      path.join(settings.outDir, 'widget@auto-1280x720.har'),
      { url: REPLAY_URL, update: true, updateContent: 'embed' },
    ],
  );
  assert.ok(calls.findIndex(([name]) => name === 'setFixedTime') < calls.findIndex(([name]) => name === 'go'));
  assert.deepEqual(calls.at(-1), ['unroute', REPLAY_URL]);
});

test('the default detection viewport is the fresh page viewport', async (t) => {
  const { page, surface, settings, calls } = fixture(t, { replay: false, viewport: VIEWPORT });
  await detectSurfaceWidths(page, surface, settings);
  assert.deepEqual(
    calls.find(([name]) => name === 'setViewportSize'),
    ['setViewportSize', VIEWPORT],
  );
  assert.equal(
    calls.find(([name]) => name === 'routeFromHAR')[1],
    path.join(settings.outDir, 'widget@auto-1280x720.har'),
  );
});

test('null viewport uses the auto HAR without resizing', async (t) => {
  const { page, surface, settings, calls } = fixture(t, { recordings: ['widget@auto.har'], viewport: null });
  await detectSurfaceWidths(page, surface, settings, null);
  assert.equal(
    calls.some(([name]) => name === 'setViewportSize'),
    false,
  );
  assert.equal(calls.find(([name]) => name === 'routeFromHAR')[1], path.join(settings.replayFrom, 'widget@auto.har'));
  assert.deepEqual(calls.at(-1), ['unroute', REPLAY_URL]);
});

test('a null detection viewport fails explicitly after an earlier capture resized the page', async (t) => {
  const { page, surface, settings, calls } = fixture(t, { recordings: ['widget@auto.har'], viewport: null });
  await page.setViewportSize({ width: 720, height: 800 });
  await assert.rejects(
    detectSurfaceWidths(page, surface, settings, null),
    /cannot restore the original null viewport.*Configure a project viewport or explicit surface widths/,
  );
  assert.equal(
    calls.some(([name]) => name === 'go' || name === 'routeFromHAR'),
    false,
  );
});

test('input, navigation and detection errors propagate after clearing replay routes', async (t) => {
  for (const phase of ['routeFromHAR', 'go', 'evaluate']) {
    const { page, surface, settings, calls } = fixture(t, { recordings: ['widget@auto-1280x720.har'] });
    const failure = new Error(`${phase} failed`);
    (phase === 'go' ? surface : page)[phase] = async () => {
      throw failure;
    };
    await assert.rejects(detectSurfaceWidths(page, surface, settings, VIEWPORT), (error) => error === failure);
    assert.deepEqual(calls.at(-1), ['unroute', REPLAY_URL]);
    assert.equal(calls.filter(([name]) => name === 'unroute').length, 2);
    assert.deepEqual(page.eventNames(), []);
  }
});

const dataRequest = (url) => ({
  url: () => url,
  resourceType: () => 'fetch',
  isNavigationRequest: () => false,
  failure: () => ({ errorText: 'net::ERR_FAILED' }),
});

test('failed detection data cannot hide a head-only band even when navigation resolves', async (t) => {
  for (const replay of [false, true]) {
    for (const failure of ['abort', 'HTTP 503']) {
      const { page, surface, settings, calls } = fixture(t, {
        replay,
        recordings: ['widget@auto-1280x720.har'],
      });
      surface.go = async () => {
        const request = dataRequest('https://app.test/api/head-band?private=value');
        page.emit('request', request);
        if (failure === 'abort') page.emit('requestfailed', request);
        else page.emit('response', { request: () => request, status: () => 503 });
        // The app catches the fetch failure and never mounts its new 1100px band.
      };
      page.evaluate = async () => ({ mediaTexts: ['(min-width: 720px)'], unreadable: [] });
      await assert.rejects(detectSurfaceWidths(page, surface, settings, VIEWPORT), (error) => {
        assert.match(error.message, /cannot detect breakpoints for 'widget'.*\/api\/head-band/);
        assert.ok(error.message.includes(failure === 'abort' ? 'net::ERR_FAILED' : failure));
        assert.equal(error.message.includes('private=value'), false);
        return true;
      });
      assert.deepEqual(calls.at(-1), ['unroute', REPLAY_URL]);
      assert.deepEqual(page.eventNames(), []);
    }
  }
});

test('successful detection data keeps all bands and disposes the watcher', async (t) => {
  const { page, surface, settings } = fixture(t, { recordings: ['widget@auto-1280x720.har'] });
  surface.go = async () => {
    const request = dataRequest('https://app.test/api/head-band');
    page.emit('request', request);
    page.emit('response', { request: () => request, status: () => 200 });
  };
  assert.deepEqual(await detectSurfaceWidths(page, surface, settings, VIEWPORT), [360, 720, 1100]);
  assert.deepEqual(page.eventNames(), []);
});

test('detection uses the configured baseURL to match relative replay URLs', async (t) => {
  const { page, surface, settings } = fixture(t, { recordings: ['widget@auto-1280x720.har'] });
  settings.replayUrl = '/api/**';
  let origin = 'https://unrelated.test';
  surface.go = async () => {
    const request = dataRequest(`${origin}/api/head-band`);
    page.emit('request', request);
    page.emit('requestfailed', request);
  };
  assert.deepEqual(await detectSurfaceWidths(page, surface, settings, VIEWPORT, 'https://app.test'), [360, 720, 1100]);
  origin = 'https://app.test';
  await assert.rejects(
    detectSurfaceWidths(page, surface, settings, VIEWPORT, 'https://app.test'),
    /data requests failed during detection: \/api\/head-band \(net::ERR_FAILED\)\. Failed data/,
  );
  assert.deepEqual(page.eventNames(), []);
});

test('a navigation failure stays original when detection also observed a failed request', async (t) => {
  const { page, surface, settings, calls } = fixture(t, { recordings: ['widget@auto-1280x720.har'] });
  const failure = new Error('surface navigation failed');
  surface.go = async () => {
    const request = dataRequest('https://app.test/api/head-band');
    page.emit('request', request);
    page.emit('requestfailed', request);
    throw failure;
  };
  await assert.rejects(detectSurfaceWidths(page, surface, settings, VIEWPORT), (error) => error === failure);
  assert.deepEqual(calls.at(-1), ['unroute', REPLAY_URL]);
  assert.deepEqual(page.eventNames(), []);
});

test('a new width without a HAR clears the previous width replay before its live load', async (t) => {
  const { page, surface, settings, calls, warnings } = fixture(t, { recordings: ['widget@720.har'] });
  const stopAtLoad = new Error('stop after observing the navigation inputs');
  surface.go = async () => {
    calls.push(['go']);
    throw stopAtLoad;
  };
  // Exercise two captures on the shared auto-width page, with a missing HAR only for the second.
  for (const width of [720, 1100]) {
    await assert.rejects(
      captureSurface(page, surface, width, settings, { index: 1, total: 1 }),
      (error) => error === stopAtLoad,
    );
  }
  const firstLoad = calls.findIndex(([name]) => name === 'go');
  const secondLoad = calls.findLastIndex(([name]) => name === 'go');
  const cleanup = calls.findIndex(([name]) => name === 'unroute');
  assert.ok(cleanup > firstLoad && cleanup < secondLoad, 'the old HAR route must not intercept the new width');
  assert.match(warnings.mock.calls.at(-1).arguments[0], /widget@1100.har.*NON-deterministic/);
});
