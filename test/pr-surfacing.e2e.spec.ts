// Dogfood: the "100% surfaced" contract. For a PR to be trusted, EVERY class of
// visible change must show up — in the diff, and in the report a reviewer reads.
// This spec pins that matrix: for each change class we capture a base surface,
// apply exactly one PR-like mutation, capture head, and assert the change is
// surfaced (and that an unchanged capture surfaces NOTHING — zero false positives).
//
// The four classes that had no end-to-end proof before this spec are called out:
// :active drop, DOM removed, DOM retagged, ::before/::after change. The rest lock
// in the classes that were already covered so the whole matrix lives in one place.
//
// Levels:
//   1. diff level  — diffStyleMaps() surfaces the finding (precise, per-class).
//   2. flow level  — the real styleproof-diff / styleproof-report CLIs surface it,
//                    so the confidence is in the actual PR gate + report, not just
//                    library calls.
import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureStyleMap, diffStyleMaps, diffStyleMapDirs, auditRunInventory, type StyleMap } from '../dist/index.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIFF_BIN = path.join(ROOT, 'bin', 'styleproof-diff.mjs');
const REPORT_BIN = path.join(ROOT, 'bin', 'styleproof-report.mjs');

// Build a minimal deterministic document. No fonts, no animation → never flaky.
const doc = (css: string, body: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><style>` +
  `body{margin:0;font-family:system-ui,sans-serif;background:rgb(255,255,255)}` +
  `${css}</style></head><body>${body}</body></html>`;

async function cap(
  page: import('@playwright/test').Page,
  css: string,
  body: string,
  opts?: Parameters<typeof captureStyleMap>[1],
): Promise<StyleMap> {
  await page.setContent(doc(css, body), { waitUntil: 'load' });
  return captureStyleMap(page, opts);
}

const BOX = '<div class="box">A</div>';
const boxCss = (rule: string) => `.box{display:block;width:140px;height:44px;${rule}}`;

// ── Level 1: every change class is surfaced in the diff ──────────────────────────
test.describe('every PR change class is surfaced in the diff', () => {
  test('computed-style change (resting) → a style finding names the property', async ({ page }) => {
    const base = await cap(page, boxCss('background-color:rgb(200,200,200)'), BOX);
    const head = await cap(page, boxCss('background-color:rgb(80,120,200)'), BOX);
    const f = diffStyleMaps(base, head).find(
      (x) => x.kind === 'style' && x.pseudo === null && x.props.some((p) => p.prop === 'background-color'),
    );
    expect(f, 'resting background-color change is surfaced').toBeTruthy();
  });

  test(':hover state drop → a state finding for hover', async ({ page }) => {
    const base = await cap(
      page,
      '.box:hover{background-color:rgb(255,0,0)}' + boxCss(''),
      '<button class="box">A</button>',
    );
    const head = await cap(page, boxCss(''), '<button class="box">A</button>');
    const f = diffStyleMaps(base, head).find((x) => x.kind === 'state' && x.state === 'hover');
    expect(f, 'a dropped :hover variant is surfaced as a state finding').toBeTruthy();
  });

  test(':focus state drop → a state finding for focus', async ({ page }) => {
    const base = await cap(
      page,
      '.box:focus{background-color:rgb(0,128,0)}' + boxCss(''),
      '<button class="box">A</button>',
    );
    const head = await cap(page, boxCss(''), '<button class="box">A</button>');
    const f = diffStyleMaps(base, head).find((x) => x.kind === 'state' && x.state === 'focus');
    expect(f, 'a dropped :focus variant is surfaced as a state finding').toBeTruthy();
  });

  // GAP CLOSED: :active drop had no end-to-end proof before this spec.
  test(':active state drop → a state finding for active', async ({ page }) => {
    const base = await cap(
      page,
      '.box:active{background-color:rgb(0,0,255)}' + boxCss(''),
      '<button class="box">A</button>',
    );
    const head = await cap(page, boxCss(''), '<button class="box">A</button>');
    const f = diffStyleMaps(base, head).find((x) => x.kind === 'state' && x.state === 'active');
    expect(f, 'a dropped :active variant is surfaced as a state finding').toBeTruthy();
  });

  // GAP CLOSED: a DOM element removed within a surface had no end-to-end proof.
  test('DOM element removed → a dom/removed finding', async ({ page }) => {
    const css = boxCss('') + ' .b{display:block;width:60px;height:20px;background:rgb(1,2,3)}';
    const base = await cap(page, css, BOX + '<div class="b">B</div>');
    const head = await cap(page, css, BOX);
    const f = diffStyleMaps(base, head).find((x) => x.kind === 'dom' && x.change === 'removed');
    expect(f, 'a removed element is surfaced as dom/removed').toBeTruthy();
  });

  test('DOM element added → a dom/added finding', async ({ page }) => {
    const css = boxCss('') + ' .b{display:block;width:60px;height:20px;background:rgb(1,2,3)}';
    const base = await cap(page, css, BOX);
    const head = await cap(page, css, BOX + '<div class="b">B</div>');
    const f = diffStyleMaps(base, head).find((x) => x.kind === 'dom' && x.change === 'added');
    expect(f, 'an added element is surfaced as dom/added').toBeTruthy();
  });

  // GAP CLOSED: a retagged element had no end-to-end proof. An element's tag is
  // part of its identity (the path is `…> button:nth-child(1)`), so swapping the
  // tag reads as the old element removed and a new one added at that position —
  // either way the change is surfaced, which is the contract this pins.
  test('DOM element retagged (button → a) → surfaced as removed + added', async ({ page }) => {
    const css = '.box{display:block;width:140px;height:44px;background:rgb(200,200,200)}';
    const base = await cap(page, css, '<button class="box">A</button>');
    const head = await cap(page, css, '<a class="box" href="#">A</a>');
    const findings = diffStyleMaps(base, head);
    expect(
      findings.some((x) => x.kind === 'dom' && x.change === 'removed'),
      'old tag surfaced as removed',
    ).toBe(true);
    expect(
      findings.some((x) => x.kind === 'dom' && x.change === 'added'),
      'new tag surfaced as added',
    ).toBe(true);
  });

  // GAP CLOSED: a ::before / ::after style change had no end-to-end proof.
  test('::before pseudo-element style change → a style finding with pseudo="::before"', async ({ page }) => {
    const base = await cap(page, '.box::before{content:"•";color:rgb(0,128,0)}' + boxCss(''), BOX);
    const head = await cap(page, '.box::before{content:"•";color:rgb(200,0,0)}' + boxCss(''), BOX);
    const f = diffStyleMaps(base, head).find(
      (x) => x.kind === 'style' && x.pseudo === '::before' && x.props.some((p) => p.prop === 'color'),
    );
    expect(f, 'a ::before color change is surfaced with its pseudo tag').toBeTruthy();
  });

  test('::after pseudo-element style change → a style finding with pseudo="::after"', async ({ page }) => {
    const base = await cap(page, '.box::after{content:"›";color:rgb(0,128,0)}' + boxCss(''), BOX);
    const head = await cap(page, '.box::after{content:"›";color:rgb(200,0,0)}' + boxCss(''), BOX);
    const f = diffStyleMaps(base, head).find(
      (x) => x.kind === 'style' && x.pseudo === '::after' && x.props.some((p) => p.prop === 'color'),
    );
    expect(f, 'an ::after color change is surfaced with its pseudo tag').toBeTruthy();
  });

  test('a REMOVED nav item → the inventory guard flags an unexplained removal', async ({ page }) => {
    // Nav buttons (not <a href>) so the harvest is origin-independent under
    // setContent; route-link harvesting is covered by inventory.e2e.spec.ts.
    const nav = (items: string[]) => `<nav>${items.map((i) => `<button>${i}</button>`).join('')}</nav>`;
    const base = await cap(page, 'button{display:inline-block;padding:8px}', nav(['Home', 'Billing', 'Settings']), {
      inventory: true,
    });
    const head = await cap(page, 'button{display:inline-block;padding:8px}', nav(['Home', 'Settings']), {
      inventory: true,
    });
    const { unexplained } = auditRunInventory([base], [head]);
    expect(
      unexplained.some((i) => /billing/i.test(i.key)),
      'a nav item present on base but gone on head is flagged as an unexplained removal',
    ).toBe(true);
  });

  test('a NEW surface (present on one side only) is surfaced as missing-baseline', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-newsurface-'));
    const baseDir = path.join(dir, 'base');
    const headDir = path.join(dir, 'head');
    fs.mkdirSync(baseDir);
    fs.mkdirSync(headDir);
    const empty: StyleMap = { defaults: {}, elements: {}, states: {} };
    fs.writeFileSync(path.join(baseDir, 'home.json'), JSON.stringify(empty));
    fs.writeFileSync(path.join(headDir, 'home.json'), JSON.stringify(empty));
    fs.writeFileSync(path.join(headDir, 'pricing.json'), JSON.stringify(empty)); // head adds a surface
    const { surfaces } = diffStyleMapDirs(baseDir, headDir);
    const pricing = surfaces.find((s) => s.surface === 'pricing');
    expect(pricing?.missing, 'the head-only surface is reported as a new surface with no baseline').toBe('before');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a clean no-op change surfaces NOTHING (zero false positives)', async ({ page }) => {
    const base = await cap(page, boxCss('background-color:rgb(200,200,200)'), BOX);
    const head = await cap(page, boxCss('background-color:rgb(200,200,200)'), BOX);
    expect(diffStyleMaps(base, head), 'an identical capture yields no findings').toEqual([]);
  });
});

// ── Level 2: the real gate + report surface the change ──────────────────────────
test.describe('the PR gate + report surface the change through the real CLIs', () => {
  function run(bin: string, args: string[], cwd: string): { status: number; out: string } {
    const r = spawnSync('node', [bin, ...args], { cwd, encoding: 'utf8' });
    return { status: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  }
  // Since v4 the CLIs refuse a map-bearing dir without styleproof-manifest.json,
  // so these synthetic fixtures stamp an identical minimal manifest on both sides.
  const MANIFEST = JSON.stringify({
    version: 1,
    packageVersion: '0.0.0-e2e',
    sha: 'e2e-fixture',
    dirty: false,
    spec: 'test/pr-surfacing.e2e.spec.ts',
    specHash: 'e2e',
    platform: 'e2e',
    arch: 'e2e',
    nodeMajor: 'e2e',
    screenshots: false,
    har: false,
    compatibilityKey: 'e2e-fixture',
  });
  function dirs(): { root: string; base: string; head: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-flow-'));
    const base = path.join(root, 'base');
    const head = path.join(root, 'head');
    fs.mkdirSync(base);
    fs.mkdirSync(head);
    fs.writeFileSync(path.join(base, 'styleproof-manifest.json'), MANIFEST);
    fs.writeFileSync(path.join(head, 'styleproof-manifest.json'), MANIFEST);
    return { root, base, head };
  }
  const writeMap = (dir: string, map: StyleMap) => fs.writeFileSync(path.join(dir, 'home.json'), JSON.stringify(map));

  test('styleproof-diff exits 1 and styleproof-report NAMES a real style change', async ({ page }) => {
    const { root, base, head } = dirs();
    writeMap(base, await cap(page, boxCss('background-color:rgb(200,200,200)'), BOX));
    writeMap(head, await cap(page, boxCss('background-color:rgb(80,120,200)'), BOX));

    const diff = run(DIFF_BIN, ['base', 'head'], root);
    expect(diff.status, `styleproof-diff blocks the change\n${diff.out}`).toBe(1);
    expect(diff.out).toMatch(/background/);

    // The report a reviewer actually reads (the real styleproof-report bin) must name it
    // too. Like the diff, the report bin exits 1 when there are changes (2 = usage error).
    const report = run(REPORT_BIN, ['base', 'head', '--out', 'report'], root);
    expect(report.status, `styleproof-report ran and flagged the change\n${report.out}`).toBe(1);
    const md = fs.readFileSync(path.join(root, 'report', 'report.md'), 'utf8');
    expect(md, 'the report names the changed property').toMatch(/background/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('styleproof-diff exits 1 and NAMES a removed nav item (inventory)', async ({ page }) => {
    const { root, base, head } = dirs();
    const nav = (items: string[]) => `<nav>${items.map((i) => `<button>${i}</button>`).join('')}</nav>`;
    writeMap(
      base,
      await cap(page, 'button{display:inline-block;padding:8px}', nav(['Home', 'Billing', 'Settings']), {
        inventory: true,
      }),
    );
    writeMap(
      head,
      await cap(page, 'button{display:inline-block;padding:8px}', nav(['Home', 'Settings']), { inventory: true }),
    );

    const diff = run(DIFF_BIN, ['base', 'head'], root);
    expect(diff.status, `a silent nav removal must block\n${diff.out}`).toBe(1);
    expect(diff.out, 'the removed affordance is named, not just counted').toMatch(/REMOVED[\s\S]*billing/i);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
