import { expect, test, type Page } from '@playwright/test';
import { captureStyleMap, diffStyleMaps, type StyleMap } from '../dist/index.js';

// A forced-state delta never changes the resting rect, so an unchanged rect cannot prove a
// balanced `:hover { margin: 0 40px }` is layout-equivalent. It moves the box and must report.

async function capture(page: Page, css: string): Promise<StyleMap> {
  await page.setContent(
    `<!doctype html><style>body { margin: 0; } ${css}</style>` +
      `<p>before <a href="#x" class="inline">link</a> after</p><a href="#y" class="block">block</a>`,
    { waitUntil: 'load' },
  );
  return captureStyleMap(page, { stabilize: false });
}

const hoverMarginProps = (base: StyleMap, head: StyleMap) =>
  diffStyleMaps(base, head)
    .filter((finding) => finding.kind === 'state' && finding.state === 'hover')
    .flatMap((finding) => finding.props.map((change) => change.prop))
    .filter((prop) => prop.startsWith('margin'));

for (const [name, baseCss, hoverCss] of [
  ['an inline link', '', '.inline:hover { margin: 0 40px; }'],
  ['a fixed-width block', '.block { display: block; width: 300px; }', '.block:hover { margin: 0 40px; }'],
]) {
  test(`a balanced :hover margin on ${name} is a state finding`, async ({ page }) => {
    const base = await capture(page, baseCss);
    const head = await capture(page, `${baseCss} ${hoverCss}`);
    expect(hoverMarginProps(base, head)).toEqual(expect.arrayContaining(['margin-left', 'margin-right']));
  });
}
