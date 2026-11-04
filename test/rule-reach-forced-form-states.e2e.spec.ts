import { expect, test, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { captureStyleMap, diffStyleMaps, trackServedRules, type StyleMap } from '../dist/index.js';
import { classifyRuleReach } from '../dist/rule-reach.js';

const selectors = ['.choice:checked + .label', '.save:disabled', '.field:placeholder-shown'];

const html = `<!doctype html><html><head><link rel="stylesheet" href="/app.css"></head><body>
  <main><input class="choice" type="checkbox"><label class="label">Choice</label>
  <button class="save">Save</button><input class="field" placeholder="Hint" value="Filled"></main>
</body></html>`;

async function capture(page: Page, color: string, options = {}): Promise<StyleMap> {
  await page.unrouteAll();
  await page.route('http://form-reach.test/**', (route) =>
    route.fulfill({
      contentType: route.request().url().endsWith('/app.css') ? 'text/css' : 'text/html',
      body: route.request().url().endsWith('/app.css')
        ? selectors.map((selector) => `${selector} { color: ${color}; }`).join('\n')
        : html,
    }),
  );
  const servedRules = await trackServedRules(page);

  try {
    await page.goto('http://form-reach.test/', { waitUntil: 'load' });
    expect(await page.locator(':checked, :disabled, :placeholder-shown').count()).toBe(0);

    return await captureStyleMap(page, { captureReach: true, servedRules, ...options });
  } finally {
    await servedRules.dispose();
  }
}

test('changed rules reached only through forced form layers are reached and show state deltas', async ({
  page,
}, testInfo) => {
  const base = await capture(page, 'rgb(10, 20, 30)');
  const head = await capture(page, 'rgb(40, 50, 60)');
  const findings = diffStyleMaps(base, head);
  expect(findings.every((finding) => finding.kind === 'state')).toBe(true);

  for (const state of ['checked', 'disabled', 'placeholder-shown']) {
    expect(head.stateLayers).toContain(state);
    expect(head.stateTargets?.[state]?.length).toBeGreaterThan(0);
    expect(
      findings.some(
        (finding) =>
          finding.state === state &&
          finding.props.some(
            (property) =>
              property.prop === 'color' &&
              property.before === 'rgb(10, 20, 30)' &&
              property.after === 'rgb(40, 50, 60)',
          ),
      ),
    ).toBe(true);
  }

  const reach = classifyRuleReach([base], [head]);
  const proofPath = testInfo.outputPath('forced-form-reach.json');
  await writeFile(
    proofPath,
    JSON.stringify({ reach, stateDeltas: findings.map(({ state, props }) => ({ state, props })) }, null, 2),
  );
  await testInfo.attach('forced-form-reach.json', {
    path: proofPath,
    contentType: 'application/json',
  });
  expect(reach.ledger).toBe('complete');
  expect(Object.fromEntries(reach.rules.map(({ key, status }) => [key, status]))).toEqual(
    Object.fromEntries(selectors.map((selector) => [selector, 'reached'])),
  );
  expect(head.reach?.rules.every((rule) => rule.used && !rule.outside)).toBe(true);
});

test('omitted form layers cannot establish reach', async ({ page }) => {
  const options = { maxFormStateScanWork: 1 };
  const base = await capture(page, 'red', options);
  const head = await capture(page, 'blue', options);
  expect(head.stateLayers).not.toContain('checked');
  expect(diffStyleMaps(base, head)).toEqual([]);
  expect(classifyRuleReach([base], [head]).rules.every((rule) => rule.status !== 'reached')).toBe(true);
});

test('an ignored candidate keeps a forced sibling rule unmeasured', async ({ page }) => {
  const options = { ignore: ['.label'] };
  const base = await capture(page, 'red', options);
  const head = await capture(page, 'blue', options);
  expect(classifyRuleReach([base], [head]).rules.find((rule) => rule.key === selectors[0])?.status).toBe('unmeasured');
});
