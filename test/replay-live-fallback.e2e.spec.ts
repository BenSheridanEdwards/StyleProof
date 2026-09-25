import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadStyleMap } from '../dist/capture.js';
import { withCaptureDeterminism } from '../dist/confidence-ledger.js';
import { auditDeterminism } from '../dist/coverage.js';
import { captureSurface } from '../dist/runner/surface-capture.js';
import { resolveSettings } from '../dist/runner/settings.js';

// Replay requested (selfCheck off) but no HAR recorded for the surface: the capture falls back
// to the live backend. The ledger is written from settings ("replayed"), so the map must carry
// the per-surface reality or the gate reads a live capture as replay-proven.
const surface = {
  key: 'home',
  go: (page: import('@playwright/test').Page) =>
    page.setContent('<!doctype html><html><body><main style="color: rgb(0, 0, 0)">home</main></body></html>'),
};

test('a live fallback under replay is stamped on the map and never proven by a replayed ledger', async ({ page }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-replay-live-'));
  try {
    const outDir = path.join(root, 'out');
    const replayFrom = path.join(root, 'baseline'); // holds no HAR for home@400
    fs.mkdirSync(replayFrom);
    const settings = resolveSettings({
      dir: outDir,
      replayFrom,
      selfCheck: false,
      screenshots: false,
      freezeClock: false,
    });
    await captureSurface(page, surface, 400, settings, { index: 1, total: 1 });

    const map = loadStyleMap(path.join(outDir, 'home@400.json.gz'));
    expect(map.metadata?.inputs).toBe('live');

    const replayedLedger = { version: 1 as const, expected: ['home'], exclude: {}, determinism: 'replayed' as const };
    const head = withCaptureDeterminism(outDir, replayedLedger);
    expect(head?.determinism).toBe('unproven');
    expect(auditDeterminism(replayedLedger, head).status).toBe('unproven');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a pinned (recorded) capture carries no live stamp', async ({ page }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-replay-pinned-'));
  try {
    const outDir = path.join(root, 'out');
    const settings = resolveSettings({ dir: outDir, selfCheck: false, screenshots: false, freezeClock: false });
    await captureSurface(page, surface, 400, settings, { index: 1, total: 1 });
    expect(loadStyleMap(path.join(outDir, 'home@400.json.gz')).metadata?.inputs).toBeUndefined();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
