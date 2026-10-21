import { expect, test, type Page } from '@playwright/test';
import { captureStyleMap, diffStyleMaps, type StyleMap } from '../dist/index.js';

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

const CHILD = '.child { display: block; margin: 0 auto; width: 200px; }';
const ECHO_BASE = `${CHILD} .card:hover .child { width: 300px; }`;
const ECHO_HEAD = `${CHILD} .card:hover .child { width: 320px; }`;

test('an auto margin echoing a :hover width change reports the width, not the margins', async ({ page }) => {
  const base = await capture(page, ECHO_BASE);
  const head = await capture(page, ECHO_HEAD);
  const proof = base.stateComputedValueStyle?.[pathOf(base, 'card')]?.hover?.[pathOf(base, 'child')];
  expect(proof?.['margin-left']).toBe('auto');
  expect(proof?.['margin-right']).toBe('auto');
  const props = hoverProps(base, head);
  expect(props).toContain('width');
  expect(marginProps(props)).toEqual([]);
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
