// #755: spacing a sibling run loses when its members leave a parent's gap. The groups'
// own computed style barely changes (the gap belongs to the parent they left), so the
// report must name the effect from the rendered boxes: "spacing between `section.group`
// siblings 14px → 0px". Real fixture pages, real captures, the real report CLI.
import { test, expect, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureStyleMap, type StyleMap } from '../dist/index.js';
import { captureSurfaceScreenshots } from '../dist/capture.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'sibling-spacing');
const REPORT_BIN = path.join(ROOT, 'bin', 'styleproof-report.mjs');
const MANIFEST = JSON.stringify({
  version: 1,
  packageVersion: '0.0.0-e2e',
  sha: 'e'.repeat(40),
  dirty: false,
  spec: 'test/sibling-spacing.e2e.spec.ts',
  specHash: '1'.repeat(64),
  platform: 'e2e',
  arch: 'e2e',
  nodeMajor: '20',
  screenshots: true,
  har: false,
  compatibilityKey: '0000000000000000',
  createdAt: '2026-01-01T00:00:00.000Z',
});
const SPACING_LOST = /Spacing between `section\.group` siblings `14px` → `0px`/;

async function captureFixture(page: Page, dir: string, fixture: string): Promise<void> {
  await page.setViewportSize({ width: 800, height: 700 });
  await page.goto('file://' + path.join(FIXTURES, fixture), { waitUntil: 'load' });
  const map: StyleMap = await captureStyleMap(page, { captureStates: false });
  fs.writeFileSync(path.join(dir, 'home.json'), JSON.stringify(map));
  await captureSurfaceScreenshots(page, path.join(dir, 'home'));
}

async function report(page: Page, headFixture: string): Promise<{ md: string; json: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-spacing-'));
  for (const side of ['base', 'head']) {
    fs.mkdirSync(path.join(root, side));
    fs.writeFileSync(path.join(root, side, 'styleproof-manifest.json'), MANIFEST);
  }
  await captureFixture(page, path.join(root, 'base'), 'before.html');
  await captureFixture(page, path.join(root, 'head'), headFixture);
  const run = spawnSync('node', [REPORT_BIN, 'base', 'head', '--out', 'report'], { cwd: root, encoding: 'utf8' });
  expect(run.status, `${run.stdout}${run.stderr}`).toBe(1);
  const md = fs.readFileSync(path.join(root, 'report', 'report.md'), 'utf8');
  const json = fs.readFileSync(path.join(root, 'report', 'report.json'), 'utf8');
  fs.rmSync(root, { recursive: true, force: true });
  return { md, json };
}

test.describe('#755 spacing lost when children leave a parent gap', () => {
  test('a display: contents wrapper turned into a gapless flex column names the lost spacing', async ({ page }) => {
    const { md, json } = await report(page, 'after.html');
    expect(md, 'the wrapper restyle is still the gated change').toMatch(/display/);
    expect(md, 'the report names the visible effect').toMatch(SPACING_LOST);
    expect(JSON.parse(json).surfaces[0].regions[0].spacing).toEqual([
      expect.objectContaining({ siblings: ['section.group'], gaps: [{ before: 14, after: 0 }] }),
    ]);
  });

  test('groups re-nested into a new gapless column still name the lost spacing', async ({ page }) => {
    const { md } = await report(page, 'after-nested.html');
    expect(md, 'the report names the visible effect').toMatch(SPACING_LOST);
  });

  test('a group that grows with its text but keeps its gap reports no spacing change', async ({ page }) => {
    const { md } = await report(page, 'after-reflow.html');
    expect(md, 'the reflow is still reported as a change').toMatch(/## Changes/);
    expect(md, 'no spacing line for an unchanged gap').not.toMatch(/Spacing between/);
  });
});
