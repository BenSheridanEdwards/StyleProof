// #1137: a timed-out surface's abandoned run must not keep acting on the shared page
// once captureSurface has given the page back (the crawl's next surface reuses it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { captureSurface } from '../dist/runner/surface-capture.js';

test('#1137 a timed-out surface does not touch the page after captureSurface settles', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-1137-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let closed = false;
  let handedBack = false;
  const lateCalls = [];

  const touch = (name) => {
    if (closed) throw new Error('Target page, context or browser has been closed');

    if (handedBack) lateCalls.push(name);
  };

  const page = Object.assign(new EventEmitter(), {
    viewportSize: () => ({ width: 1280, height: 720 }),
    async emulateMedia() {
      touch('emulateMedia');
    },
    async setViewportSize() {
      touch('setViewportSize');
    },
    async routeFromHAR() {
      touch('routeFromHAR');
    },
    async route() {
      touch('route');
    },
    async unroute() {
      touch('unroute');
    },
    async evaluate() {
      touch('evaluate');

      return undefined;
    },
    async addInitScript() {
      touch('addInitScript');
    },
    async addStyleTag() {
      touch('addStyleTag');
    },
    async waitForLoadState() {
      touch('waitForLoadState');
    },
    async waitForFunction() {
      touch('waitForFunction');
    },
    async goto() {
      touch('goto');
    },
    async close() {
      closed = true;
    },
    isClosed: () => closed,
    context: () => ({
      newCDPSession: async () => {
        touch('newCDPSession');

        return { send: async () => touch('cdp'), detach: async () => {} };
      },
    }),
    mainFrame: () => ({ url: () => 'http://example.invalid/' }),
    url: () => 'http://example.invalid/',
    clock: {
      async setFixedTime() {
        touch('setFixedTime');
      },
    },
  });

  const surface = {
    key: 'slow',
    async go(p) {
      await sleep(300); // outlives the 100ms surface budget
      await p.goto('http://example.invalid/next'); // the abandoned run keeps driving the page
    },
  };

  const settings = {
    outDir: path.join(root, 'out'),
    replayUrl: '**/api/**',
    surfaceTimeoutMs: 100,
    freezeClock: false,
  };

  fs.mkdirSync(settings.outDir);
  await assert.rejects(captureSurface(page, surface, 1280, settings, { index: 1, total: 2 }), /timed out/);
  handedBack = true; // the crawl now starts the next surface on this page
  await sleep(600);
  assert.deepEqual(lateCalls, [], 'the abandoned run acted on the page the next surface is using');
});
