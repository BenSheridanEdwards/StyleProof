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
import {
  captureStyleMap,
  captureSurfaceScreenshots,
  diffStyleMaps,
  diffStyleMapDirs,
  auditRunInventory,
  type StyleMap,
} from '../dist/index.js';
import { correspondBeforeMap } from '../dist/path-correspondence.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIFF_BIN = path.join(ROOT, 'bin', 'styleproof-diff.mjs');
const REPORT_BIN = path.join(ROOT, 'bin', 'styleproof-report.mjs');
const CAPTURE_BIN = path.join(ROOT, 'bin', 'styleproof-capture.mjs');

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

  test('inserting a middle navigation link does not restyle the links after it', async ({ page }) => {
    const css = [
      'nav{display:flex;flex-direction:column}',
      'a{display:block;padding:8px}',
      'a[href="/home"]{color:rgb(20,40,60)}',
      'a[href="/pricing"]{color:rgb(80,100,120)}',
      'a[href="/about"]{color:rgb(140,160,180)}',
    ].join('');
    const base = await cap(page, css, '<nav><a href="/home">Home</a><a href="/about">About</a></nav>');
    const head = await cap(
      page,
      css,
      '<nav><a href="/home">Home</a><a href="/pricing">Pricing</a><a href="/about">About</a></nav>',
    );

    const findings = diffStyleMaps(base, head);
    expect(Object.keys(head.elements).some((elementPath) => elementPath.includes('/pricing'))).toBe(false);
    const added = findings.filter((finding) => finding.kind === 'dom' && finding.change === 'added');
    expect(added).toHaveLength(1);
    const changedAnchorPaths = new Set(
      findings
        .filter((finding) => finding.kind === 'style' && finding.path.includes(' > a:'))
        .map((finding) => finding.path),
    );
    expect(changedAnchorPaths, 'only the newly inserted link may carry anchor style findings').toEqual(
      new Set([added[0].path]),
    );
    expect(
      new Set(findings.filter((finding) => finding.kind === 'state').map((finding) => finding.path)),
      'only the newly inserted link may carry interaction-state findings',
    ).toEqual(new Set([added[0].path]));
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

  // GAP CLOSED (#472): certification excludes structure, so a wrapper added around
  // (or removed from around) an element re-keyed every descendant and a real restyle
  // on it vanished with the advisory remove+add — the surface certified clean. The
  // certification correspondence now pairs the re-nested element back by geometry.
  const CARD_CSS = '.card{display:block}.wrap{display:block}';
  const CTA = (color: string) => `.cta{display:block;width:120px;height:40px;color:${color};background:rgb(0,0,255)}`;
  const FLAT = '<div class="card"><button class="cta">Go</button></div>';
  const WRAPPED = '<div class="card"><div class="wrap"><button class="cta">Go</button></div></div>';
  // Exactly what diffStyleMapDirs runs for certification (structure excluded).
  const certify = (base: StyleMap, head: StyleMap) =>
    diffStyleMaps(correspondBeforeMap(base, head), head, { includeStructure: false });

  test('a wrapper added around a RESTYLED element → the style finding still names the property', async ({ page }) => {
    const base = await cap(page, CARD_CSS + CTA('rgb(255,0,0)'), FLAT);
    const head = await cap(page, CARD_CSS + CTA('rgb(0,128,0)'), WRAPPED);
    const f = certify(base, head).find((x) => x.kind === 'style' && x.props.some((p) => p.prop === 'color'));
    expect(f, 'the colour change on the re-nested button is surfaced').toBeTruthy();
    expect(f!.path, 'the finding sits on the head path').toContain(' > button:');
  });

  test('a wrapper removed from around a RESTYLED element → the style finding still names the property', async ({
    page,
  }) => {
    const base = await cap(page, CARD_CSS + CTA('rgb(255,0,0)'), WRAPPED);
    const head = await cap(page, CARD_CSS + CTA('rgb(0,128,0)'), FLAT);
    const f = certify(base, head).find((x) => x.kind === 'style' && x.props.some((p) => p.prop === 'color'));
    expect(f, 'the colour change on the un-nested button is surfaced').toBeTruthy();
  });

  test('a wrapper added around an element whose :hover was dropped → a state finding for hover', async ({ page }) => {
    const base = await cap(page, CARD_CSS + CTA('rgb(255,0,0)') + '.cta:hover{color:rgb(200,0,0)}', FLAT);
    const head = await cap(page, CARD_CSS + CTA('rgb(255,0,0)'), WRAPPED);
    const f = certify(base, head).find((x) => x.kind === 'state' && x.state === 'hover');
    expect(f, 'the dropped :hover on the re-nested button is surfaced').toBeTruthy();
  });

  test('a wrapper added around an UNCHANGED element surfaces NOTHING (zero false positives)', async ({ page }) => {
    const base = await cap(page, CARD_CSS + CTA('rgb(255,0,0)'), FLAT);
    const head = await cap(page, CARD_CSS + CTA('rgb(255,0,0)'), WRAPPED);
    expect(certify(base, head)).toEqual([]);
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
    sha: 'e'.repeat(40),
    dirty: false,
    spec: 'test/pr-surfacing.e2e.spec.ts',
    specHash: '1'.repeat(64),
    platform: 'e2e',
    arch: 'e2e',
    nodeMajor: '20',
    screenshots: false,
    har: false,
    compatibilityKey: '0000000000000000',
    createdAt: '2026-01-01T00:00:00.000Z',
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

  // GAP CLOSED (#472): the same re-nesting through the real gate + report bins.
  test('styleproof-diff exits 1 and styleproof-report NAMES a restyle hidden behind a new wrapper', async ({
    page,
  }) => {
    const { root, base, head } = dirs();
    const cardCss = '.card{display:block}.wrap{display:block}';
    const ctaCss = (bg: string) => `.cta{display:block;width:120px;height:40px;background-color:${bg}}`;
    writeMap(
      base,
      await cap(page, cardCss + ctaCss('rgb(200,200,200)'), '<div class="card"><button class="cta">Go</button></div>'),
    );
    writeMap(
      head,
      await cap(
        page,
        cardCss + ctaCss('rgb(80,120,200)'),
        '<div class="card"><div class="wrap"><button class="cta">Go</button></div></div>',
      ),
    );

    const diff = run(DIFF_BIN, ['base', 'head'], root);
    expect(diff.status, `styleproof-diff blocks the re-nested restyle\n${diff.out}`).toBe(1);
    expect(diff.out).toMatch(/background-color/);

    const report = run(REPORT_BIN, ['base', 'head', '--out', 'report'], root);
    expect(report.status, `styleproof-report ran and flagged the change\n${report.out}`).toBe(1);
    const md = fs.readFileSync(path.join(root, 'report', 'report.md'), 'utf8');
    expect(md, 'the report names the changed property').toMatch(/background-color/);
    expect(md, 'the report does not claim a clean match').not.toMatch(/No reviewable computed-style changes/);
    const json = JSON.parse(fs.readFileSync(path.join(root, 'report', 'report.json'), 'utf8'));
    expect(json.counts.style, 'the machine-readable count agrees with the gate').toBe(1);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('styleproof-diff certifies a wrapper-only change as 0 reviewable changes (diagnostic compare)', async ({
    page,
  }) => {
    const { root, base, head } = dirs();
    const css =
      '.card{display:block}.wrap{display:block}.cta{display:block;width:120px;height:40px;background-color:rgb(200,200,200)}';
    writeMap(base, await cap(page, css, '<div class="card"><button class="cta">Go</button></div>'));
    writeMap(
      head,
      await cap(page, css, '<div class="card"><div class="wrap"><button class="cta">Go</button></div></div>'),
    );

    const diff = run(DIFF_BIN, ['base', 'head', '--allow-unasserted'], root);
    expect(diff.status, `a no-op re-nesting is not a style change\n${diff.out}`).toBe(0);
    expect(diff.out).toMatch(/0 reviewable computed-style changes/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  // GAP CLOSED (#473, opt-in): a change computed styles cannot observe. The two
  // <img> elements have identical computed styles (same box, same everything) but
  // different pixels. Without --pixels the gate is green; with it the region is
  // caught and attributed to the image element.
  const PIXEL_CSS = '.card{display:block;padding:8px}.hero{display:block;width:120px;height:40px}';
  // 1×1 PNGs stretched to 120×40: solid green vs solid red.
  const GREEN =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkuMR8HgAD2AH3PE7ABQAAAABJRU5ErkJggg==';
  const RED =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8Dw/wAF/AHOOxKrpwAAAABJRU5ErkJggg==';
  const heroPage = (src: string) => `<div class="card"><img class="hero" alt="" src="${src}"></div>`;
  async function capWithShots(dir: string, css: string, body: string): Promise<StyleMap> {
    const map = await cap(page, css, body);
    await captureSurfaceScreenshots(page, path.join(dir, 'home'));
    return map;
  }
  // `page` is a fixture, so the helper above closes over it per test via a let.
  let page: import('@playwright/test').Page;

  test('image content changed with identical computed styles → green without --pixels, exit 1 and attributed with it', async ({
    page: p,
  }) => {
    page = p;
    const { root, base, head } = dirs();
    writeMap(base, await capWithShots(base, PIXEL_CSS, heroPage(GREEN)));
    writeMap(head, await capWithShots(head, PIXEL_CSS, heroPage(RED)));

    const plain = run(DIFF_BIN, ['base', 'head', '--allow-unasserted'], root);
    expect(plain.status, `computed styles alone cannot see the image change\n${plain.out}`).toBe(0);

    const gated = run(DIFF_BIN, ['base', 'head', '--allow-unasserted', '--pixels', '--json', 'diff.json'], root);
    expect(gated.status, `the pixel gate blocks the image change\n${gated.out}`).toBe(1);
    expect(gated.out).toMatch(/pixel gate: [1-9]\d* changed region/);
    expect(gated.out).toMatch(/img:nth-child\(\d+\)\s+\(\.hero\)/);
    const json = JSON.parse(fs.readFileSync(path.join(root, 'diff.json'), 'utf8'));
    expect(json.counts, 'style counts stay untouched').toEqual({ dom: 0, style: 0, state: 0 });
    expect(json.pixels.blocking).toBe(true);
    expect(json.pixels.surfaces[0].layers[0].comparison.regions[0].elements[0].path).toMatch(/img/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('the same page captured twice → the pixel gate certifies 0 regions (no false positives)', async ({
    page: p,
  }) => {
    page = p;
    const { root, base, head } = dirs();
    writeMap(base, await capWithShots(base, PIXEL_CSS, heroPage(GREEN)));
    writeMap(head, await capWithShots(head, PIXEL_CSS, heroPage(GREEN)));
    const gated = run(DIFF_BIN, ['base', 'head', '--allow-unasserted', '--pixels'], root);
    expect(gated.status, `identical renders pass the pixel gate\n${gated.out}`).toBe(0);
    expect(gated.out).toMatch(/pixel gate: 0 changed region/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('a screenshot layer missing on one side fails the pixel gate closed', async ({ page: p }) => {
    page = p;
    const { root, base, head } = dirs();
    writeMap(base, await capWithShots(base, PIXEL_CSS, heroPage(GREEN)));
    writeMap(head, await capWithShots(head, PIXEL_CSS, heroPage(GREEN)));
    fs.rmSync(path.join(head, 'home.hover.png'));
    const gated = run(DIFF_BIN, ['base', 'head', '--allow-unasserted', '--pixels'], root);
    expect(gated.status, `an uncompared layer is not certified\n${gated.out}`).toBe(1);
    expect(gated.out).toMatch(/\[hover\]: ✗ screenshot missing on the after side/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  // GAP CLOSED (#474): two real URL-only captures of the SAME page, compared with
  // the real report CLI. Before the fix report.md opened with
  // "**Release confidence** — ✗ blocked (absent-legacy; integrity; manifest-absent)"
  // and stderr said only "projection failed": a clean compare that read as a
  // finding. Now the line says what did NOT happen and why, the cause is a fixed
  // reason literal, and the machine summary (and so the gate) is unchanged.
  test('a clean URL-only compare reads "not evaluated" with a named cause, not "✗ blocked"', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-flow-rc-'));
    const pageFile = path.join(root, 'page.html');
    fs.writeFileSync(
      pageFile,
      doc('.hero{display:block;width:200px;height:80px;background:rgb(0,128,128)}', '<div class="hero">Hi</div>'),
    );
    const base = path.join(root, 'base');
    const head = path.join(root, 'head');
    for (const out of [base, head]) {
      const cap = run(CAPTURE_BIN, ['file://' + pageFile, '--out', out, '--key', 'home', '--widths', '1280'], root);
      expect(cap.status, `real capture must succeed\n${cap.out}`).toBe(0);
    }
    // The manifest a URL-only capture stamps: no spec file → specHash 'missing'.
    // Outside a git checkout the SHA is not a full commit either; the projector
    // refuses on the first unbound field, so derive the expected reason from the
    // manifest rather than the environment.
    const manifest = JSON.parse(fs.readFileSync(path.join(head, 'styleproof-manifest.json'), 'utf8'));
    expect(manifest.specHash).toBe('missing');
    const bound = /^[0-9a-f]{40}$/.test(manifest.sha) && /^[0-9a-f]{16}$/.test(manifest.compatibilityKey);
    const reason = bound ? 'spec-hash-unbound' : 'head-manifest-unbound';
    const sentence = bound
      ? 'the head capture ran without a StyleProof spec file'
      : 'the head manifest is not bound to a full commit SHA and compatibility key';

    const report = run(REPORT_BIN, [base, head, '--out', path.join(root, 'out')], root);
    expect(report.status, `fail-closed exit code is unchanged\n${report.out}`).toBe(1);
    expect(report.out).toContain(`release confidence not evaluated — projection refused (${reason}): ${sentence}`);
    expect(report.out).not.toMatch(/projection failed$/m);

    const md = fs.readFileSync(path.join(root, 'out', 'report.md'), 'utf8');
    expect(md).toContain(`**Release confidence** — ⚠ not evaluated (projection refused — ${sentence}`);
    expect(md).not.toMatch(/✗ blocked/);
    expect(md).not.toMatch(/absent-legacy|manifest-absent/);
    const json = JSON.parse(fs.readFileSync(path.join(root, 'out', 'report.json'), 'utf8'));
    expect(json.releaseConfidence).toMatchObject({
      presence: 'absent-legacy',
      blocking: true,
      reasons: ['manifest-absent'],
    });
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
