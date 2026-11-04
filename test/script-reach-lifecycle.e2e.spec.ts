import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { transform } from 'esbuild';
import { trackScriptReach } from '../dist/capture.js';
import { assertDeterministicScriptReach } from '../dist/runner/self-check.js';

async function serve(assets: Record<string, string>) {
  const server = createServer((request, response) => {
    const name = new URL(request.url!, 'http://fixture.test').pathname;
    response.writeHead(200, {
      'content-type': name.endsWith('.map')
        ? 'application/json'
        : name.endsWith('.js')
          ? 'application/javascript'
          : 'text/html',
      'cache-control': 'max-age=3600',
    });
    response.end(assets[name] ?? '<body>Ready<script src="/bundle.js"></script>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}
const root = new URL('./fixtures/script-reach/', import.meta.url);
const fixture = {
  '/bundle.js': readFileSync(new URL('bundle.js', root), 'utf8'),
  '/bundle.js.map': readFileSync(new URL('bundle.js.map', root), 'utf8'),
};

test('browser false branch is never executed through an unmapped gap', async ({ page }) => {
  const text = 'ok(); if (f) bad(); tail();';
  const map = { version: 3, sources: ['src/app.js'], sourcesContent: [text], mappings: 'AAAA,K,cAAmB' };
  const host = await serve({
    '/': '<body><script>window.f=false;window.ok=window.bad=window.tail=()=>{};</script><script src="/bundle.js"></script>',
    '/bundle.js': text + '\n//# sourceMappingURL=bundle.js.map',
    '/bundle.js.map': JSON.stringify(map),
  });
  try {
    const tracker = await trackScriptReach(page);
    await page.goto(host.url);
    const result = await tracker.stop();
    const file = result.scripts.find((s) => s.url.endsWith('/bundle.js'))?.files?.[0];
    expect(file).toBeDefined();
    expect(file!.executed.every((r) => r[2] <= 13 || r[1] >= 19)).toBe(true);
  } finally {
    await host.close();
  }
});

test('four cacheable navigations on one page retain precise evidence', async ({ page }) => {
  const host = await serve(fixture);
  try {
    for (let visit = 0; visit < 4; visit++) {
      const tracker = await trackScriptReach(page);
      await page.goto(host.url);
      const result = await tracker.stop();
      expect(result.status, JSON.stringify(result)).toBe('measured');
      expect(result.scripts.find((s) => s.url.endsWith('/bundle.js'))?.status).toBe('mapped');
    }
  } finally {
    await host.close();
  }
});

test('arming after a debugger interval cannot hang the next navigation', async ({ page }) => {
  const host = await serve({ ...fixture, '/paused': '<body><script>setInterval(()=>{debugger},0)</script>' });
  try {
    await page.goto(host.url + 'paused');
    const tracker = await trackScriptReach(page);
    await page.goto(host.url, { timeout: 3000 });
    expect((await tracker.stop()).status).toBe('measured');
  } finally {
    await host.close();
  }
});

test('localStorage first and repeat visits record named unknown evidence', async ({ page }) => {
  const text = 'if(localStorage.seen){window.result=1;}else{window.result=2;}localStorage.seen="yes";';
  const built = await transform(text, { sourcemap: 'external', sourcefile: 'src/visit.js', minify: true });
  const host = await serve({
    '/bundle.js': built.code + '\n//# sourceMappingURL=bundle.js.map',
    '/bundle.js.map': built.map,
  });
  try {
    const maps = [];
    for (let i = 0; i < 2; i++) {
      const t = await trackScriptReach(page);
      await page.goto(host.url);
      maps.push({ scriptReach: await t.stop() });
    }
    expect(() => assertDeterministicScriptReach(maps[0], maps[1], 'home')).not.toThrow();
    expect(maps[0].scriptReach.status).toBe('unknown');
    expect(maps[0].scriptReach.reason).toMatch(/^script evidence not reproducible: src\/visit.js:1$/);
  } finally {
    await host.close();
  }
});

test('app-sized evidence uses compact spans under the per-script cap', async ({ page }) => {
  const original = Array.from(
    { length: 2200 },
    (_, i) => `function f${i}(flag) {\n if(flag) return ${i};\n return -${i};\n}\nf${i}(${i % 2 === 0});`,
  ).join('\n');
  const built = await transform(original, { sourcemap: 'external', sourcefile: 'src/application.js', minify: true });
  const host = await serve({
    '/bundle.js': built.code + '\n//# sourceMappingURL=bundle.js.map',
    '/bundle.js.map': built.map,
  });
  try {
    const t = await trackScriptReach(page);
    await page.goto(host.url);
    const evidence = await t.stop();
    const script = evidence.scripts.find((s) => s.url.endsWith('/bundle.js'));
    expect(script?.status, JSON.stringify(script)).toBe('mapped');
    expect(script?.files?.[0].encoding).toBe('line-column-tuples');
    expect(Array.isArray(script?.files?.[0].executed[0])).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(script))).toBeLessThan(1024 * 1024);
  } finally {
    await host.close();
  }
});

test('browser HTTP scripts cannot read a file source map', async ({ page }) => {
  const host = await serve({
    '/bundle.js': 'window.ready=true;\n//# sourceMappingURL=' + new URL('bundle.js.map', root).href,
  });
  try {
    const t = await trackScriptReach(page);
    await page.goto(host.url);
    expect((await t.stop()).scripts.find((s) => s.url.endsWith('/bundle.js'))).toMatchObject({
      status: 'unknown',
      reason: 'file source map refused for non-file script',
    });
  } finally {
    await host.close();
  }
});

test('browser map routing cannot be bypassed with the CDP fallback', async ({ page }) => {
  const host = await serve(fixture);
  try {
    await page.route(host.url + 'bundle.js.map', (route) => route.abort());
    const t = await trackScriptReach(page);
    await page.goto(host.url);
    expect((await t.stop()).scripts.find((s) => s.url.endsWith('/bundle.js'))).toMatchObject({
      status: 'unknown',
      reason: 'source map fallback refused during routing or HAR replay',
    });
  } finally {
    await host.close();
  }
});

test('an HTTP page cannot spoof a file script URL to read local maps', async ({ page }, testInfo) => {
  const mapPath = testInfo.outputPath('private.map');
  writeFileSync(
    mapPath,
    JSON.stringify({ version: 3, sources: ['src/a.js'], sourcesContent: ['window.ready=true;'], mappings: 'AAAA' }),
  );
  const mapUrl = pathToFileURL(mapPath).href;
  const sourceUrl = pathToFileURL(testInfo.outputPath('synthetic-source.js')).href;
  const host = await serve({
    '/bundle.js': `window.ready=true;\n//# sourceURL=${sourceUrl}\n//# sourceMappingURL=${mapUrl}`,
  });
  try {
    const tracker = await trackScriptReach(page);
    await page.goto(host.url);
    const evidence = await tracker.stop();
    expect(evidence.scripts.find((script) => script.url.startsWith('file:'))).toMatchObject({
      status: 'unknown',
      reason: 'file source map refused for non-file script',
    });
  } finally {
    await host.close();
  }
});
