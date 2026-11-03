import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { captureStyleMap, trackScriptReach } from '../dist/capture.js';

const root = new URL('./fixtures/script-reach/', import.meta.url);

test.beforeEach(async ({ page }) => {
  await page.route('https://script.test/**', async (route) => {
    const name = new URL(route.request().url()).pathname.slice(1) || 'index.html';
    await route.fulfill({
      body: readFileSync(new URL(name, root)),
      contentType: name.endsWith('.html') ? 'text/html' : 'application/javascript',
    });
  });
});

test('navigation coverage records branches at ORIGINAL lines and unmapped scripts as unmeasured', async ({ page }) => {
  const scriptReach = await trackScriptReach(page);
  try {
    await page.goto('https://script.test/');
    const map = await captureStyleMap(page, {
      captureScriptReach: true,
      scriptReach,
      captureStates: false,
      stabilize: false,
    });
    expect(map.scriptReach?.window).toBe('navigation');
    const script = map.scriptReach?.scripts.find((s) => s.url === 'https://script.test/bundle.js');
    expect(script?.status).toBe('mapped');
    const file = script?.files?.find((f) => f.source === 'https://script.test/original.js');
    expect(file?.executed.some((r) => r.start.line === 3)).toBe(true);
    expect(file?.unexecuted.some((r) => r.start.line === 5)).toBe(true);
    expect(map.scriptReach?.scripts.find((s) => s.url.endsWith('/unmapped.js'))).toMatchObject({
      status: 'unmeasured',
      reason: 'source map absent',
    });
    process.stdout.write(`ORIGINAL branch evidence: ${JSON.stringify(file)}\n`);
  } finally {
    await scriptReach.dispose();
  }
});

test('page.coverage interference invalidates script evidence without failing capture', async ({ page }) => {
  const scriptReach = await trackScriptReach(page);
  try {
    await page.goto('https://script.test/');
    await page.coverage.startJSCoverage();
    await page.coverage.stopJSCoverage();
    const map = await captureStyleMap(page, {
      captureScriptReach: true,
      scriptReach,
      captureStates: false,
      stabilize: false,
    });
    expect(map.scriptReach).toMatchObject({ status: 'unmeasured', reason: 'shared V8 precise coverage', scripts: [] });
  } finally {
    await scriptReach.dispose();
  }
});

test('opt-in without a pre-navigation tracker is unmeasured; default stays absent', async ({ page }) => {
  await page.goto('https://script.test/');
  expect((await captureStyleMap(page, { captureStates: false, stabilize: false })).scriptReach).toBeUndefined();
  expect(
    (await captureStyleMap(page, { captureScriptReach: true, captureStates: false, stabilize: false })).scriptReach
      ?.status,
  ).toBe('unmeasured');
});

test('coverage already owned by the spec stays unmeasured and leaves its session usable', async ({ page }) => {
  await page.coverage.startJSCoverage();
  const scriptReach = await trackScriptReach(page);
  try {
    await page.goto('https://script.test/');
    const map = await captureStyleMap(page, {
      captureScriptReach: true,
      scriptReach,
      stabilize: false,
      captureStates: false,
    });
    expect(map.scriptReach?.reason).toBe('shared V8 precise coverage');
    expect((await page.coverage.stopJSCoverage()).some((entry) => entry.url.endsWith('/bundle.js'))).toBe(true);
  } finally {
    await scriptReach.dispose();
  }
});

