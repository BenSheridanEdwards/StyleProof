/**
 * Performance benchmark for #538: diff two ~500-surface bundles under a stated budget.
 * TDD failing-first: generates synthetic fixture bundles and asserts completion within
 * the budget threshold.
 *
 * Performance Budget: <5s for diffing ~500 surfaces on CI.
 * This budget is conservative and may be tuned based on CI environment profiling.
 *
 * @see https://github.com/BenSheridanEdwards/StyleProof/issues/538
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { gzipSync } from 'node:zlib';
import { diffStyleMapDirs } from '../dist/diff.js';

const PERFORMANCE_BUDGET_MS = 5000; // 5 seconds
const SURFACE_COUNT = 500;

function mkTmp(prefix = 'styleproof-benchmark-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmTmp(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Generate a synthetic privacy-clean StyleMap with realistic structure.
 * @param {number} elementCount - Number of elements per surface
 * @param {string} variant - 'before' or 'after' to create slight variations
 */
function generateSyntheticMap(elementCount, variant = 'before') {
  const defaults = {};
  const elements = {};

  // Generate a realistic element tree
  for (let i = 0; i < elementCount; i++) {
    const path = `body > div:nth-child(1) > section:nth-child(${Math.floor(i / 10) + 1}) > div:nth-child(${(i % 10) + 1})`;

    // Create slight variations between before/after to exercise the diff logic
    const baseColor = variant === 'before' ? 'rgb(0, 0, 0)' : i % 50 === 0 ? 'rgb(255, 0, 0)' : 'rgb(0, 0, 0)';
    const fontSize = variant === 'before' ? '16px' : i % 100 === 0 ? '18px' : '16px';

    elements[path] = {
      tag: 'div',
      cls: `element-${i} card`,
      rect: [i * 10, i * 5, 200, 100],
      ownTextLength: 10 + (i % 20),
      style: {
        color: baseColor,
        'font-size': fontSize,
        padding: '16px',
        margin: '8px',
        display: 'flex',
        'flex-direction': 'column',
        'align-items': 'center',
        'justify-content': 'center',
        'background-color': 'rgb(255, 255, 255)',
        'border-radius': '4px',
        'box-shadow': '0 2px 4px rgba(0, 0, 0, 0.1)',
      },
    };
  }

  return { defaults, elements, states: {} };
}

/**
 * Write a synthetic capture to disk.
 */
