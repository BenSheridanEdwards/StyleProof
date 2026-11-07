import { test, expect, type Page } from '@playwright/test';
import { captureStyleMap } from '../dist/capture.js';
import { diffStyleMaps } from '../dist/diff.js';
import fs from 'node:fs';
import { generateStyleMapReport } from '../dist/index.js';
import { pairFixture, rmTmp } from './helpers.mjs';

// Fixture blocks isolate helper state; the test bodies and matrices are unchanged.
{
  // Canonical/source comparisons use settling; unstabilized relative models have document-wide limits.
  const options = { captureVisualChannels: true, captureStates: false };

  async function capture(page: Page, html: string) {
    await page.setContent(html);
    return captureStyleMap(page, options);
  }

  const changes = (a: Awaited<ReturnType<typeof capture>>, b: Awaited<ReturnType<typeof capture>>) =>
    diffStyleMaps(a, b).flatMap((finding) => (finding.kind === 'dom' ? [] : finding.props));

  test('credential query fields are removed from stored sources but benign parameters and external hosts retain identity', async ({
    page,
  }) => {
    await page.route('http://**/*', (route) => {
      if (route.request().resourceType() === 'image')
        return route.fulfill({
          contentType: 'image/svg+xml',
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>',
        });
      const keys = [
        'X-Amz-Credential',
        'X-Amz-Signature',
        'Signature',
        'token',
        'access_token',
        'sig',
        'se',
        'sp',
        'sv',
        'Expires',
        'Key-Pair-Id',
        'Policy',
      ];
      const query = keys.map((key) => `${key}=fixture-sensitive-${key}`).join('&');
      return route.fulfill({
        contentType: 'text/html',
        body: `<img width="10" height="10" src="/a.svg?version=7&${query}#part">`,
      });
    });
    await page.goto('http://fixture.test/');
    const map = await captureStyleMap(page, options);
    expect(Object.values(map.elements).find((e) => e.tag === 'img')!.style['img currentSrc']).toBe(
      '/a.svg?version=7#part',
    );
    expect(JSON.stringify(map)).not.toContain('fixture-sensitive');
    const before = await capture(page, '<img width="10" height="10" src="http://assets-a.test/a.svg">');
    const after = await capture(page, '<img width="10" height="10" src="http://assets-b.test/a.svg">');
    expect(changes(before, after).map((p) => p.prop)).toContain('img currentSrc');
  });

  test('redaction preserves benign raw query spelling when a credential parameter disappears', async ({ page }) => {
    await page.route('http://**/*', (route) =>
      route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>',
      }),
    );
    const before = await capture(
      page,
      '<img width="10" height="10" src="http://assets.test/a.svg?asset=a%20b&%74oken=fixture-sensitive">',
    );
    const after = await capture(page, '<img width="10" height="10" src="http://assets.test/a.svg?asset=a%20b">');
    expect(changes(before, after)).toEqual([]);
    expect(Object.values(before.elements).find((element) => element.tag === 'img')!.style['img currentSrc']).toBe(
      'http://assets.test/a.svg?asset=a%20b',
    );
  });
}

