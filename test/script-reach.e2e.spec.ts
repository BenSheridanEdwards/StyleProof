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
    const file = script?.files?.find((f) => f.sourceKey === 'original.js');
    expect(file?.executed.some((r) => (Array.isArray(r) ? r[0] : r.start.line) === 3)).toBe(true);
    expect(file?.unexecuted.some((r) => (Array.isArray(r) ? r[0] : r.start.line) === 5)).toBe(true);
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
    expect(map.scriptReach).toMatchObject({
      status: 'unmeasured',
      reason: 'page.coverage used during capture',
      scripts: [],
    });
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
    expect(map.scriptReach?.reason).toMatch(/page.coverage/);
    expect((await page.coverage.stopJSCoverage()).some((entry) => entry.url.endsWith('/bundle.js'))).toBe(true);
  } finally {
    await scriptReach.dispose();
  }
});

for (const mode of ['inline', 'header', 'x-header', 'malformed', 'missing-content'] as const) {
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
        body: original + (mode.endsWith('header') ? '' : `\n//# sourceMappingURL=${reference}`),
        contentType: 'application/javascript',
        headers: mode === 'header' ? { SourceMap: reference } : mode === 'x-header' ? { 'X-SourceMap': reference } : {},
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
      if (mode !== 'malformed')
        expect(script?.files?.[0].unexecuted.some((r) => (Array.isArray(r) ? r[0] : r.start.line) === 5)).toBe(true);
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
    if (drift) {
      await capture;
      expect(loadStyleMap(testInfo.outputPath('maps/branch@800.json.gz')).scriptReach).toMatchObject({
        status: 'unknown',
        reason: 'script evidence not reproducible: original.js:2',
      });
    } else {
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
    expect(map.scriptReach?.reason).toMatch(/page.coverage/);
    expect(
      (await page.coverage.stopJSCoverage()).some(
        (entry) =>
          entry.url.endsWith('/bundle.js') &&
          entry.functions.some((fn) => fn.ranges.some((range) => range.count === 0)),
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

test('review 2: pre-bound coverage methods cannot turn a shared session into measured-empty evidence', async ({
  page,
}) => {
  const start = page.coverage.startJSCoverage.bind(page.coverage);
  const stop = page.coverage.stopJSCoverage.bind(page.coverage);
  const tracker = await trackScriptReach(page);
  try {
    await start();
    await page.goto('https://script.test/');
    await stop();
    const map = await captureStyleMap(page, {
      captureScriptReach: true,
      scriptReach: tracker,
      stabilize: false,
      captureStates: false,
    });
    expect(map.scriptReach).toMatchObject({
      status: 'unmeasured',
      reason: 'page.coverage used during capture',
      scripts: [],
    });
  } finally {
    await tracker.dispose();
  }
});

test('review 9: an existing raw CDP coverage session keeps its unexecuted blocks', async ({ page }) => {
  const raw = await page.context().newCDPSession(page);
  await raw.send('Profiler.enable');
  await raw.send('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
  await page.goto('https://script.test/');
  const tracker = await trackScriptReach(page);
  await tracker.dispose();
  const result = await raw.send('Profiler.takePreciseCoverage');
  expect(
    result.result.find((e) => e.url.endsWith('/bundle.js'))?.functions.some((f) => f.ranges.some((r) => r.count === 0)),
  ).toBe(true);
  await raw.detach();
});

test('review 7: local maps do not require opening a browser page', async ({ page }) => {
  const browser = page.context().browser()!;
  const original = browser.newPage;
  browser.newPage = async () => {
    throw new Error('newPage unavailable in persistent context');
  };
  const tracker = await trackScriptReach(page);
  try {
    await page.goto(new URL('index.html', root).href);
    const map = await captureStyleMap(page, {
      captureScriptReach: true,
      scriptReach: tracker,
      stabilize: false,
      captureStates: false,
    });
    expect(map.scriptReach?.scripts.find((s) => s.url.endsWith('/bundle.js'))?.status).toBe('mapped');
  } finally {
    browser.newPage = original;
    await tracker.dispose();
  }
});

test('review 11: popup captures retain mapped navigation evidence', async ({ page }, testInfo) => {
  const { captureSurface } = await import('../dist/runner/surface-capture.js');
  const { resolveSettings } = await import('../dist/runner/settings.js');
  const { loadStyleMap } = await import('../dist/capture.js');
  await page.route('https://script.test/', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><body><button type="button" onclick="document.querySelector(\'dialog\').showModal()">Open panel</button><dialog>Panel</dialog><script src="bundle.js"></script></body>',
    }),
  );
  // Route-fulfilled scripts can retain renderer best-effort functions across reopens.
  // Keep this popup test focused on mapped evidence; real cache reuse has its own server regression.
  let scriptVisit = 0;
  await page.route('https://script.test/bundle.js', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: readFileSync(new URL('bundle.js', root), 'utf8') + `\n// popup visit ${++scriptVisit}\n`,
    }),
  );
  const settings = resolveSettings({
    dir: testInfo.outputPath('maps'),
    captureScriptReach: true,
    freezeClock: false,
    selfCheck: true,
    screenshots: false,
    popups: true,
  });
  await captureSurface(
    page,
    {
      key: 'popup',
      async go() {
        await page.goto('https://script.test/');
      },
    },
    800,
    settings,
    { index: 1, total: 1 },
  );
  const captured = loadStyleMap(testInfo.outputPath('maps/popup-popup-01@800.json.gz'));
  expect(captured.scriptReach?.scripts.some((s) => s.status === 'mapped')).toBe(true);
});

for (const variation of ['query', 'map-failure', 'third-party'] as const) {
  test(`review 5: runner preserves unknown evidence for ${variation} drift`, async ({ page }, testInfo) => {
    const { captureSurface } = await import('../dist/runner/surface-capture.js');
    const { resolveSettings } = await import('../dist/runner/settings.js');
    const { loadStyleMap } = await import('../dist/capture.js');
    let visits = 0;
    await page.route('https://script.test/', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><body><p>Ready</p><script src="bundle.js"></script><script src="unmapped.js?cache=${variation === 'query' ? visits : 0}"></script>${variation === 'third-party' && visits > 1 ? '<script src="https://vendor.test/widget.js"></script>' : ''}</body>`,
      }),
    );
    await page.route('https://vendor.test/widget.js', (route) =>
      route.fulfill({ contentType: 'application/javascript', body: 'document.body.dataset.vendor = "loaded";' }),
    );
    if (variation === 'map-failure')
      await page.route('https://script.test/bundle.js.map', (route) =>
        route.fulfill({
          status: visits > 1 ? 503 : 200,
          contentType: 'application/json',
          body: visits > 1 ? 'unavailable' : readFileSync(new URL('bundle.js.map', root), 'utf8'),
        }),
      );
    const settings = resolveSettings({
      dir: testInfo.outputPath('maps'),
      captureScriptReach: true,
      freezeClock: false,
      selfCheck: true,
      screenshots: false,
    });
    await captureSurface(
      page,
      {
        key: 'drift',
        async go() {
          visits++;
          await page.goto('https://script.test/');
        },
      },
      800,
      settings,
      { index: 1, total: 1 },
    );
    const evidence = loadStyleMap(testInfo.outputPath('maps/drift@800.json.gz')).scriptReach;
    if (variation === 'query') expect(evidence?.status).toBe('measured');
    else expect(evidence).toMatchObject({ status: 'unknown', reason: 'script evidence not reproducible' });
  });
}

test('review 5: blob script UUIDs never enter app execution evidence', async ({ page }) => {
  await page.route('https://script.test/', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><body><p>Ready</p><script>const s=document.createElement("script");s.src=URL.createObjectURL(new Blob(["document.body.dataset.ready=\'yes\'"],{type:"application/javascript"}));document.body.append(s);</script></body>',
    }),
  );
  const tracker = await trackScriptReach(page);
  try {
    await page.goto('https://script.test/');
    await page.waitForFunction(() => document.body.dataset.ready === 'yes');
    const map = await captureStyleMap(page, {
      captureScriptReach: true,
      scriptReach: tracker,
      captureStates: false,
      stabilize: false,
    });
    expect(map.scriptReach?.status).toBe('measured');
    expect(map.scriptReach?.scripts.find((script) => script.url === 'blob:')).toMatchObject({
      status: 'unmeasured',
      reason: 'blob script has no stable source map',
    });
  } finally {
    await tracker.dispose();
  }
});

test('review 7: file maps resolve in an actual persistent browser context', async ({ browser }, testInfo) => {
  const context = await browser
    .browserType()
    .launchPersistentContext(testInfo.outputPath('persistent-profile'), { headless: true });
  try {
    const page = context.pages()[0];
    const tracker = await trackScriptReach(page);
    try {
      await page.goto(new URL('index.html', root).href);
      const map = await captureStyleMap(page, {
        captureScriptReach: true,
        scriptReach: tracker,
        stabilize: false,
        captureStates: false,
      });
      expect(map.scriptReach?.scripts.find((s) => s.url.endsWith('/bundle.js'))?.status).toBe('mapped');
    } finally {
      await tracker.dispose();
    }
  } finally {
    await context.close();
  }
});

test('review 1/2: pre-bound active coverage remains precise after tracker disposal', async ({ page }) => {
  const start = page.coverage.startJSCoverage.bind(page.coverage);
  const stop = page.coverage.stopJSCoverage.bind(page.coverage);
  const tracker = await trackScriptReach(page);
  try {
    await start();
    await page.goto('https://script.test/');
    const map = await captureStyleMap(page, {
      captureScriptReach: true,
      scriptReach: tracker,
      captureStates: false,
      stabilize: false,
    });
    expect(map.scriptReach?.status).toBe('unmeasured');
    expect(
      (await stop()).some(
        (entry) =>
          entry.url.endsWith('/bundle.js') &&
          entry.functions.some(
            (fn) => fn.isBlockCoverage && fn.ranges.length > 1 && fn.ranges.some((range) => range.count === 0),
          ),
      ),
    ).toBe(true);
  } finally {
    await tracker.dispose();
  }
});

test('CSS and script reach controllers coexist without being mistaken for shared coverage', async ({ page }) => {
  const { trackServedRules } = await import('../dist/capture.js');
  const servedRules = await trackServedRules(page);
  const tracker = await trackScriptReach(page);
  try {
    await page.goto('https://script.test/');
    const map = await captureStyleMap(page, {
      captureReach: true,
      servedRules,
      captureScriptReach: true,
      scriptReach: tracker,
      captureStates: false,
      stabilize: false,
    });
    expect(map.scriptReach?.scripts.some((script) => script.status === 'mapped')).toBe(true);
    expect(map.reach?.version).toBe(2);
  } finally {
    await tracker.dispose();
    await servedRules.dispose();
  }
});
