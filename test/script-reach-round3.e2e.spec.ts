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

test('R3.1 QA false branch stores executed anchors only', async ({ page }) => {
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
    expect(
      script?.files?.[0].executed.every((r) => (Array.isArray(r) ? r[1] === r[2] : r.start.column === r.end.column)),
    ).toBe(true);
  } finally {
    await host.close();
  }
});

test('R3.4 webpack eval scripts remain visible as unsupported unmeasured entries', async ({ page }) => {
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

test('R3.10 CDP map reads are invisible to page fetch patches and request listeners', async ({ page }) => {
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

test('R3.6 a realistic 1–2 MiB React bundle maps despite more than 100k total segments', async ({ page }) => {
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
