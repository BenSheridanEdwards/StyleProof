import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { defineCrawlCapture, loadStyleMap } from '../dist/index.js';
import { generateStyleMapReport } from '../dist/report.js';

// A crawl spec (the `styleproof-init` template for non-Next apps) must be able to declare
// productState, or its reports can never certify. Declaring it must not make a real
// mismatch, a one-sided identity, or an undeclared link read as comparable.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-crawl-state-'));

test.afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));

let tone = 'rgb(0, 0, 0)';
const seenLinks: string[] = [];

// The fixture echoes the request path into the page, so escape it like any reflected value.
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  const nav = '<nav><a href="/alpha">a</a> <a href="/beta">b</a></nav>';

  // /gamma is reachable only through the history API, so only the navigation observer finds it.
  const push =
    req.url === '/alpha' ? '<script>addEventListener("load", () => history.pushState({}, "", "/gamma"))</script>' : '';

  const popup =
    '<button aria-haspopup="dialog" onclick="document.getElementById(\'d\').hidden = false">open</button>' +
    '<div id="d" role="dialog" hidden>dialog</div>';

  res.end(
    `<!doctype html><html><body>${nav}<h1 style="color: ${tone}">${escapeHtml(req.url ?? '')}</h1>${popup}${push}</body></html>`,
  );
});

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

test.afterAll(() => server.close());

// SAFETY: a listening TCP server has an AddressInfo address.
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const shared = {
  baseDir: directory,
  screenshots: false,
  selfCheck: false,
  parallel: false,
  from: origin + '/',
  match: /\/(alpha|beta|gamma)$/,
  widths: [800],
  popups: true,
  variants: [{ key: 'v', go: async () => {} }],
};

const seeded = { id: 'seeded-app', revision: 'fixture-v1' };

function report(head: string) {
  const result = generateStyleMapReport({
    beforeDir: path.join(directory, 'base'),
    afterDir: path.join(directory, head),
    outDir: path.join(directory, `report-${head}`),
  });

  return { result, md: fs.readFileSync(result.reportMdPath, 'utf8') };
}

const receipts = (result: ReturnType<typeof generateStyleMapReport>) =>
  Object.fromEntries(result.comparability.map((r) => [r.surface, [r.status, r.required]]));

const capturesIn = (side: string) =>
  fs
    .readdirSync(path.join(directory, side))
    .filter((file) => file.endsWith('.json.gz'))
    .map((file) => file.replace(/\.json\.gz$/, ''))
    .sort();

const every = (keys: string[], receipt: [string, boolean]) => Object.fromEntries(keys.map((key) => [key, receipt]));

test.describe.serial('crawl productState', () => {
  test.use({ baseURL: origin });
  test.describe('base', () => {
    defineCrawlCapture({ ...shared, dir: 'base', productState: seeded });
  });
  test.describe('heads', () => {
    test.beforeAll(() => {
      tone = 'rgb(255, 0, 0)';
    });
    test.describe('per-link identity', () => {
      defineCrawlCapture({
        ...shared,
        dir: 'head',
        productState: (link) => {
          seenLinks.push(link.key);

          return seeded;
        },
      });
    });
    test.describe('different revision', () => {
      defineCrawlCapture({ ...shared, dir: 'head-mismatch', productState: { ...seeded, revision: 'fixture-v2' } });
    });
    test.describe('no identity', () => {
      defineCrawlCapture({ ...shared, dir: 'head-undeclared' });
    });
    test.describe('identity for one link only', () => {
      defineCrawlCapture({
        ...shared,
        dir: 'head-partial',
        productState: (link) => (link.key === 'alpha' ? seeded : undefined),
      });
    });
  });
  test('matching crawl identity certifies every crawled capture', () => {
    const keys = capturesIn('base');
    // Base links, the observed route, a variant and popups all came through the crawl.
    expect(keys).toEqual(expect.arrayContaining(['alpha@800', 'beta@800', 'gamma@800', 'gamma-v@800']));
    expect(keys.some((key) => key.includes('-popup-'))).toBe(true);
    expect(capturesIn('head')).toEqual(keys);
    const { result, md } = report('head');
    expect(md).not.toContain('Product-state identity unproven');
    expect(md).not.toContain('This compare cannot certify');
    expect(result.comparison.status).toBe('comparable');
    expect(receipts(result)).toEqual(every(keys, ['comparable', true]));
    expect(result.comparison.blocksCertification).toBe(false);

    for (const side of ['base', 'head']) {
      for (const key of keys) {
        expect(loadStyleMap(path.join(directory, side, `${key}.json.gz`)).metadata?.productState).toEqual(seeded);
      }
    }

    expect([...new Set(seenLinks)].sort()).toEqual(['alpha', 'beta', 'gamma']);
  });
  test('a different crawl revision stays incomparable and blocks certification', () => {
    const { result } = report('head-mismatch');
    expect(result.comparison.status).toBe('incomparable');
    expect(result.comparison.blocksCertification).toBe(true);
    expect(receipts(result)).toEqual(every(capturesIn('base'), ['incomparable', true]));
    expect(result.changedSurfaces).toBe(0);
  });
  test('a head crawl without identity stays required-unproven against a stamped base', () => {
    const { result, md } = report('head-undeclared');
    expect(result.comparison.status).toBe('unproven');
    expect(receipts(result)).toEqual(every(capturesIn('base'), ['unproven', true]));
    expect(result.comparison.blocksCertification).toBe(true);
    // The report states the block as one line (the visual-first report has no "identity unproven" label).
    expect(md).toMatch(
      /⛔ \*\*This compare cannot certify:\*\* \d+ paired capture\(s\) are not proven to show the same product state/,
    );
    expect(md).not.toContain('Product-state identity unproven');
  });
  test('a link the function leaves undeclared is not promoted to comparable', () => {
    const { result } = report('head-partial');
    const keys = capturesIn('base');
    expect(receipts(result)).toEqual(
      Object.fromEntries(keys.map((key) => [key, key.startsWith('alpha') ? ['comparable', true] : ['unproven', true]])),
    );
    expect(result.comparison.blocksCertification).toBe(true);
    expect(loadStyleMap(path.join(directory, 'head-partial', 'beta@800.json.gz')).metadata?.productState).toBe(
      undefined,
    );
  });
});
