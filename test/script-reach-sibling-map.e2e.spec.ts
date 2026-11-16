import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { trackScriptReach } from '../dist/capture.js';
import { scriptMapRequests } from '../dist/capture/script-map-resources.js';

const map = {
  version: 3,
  file: 'app.js',
  sources: ['src/app.js'],
  sourcesContent: ['window.ready=true;'],
  mappings: 'AAAA',
};

async function serve(handler: Parameters<typeof createServer>[0]) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function hiddenPage(script: string, mapBody: string, status = 200) {
  const probes: string[] = [];
  return {
    probes,
    handler: ((req, res) => {
      if (req.url?.includes('.map')) {
        probes.push(req.url);
        res.writeHead(status);
        res.end(mapBody);
      } else if (req.url?.startsWith('/app.js')) {
        res.writeHead(200, { 'content-type': 'application/javascript' });
        res.end(script);
      } else res.end('<script src="/app.js?v=1#x"></script>');
    }) as Parameters<typeof createServer>[0],
  };
}

for (const [name, body, status, expected] of [
  ['a hidden sibling map is measured', JSON.stringify(map), 200, 'mapped'],
  ['nested file is mapped', JSON.stringify({ ...map, file: 'static/js/app.js' }), 200, 'mapped'],
  ['a missing sibling stays source map absent', '', 404, 'unmeasured'],
  ['HTML sibling fallback stays source map absent', '<html>fallback</html>', 200, 'unmeasured'],
  ['non-JSON sibling stays source map absent', 'no json', 200, 'unmeasured'],
  ['a sibling with version !== 3 stays source map absent', JSON.stringify({ ...map, version: 2 }), 200, 'unmeasured'],
  [
    'a sibling naming another script stays source map absent',
    JSON.stringify({ ...map, file: 'other.js' }),
    200,
    'unmeasured',
  ],
] as const) {
  test(name, async ({ page }) => {
    const { probes, handler } = hiddenPage('window.ready=true;', body, status);
    const host = await serve(handler);
    try {
      const tracker = await trackScriptReach(page);
      await page.goto(`${host.url}/`);
      const script = (await tracker.stop()).scripts.find((s) => s.url.includes('/app.js'));
      expect(script?.status).toBe(expected);
      if (expected === 'unmeasured') expect(script?.reason).toBe('source map absent');
      expect(probes).toEqual(['/app.js.map']);
    } finally {
      await host.close();
    }
  });
}

test('a file page reads a sibling map on disk', async ({ page }, testInfo) => {
  const dir = testInfo.outputPath('file-page');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'app.js'), 'window.ready=true;');
  writeFileSync(path.join(dir, 'app.js.map'), JSON.stringify(map));
  writeFileSync(path.join(dir, 'index.html'), '<script src="./app.js"></script>');
  const tracker = await trackScriptReach(page, { projectRoot: dir });
  await page.goto(pathToFileURL(path.join(dir, 'index.html')).href);
  const script = (await tracker.stop()).scripts.find((s) => s.url.endsWith('/app.js') || s.url.includes('app.js'));
  expect(script?.status).toBe('mapped');
});

test('an HTTP page never probes a file sibling', async ({ page }, testInfo) => {
  const dir = testInfo.outputPath('http-no-file');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'app.js'), 'window.ready=true;');
  writeFileSync(path.join(dir, 'app.js.map'), JSON.stringify(map));
  const sourceUrl = pathToFileURL(path.join(dir, 'app.js')).href;
  const host = await serve((req, res) => {
    if (req.url?.startsWith('/app.js')) {
      res.writeHead(200, { 'content-type': 'application/javascript' });
      res.end(`window.ready=true;\n//# sourceURL=${sourceUrl}`);
    } else res.end('<script src="/app.js"></script>');
  });
  try {
    const tracker = await trackScriptReach(page);
    await page.goto(`${host.url}/`);
    const script = (await tracker.stop()).scripts.find((s) => s.url.startsWith('file:') || s.url.includes('app.js'));
    expect(script?.status).toBe('unmeasured');
    expect(script?.reason).toBe('source map absent');
  } finally {
    await host.close();
  }
});

