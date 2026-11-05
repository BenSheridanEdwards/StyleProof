import { test, expect } from '@playwright/test';
import { captureStyleMap } from '../dist/capture.js';
import { classifyClassReach, combineClassReach } from '../dist/class-join.js';
import { changedScriptRanges } from '../dist/script-join-git.js';

for (const [name, build] of [
  ['html child', "const el=document.createElement('div'); document.documentElement.appendChild(el);"],
  [
    'closed shadow',
    "const host=document.createElement('div'); document.body.append(host); const root=host.attachShadow({mode:'closed'}); const el=document.createElement('span'); root.append(el);",
  ],
  ['object document', "const el=document.querySelector('span');"],
  ['embed document', "const el=document.querySelector('span');"],
])
  test(`real capture leaves absence unknown for ${name}`, async ({ page }) => {
    let nestedSource = '';
    await page.route('https://nested.test/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: `<span>Nested</span><script>${nestedSource}</script>` }),
    );
    await page.route('https://outer.test/**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<style>.clock{color:red}</style><body>${name.startsWith('object') ? '<object type="text/html" data="https://nested.test/"></object>' : '<embed type="text/html" src="https://nested.test/"/>'}</body>`,
      }),
    );
    const before = build + " el.className='clock';";
    const after = build + " const CLS='clock'; el.className=CLS;";
    const maps = [];
    for (const source of [before, after]) {
      await page.goto('about:blank');
      if (name.endsWith('document')) {
        nestedSource = source;
        await page.goto('https://outer.test/');
        const nested = page.frames().find((frame) => frame.url().startsWith('https://nested.test/'));
        expect(nested).toBeTruthy();
        await nested!.waitForFunction(
          () => document.querySelector('span')?.className === 'clock',
          {},
          { timeout: 5000 },
        );
      } else await page.setContent(`<style>.clock{color:red}</style><body><script>${source}</script></body>`);
      const map = await captureStyleMap(page, { captureReach: true, captureStates: false, stabilize: false });
      maps.push(map);
    }
    const changes = changedScriptRanges(
      `@@ -1 +1 @@\n-${before}\n+${after}\n`,
      { base: before, head: after },
      'app.js',
    );
    const result = classifyClassReach([maps[0]], [maps[1]], changes, [{ base: maps[0], head: maps[1] }]);
    expect(result.units.length).toBeGreaterThanOrEqual(2);
    expect(result.units.every((u) => u.status === 'unknown')).toBe(true);
    const scripts = changes.map(({ sourceKey, side, range }) => ({
      sourceKey,
      side,
      range,
      execution: 'ran' as const,
      status: 'reached' as const,
      why: 'statement executed',
      level: 'warn' as const,
    }));
    expect(combineClassReach(scripts, result.units).every((u) => u.status === 'reached')).toBe(true);
    for (const map of maps) {
      expect(map.classPresence?.version).toBe(2);
      if (name === 'html child') expect(map.classPresence?.outsideBody).toBeGreaterThan(0);
      if (name === 'closed shadow') expect(map.classPresence?.shadowHosts).toBeGreaterThan(0);
      if (name.endsWith('document')) expect(map.classPresence?.frames).toBeGreaterThan(0);
    }
  });

for (const call of ["remove('clock')", "contains('clock')", "toggle('clock', false)", "replace('clock', 'card')"])
  test(`real capture ${call} refactor cannot lower J2`, async ({ page }) => {
    const before = `document.body.classList.${call};`;
    const after = `const OPEN='clock'; document.body.classList.${call.replace("'clock'", 'OPEN')};`;
    const maps = [];
    for (const source of [before, after]) {
      await page.goto('about:blank');
      await page.setContent(`<style>.clock{color:red}.card{color:blue}</style><body><script>${source}</script></body>`);
      maps.push(await captureStyleMap(page, { captureReach: true, captureStates: false, stabilize: false }));
    }
    const changes = changedScriptRanges(
      `@@ -1 +1 @@\n-${before}\n+${after}\n`,
      { base: before, head: after },
      'app.js',
    );
    const result = classifyClassReach([maps[0]], [maps[1]], changes, [{ base: maps[0], head: maps[1] }]);
    const scripts = changes.map(({ sourceKey, side, range }) => ({
      sourceKey,
      side,
      range,
      execution: 'ran' as const,
      status: 'reached' as const,
      why: 'statement executed',
      level: 'warn' as const,
    }));
    expect(result.units.every((u) => !u.explicit)).toBe(true);
    expect(combineClassReach(scripts, result.units).every((u) => u.status === 'reached')).toBe(true);
  });

for (const markup of [
  '<next-route-announcer></next-route-announcer>',
  '<div id="__next-route-announcer__"></div>',
  '<next-route-announcer></next-route-announcer><script>document.querySelector("next-route-announcer").attachShadow({mode:"open"}).innerHTML="<span>Announcement</span>";</script>',
  '<div id="__next-route-announcer__"></div><script>document.querySelector("div").attachShadow({mode:"closed"}).innerHTML="<span>Announcement</span>";</script>',
])
  test(`framework exemption permits absence: ${markup}`, async ({ page }) => {
    await page.setContent(`<style>.old{color:red}.new{color:blue}</style><body>${markup}</body>`);
    const map = await captureStyleMap(page, { captureReach: true, captureStates: false, stabilize: false });
    const before = 'el.className="old"',
      after = 'el.className="new"';
    const changes = changedScriptRanges(
      `@@ -1 +1 @@\n-${before}\n+${after}\n`,
      { base: before, head: after },
      'app.js',
    );
    const result = classifyClassReach([map], [map], changes, [{ base: map, head: map }]);
    expect(map.classPresence?.ignored).toBe(false);
    expect(result.units.every((u) => u.status === 'never-rendered')).toBe(true);
  });

test('user-agent shadow roots do not prevent absence proof', async ({ page }) => {
  await page.setContent('<style>.old{color:red}.new{color:blue}</style><body><input type="range"/></body>');
  const map = await captureStyleMap(page, { captureReach: true, captureStates: false, stabilize: false });
  expect(map.classPresence?.shadowHosts).toBe(0);
  expect(map.classPresence?.shadowRootsVerified).toBe(true);
  const before = 'el.className="old"',
    after = 'el.className="new"';
  const changes = changedScriptRanges(`@@ -1 +1 @@\n-${before}\n+${after}\n`, { base: before, head: after }, 'app.js');
  expect(
    classifyClassReach([map], [map], changes, [{ base: map, head: map }]).units.every(
      (u) => u.status === 'never-rendered',
    ),
  ).toBe(true);
});

test('an untraversed frame outside body is also an omission', async ({ page }) => {
  await page.setContent('<style>.old{color:red}.new{color:blue}</style><body></body>');
  await page.evaluate(() => {
    const frame = document.createElement('iframe');
    frame.srcdoc = '<span class="old">Nested</span>';
    document.head.appendChild(frame);
  });
  const map = await captureStyleMap(page, { captureReach: true, captureStates: false, stabilize: false });
  expect(map.classPresence?.frames).toBe(1);
  const before = 'el.className="old"',
    after = 'el.className="new"';
  const changes = changedScriptRanges(`@@ -1 +1 @@\n-${before}\n+${after}\n`, { base: before, head: after }, 'app.js');
  expect(
    classifyClassReach([map], [map], changes, [{ base: map, head: map }]).units.every((u) => u.status === 'unknown'),
  ).toBe(true);
});
