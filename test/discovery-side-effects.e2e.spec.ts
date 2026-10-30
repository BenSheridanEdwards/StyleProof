import { test, expect } from '@playwright/test';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureSurface } from '../dist/runner/surface-capture.js';
import { collectClickable } from '../dist/crawl/browser.js';
import { DANGER_SOURCE, SUBMITS_FORM_SOURCE } from '../dist/danger.js';
import { resolveSettings } from '../dist/runner/settings.js';
import { harvestStyleVariants } from '../dist/variant-crawler.js';

const SIDE_EFFECT_VERBS = 'Send Submit Save Confirm Approve Invite Transfer Cancel Delete Pay'.split(' ');

function page(): string {
  const verbs = SIDE_EFFECT_VERBS.map(
    (verb) => `<button type="button" class="verb" data-verb="${verb}">${verb}</button>`,
  ).join('\n');

  return `<!doctype html><html><head><style>button:hover { outline: 3px solid blue; }</style></head><body>
    <form method="post" action="/form-post"><input name="note" aria-label="Note" value="hello"><button>Continue</button></form>
    ${['type="checkbox" checked', 'type="hidden"', 'readonly', 'disabled']
      .map(
        (attrs, i) =>
          `<form method="post" action="/side-effect/terms-${i}"><input name="terms" required ${attrs}><input name="email"><button type="button">x</button></form>`,
      )
      .join('')}
    ${[
      '<label for="go-0" role="button">Continue</label><button id="go-0">Go</button>',
      '<label for="go-1" aria-haspopup="menu">Continue</label><button id="go-1">Go</button>',
      '<label for="go-2" aria-expanded="false">Continue</label><button id="go-2">Go</button>',
      '<label for="go-3"><span role="button">Continue</span></label><button id="go-3">Go</button>',
      '<label for="go-4"><span style="cursor:pointer">Continue</span></label><button id="go-4">Go</button>',
      '<div role="button" aria-haspopup="menu" style="width:100px"><button style="width:100px;height:50px">Go</button></div>',
    ]
      .map((controls, i) => `<form method="post" action="/side-effect/label-${i}">${controls}</form>`)
      .join('')}
    ${verbs}
    <script>for (const b of document.querySelectorAll('.verb')) b.addEventListener('click', () => fetch('/side-effect/' + b.dataset.verb, { method: 'POST', body: 'x' }));</script>
  </body></html>`;
}

async function withServer(run: (baseUrl: string, posts: string[]) => Promise<void>): Promise<void> {
  const posts: string[] = [];

  const server = http.createServer((req, res) => {
    if (req.method === 'POST') posts.push(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(req.method === 'POST' ? '<!doctype html><p>posted</p>' : page());
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  // SAFETY: listening on a TCP port completed above, so address() is an AddressInfo.
  const { port } = server.address() as import('node:net').AddressInfo;

  try {
    await run(`http://127.0.0.1:${port}`, posts);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

for (const mode of ['crawl', 'variant', 'popup']) {
  test(`${mode} discovery sends no POST through submit labels, children, wrappers or verbs`, async ({ page }) => {
    const baseDir = mkdtempSync(join(tmpdir(), 'styleproof-discovery-'));
    try {
      await withServer(async (baseUrl, posts) => {
        if (mode === 'variant') {
          await harvestStyleVariants(page, {
            baseUrl,
            routes: [{ key: 'home', url: '/' }],
            maxActionsPerRoute: 100,
            maxStateActionsPerRoute: 0,
          });
        } else if (mode === 'popup') {
          await captureSurface(
            page,
            {
              key: 'home',
              popups: true,
              go: async () => {
                await page.goto(baseUrl);
              },
            },
            900,
            resolveSettings({ baseDir, dir: 'capture', screenshots: false, selfCheck: false }),
            { index: 1, total: 1 },
          );
        } else {
          await page.goto(baseUrl);

          const candidates = await page.evaluate(collectClickable, {
            dangerSource: DANGER_SOURCE,
            submitsFormSource: SUBMITS_FORM_SOURCE,
          });

          for (const candidate of candidates.filter((item) => item.action === 'click' && !item.unsafe)) {
            await page.locator(candidate.selector).evaluate((el: HTMLElement) => el.click());
          }
        }

        await page.waitForTimeout(250);
        expect(posts).toEqual([]);
      });
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
}
