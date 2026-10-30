import { test, expect } from '@playwright/test';
import http from 'node:http';
import { DANGER_SOURCE } from '../dist/danger.js';
import { resolvePopupCaptureOptions } from '../dist/runner/settings.js';
import { harvestStyleVariants } from '../dist/variant-crawler.js';

const SIDE_EFFECT_VERBS = ['Send', 'Submit', 'Save', 'Confirm', 'Approve', 'Invite', 'Transfer', 'Cancel'];

function page(): string {
  const verbs = SIDE_EFFECT_VERBS.map(
    (verb) => `<button type="button" class="verb" data-verb="${verb}">${verb}</button>`,
  ).join('\n');

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    button:hover { outline: 3px solid rgb(14, 165, 233); }
  </style></head><body>
    <form method="post" action="/form-post">
      <input name="note" aria-label="Note" value="hello">
      <button>Continue</button>
    </form>
    <nav>${verbs}</nav>
    <script>
      for (const button of document.querySelectorAll('.verb')) {
        button.addEventListener('click', () => {
          fetch('/side-effect/' + button.dataset.verb, { method: 'POST', body: 'x' });
        });
      }
    </script>
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

test('the destructive guard names the common side-effect verbs', () => {
  const dangerous = new RegExp(DANGER_SOURCE, 'i');
  expect(SIDE_EFFECT_VERBS.filter((verb) => !dangerous.test(verb))).toEqual([]);
});

test('default popup triggers never match an untyped button inside a form', async ({ browser }) => {
  const ctx = await browser.newContext();

  try {
    const tab = await ctx.newPage();
    await tab.setContent(page());
    const { triggers } = resolvePopupCaptureOptions(true);

    const formButtons = await tab
      .locator('form button')
      .evaluateAll((nodes, selector) => nodes.filter((node) => node.matches(selector)).length, triggers);

    expect(formButtons).toBe(0);
  } finally {
    await ctx.close();
  }
});

test('variant discovery sends no POST through untyped form buttons or side-effect verbs', async ({ browser }) => {
  await withServer(async (baseUrl, posts) => {
    const ctx = await browser.newContext({ viewport: { width: 900, height: 700 } });

    try {
      const tab = await ctx.newPage();
      await harvestStyleVariants(tab, {
        baseUrl,
        routes: [{ key: 'home', url: '/' }],
        maxActionsPerRoute: 20,
        maxStateActionsPerRoute: 0,
      });
      await tab.waitForTimeout(250);
      expect(posts).toEqual([]);
    } finally {
      await ctx.close();
    }
  });
});
