import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { crawlAndCapture } from '../dist/crawl/sweep.js';

async function serve(html: string): Promise<{ origin: string; close: () => void }> {
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

test('--until-covered stops at once when the base surface already renders every class', async ({ page }) => {
  const site = await serve(`<!doctype html><style>.a{color:red}</style><body><p class="a">every class</p>
<button onclick="document.body.insertAdjacentHTML('beforeend','<p>panel one</p>')">One</button>
<button onclick="document.body.insertAdjacentHTML('beforeend','<div><span>panel two</span></div>')">Two</button></body>`);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-until-covered-'));
  try {
    const report = await crawlAndCapture(page, {
      url: `${site.origin}/`,
      out,
      widths: [800],
      ignore: [],
      height: 600,
      screenshots: false,
      dataStates: false,
      stopWhenCovered: true,
      maxDepth: 16,
      maxActionsPerState: 100000,
      maxStates: 100000,
      resetStorage: true,
      workers: 1,
    });
    expect(report.coverage.missing).toEqual([]);
    expect(report.actionsTried).toBe(0);
    expect(report.surfaces.map((s: { key: string }) => s.key)).toEqual(['base']);
  } finally {
    site.close();
    fs.rmSync(out, { recursive: true, force: true });
  }
});