{
  // Canonical/source comparisons use settling; unstabilized relative models have document-wide limits.
  const options = { captureVisualChannels: true, captureStates: false };

  async function capture(page: Page, html: string) {
    await page.setContent(html);
    return captureStyleMap(page, options);
  }

  const changes = (a: Awaited<ReturnType<typeof capture>>, b: Awaited<ReturnType<typeof capture>>) =>
    diffStyleMaps(a, b).flatMap((finding) => (finding.kind === 'dom' ? [] : finding.props));

  function report(before: Awaited<ReturnType<typeof capture>>, after: Awaited<ReturnType<typeof capture>>) {
    const fixture = pairFixture({ surface: 'home@800', before, after });
    try {
      return fs.readFileSync(generateStyleMapReport(fixture).reportMdPath, 'utf8');
    } finally {
      rmTmp(fixture.root);
    }
  }

  const image = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>';

  async function imageRoutes(page: Page) {
    await page.route('http://**/*', (route) => route.fulfill({ contentType: 'image/svg+xml', body: image }));
  }

  const sourceOf = (map: Awaited<ReturnType<typeof capture>>) =>
    Object.values(map.elements).find((element) => element.tag === 'img')!.style['img currentSrc'];

  for (const [provider, keys] of [
    ['S3 v2', ['AWSAccessKeyId', 'Expires', 'Signature']],
    [
      'S3 v4',
      [
        'X-Amz-Algorithm',
        'X-Amz-Credential',
        'X-Amz-Date',
        'X-Amz-Expires',
        'X-Amz-SignedHeaders',
        'X-Amz-Security-Token',
        'X-Amz-Signature',
      ],
    ],
    [
      'GCS v4',
      [
        'X-Goog-Algorithm',
        'X-Goog-Credential',
        'X-Goog-Date',
        'X-Goog-Expires',
        'X-Goog-SignedHeaders',
        'X-Goog-Signature',
      ],
    ],
    ['Azure SAS', ['sv', 'st', 'se', 'sr', 'sp', 'skt', 'ske', 'skoid', 'sktid', 'sks', 'skv', 'sdd', 'spr', 'sig']],
    ['CloudFront', ['Signature', 'Key-Pair-Id', 'Expires', 'Policy']],
  ] as const) {
    test(`${provider} credential rotations expose no credential text in map or report`, async ({ page }) => {
      await imageRoutes(page);
      const html = (rotation: string) =>
        `<img width="10" height="10" src="http://assets.test/a.svg?asset=a%20b&${keys.map((key) => `${key}=fixture-private-${rotation}-${key}`).join('&')}#part">`;
      const before = await capture(page, html('first'));
      const after = await capture(page, html('second'));
      expect(sourceOf(before)).toBe('http://assets.test/a.svg?asset=a%20b#part');
      expect(sourceOf(after)).toBe(sourceOf(before));
      expect(JSON.stringify([before, after])).not.toContain('fixture-private');
      expect(changes(before, after)).toEqual([]);
      // Also render a real source finding; signatures must not leak into its values.
      const changed = await capture(page, html('third').replace('/a.svg?', '/b.svg?'));
      expect(changes(before, changed).map((property) => property.prop)).toContain('img currentSrc');
      const text = report(before, changed);
      expect(text).toContain('img currentSrc');
      expect(text).not.toContain('fixture-private');
      for (const key of keys) expect(text).not.toContain(`${key}=`);
    });
  }

  test('unsigned query fields keep identity without provider signature markers', async ({ page }) => {
    await imageRoutes(page);
    const keys = [
      'sp',
      'se',
      'sv',
      'st',
      'skt',
      'ske',
      'skoid',
      'sktid',
      'sks',
      'skv',
      'sdd',
      'spr',
      'Expires',
      'Policy',
      'X-Amz-Date',
      'X-Goog-Date',
    ];
    for (const key of keys) {
      const before = await capture(page, `<img width="10" height="10" src="http://assets.test/sprite.svg?${key}=1">`);
      const after = await capture(page, `<img width="10" height="10" src="http://assets.test/sprite.svg?${key}=2">`);
      expect(
        changes(before, after).map((property) => property.prop),
        key,
      ).toContain('img currentSrc');
    }
  });

  test('an access-key field alone is redacted without hiding unsigned Expires or Policy identity', async ({ page }) => {
    await imageRoutes(page);
    for (const field of ['Expires', 'Policy']) {
      const html = (value: string) =>
        `<img width="10" height="10" src="http://assets.test/a.svg?AWSAccessKeyId=fixture-private&${field}=${value}">`;
      const before = await capture(page, html('first'));
      const after = await capture(page, html('second'));
      expect(sourceOf(before)).toBe(`http://assets.test/a.svg?${field}=first`);
      expect(changes(before, after).map((property) => property.prop)).toContain('img currentSrc');
      expect(JSON.stringify([before, after])).not.toContain('fixture-private');
      expect(report(before, after)).not.toContain('fixture-private');
    }
  });
}

