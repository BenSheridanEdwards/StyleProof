import type { Page, Route } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const HAR_DRAIN_TIMEOUT_MS = 2_000;

export async function recordLoadHar(page: Page, url: string, file: string): Promise<() => Promise<void>> {
  const entries: unknown[] = [];
  const pending = new Set<Promise<void>>();
  let active = true;
  let sealed = false;

  async function record(route: Route): Promise<void> {
    const request = route.request();
    // Keep redirects as separate entries, so HAR replay can follow the same chain.
    const response = await route.fetch({ maxRedirects: 0 });

    try {
      const body = await response.body();
      const headers = await request.headersArray();
      const postData = request.postDataBuffer();

      if (!sealed)
        entries.push({
          request: {
            url: request.url(),
            method: request.method(),
            headers,
            ...(postData && {
              postData: {
                mimeType: request.headers()['content-type'] ?? '',
                text: postData.toString('base64'),
                encoding: 'base64',
              },
            }),
          },
          response: {
            status: response.status(),
            headers: response.headersArray(),
            content: { text: body.toString('base64'), encoding: 'base64' },
          },
        });
      // Navigation can cancel fulfillment after the response was recorded.
      await route.fulfill({ response, body }).catch(() => {});
    } finally {
      await response.dispose();
    }
  }

  const handler = async (route: Route): Promise<void> => {
    if (!active) return route.fallback();

    const work = record(route).catch(async () => {
      // Failed or cancelled requests are not capture failures.
      await route.abort().catch(() => {});
    });

    pending.add(work);

    try {
      await work;
    } finally {
      pending.delete(work);
    }
  };

  await page.route(url, handler);
  let finishing: Promise<void> | undefined;

  const finish = async (): Promise<void> => {
    active = false;
    await page.unroute(url, handler).catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;

    await Promise.race([
      Promise.all(pending),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, HAR_DRAIN_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(timer);
    sealed = true;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Playwright's minimal HAR reader needs URL/method/headers, POST bytes and response content.
    fs.writeFileSync(
      file,
      JSON.stringify({ log: { version: '1.2', creator: { name: 'StyleProof', version: '1' }, entries } }),
    );
  };

  return () => (finishing ??= finish());
}