for (const mode of ['inline', 'header', 'malformed', 'missing-content'] as const) {
  test(`source-map acquisition: ${mode}`, async ({ page }) => {
    const original = readFileSync(new URL('bundle.js', root), 'utf8').replace(/\/\/# sourceMappingURL=.*\n?/, '');
    const map = JSON.parse(readFileSync(new URL('bundle.js.map', root), 'utf8'));
    if (mode === 'missing-content') delete map.sourcesContent;
    const reference =
      mode === 'inline'
        ? `data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString('base64')}`
        : 'branch.map';
    await page.route('https://script.test/bundle.js', (route) =>
      route.fulfill({
        body: original + (mode === 'header' ? '' : `\n//# sourceMappingURL=${reference}`),
        contentType: 'application/javascript',
        headers: mode === 'header' ? { SourceMap: reference } : {},
      }),
    );
    await page.route('https://script.test/branch.map', (route) =>
      route.fulfill({ body: mode === 'malformed' ? '{bad' : JSON.stringify(map), contentType: 'application/json' }),
    );
    const scriptReach = await trackScriptReach(page);
    try {
      await page.goto('https://script.test/');
      const captured = await captureStyleMap(page, {
        captureScriptReach: true,
        scriptReach,
        captureStates: false,
        stabilize: false,
      });
      const script = captured.scriptReach?.scripts.find((s) => s.url.endsWith('/bundle.js'));
      expect(script?.status).toBe(mode === 'malformed' ? 'unknown' : 'mapped');
      if (mode === 'missing-content') expect(script?.files?.[0].contentHash).toBeUndefined();
      if (mode !== 'malformed') expect(script?.files?.[0].unexecuted.some((r) => r.start.line === 5)).toBe(true);
    } finally {
      await scriptReach.dispose();
    }
  });
}

for (const drift of [false, true]) {
  test(`runner captures and self-checks mapped execution: drift=${drift}`, async ({ page }, testInfo) => {
    const { captureSurface } = await import('../dist/runner/surface-capture.js');
    const { resolveSettings } = await import('../dist/runner/settings.js');
    const { loadStyleMap } = await import('../dist/capture.js');
    const settings = resolveSettings({
      dir: testInfo.outputPath('maps'),
      captureScriptReach: true,
      freezeClock: false,
      selfCheck: true,
      screenshots: false,
    });
    let navigations = 0;
    await page.route('https://script.test/bundle.js', (route) => {
      const source = readFileSync(new URL('bundle.js', root), 'utf8');
      return route.fulfill({
        body: source.replace('c(true)', drift && navigations > 1 ? 'c(false)' : 'c(true)'),
        contentType: 'application/javascript',
      });
    });
    const surface = {
      key: 'branch',
      async go() {
        navigations++;
        await page.goto('https://script.test/');
      },
    };
    const capture = captureSurface(page, surface, 800, settings, { index: 1, total: 1 });
    if (drift)
      await expect(capture).rejects.toThrow(/self-check failed.*original-source script reach evidence changed/);
    else {
      await capture;
      expect(
        loadStyleMap(testInfo.outputPath('maps/branch@800.json.gz')).scriptReach?.scripts.some(
          (s) => s.status === 'mapped',
        ),
      ).toBe(true);
    }
  });
}

test('tracker armed after navigation does not claim navigation-window evidence', async ({ page }) => {
  await page.goto('https://script.test/');
  const scriptReach = await trackScriptReach(page);
  try {
    const map = await captureStyleMap(page, {
      captureScriptReach: true,
      scriptReach,
      stabilize: false,
      captureStates: false,
    });
    expect(map.scriptReach).toMatchObject({
      status: 'unmeasured',
      reason: 'navigation not observed after tracker start',
    });
  } finally {
    await scriptReach.dispose();
  }
});

test('a spec starting coverage during capture retains a usable session', async ({ page }) => {
  const scriptReach = await trackScriptReach(page);
  await page.coverage.startJSCoverage();
  try {
    await page.goto('https://script.test/');
    const map = await captureStyleMap(page, {
      captureScriptReach: true,
      scriptReach,
      captureStates: false,
      stabilize: false,
    });
    expect(map.scriptReach?.reason).toBe('shared V8 precise coverage');
    expect(
      (await page.coverage.stopJSCoverage()).some(
        (entry) =>
          entry.url.endsWith('/bundle.js') && entry.functions.some((fn) => fn.ranges.some((range) => range.count > 0)),
      ),
    ).toBe(true);
  } finally {
    await scriptReach.dispose();
  }
});

test('page resolves local file source maps used by the cost fixtures', async ({ page }) => {
  const scriptReach = await trackScriptReach(page);
  try {
    await page.goto(new URL('index.html', root).href);
    const map = await captureStyleMap(page, {
      captureScriptReach: true,
      scriptReach,
      stabilize: false,
      captureStates: false,
    });
    expect(map.scriptReach?.scripts.find((s) => s.url.endsWith('/bundle.js'))?.status).toBe('mapped');
  } finally {
    await scriptReach.dispose();
  }
});

test('same-document hash navigation cannot recover earlier module execution', async ({ page }) => {
  await page.goto('https://script.test/');
  const scriptReach = await trackScriptReach(page);
  try {
    await page.goto('https://script.test/#state');
    const map = await captureStyleMap(page, {
      captureScriptReach: true,
      scriptReach,
      stabilize: false,
      captureStates: false,
    });
    expect(map.scriptReach?.status).toBe('unmeasured');
  } finally {
    await scriptReach.dispose();
  }
});
