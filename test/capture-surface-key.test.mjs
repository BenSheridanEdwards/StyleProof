import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  captureKeyFromMapFile,
  surfaceKeyByCaptureKey,
  mergeSurfaceKeyLookup,
  surfaceElementPaths,
} from '../dist/capture.js';
import { countCapturedSurfaceBases } from '../dist/change-groups.js';
import { generateStyleMapReport } from '../dist/report.js';
import { MAP_MANIFEST } from '../dist/map-store.js';
import { makeMap, mkTmp, rmTmp, writeCapture, solidPng } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIFF = path.join(here, '..', 'bin', 'styleproof-diff.mjs');

function writeManifest(dir, sha, compatibilityKey) {
  fs.writeFileSync(
    path.join(dir, MAP_MANIFEST),
    JSON.stringify(
      {
        version: 1,
        packageVersion: 'test',
        sha,
        dirty: false,
        spec: 'e2e/styleproof.spec.ts',
        specHash: 'test',
        platform: process.platform,
        arch: process.arch,
        nodeMajor: process.versions.node.split('.')[0],
        screenshots: true,
        har: false,
        compatibilityKey,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      null,
      2,
    ),
  );
}

test('captureKeyFromMapFile strips .json and .json.gz suffixes', () => {
  assert.equal(captureKeyFromMapFile('home@1280.json.gz'), 'home@1280');
  assert.equal(captureKeyFromMapFile('dashboard-loaded@375.json'), 'dashboard-loaded@375');
});

test('surfaceKeyByCaptureKey reads metadata.surfaceKey per map file', () => {
  const root = mkTmp();
  const dir = path.join(root, 'maps');
  try {
    writeCapture(dir, 'alpha@1280', { ...makeMap({}), metadata: { surfaceKey: 'alpha-product' } }, null);
    writeCapture(dir, 'beta@1280', makeMap({}), null);
    const map = surfaceKeyByCaptureKey(dir);
    assert.equal(map.get('alpha@1280'), 'alpha-product');
    assert.equal(map.get('beta@1280'), undefined);
  } finally {
    rmTmp(root);
  }
});

test('mergeSurfaceKeyLookup: later dir wins on conflicting defined surfaceKey', () => {
  const root = mkTmp();
  const beforeDir = path.join(root, 'before');
  const afterDir = path.join(root, 'after');
  try {
    const body = makeMap({
      elements: { body: { tag: 'body', rect: [0, 0, 100, 100], style: {} } },
    });
    writeCapture(beforeDir, 'dashboard@1280', { ...body, metadata: { surfaceKey: 'before-base' } }, null);
    writeCapture(afterDir, 'dashboard@1280', { ...body, metadata: { surfaceKey: 'after-base' } }, null);
    const lookup = mergeSurfaceKeyLookup(beforeDir, afterDir);
    assert.equal(lookup('dashboard@1280'), 'after-base');
  } finally {
    rmTmp(root);
  }
});

test('mergeSurfaceKeyLookup: missing head surfaceKey falls back to base metadata', () => {
  const root = mkTmp();
  const beforeDir = path.join(root, 'before');
  const afterDir = path.join(root, 'after');
  try {
    const body = makeMap({
      elements: { body: { tag: 'body', rect: [0, 0, 100, 100], style: {} } },
    });
    writeCapture(beforeDir, 'dashboard@1280', { ...body, metadata: { surfaceKey: 'from-base' } }, null);
    writeCapture(afterDir, 'dashboard@1280', body, null);
    const lookup = mergeSurfaceKeyLookup(beforeDir, afterDir);
    assert.equal(lookup('dashboard@1280'), 'from-base');
  } finally {
    rmTmp(root);
  }
});

test('report and diff CLI agree on captured surface base count when metadata.surfaceKey conflicts', () => {
  const root = mkTmp();
  const beforeDir = path.join(root, 'before');
  const afterDir = path.join(root, 'after');
  const outDir = path.join(root, 'out');
  try {
    const nav = (color) => ({
      'html > body > nav': { tag: 'nav', cls: 'rail', style: { display: 'flex' } },
      'html > body > nav > a:nth-child(1)': { tag: 'a', cls: 'link', style: { color } },
    });
    const views = ['home', 'settings', 'reports'];
    for (const v of views) {
      writeCapture(beforeDir, `${v}@1280`, makeMap({ elements: nav('rgb(0, 0, 0)') }), null);
      writeCapture(afterDir, `${v}@1280`, makeMap({ elements: nav('rgb(255, 0, 0)') }), null);
    }
    const dashBody = makeMap({
      elements: {
        body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} },
        'body > button:nth-child(1)': { tag: 'button', style: { color: 'rgb(0, 0, 0)' } },
      },
    });
    writeCapture(
      beforeDir,
      'dashboard@1280',
      { ...dashBody, metadata: { surfaceKey: 'legacy-dashboard' } },
      solidPng(1280, 800),
    );
    writeCapture(
      afterDir,
      'dashboard@1280',
      {
        ...makeMap({
          elements: {
            body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} },
            'body > button:nth-child(1)': { tag: 'button', style: { color: 'rgb(255, 0, 0)' } },
          },
        }),
        metadata: { surfaceKey: 'dashboard' },
      },
      solidPng(1280, 800),
    );
    const loadedMeta = {
      surfaceKey: 'dashboard',
      variantKey: 'loaded',
      variantKind: 'live-state',
    };
    writeCapture(beforeDir, 'dashboard-loaded@1280', { ...dashBody, metadata: loadedMeta }, solidPng(1280, 800));
    writeCapture(
      afterDir,
      'dashboard-loaded@1280',
      {
        ...makeMap({
          elements: {
            body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} },
            'body > button:nth-child(1)': { tag: 'button', style: { color: 'rgb(255, 0, 0)' } },
          },
        }),
        metadata: loadedMeta,
      },
      solidPng(1280, 800),
    );
    writeManifest(beforeDir, 'base-sha', 'same-env-key');
    writeManifest(afterDir, 'head-sha', 'same-env-key');

    const surfaceKeyOf = mergeSurfaceKeyLookup(beforeDir, afterDir);
    const expectedBases = countCapturedSurfaceBases([...surfaceElementPaths(beforeDir, afterDir).keys()], surfaceKeyOf);
    assert.equal(expectedBases, 4, 'head surfaceKey collapses dashboard + loaded to one product base');

    const reportMd = fs.readFileSync(generateStyleMapReport({ beforeDir, afterDir, outDir }).reportMdPath, 'utf8');
    assert.match(
      reportMd,
      new RegExp(`## 🧱 Global chrome change — across all ${expectedBases} captured surface base\\(s\\)`),
    );

    const diffRun = spawnSync(process.execPath, [DIFF, beforeDir, afterDir, '--max', '50'], {
      encoding: 'utf8',
    });
    assert.equal(diffRun.status, 1, diffRun.stderr);
    assert.match(
      diffRun.stdout,
      new RegExp(`🧱 Global chrome change\\(s\\) — across all ${expectedBases} captured surface base\\(s\\)`),
      diffRun.stdout,
    );
  } finally {
    rmTmp(root);
  }
});
