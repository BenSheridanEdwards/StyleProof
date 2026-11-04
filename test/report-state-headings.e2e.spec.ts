import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { captureStyleMap, saveStyleMap } from '../dist/index.js';
import { captureSurfaceScreenshots } from '../dist/capture.js';
import { spawnSyncToCompletion } from './helpers.mjs';

const reportCli = fileURLToPath(new URL('../bin/styleproof-report.mjs', import.meta.url));

function fixture(head: boolean): string {
  return `<!doctype html><html><head><style>
    body { margin: 24px; font: 16px sans-serif; }
    input, button { border: 2px solid #c8c8d2; padding: 6px; }
    .offers-label { color: #222; }
    .offers-check:checked + .offers-label { color: ${head ? '#a02828' : '#14783c'}; }
    .nickname:placeholder-shown { border-color: ${head ? '#fa7800' : '#c8c8d2'}; }
    .save:disabled { background: ${head ? '#787878' : '#a0aabe'}; }
  </style></head><body>
    <input class="offers-check" type="checkbox"><label class="offers-label">Offers</label>
    <input class="nickname" placeholder="Nickname" value="Visitor">
    <button class="save">Save</button>
  </body></html>`;
}

test('two-directory report separates forced form states and identifies the changed label', async ({
  page,
}, testInfo) => {
  const root = testInfo.outputPath('captures');
  const beforeDir = path.join(root, 'before');
  const afterDir = path.join(root, 'after');
  const outDir = path.join(root, 'report');
  await page.setViewportSize({ width: 390, height: 400 });
  for (const dir of [beforeDir, afterDir]) {
    fs.mkdirSync(dir, { recursive: true });
    await page.setContent(fixture(dir === afterDir));
    const map = await captureStyleMap(page, { stabilize: false });
    expect(map.statesSkipped).toBeFalsy();
    saveStyleMap(path.join(dir, 'form@390.json.gz'), map);
    await captureSurfaceScreenshots(page, path.join(dir, 'form@390'));
    fs.writeFileSync(
      path.join(dir, 'styleproof-manifest.json'),
      JSON.stringify({
        version: 1,
        packageVersion: '0.0.0-e2e',
        sha: 'e'.repeat(40),
        dirty: false,
        spec: 'test/report-state-headings.e2e.spec.ts',
        specHash: '1'.repeat(64),
        platform: process.platform,
        arch: process.arch,
        nodeMajor: process.versions.node.split('.')[0],
        screenshots: true,
        har: false,
        compatibilityKey: '0000000000000000',
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    );
  }
  const result = spawnSyncToCompletion(
    process.execPath,
    [reportCli, beforeDir, afterDir, '--out', outDir, '--max-crops', '1'],
    {
      cwd: root,
      encoding: 'utf8',
    },
  );
  expect(result.status, result.stderr).toBe(1);
  const md = fs.readFileSync(path.join(outDir, 'report.md'), 'utf8');
  expect(md.split('\n').filter((line) => line.startsWith('### '))).toEqual([
    '### **Offers label** `label.offers-label` · 1 element restyled `:checked`',
    '### **Save** `button.save` · 1 element restyled `:disabled`',
    '### **Nickname** `input.nickname` · 1 element restyled `:placeholder-shown`',
  ]);
  expect(md).toContain('`label.offers-label` restyled when `input.offers-check` is `:checked`.');
  expect(md).toContain('**Offers label** `label.offers-label`\n\nInteractive-state changes:');
  expect(md).toContain('changed: `label.offers-label`');
  expect(md).not.toContain('changed: `input.offers-check`');
  await page.goto(pathToFileURL(path.join(outDir, 'report.html')).href);
  expect(await page.locator('h3').allTextContents()).toEqual([
    'Offers label label.offers-label · 1 element restyled :checked',
    'Save button.save · 1 element restyled :disabled',
    'Nickname input.nickname · 1 element restyled :placeholder-shown',
  ]);
  await expect(
    page.getByText('label.offers-label restyled when input.offers-check is :checked.', { exact: true }),
  ).toBeVisible();
});
