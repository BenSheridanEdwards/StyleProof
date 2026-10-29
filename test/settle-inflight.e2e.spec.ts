/* eslint-disable no-console -- Intercept capture warnings to assert the user-visible diagnostic. */
import { test, expect } from '@playwright/test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { captureStyleMap } from '../dist/index.js';

// Issue #1139: a settle that times out with data requests still in flight must say so
// (in the map and on stderr) instead of silently capturing whatever was on screen.
test('#1139 a settle timeout with a request in flight is recorded and printed', async ({ page }) => {
  const held: http.ServerResponse[] = [];

  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/api/')) {
      held.push(res); // never answers within the settle budget (fetch starts after capture's tracker is armed)

      return;
    }

    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><html><body><main id="app">loading…</main>
      <script>setTimeout(() => fetch('/api/slow').then((r) => r.json()).then(() => { app.textContent = 'data'; }), 300);</script></body></html>`);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    // SAFETY: listen() completed on a TCP port, so address() returns AddressInfo.
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };

    let map;

    try {
      await page.goto(origin);
      map = await captureStyleMap(page, { stabilize: { timeout: 1_000 } });
    } finally {
      console.warn = original;
    }

    expect(held.length, 'the data request reached the server and is still open').toBe(1);
    const recorded = JSON.stringify(map.metadata ?? {});
    const printed = warnings.join('\n');
    expect({ recorded, printed }).toEqual({
      recorded: expect.stringMatching(/in.?flight|pending|still loading|unsettled/i),
      printed: expect.stringMatching(/in.?flight|pending|still loading|unsettled/i),
    });
  } finally {
    for (const res of held) res.destroy();
    server.close();
  }
});
