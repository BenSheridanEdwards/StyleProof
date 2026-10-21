import { expect, test, type Page } from '@playwright/test';
import { captureStyleMap, diffStyleMaps, type StyleMap } from '../dist/index.js';
import { cleanFindingsForDisplay } from '../dist/findings-clean.js';

// An `auto`-centred child whose margins only echo a :hover width change is not a margin
// change (#917). The capture proves `auto` at rest and forced with CSS Typed OM; an authored
// margin, an `auto` set only by the state, or a map without that proof still reports.

async function capture(page: Page, css: string): Promise<StyleMap> {
  await page.setContent(
    `<!doctype html><style>body { margin: 0; } .card { display: block; width: 1000px; } ${css}</style>` +
      `<a href="#x" class="card"><div class="child">child</div></a>`,
    { waitUntil: 'load' },
  );
  return captureStyleMap(page, { stabilize: false });
}

const pathOf = (map: StyleMap, cls: string): string =>
  Object.keys(map.elements).find((key) => map.elements[key]!.cls === cls)!;

const hoverProps = (base: StyleMap, head: StyleMap): string[] =>
  diffStyleMaps(base, head)
    .filter((finding) => finding.kind === 'state' && finding.state === 'hover')
    .flatMap((finding) => finding.props.map((change) => change.prop));

const marginProps = (props: string[]): string[] => props.filter((prop) => prop.startsWith('margin'));

const MARGINS = ['margin-left', 'margin-right', 'margin-inline-start', 'margin-inline-end'];

const hoverProof = (map: StyleMap): Record<string, string> | undefined =>
  map.stateComputedValueStyle?.[pathOf(map, 'card')]?.hover?.[pathOf(map, 'child')];

const CHILD = '.child { display: block; margin: 0 auto; width: 200px; }';
const ECHO_BASE = `${CHILD} .card:hover .child { width: 300px; }`;
const ECHO_HEAD = `${CHILD} .card:hover .child { width: 320px; }`;

test('an auto margin echoing a :hover width change reports the width, not the margins', async ({ page }) => {
  const base = await capture(page, ECHO_BASE);
  const head = await capture(page, ECHO_HEAD);
  for (const map of [base, head]) {
    const proof = hoverProof(map);
    for (const prop of MARGINS) expect(proof?.[prop]).toBe('auto');
  }
  const props = hoverProps(base, head);
  expect(props).toContain('width');
  expect(marginProps(props)).toEqual([]);
  const display = cleanFindingsForDisplay(diffStyleMaps(base, head));
  const shownProps = display.filter((finding) => finding.kind === 'state').flatMap((finding) => finding.props);
  expect(shownProps.map((change) => change.prop)).toContain('width');
  expect(marginProps(shownProps.map((change) => change.prop))).toEqual([]);
});

test('an authored :hover margin with the same used px still reports', async ({ page }) => {
  const base = await capture(page, ECHO_BASE);
  const head = await capture(page, `${CHILD} .card:hover .child { width: 320px; margin: 0 340px; }`);
  expect(marginProps(hoverProps(base, head))).toEqual(expect.arrayContaining(['margin-left', 'margin-right']));
});

test('an auto margin set only by :hover over an authored resting margin still reports', async ({ page }) => {
  const child = '.child { display: block; margin: 0 350px; width: 200px; }';
  const base = await capture(page, `${child} .card:hover .child { margin: 0 auto; width: 300px; }`);
  const head = await capture(page, `${child} .card:hover .child { margin: 0 auto; width: 320px; }`);
  expect(marginProps(hoverProps(base, head))).toEqual(expect.arrayContaining(['margin-left', 'margin-right']));
});

// Base authors `margin: 0 400px` on :hover, which equals the resting `auto` used px in a
// 1000px card, so the child is absent from base's hover delta. Only the Typed OM change
// records it; without that record the diff would fall back to the resting `auto`.
const AUTHORED_SAME_PX = `${CHILD} .card:hover .child { margin: 0 400px; }`;

test('a :hover margin that changes the computed value but not the used px is recorded', async ({ page }) => {
  const base = await capture(page, AUTHORED_SAME_PX);
  const head = await capture(page, ECHO_HEAD);
  expect(base.states[pathOf(base, 'card')]?.hover?.[pathOf(base, 'child')]).toBeUndefined();
  const proof = hoverProof(base);
  expect(proof?.['margin-left']).toBe('400px');
  expect(proof?.['margin-right']).toBe('400px');
  expect(marginProps(hoverProps(base, head))).toEqual(expect.arrayContaining(MARGINS));
});

test('an echo base against an authored same-px :hover margin head still reports', async ({ page }) => {
  const base = await capture(page, ECHO_HEAD);
  const head = await capture(page, AUTHORED_SAME_PX);
  expect(marginProps(hoverProps(base, head))).toEqual(expect.arrayContaining(MARGINS));
});

test('a map without the Typed OM proof (legacy) still reports the echo margins', async ({ page }) => {
  const base = await capture(page, ECHO_BASE);
  const head = await capture(page, ECHO_HEAD);
  const legacyBase: StyleMap = { ...base };
  delete legacyBase.stateComputedValueStyle;
  expect(marginProps(hoverProps(legacyBase, head))).toEqual(expect.arrayContaining(['margin-left', 'margin-right']));
});

test('the proof is omitted when Typed OM is unavailable', async ({ page }) => {
  await page.setContent(
    `<!doctype html><style>body { margin: 0; } ${ECHO_BASE}</style>` +
      `<a href="#x" class="card"><div class="child">child</div></a>`,
    { waitUntil: 'load' },
  );
  await page.evaluate(() => {
    delete (Element.prototype as { computedStyleMap?: unknown }).computedStyleMap;
  });
  const map = await captureStyleMap(page, { stabilize: false });
  expect(map.statesSkipped).toBeUndefined();
  expect(map.stateComputedValueStyle).toBeUndefined();
});

test('the proof is omitted when the forced-state layer is skipped', async ({ page }) => {
  await page.setContent(
    `<!doctype html><style>body { margin: 0; } ${ECHO_BASE}</style>` +
      `<a href="#x" class="card"><div class="child">child</div></a>`,
    { waitUntil: 'load' },
  );
  const map = await captureStyleMap(page, { stabilize: false, maxInteractive: 0 });
  expect(map.statesSkipped).toBe(true);
  expect(map.stateComputedValueStyle).toBeUndefined();
});
