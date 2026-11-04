import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { trackScriptReach } from '../dist/capture.js';
import { buildLargeReachBundle } from '../bench/fixtures/reach-cost/large-bundle.mjs';

async function serve(script: string, map?: object) {
  const server = createServer((request, response) => {
    response.writeHead(200, {
      'content-type': request.url?.endsWith('.map')
        ? 'application/json'
        : request.url?.endsWith('.js')
          ? 'application/javascript'
          : 'text/html',
    });
    response.end(
      request.url?.endsWith('.map')
        ? JSON.stringify(map)
        : request.url?.endsWith('.js')
          ? script
          : '<body><script>window.f=false;window.ok=window.bad=window.tail=()=>{};</script><script src="/app.js"></script>',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}/`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

test('false branch stores executed anchors only', async ({ page }) => {
  const source = 'ok(); if (f) bad(); tail();';
  const host = await serve(source + '\n//# sourceMappingURL=app.js.map', {
    version: 3,
    sources: ['src/app.js'],
    sourcesContent: [source],
    mappings: 'AAAA,aAAa,MAAb,CAAa,KAAM',
  });
  try {
    const tracker = await trackScriptReach(page);
    await page.goto(host.url);
    const script = (await tracker.stop()).scripts.find((s) => s.url.endsWith('/app.js'));
    expect(script?.status).toBe('mapped');
    expect(script?.files?.[0].executed.every((r) => r[1] === r[2])).toBe(true);
  } finally {
    await host.close();
  }
});

test('webpack eval scripts remain visible as unsupported unmeasured entries', async ({ page }) => {
  const host = await serve('eval("window.ready=true;\\n//# sourceURL=webpack-internal:///./src/eval.js")');
  try {
    const tracker = await trackScriptReach(page);
    await page.goto(host.url);
    expect(
      (await tracker.stop()).scripts.some(
        (s) =>
          s.status === 'unmeasured' && s.reason === 'unsupported script URL' && s.url.startsWith('webpack-internal:'),
      ),
    ).toBe(true);
  } finally {
    await host.close();
  }
});

test('CDP map reads are invisible to page fetch patches and request listeners', async ({ page }) => {
  const script = 'window.ready=true;\n//# sourceMappingURL=app.js.map';
  const host = await serve(script, {
    version: 3,
    sources: ['src/app.js'],
    sourcesContent: ['window.ready=true;'],
    mappings: 'AAAA',
  });
  try {
    const tracker = await trackScriptReach(page);
    await page.goto(host.url);
    await page.evaluate(() => {
      (window as unknown as { mapFetchCalled: boolean }).mapFetchCalled = false;
      window.fetch = async () => {
        (window as unknown as { mapFetchCalled: boolean }).mapFetchCalled = true;
        throw new Error('page fetch patched');
      };
    });
    const requests: string[] = [];
    page.on('request', (request) => requests.push(request.url()));
    expect((await tracker.stop()).scripts.find((s) => s.url.endsWith('/app.js'))?.status).toBe('mapped');
    expect(requests.some((url) => url.endsWith('.map'))).toBe(false);
    expect(await page.evaluate(() => (window as unknown as { mapFetchCalled: boolean }).mapFetchCalled)).toBe(false);
  } finally {
    await host.close();
  }
});

test('a realistic 1–2 MiB React bundle maps despite more than 100k total segments', async ({ page }) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'reach-large-bundle-'));
  try {
    const built = await buildLargeReachBundle(directory);
    expect(built.bytes).toBeGreaterThan(1024 * 1024);
    expect(built.bytes).toBeLessThan(2 * 1024 * 1024);
    const map = JSON.parse(await readFile(path.join(directory, 'large.js.map'), 'utf8'));
    const total = map.mappings.split(/[;,]/).filter(Boolean).length;
    expect(total).toBeGreaterThan(100_000);
    const tracker = await trackScriptReach(page);
    await page.goto(built.url);
    const evidence = await tracker.stop();
    const script = evidence.scripts.find((s) => s.url === 'file:' || s.url.endsWith('/large.js'));
    expect(script?.status, JSON.stringify(script)).toBe('mapped');
    expect(script?.files?.some((f) => f.sourceKey === 'bench/fixtures/reach-cost/catalogue.jsx')).toBe(true);
    process.stdout.write(`LARGE BUNDLE: ${built.bytes} bytes, ${total} segments, status ${script?.status}\n`);
  } finally {
    for (const name of await readdir(directory)) await unlink(path.join(directory, name));
    await rmdir(directory);
  }
});

test('V8 block evidence retains explicit expression-evaluation residuals', async ({ page }) => {
  const { transform } = await import('esbuild');
  const original = [
    'window.faultCalls = 0;',
    'function renderFault() { window.faultCalls++; return "fault"; }',
    'function parameter(tone = renderFault()) { return tone; }',
    'function destructure({ style = renderFault() }) { return style; }',
    'let or = "ok"; or ||= renderFault();',
    'let and = false; and &&= renderFault();',
    'let nullish = "ok"; nullish ??= renderFault();',
    'let fault = null; fault?.message.toUpperCase();',
    'parameter("ok"); destructure({ style: "ok" });',
  ].join('\n');
  const built = await transform(original, { sourcefile: 'src/residual.js', sourcemap: 'external', minify: true });
  const host = await serve(built.code + '\n//# sourceMappingURL=app.js.map', JSON.parse(built.map));
  try {
    const tracker = await trackScriptReach(page);
    await page.goto(host.url);
    const evidence = await tracker.stop();
    expect(await page.evaluate(() => (window as unknown as { faultCalls: number }).faultCalls)).toBe(0);
    const file = evidence.scripts.find((s) => s.url.endsWith('/app.js'))?.files?.[0];
    // 2.2 must NOT treat these lines as reached: V8 reports their containing block only.
    for (const line of [3, 4, 5, 6, 7, 8]) expect(file?.executed.some((span) => span[0] === line)).toBe(true);
    expect(evidence.notes?.join(' ')).toMatch(
      /default parameter.*destructuring default.*logical assignment.*optional chain/,
    );
  } finally {
    await host.close();
  }
});

test('runner uses the CDP map loader outside its replay matcher', async ({ page }, testInfo) => {
  const { captureSurface } = await import('../dist/runner/surface-capture.js');
  const { resolveSettings } = await import('../dist/runner/settings.js');
  const { loadStyleMap } = await import('../dist/capture.js');
  const host = await serve('window.ready=true;\n//# sourceMappingURL=app.js.map', {
    version: 3,
    sources: ['src/app.js'],
    sourcesContent: ['window.ready=true;'],
    mappings: 'AAAA',
  });
  try {
    const settings = resolveSettings({
      dir: testInfo.outputPath('maps'),
      captureScriptReach: true,
      selfCheck: false,
      screenshots: false,
      freezeClock: false,
      replayUrl: '**/api/**',
    });
    const requests: string[] = [];
    page.on('request', (r) => requests.push(r.url()));
    await captureSurface(
      page,
      {
        key: 'reader',
        async go() {
          await page.goto(host.url);
          await page.evaluate(() => {
            window.fetch = async () => {
              throw new Error('page fetch must not read map');
            };
          });
        },
      },
      800,
      settings,
      { index: 1, total: 1 },
    );
    expect(
      loadStyleMap(testInfo.outputPath('maps/reader@800.json.gz')).scriptReach?.scripts.find((s) =>
        s.url.endsWith('/app.js'),
      )?.status,
    ).toBe('mapped');
    expect(requests.some((url) => url.endsWith('.map'))).toBe(false);
  } finally {
    await host.close();
  }
});

test('capture excludes Playwright evaluations and preserves page anonymous eval', async ({ page }) => {
  const host = await serve('eval("window.fromPage=true")');
  try {
    const tracker = await trackScriptReach(page);
    await page.goto(host.url);
    for (let i = 0; i < 4; i++) await page.evaluate(() => document.body.textContent);
    const evidence = await tracker.stop();
    expect(evidence.scripts.filter((s) => s.url === '<anonymous>')).toHaveLength(1);
    expect(evidence.scripts.find((s) => s.url === '<anonymous>')?.status).toBe('unmeasured');
  } finally {
    await host.close();
  }
});

test('V8 block entry cannot prove code after a throwing call', async ({ page }) => {
  const { transform } = await import('esbuild');
  const original = [
    'window.afterCall=false;',
    'function fetchFault(){throw new Error("fixture");}',
    'try {',
    '  fetchFault();',
    '  window.afterCall=true;',
    '} catch {}',
  ].join('\n');
  const built = await transform(original, { sourcefile: 'src/throwing-call.js', sourcemap: 'external', minify: true });
  const host = await serve(built.code + '\n//# sourceMappingURL=app.js.map', JSON.parse(built.map));
  try {
    const tracker = await trackScriptReach(page);
    await page.goto(host.url);
    const evidence = await tracker.stop();
    expect(await page.evaluate(() => (window as unknown as { afterCall: boolean }).afterCall)).toBe(false);
    const file = evidence.scripts.find((s) => s.url.endsWith('/app.js'))?.files?.[0];
    // 2.2 must keep this unknown: V8 counts entry to the block, not continuation after calls.
    expect(file?.executed.some((span) => span[0] === 5)).toBe(true);
    expect(evidence.notes?.join(' ')).toMatch(
      /block was entered; code after a call that threw in that block is not proved/,
    );
  } finally {
    await host.close();
  }
});

test('a no-script page with locator textContent leaves zero script entries', async ({ page }) => {
  await page.route('https://injected.test/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<div>Ready</div>' }),
  );
  const tracker = await trackScriptReach(page);
  await page.goto('https://injected.test/');
  expect(await page.locator('div').textContent()).toBe('Ready');
  const evidence = await tracker.stop();
  expect(evidence.status).toBe('measured');
  expect(evidence.scripts).toEqual([]);
});
