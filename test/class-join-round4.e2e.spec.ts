import { test, expect } from '@playwright/test';
import { captureStyleMap } from '../dist/capture.js';
import { classifyClassReach, combineClassReach } from '../dist/class-join.js';
import { changedScriptRanges } from '../dist/script-join-git.js';

for (const [name, setup] of [
  ['head rendered child', "const el=document.createElement('div'); document.head.append(el);"],
  ['head hidden child', "const el=document.createElement('div'); el.style.display='none'; document.head.append(el);"],
  [
    'head visible framework node',
    "const el=document.createElement('meta'); el.style.display='block'; document.head.append(el);",
  ],
  [
    'route tag light child',
    "const host=document.createElement('next-route-announcer'); document.body.append(host); const el=document.createElement('span'); host.append(el);",
  ],
  [
    'route id light child',
    "const host=document.createElement('div'); host.id='__next-route-announcer__'; document.body.append(host); const el=document.createElement('span'); host.append(el);",
  ],
])
  test(`real capture cannot prove absence: ${name}`, async ({ page }) => {
    const base = setup + " el.className='clock';",
      head = setup + " const CLS='clock'; el.className=CLS;";
    const maps = [];
    for (const source of [base, head]) {
      await page.goto('about:blank');
      await page.setContent(`<style>.clock{color:red}</style><body><script>${source}</script></body>`);
      maps.push(await captureStyleMap(page, { captureReach: true, captureStates: false, stabilize: false }));
    }
    const changes = changedScriptRanges(`@@ -1 +1 @@\n-${base}\n+${head}\n`, { base, head }, 'app.js');
    const result = classifyClassReach([maps[0]], [maps[1]], changes, [{ base: maps[0], head: maps[1] }]);
    expect(result.units.length).toBeGreaterThanOrEqual(2);
    expect(result.units.every((u) => u.status === 'unknown')).toBe(true);
    expect(
      maps.every(
        (m) => (m.classPresence?.outsideBody ?? 0) > 0 || Object.values(m.elements).some((e) => e.cls === 'clock'),
      ),
    ).toBe(true);
  });

for (const expression of [
  "clsx('tab', state === 'TOKEN' && 'tab-on')",
  "state === 'TOKEN' ? 'tab tab-on' : 'tab'",
  "({ TOKEN: 'tab tab-on' })[size]",
  "['TOKEN'].includes(state) ? 'tab tab-on' : 'tab'",
])
  test(`real capture predicates cannot lower J2: ${expression}`, async ({ page }) => {
    const base = `const state='active', size='active'; document.body.className=${expression.replace('TOKEN', 'active')};`;
    const head = `const state='selected', size='selected'; document.body.className=${expression.replace('TOKEN', 'selected')};`;
    const maps = [];
    for (const source of [base, head]) {
      await page.goto('about:blank');
      await page.setContent(
        `<style>.active,.selected{color:red}.tab{display:block}</style><body><script>const clsx=(...args)=>args.filter(Boolean).join(' ');${source}</script></body>`,
      );
      expect(await page.locator('body').getAttribute('class')).toBe('tab tab-on');
      maps.push(await captureStyleMap(page, { captureReach: true, captureStates: false, stabilize: false }));
    }
    const changes = changedScriptRanges(`@@ -1 +1 @@\n-${base}\n+${head}\n`, { base, head }, 'app.js');
    const result = classifyClassReach([maps[0]], [maps[1]], changes, [{ base: maps[0], head: maps[1] }]);
    expect(result.units.length).toBeGreaterThanOrEqual(2);
    expect(result.units.every((u) => !u.explicit)).toBe(true);
    const j2 = changes.map(({ sourceKey, side, range }) => ({
      sourceKey,
      side,
      range,
      execution: 'ran' as const,
      status: 'reached' as const,
      why: 'executed',
      level: 'warn' as const,
    }));
    expect(combineClassReach(j2, result.units).every((u) => u.status === 'reached')).toBe(true);
  });

test('default capture retains the pre-J3 output shape', async ({ page }) => {
  await page.setContent('<p>Hello</p>');
  const result = await captureStyleMap(page);
  expect(Object.keys(result).sort()).toEqual([
    'defaults',
    'elements',
    'stateComputedValueStyle',
    'stateLayers',
    'stateTargets',
    'states',
    'viewport',
  ]);
  expect(result).not.toHaveProperty('classPresence');
});