test('routing with no sibling HAR entry stays source map absent and records the probe', async ({ page }) => {
  const { probes, handler } = hiddenPage('window.ready=true;', JSON.stringify(map));
  const host = await serve(handler);
  const requests: import('@playwright/test').Request[] = [];
  page.on('request', (request) => {
    requests.push(request);
  });
  await page.route('**/*', async (route) => {
    if (route.request().url().includes('.map') && route.request().resourceType() === 'fetch') {
      await route.fulfill({ status: 404, body: '' });
      return;
    }
    await route.continue();
  });
  try {
    const tracker = await trackScriptReach(page);
    await page.goto(`${host.url}/`);
    const script = (await tracker.stop()).scripts.find((s) => s.url.includes('/app.js'));
    expect(script?.status).toBe('unmeasured');
    expect(script?.reason).toBe('source map absent');
    expect(probes).toEqual([]);
    expect(requests.some((request) => scriptMapRequests.has(request) && request.url().endsWith('/app.js.map'))).toBe(
      true,
    );
  } finally {
    await host.close();
  }
});

test('a mapping directive is used and the sibling is not probed', async ({ page }) => {
  const probes: string[] = [];
  const host = await serve((req, res) => {
    if (req.url === '/app.js.map') {
      probes.push(req.url);
      res.writeHead(200);
      res.end(JSON.stringify(map));
    } else if (req.url === '/declared.map') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(map));
    } else if (req.url?.startsWith('/app.js')) {
      res.writeHead(200, { 'content-type': 'application/javascript' });
      res.end('window.ready=true;\n//# sourceMappingURL=declared.map');
    } else res.end('<script src="/app.js"></script>');
  });
  try {
    const tracker = await trackScriptReach(page);
    await page.goto(`${host.url}/`);
    const script = (await tracker.stop()).scripts.find((s) => s.url.includes('/app.js'));
    expect(script?.status).toBe('mapped');
    expect(probes).toEqual([]);
  } finally {
    await host.close();
  }
});

test('a SourceMap header is used and the sibling is not probed', async ({ page }) => {
  const probes: string[] = [];
  const host = await serve((req, res) => {
    if (req.url === '/app.js.map') {
      probes.push(req.url);
      res.writeHead(200);
      res.end(JSON.stringify(map));
    } else if (req.url === '/declared.map') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(map));
    } else if (req.url?.startsWith('/app.js')) {
      res.writeHead(200, {
        'content-type': 'application/javascript',
        SourceMap: '/declared.map',
      });
      res.end('window.ready=true;');
    } else res.end('<script src="/app.js"></script>');
  });
  try {
    const tracker = await trackScriptReach(page);
    await page.goto(`${host.url}/`);
    const script = (await tracker.stop()).scripts.find((s) => s.url.includes('/app.js'));
    expect(script?.status).toBe('mapped');
    expect(probes).toEqual([]);
  } finally {
    await host.close();
  }
});

test('an inline document script does not collide with a mapped src script', async ({ page }) => {
  const probes: string[] = [];
  const host = await serve((req, res) => {
    if (req.url?.includes('.map')) {
      probes.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(map));
    } else if (req.url?.startsWith('/app.js')) {
      res.writeHead(200, { 'content-type': 'application/javascript' });
      res.end('window.ready=true;\n//# sourceMappingURL=app.js.map');
    } else res.end('<body><script>window.f=false;</script><script src="/app.js"></script>');
  });
  try {
    const tracker = await trackScriptReach(page);
    await page.goto(`${host.url}/`);
    const script = (await tracker.stop()).scripts.find((s) => s.url.includes('/app.js'));
    expect(script?.status).toBe('mapped');
    expect(probes).toEqual(['/app.js.map']);
  } finally {
    await host.close();
  }
});
