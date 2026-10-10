import { test, expect } from '@playwright/test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { trackDataResidue } from '../dist/capture.js';
import { auditRunResidue } from '../dist/data-residue.js';

test('a download followed by pushState preserves the live document’s API failure', async ({ page }) => {
  let releaseProbe: (() => void) | undefined;
  let probeStarted: () => void;
  const started = new Promise<void>((resolve) => {
    probeStarted = resolve;
  });
  const server = http.createServer((req, res) => {
    if (req.url === '/download') {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': 'attachment; filename="export.txt"',
      });
      res.end('export');
    } else if (req.url === '/api/probe') {
      releaseProbe = () => {
        if (!res.writableEnded) {
          res.writeHead(503);
          res.end('unavailable');
        }
      };
      probeStarted();
    } else {
      res.setHeader('content-type', 'text/html');
      res.end('<!doctype html><a href="/download">Export</a><main id="view">loaded</main>');
    }
  });
  const baseUrl = await new Promise<string>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  });
  const residue = trackDataResidue(page, '**/api/**', 'dashboard');
  try {
    await page.goto(baseUrl);
    const aborted = page.waitForEvent(
      'requestfailed',
      (request) => request.isNavigationRequest() && new URL(request.url()).pathname === '/download',
    );
    const downloaded = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Export' }).click();
    await downloaded;
    await aborted;
    expect(page.url()).toBe(`${baseUrl}/`);
    await page.evaluate(() => {
      void fetch('/api/probe').then((r) => {
        if (!r.ok) document.getElementById('view')!.textContent = 'fallback';
      });
    });
    await started;
    await page.evaluate(() => history.pushState({}, '', '/dashboard?tab=stats'));
    releaseProbe!();
    await expect(page.locator('#view')).toHaveText('fallback');
    const audit = auditRunResidue([{ dataResidue: residue.residue() }], {}, true);
    expect(audit.armed).toBe(true);
    expect(audit.unacknowledged.map(({ key, reason }) => ({ key, reason }))).toEqual([
      { key: 'dashboard·/api/probe', reason: 'HTTP 503' },
    ]);
  } finally {
    residue.dispose();
    releaseProbe?.();
    server.closeAllConnections();
    server.close();
  }
});
