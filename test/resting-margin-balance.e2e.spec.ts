import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { captureStyleMap, diffStyleMapDirs, diffStyleMaps, saveStyleMap, type StyleMap } from '../dist/index.js';

// A centring container absorbs a balanced margin growth: the item's own rect stays put and its
// neighbours move instead (#951). An unchanged rect cannot prove an authored px margin change
// is layout-equivalent; only Typed OM `auto` proof on both sides drops an echo.

async function capture(page: Page, css: string, body: string): Promise<StyleMap> {
  await page.setContent(`<!doctype html><style>body { margin: 0; } ${css}</style>${body}`, { waitUntil: 'load' });
  return captureStyleMap(page, { stabilize: false });
}

const pathOf = (map: StyleMap, cls: string) => Object.entries(map.elements).find(([, e]) => e.cls === cls)![0];

const marginProps = (base: StyleMap, head: StyleMap, elementPath: string) =>
  diffStyleMaps(base, head)
    .flatMap((finding) => (finding.kind === 'style' && finding.path === elementPath ? finding.props : []))
    .map((change) => change.prop)
    .filter((prop) => prop.startsWith('margin'));

test('a balanced margin change on a centred flex item that moves its siblings reports', async ({ page }) => {
  const css = '.row { display: flex; justify-content: center; } .chip { width: 80px; height: 30px; }';
  const body = '<nav class="row"><a class="chip">A</a><a class="chip mid">B</a><a class="chip">C</a></nav>';
  const base = await capture(page, `${css} .mid { margin: 0 8px; }`, body);
  const head = await capture(page, `${css} .mid { margin: 0 48px; }`, body);
  const mid = pathOf(head, 'chip mid');
  expect(head.elements[mid]!.rect, 'the centred item itself does not move').toEqual(base.elements[mid]!.rect);

  expect(marginProps(base, head, mid)).toEqual(expect.arrayContaining(['margin-left', 'margin-right']));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-resting-margin-'));
  try {
    saveStyleMap(path.join(root, 'base', 'row.json.gz'), base);
    saveStyleMap(path.join(root, 'head', 'row.json.gz'), head);
    expect(diffStyleMapDirs(path.join(root, 'base'), path.join(root, 'head')).counts.style).toBeGreaterThan(0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an auto-centred child whose container narrows symmetrically stays clean', async ({ page }) => {
  const css = '.card { width: 400px; height: 30px; margin: 0 auto; }';
  const body = '<main class="wrap"><section class="card">card</section></main>';
  const base = await capture(page, `${css} .wrap { padding: 0; }`, body);
  const head = await capture(page, `${css} .wrap { padding: 0 40px; }`, body);
  const card = pathOf(head, 'card');
  expect(head.elements[card]!.rect, 'the auto-centred child does not move').toEqual(base.elements[card]!.rect);
  expect(head.elements[card]!.style['margin-left'], 'its used margin echoes the narrower container').not.toBe(
    base.elements[card]!.style['margin-left'],
  );

  expect(marginProps(base, head, card)).toEqual([]);
});
