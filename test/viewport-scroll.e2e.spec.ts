import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { captureStyleMap, type StyleMap } from '../dist/index.js';
import { saveStyleMap, captureSurfaceScreenshots } from '../dist/capture.js';
import { hashDeterminismMap } from '../dist/determinism-oracle.js';
import { generateStyleMapReport } from '../dist/report.js';
import { PNG } from 'pngjs';

const BASE_SHA = 'a'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function stampPair(dir: string, map: StyleMap, sha: string, png: Buffer): void {
  saveStyleMap(path.join(dir, 'home@400.json.gz'), map);
  fs.writeFileSync(path.join(dir, 'home@400.png'), png);
  // Controlled CLI inputs, with repeat-capture hashes verified by the test below.
  fs.writeFileSync(
    path.join(dir, 'styleproof-manifest.json'),
    JSON.stringify({
      version: 1,
      packageVersion: 'test',
      sha,
      dirty: false,
      spec: 'e2e/styleproof.spec.ts',
      specHash: '1'.repeat(64),
      platform: process.platform,
      arch: process.arch,
      nodeMajor: process.versions.node.split('.')[0],
      screenshots: true,
      har: false,
      compatibilityKey: '0'.repeat(16),
      createdAt: '2026-01-01T00:00:00.000Z',
    }),
  );
  fs.writeFileSync(
    path.join(dir, 'styleproof-coverage.json'),
    JSON.stringify({
      version: 1,
      expected: ['home'],
      exclude: {},
      determinism: 'self-checked',
    }),
  );
}

