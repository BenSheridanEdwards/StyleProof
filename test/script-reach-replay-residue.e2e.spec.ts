import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

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

test('runner abort-HAR map fetch leaves no data residue', async ({ page, browser }, testInfo) => {
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
    const har = testInfo.outputPath('reader@800.har');
    const recording = await browser.newContext({ recordHar: { path: har } });
    const recordingPage = await recording.newPage();
    await recordingPage.goto(host.url);
    await recording.close();
    const recorded = JSON.parse(await readFile(har, 'utf8'));
    expect(recorded.log.entries.some((entry: { request: { url: string } }) => entry.request.url.endsWith('.map'))).toBe(
      false,
    );
    const settings = resolveSettings({
      dir: testInfo.outputPath('maps'),
      captureScriptReach: true,
      selfCheck: false,
      screenshots: false,
      freezeClock: false,
      replayUrl: '**/*',
      replayFrom: testInfo.outputPath(),
    });
    const requests: string[] = [];
    page.on('request', (r) => requests.push(r.url()));
    await captureSurface(
      page,
      {
        key: 'reader',
        async go() {
          await page.goto(host.url);
        },
      },
      800,
      settings,
      { index: 1, total: 1 },
    );
    expect(loadStyleMap(testInfo.outputPath('maps/reader@800.json.gz')).dataResidue ?? []).toEqual([]);
    expect(
      loadStyleMap(testInfo.outputPath('maps/reader@800.json.gz')).scriptReach?.scripts.find((s) =>
        s.url.endsWith('/app.js'),
      )?.status,
    ).toBe('unknown');
    // Abort-mode replay cannot supply the unrecorded map; mapping remains unknown.
    expect(requests.some((url) => url.endsWith('.map'))).toBe(true);
  } finally {
    await host.close();
  }
});