{
  // Canonical/source comparisons use settling; unstabilized relative models have document-wide limits.
  const options = { captureVisualChannels: true, captureStates: false };

  async function capture(page: Page, html: string) {
    await page.goto('about:blank');
    await page.setContent(html);
    return captureStyleMap(page, options);
  }

  const changes = (a: Awaited<ReturnType<typeof capture>>, b: Awaited<ReturnType<typeof capture>>) =>
    diffStyleMaps(a, b).flatMap((f) => (f.kind === 'dom' ? [] : f.props));

  for (const [label, a, b, equal] of [
    ['R1 Bunny', 'token=fixture-first&expires=1&exp=1', 'token=fixture-second&expires=2&exp=2', true],
    ['R2 Akamai', 'hdnts=exp%3D1~hmac%3Dfixture-first', 'hdnts=exp%3D2~hmac%3Dfixture-second', true],
    ['R3 Akamai token', '__token__=exp=1~hmac=fixture-first', '__token__=exp=2~hmac=fixture-second', true],
    [
      'R4 GCS V2',
      'GoogleAccessId=public&Expires=1&Signature=fixture-first',
      'GoogleAccessId=public&Expires=2&Signature=fixture-second',
      true,
    ],
    ['R5 S3 identity', 'w=100&X-Amz-Signature=fixture-first', 'w=200&X-Amz-Signature=fixture-second', false],
    ['R6 SAS identity', 'v=1&sig=fixture-first&se=1', 'v=2&sig=fixture-second&se=2', false],
    [
      'R7 encoded signature',
      'X-Amz-Credential=k&x%2Damz%2Dsignature=fixture-first',
      'X-Amz-Credential=k&x%2Damz%2Dsignature=fixture-second',
      true,
    ],
    ['R8 unsigned expiry', 'expires=1', 'expires=2', false],
    ['R9 Maps identity', 'key=public-one', 'key=public-two', false],
    [
      'R10 CloudFront',
      'Policy=p1&Signature=fixture-first&Key-Pair-Id=K',
      'Policy=p2&Signature=fixture-second&Key-Pair-Id=K',
      true,
    ],
    ['R11 encoding', 'b=%2B&a=1%20&token=fixture-first', 'b=%2B&a=1%20&token=fixture-second', true],
  ] as const)
    test(label, async ({ page }) => {
      await page.route('http://assets.test/**', (r) =>
        r.fulfill({
          contentType: 'image/svg+xml',
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>',
        }),
      );
      const html = (q: string) => `<img width=10 height=10 src="http://assets.test/a.svg?${q}">`;
      const before = await capture(page, html(a));
      const after = await capture(page, html(b));
      expect(changes(before, after).some((p) => p.prop === 'img currentSrc')).toBe(!equal);
      expect(JSON.stringify([before, after])).not.toMatch(/fixture-first|fixture-second|hmac/);
      const fixture = pairFixture({ surface: 'home@800', before, after });
      try {
        expect(fs.readFileSync(generateStyleMapReport(fixture).reportMdPath, 'utf8')).not.toMatch(
          /fixture-first|fixture-second|hmac/,
        );
      } finally {
        rmTmp(fixture.root);
      }
    });
}

{
  // Canonical/source comparisons use settling; unstabilized relative models have document-wide limits.
  const options = { captureVisualChannels: true, captureStates: false };

  test('same-origin currentSrc ignores host/port and retains query and fragment identity', async ({ page }) => {
    await page.route('http://**/*', async (route) => {
      if (route.request().resourceType() === 'image')
        return route.fulfill({
          contentType: 'image/svg+xml',
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>',
        });
      return route.fulfill({
        contentType: 'text/html',
        body: '<img class="target" width="10" height="10" src="/image.svg?version=1#part">',
      });
    });
    await page.goto('http://base.test:1234/');
    const before = await captureStyleMap(page, options);
    await page.goto('http://head.test:9876/');
    const after = await captureStyleMap(page, options);
    expect(Object.values(after.elements).find((entry) => entry.tag === 'img')!.style['img currentSrc']).toBe(
      '/image.svg?version=1#part',
    );
    expect(diffStyleMaps(before, after)).toEqual([]);
  });
}
