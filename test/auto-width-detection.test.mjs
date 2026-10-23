import { test } from 'node:test';
import assert from 'node:assert/strict';
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
  const page = {
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
    on() {},
    off() {},
  };
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

test('navigation and detection errors propagate after clearing replay routes', async (t) => {
  for (const phase of ['go', 'evaluate']) {
    const { page, surface, settings, calls } = fixture(t, { recordings: ['widget@auto-1280x720.har'] });
    const failure = new Error(`${phase} failed`);
    (phase === 'go' ? surface : page)[phase] = async () => {
      throw failure;
    };
    await assert.rejects(detectSurfaceWidths(page, surface, settings, VIEWPORT), (error) => error === failure);
    assert.deepEqual(calls.at(-1), ['unroute', REPLAY_URL]);
  }
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