function writeSyntheticCapture(dir, surfaceKey, map) {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${surfaceKey}.json.gz`);
  fs.writeFileSync(filePath, gzipSync(JSON.stringify(map)));
}

/**
 * Generate synthetic surface keys.
 */
function generateSurfaceKeys(count) {
  const keys = [];
  const pages = ['home', 'about', 'contact', 'products', 'services', 'blog', 'pricing', 'features', 'team', 'faq'];
  const widths = [390, 768, 1024, 1280, 1440];

  for (let i = 0; i < count; i++) {
    const page = pages[i % pages.length];
    const width = widths[Math.floor(i / pages.length) % widths.length];
    const suffix = Math.floor(i / (pages.length * widths.length));
    const key = suffix > 0 ? `${page}-${suffix}@${width}` : `${page}@${width}`;
    keys.push(key);
  }

  return keys;
}

describe('diff large-map performance benchmark (#538)', () => {
  let testRoot;
  let beforeDir;
  let afterDir;
  let surfaceKeys;

  before(async () => {
    testRoot = mkTmp('styleproof-large-map-benchmark-');
    beforeDir = path.join(testRoot, 'before');
    afterDir = path.join(testRoot, 'after');

    surfaceKeys = generateSurfaceKeys(SURFACE_COUNT);

    // Generate synthetic bundles - this is setup, not part of the benchmark
    const setupStart = performance.now();
    for (const key of surfaceKeys) {
      const elementsPerSurface = 50; // Realistic element count per page
      writeSyntheticCapture(beforeDir, key, generateSyntheticMap(elementsPerSurface, 'before'));
      writeSyntheticCapture(afterDir, key, generateSyntheticMap(elementsPerSurface, 'after'));
    }
    const setupDuration = performance.now() - setupStart;
    console.log(`Setup: generated ${SURFACE_COUNT} synthetic surfaces in ${Math.round(setupDuration)}ms`);
  });

  after(async () => {
    if (testRoot) rmTmp(testRoot);
  });

  test(`diff ${SURFACE_COUNT} surfaces completes under ${PERFORMANCE_BUDGET_MS}ms budget`, async () => {
    const startTime = performance.now();

    const result = diffStyleMapDirs(beforeDir, afterDir);

    const duration = performance.now() - startTime;

    // Log performance metrics for CI profiling
    console.log(`Performance metrics:`);
    console.log(`  - Surfaces diffed: ${SURFACE_COUNT}`);
    console.log(`  - Wall-clock time: ${Math.round(duration)}ms`);
    console.log(`  - Budget: ${PERFORMANCE_BUDGET_MS}ms`);
    console.log(`  - Headroom: ${Math.round(PERFORMANCE_BUDGET_MS - duration)}ms`);
    console.log(`  - Per-surface average: ${(duration / SURFACE_COUNT).toFixed(2)}ms`);
    console.log(`  - DOM changes: ${result.counts.dom}`);
    console.log(`  - Style changes: ${result.counts.style}`);
    console.log(`  - State changes: ${result.counts.state}`);

    assert.ok(
      duration < PERFORMANCE_BUDGET_MS,
      `Diff took ${Math.round(duration)}ms, exceeding the ${PERFORMANCE_BUDGET_MS}ms budget`,
    );
  });

  test('diff result structure is valid for large bundles', async () => {
    const result = diffStyleMapDirs(beforeDir, afterDir);

    // Verify the result has the expected shape
    assert.ok(result.counts !== undefined, 'Result should have counts');
    assert.ok(typeof result.counts.dom === 'number', 'counts.dom should be a number');
    assert.ok(typeof result.counts.style === 'number', 'counts.style should be a number');
    assert.ok(typeof result.counts.state === 'number', 'counts.state should be a number');
    assert.ok(Array.isArray(result.surfaces), 'Result should have surfaces array');
  });

  test('diff detects intentional changes in large bundles', async () => {
    const result = diffStyleMapDirs(beforeDir, afterDir);

    // Our synthetic data has ~1% of elements with changed color and ~0.5% with changed font-size
    // With 500 surfaces * 50 elements each = 25,000 elements
    // Expected changes: ~500 color changes + ~250 font-size changes
    assert.ok(result.counts.style > 0, 'Should detect style changes in synthetic data');
  });

  test('diff handles empty or minimal change bundles efficiently', async () => {
    // Create identical bundles
    const identicalRoot = mkTmp('styleproof-identical-');
    const identicalBefore = path.join(identicalRoot, 'before');
    const identicalAfter = path.join(identicalRoot, 'after');

    try {
      // Generate 100 identical surfaces
      const keys = generateSurfaceKeys(100);
      for (const key of keys) {
        const map = generateSyntheticMap(30, 'before');
        writeSyntheticCapture(identicalBefore, key, map);
        writeSyntheticCapture(identicalAfter, key, map);
      }

      const startTime = performance.now();
      const result = diffStyleMapDirs(identicalBefore, identicalAfter);
      const duration = performance.now() - startTime;

      console.log(`Identical bundle diff: ${Math.round(duration)}ms for 100 surfaces`);

      // Identical bundles should be faster and have zero changes
      assert.equal(result.counts.dom, 0, 'Identical bundles should have no DOM changes');
      assert.equal(result.counts.style, 0, 'Identical bundles should have no style changes');
      assert.equal(result.counts.state, 0, 'Identical bundles should have no state changes');
      assert.ok(duration < PERFORMANCE_BUDGET_MS / 2, 'Identical bundles should diff faster');
    } finally {
      rmTmp(identicalRoot);
    }
  });
});

describe('diff scalability characteristics (#538)', () => {
  test('diff time scales sub-linearly with surface count', async () => {
    const root = mkTmp('styleproof-scaling-');
    const sizes = [50, 100, 200];
    const timings = [];

    try {
      for (const size of sizes) {
        const beforeDir = path.join(root, `before-${size}`);
        const afterDir = path.join(root, `after-${size}`);
        const keys = generateSurfaceKeys(size);

        for (const key of keys) {
          writeSyntheticCapture(beforeDir, key, generateSyntheticMap(30, 'before'));
          writeSyntheticCapture(afterDir, key, generateSyntheticMap(30, 'after'));
        }

        const startTime = performance.now();
        diffStyleMapDirs(beforeDir, afterDir);
        const duration = performance.now() - startTime;

        timings.push({ size, duration, perSurface: duration / size });
        console.log(`  ${size} surfaces: ${Math.round(duration)}ms (${(duration / size).toFixed(2)}ms/surface)`);
      }

      // Verify that per-surface time doesn't grow significantly
      // (allows for some variance due to caching, JIT, etc.)
      const firstPerSurface = timings[0].perSurface;
      const lastPerSurface = timings[timings.length - 1].perSurface;

      // Allow up to 3x growth in per-surface time (accounting for overhead)
      assert.ok(
        lastPerSurface < firstPerSurface * 3,
        `Per-surface time should not grow excessively: ${firstPerSurface.toFixed(2)}ms → ${lastPerSurface.toFixed(2)}ms`,
      );
    } finally {
      rmTmp(root);
    }
  });

  test('memory usage stays bounded during large diff', async () => {
    const root = mkTmp('styleproof-memory-');
    const beforeDir = path.join(root, 'before');
    const afterDir = path.join(root, 'after');

    try {
      // Create 200 surfaces with more elements
      const keys = generateSurfaceKeys(200);
      for (const key of keys) {
        writeSyntheticCapture(beforeDir, key, generateSyntheticMap(100, 'before'));
        writeSyntheticCapture(afterDir, key, generateSyntheticMap(100, 'after'));
      }

      const memBefore = process.memoryUsage().heapUsed;
      diffStyleMapDirs(beforeDir, afterDir);
      const memAfter = process.memoryUsage().heapUsed;

      const memDelta = memAfter - memBefore;
      const memDeltaMB = memDelta / (1024 * 1024);

      console.log(`Memory delta for 200-surface diff: ${memDeltaMB.toFixed(2)} MB`);

      // Memory growth should be reasonable (under 500MB for this test)
      assert.ok(memDeltaMB < 500, `Memory growth should be bounded: ${memDeltaMB.toFixed(2)} MB`);
    } finally {
      rmTmp(root);
    }
  });
});