for (const axis of ['vertical', 'horizontal'] as const) {
  test(`document ${axis} scroll: visible additions and removals require review in diff and report`, async ({
    page,
  }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-scrolled-structure-'));
    const scrollX = axis === 'horizontal' ? 1800 : 0;
    const scrollY = axis === 'vertical' ? 1800 : 0;
    const maps: StyleMap[] = [];
    try {
      await page.setViewportSize({ width: 400, height: 300 });
      for (const present of [false, true]) {
        await page.setContent(
          `<style>html,body{margin:0}body{height:2400px;width:2800px}.marker{position:absolute;left:${scrollX + 30}px;top:${scrollY + 100}px;width:120px;height:40px;background:rgb(255,0,128)}</style>${present ? '<div class="marker"></div>' : ''}`,
        );
        await page.evaluate(({ x, y }) => window.scrollTo(x, y), { x: scrollX, y: scrollY });
        const options = {
          stabilize: false as const,
          metadata: { productState: { id: 'scrolled-page', revision: 'fixture-v1' } },
        };
        const map = await captureStyleMap(page, options);
        maps.push(map);
        const repeated = await captureStyleMap(page, options);
        expect(hashDeterminismMap(repeated), 'real repeat captures agree before declaring self-check evidence').toBe(
          hashDeterminismMap(map),
        );
        expect(map.statesSkipped).toBeUndefined();
        expect(await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }))).toEqual({
          x: scrollX,
          y: scrollY,
        });
        if (present) {
          const marker = Object.values(map.elements).find((e) => e.cls === 'marker')!;
          expect(marker.rect).toEqual([scrollX + 30, scrollY + 100, 120, 40]);
          expect(await page.locator('.marker').boundingBox()).toEqual({ x: 30, y: 100, width: 120, height: 40 });
        }
        const stem = path.join(root, present ? 'present-shot' : 'absent-shot');
        await captureSurfaceScreenshots(page, stem);
        expect(await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }))).toEqual({
          x: scrollX,
          y: scrollY,
        });
        stampPair(
          path.join(root, present ? 'present' : 'absent'),
          map,
          present ? HEAD_SHA : BASE_SHA,
          fs.readFileSync(`${stem}.png`),
        );
      }
      for (const change of ['added', 'removed']) {
        const before = path.join(root, change === 'added' ? 'absent' : 'present');
        const after = path.join(root, change === 'added' ? 'present' : 'absent');
        const args = [
          before,
          after,
          '--expected-before-sha',
          change === 'added' ? BASE_SHA : HEAD_SHA,
          '--expected-after-sha',
          change === 'added' ? HEAD_SHA : BASE_SHA,
        ];
        const json = path.join(root, `${change}-diff.json`);
        const diff = spawnSync(
          process.execPath,
          [path.join(ROOT, 'bin/styleproof-diff.mjs'), ...args, '--json', json],
          { cwd: root, encoding: 'utf8', timeout: 30_000 },
        );
        const out = path.join(root, `${change}-report`);
        const report = spawnSync(
          process.execPath,
          [path.join(ROOT, 'bin/styleproof-report.mjs'), ...args, '--out', out],
          { cwd: root, encoding: 'utf8', timeout: 30_000 },
        );
        expect([diff.status, report.status], diff.stderr || report.stderr || diff.stdout).toEqual([1, 1]);
        const receipt = JSON.parse(fs.readFileSync(json, 'utf8'));
        expect(receipt.reviewableCounts.dom).toBe(1);
        expect(receipt.certifiesFully).toBe(false);
        const reportReceipt = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
        expect(reportReceipt.reviewableCounts.dom).toBe(1);
        expect(report.stdout).toContain('reviewable element addition(s)/removal(s)');
        expect(report.stdout).not.toContain('no reviewable computed-style changes');
        const withContent = spawnSync(
          process.execPath,
          [path.join(ROOT, 'bin/styleproof-report.mjs'), ...args, '--out', out, '--include-content'],
          { cwd: root, encoding: 'utf8', timeout: 30_000 },
        );
        expect(withContent.status, withContent.stderr || withContent.stdout).toBe(1);
        expect(withContent.stdout).toContain('visible element additions/removals require review');
        expect(withContent.stdout).not.toContain('does not affect the exit code');
      }
      for (const map of maps) expect(map.viewport).toEqual({ width: 400, height: 300, scrollX, scrollY });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test('horizontal-scrolled style changes retain real screenshot crops', async ({ page }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-scrolled-crop-'));
  try {
    await page.setViewportSize({ width: 400, height: 300 });
    for (const [name, color] of [
      ['base', 'rgb(0,100,200)'],
      ['head', 'rgb(240,100,0)'],
    ]) {
      await page.setContent(
        `<style>html,body{margin:0}body{height:300px;width:2800px}.marker{position:absolute;left:2000px;top:30px;width:120px;height:40px;background:${color}}</style><div class="marker"></div>`,
      );
      await page.evaluate(() => window.scrollTo(1800, 0));
      const map = await captureStyleMap(page, { stabilize: false });
      saveStyleMap(path.join(root, name, 'horizontal@400.json.gz'), map);
      fs.writeFileSync(path.join(root, name, 'horizontal@400.png'), await page.screenshot({ fullPage: true }));
    }
    const result = generateStyleMapReport({
      beforeDir: path.join(root, 'base'),
      afterDir: path.join(root, 'head'),
      outDir: path.join(root, 'report'),
    });
    const receipt = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));
    expect(receipt.surfaces[0].regions.length).toBeGreaterThan(0);
    expect(receipt.surfaces[0].regions[0].images.composite).toBeTruthy();
    const file = path.join(root, 'report', receipt.surfaces[0].regions[0].images.composite);
    expect(fs.existsSync(file)).toBe(true);
    const png = PNG.sync.read(fs.readFileSync(file));
    for (const expected of [
      [0, 100, 200],
      [240, 100, 0],
    ]) {
      let found = false;
      for (let i = 0; i < png.data.length; i += 4) {
        if (expected.every((value, channel) => png.data[i + channel] === value)) found = true;
      }
      expect(found, `crop contains the real ${expected.join(',')} marker pixels`).toBe(true);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('unscrolled captures retain the legacy width/height viewport shape', async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 300 });
  await page.setContent('<style>html,body{margin:0}</style><div>fixture</div>');
  const map = await captureStyleMap(page, { stabilize: false });
  expect(map.viewport).toEqual({ width: 400, height: 300 });
  expect(map.statesSkipped).toBeUndefined();
});
