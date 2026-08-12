import { test, expect } from '@playwright/test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { trackDataResidue } from '../dist/index.js';

// The incident, generic: a page requests a `/api/**` data endpoint that nothing routes,
// so the request FALLS THROUGH and fails during capture; the view renders its fallback
// branch and a restyle confined to the data-driven state ships uncaught. This proves the
// residue watcher, armed like the runner does (before navigation), NAMES that failure —
// and that fixturing the endpoint (page.route) captures clean with no residue.
//
// It also proves the browser-only half of trackDataResidue (the requestfailed/response
// listeners + URL-glob matching) end to end against real Chromium, unreachable from node:test.

// A page whose script fetches `/api/probe`; on failure it paints a fallback branch. The
// HTML server serves the page but NEVER the /api route (the incident: no fixture routes it).
function serveIncidentPage(): Promise<{ url: string; stop: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url?.startsWith('/api/')) {
        // The real incident refused the connection; here the page server simply has no
        // /api handler and we abort it via route below — either way the fetch FAILS.
        res.statusCode = 503;
        res.end('unavailable');
        return;
      }
      res.setHeader('content-type', 'text/html');
      res.end(
        `<!doctype html><html><head><meta charset="utf-8"></head><body>
          <main id="view">loading</main>
          <script>
            fetch('/api/probe?all=1')
              .then((r) => { if (!r.ok) throw new Error('bad status'); return r.json(); })
              .then(() => { document.getElementById('view').textContent = 'loaded'; })
              .catch(() => { document.getElementById('view').textContent = 'fallback'; });
          </script>
        </body></html>`,
      );
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}/`, stop: () => server.close() });
    });
  });
}

test('a /api endpoint that fails during capture is NAMED as residue; fixturing it is clean', async ({ page }) => {
  const { url, stop } = await serveIncidentPage();
  try {
    // Abort the /api request so it FAILS at the network level (the incident shape). The
    // watcher matches by listening, not routing, so this abort route can't hide it.
    await page.route('**/api/**', (route) => route.abort('connectionrefused'));

    // Arm the residue watcher BEFORE navigation, exactly as captureSurface does.
    const residue = trackDataResidue(page, '**/api/**', 'dashboard');
    await page.goto(url, { waitUntil: 'load' });
    await expect(page.locator('#view')).toHaveText('fallback'); // the unprovoked fallback branch
    const named = residue.residue();
    residue.dispose();

    expect(named).toHaveLength(1);
    expect(named[0].surface).toBe('dashboard');
    expect(named[0].endpoint).toBe('/api/probe'); // query stripped
    expect(named[0].key).toBe('dashboard·/api/probe');
    expect(named[0].reason).toMatch(/net::ERR|refused|failed/i);
  } finally {
    stop();
  }
});

test('a 4xx/5xx completion is residue too (fixtured-but-erroring endpoint)', async ({ page }) => {
  const { url, stop } = await serveIncidentPage();
  try {
    // Let the request reach the server, which answers 503 → a completed-but-error response.
    const residue = trackDataResidue(page, '**/api/**', 'dashboard');
    await page.goto(url, { waitUntil: 'load' });
    await expect(page.locator('#view')).toHaveText('fallback');
    const named = residue.residue();
    residue.dispose();

    expect(named).toHaveLength(1);
    expect(named[0].reason).toBe('HTTP 503');
  } finally {
    stop();
  }
});

test('a fixtured /api endpoint captures CLEAN — no residue', async ({ page }) => {
  const { url, stop } = await serveIncidentPage();
  try {
    // Fixture the endpoint with a 200 — the loaded (response-driven) state, no fallback.
    await page.route('**/api/**', (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) }),
    );
    const residue = trackDataResidue(page, '**/api/**', 'dashboard');
    await page.goto(url, { waitUntil: 'load' });
    await expect(page.locator('#view')).toHaveText('loaded'); // real response drives the state
    const named = residue.residue();
    residue.dispose();

    expect(named).toEqual([]); // a fixtured 2xx is NEVER flagged
  } finally {
    stop();
  }
});

// The attribution defect (issue #364), end to end: surface A starts a long-lived
// EventSource that is still in flight when the shared-page walk hands off to surface B.
// B's navigation aborts it, and Chromium reports `requestfailed(ERR_ABORTED)` while B's
// watcher is armed. B never initiated that request, so B's map must carry NO residue for
// it — while a data request B itself initiates and fails must still be recorded.
test('an in-flight stream aborted by the surface handoff is not the successor surface’s residue', async ({ page }) => {
  const streamConnections: import('node:http').ServerResponse[] = [];
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/api/stream')) {
      // A long-lived stream: headers sent, never finished — in flight until navigation.
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(':\n\n');
      streamConnections.push(res);
      return;
    }
    if (req.url?.startsWith('/api/')) {
      res.statusCode = 503;
      res.end('unavailable');
      return;
    }
    res.setHeader('content-type', 'text/html');
    if (req.url?.startsWith('/two')) {
      // Surface B: fetches its own data endpoint, which genuinely fails (503).
      res.end(
        `<!doctype html><html><body><main>two</main>
          <script>fetch('/api/probe').catch(() => {});</script>
        </body></html>`,
      );
      return;
    }
    // Surface A: opens a long-lived stream that outlives the surface.
    res.end(
      `<!doctype html><html><body><main>one</main>
        <script>new EventSource('/api/stream');</script>
      </body></html>`,
    );
  });
  const baseUrl = await new Promise<string>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
  try {
    // Surface A, armed exactly as captureSurface arms it: before navigation.
    const surfaceAResidue = trackDataResidue(page, '**/api/**', 'surface-a');
    const streamOpened = page.waitForResponse((candidate) => new URL(candidate.url()).pathname === '/api/stream');
    await page.goto(`${baseUrl}/`, { waitUntil: 'load' });
    await streamOpened; // the stream is now in flight and stays in flight
    expect(surfaceAResidue.residue()).toEqual([]); // a live stream is not a failure
    surfaceAResidue.dispose();

    // Handoff: surface B's watcher arms, then B's navigation aborts A's stream.
    const surfaceBResidue = trackDataResidue(page, '**/api/**', 'surface-b');
    const streamAborted = page.waitForEvent(
      'requestfailed',
      (request) => new URL(request.url()).pathname === '/api/stream',
    );
    const probeFailed = page.waitForResponse((candidate) => new URL(candidate.url()).pathname === '/api/probe');
    await page.goto(`${baseUrl}/two`, { waitUntil: 'load' });
    await streamAborted; // the abort was reported while B's watcher was armed
    await probeFailed; // B's own genuinely failing request has completed (HTTP 503)
    const named = surfaceBResidue.residue();
    surfaceBResidue.dispose();

    // B is charged for its OWN failing request only — never for A's aborted leftover.
    expect(named.map((entry) => entry.key)).toEqual(['surface-b·/api/probe']);
  } finally {
    for (const connection of streamConnections) connection.destroy();
    server.close();
  }
});

test('an EventSource terminal HTTP 204 captures CLEAN — no false stream residue', async ({ page }) => {
  const { url, stop } = await serveIncidentPage();
  try {
    await page.route('**/api/probe**', (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) }),
    );
    await page.route('**/api/stream', (route) => route.fulfill({ status: 204 }));
    const residue = trackDataResidue(page, '**/api/**', 'dashboard');
    await page.goto(url, { waitUntil: 'load' });
    const response = page.waitForResponse(
      (candidate) => new URL(candidate.url()).pathname === '/api/stream' && candidate.status() === 204,
    );
    await page.evaluate(() => {
      new EventSource('/api/stream');
    });
    await response;
    await page.waitForTimeout(100);

    expect(residue.residue()).toEqual([]);
    residue.dispose();
  } finally {
    stop();
  }
});
