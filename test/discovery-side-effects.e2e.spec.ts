import { test, expect } from '@playwright/test';
import http from 'node:http';
import { captureSurface } from '../dist/runner/surface-capture.js';
import { collectClickable } from '../dist/crawl/browser.js';
import { DANGER_SOURCE, DANGER_TEXT_SOURCE, SUBMITS_FORM_SOURCE } from '../dist/danger.js';
import { resolveSettings } from '../dist/runner/settings.js';
import { harvestStyleVariants } from '../dist/variant-crawler.js';

const SIDE_EFFECT_VERBS = 'Send Submit Save Confirm Approve Invite Transfer Cancel Delete Pay'.split(' ');
// Action words a real app wires to a side effect that discovery still clicked (#1206).
const ACTION_WORDS = [
  'Tick',
  'Merge',
  'Sign in',
  'Start sign-in',
  'Sign up',
  'Log in',
  'Login',
  'Sign-out',
  'Log-out',
  'Authorize',
  'Restart',
  'Reboot',
  'Recover',
  'Restore',
];
// Unicode separators and further forms that still slipped through (#1208).
const SEPARATOR_WORDS = [
  'Sign\u2011in',
  'Log\u2013in',
  'Sign\u2010out',
  'Sign\u00a0up',
  'Sign\u200bin',
  'Sign_in',
  'Sign - in',
  'Log on',
  'Logon',
  'Log-on',
  'Signing in',
  'Logging in',
  'Untick',
  'Unmerge',
  'Re-start',
  'Re-store',
];

function page(): string {
  const verbs = [...SIDE_EFFECT_VERBS, ...ACTION_WORDS, ...SEPARATOR_WORDS]
    .map((verb) => `<button type="button" class="verb" data-verb="${verb}">${verb}</button>`)
    .join('\n');

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
      '<div role="button" aria-haspopup="menu"><label for="go-6">Continue</label></div><button id="go-6">Go</button>',
    ]
      .map((controls, i) => `<form method="post" action="/side-effect/label-${i}">${controls}</form>`)
      .join('')}
    <form method="post" action="/side-effect/custom"><form-button role="button" aria-haspopup="menu" style="cursor:pointer">Continue</form-button></form>
    <script>customElements.define('form-button', class extends HTMLElement { static formAssociated = true; internals = this.attachInternals(); connectedCallback() { this.addEventListener('click', () => this.internals.form.requestSubmit()); } });</script>
    <form method="post"><div style="cursor:pointer" onclick="this.closest('form').requestSubmit()">Continue</div></form>
    ${verbs}
    <script>for (const b of document.querySelectorAll('.verb')) b.addEventListener('click', () => fetch('/side-effect/' + b.dataset.verb, { method: 'POST', body: 'x' }));</script>
  </body></html>`;
}

async function withServer(run: (baseUrl: string, posts: string[]) => Promise<void>): Promise<void> {
  const posts: string[] = [];

  const server = http.createServer((req, res) => {
    if (req.method === 'POST') posts.push(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);

    if (req.url === '/csp') res.setHeader('Content-Security-Policy', "script-src 'self'");
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      req.method === 'POST'
        ? '<!doctype html><p>posted</p>'
        : req.url === '/csp'
          ? '<button type="button">Open</button><form method="post"><button>Continue</button></form>'
          : page(),
    );
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

for (const mode of ['crawl', 'variant', 'popup'])
  test(`${mode} discovery sends no POST through submits, labels, pointers or verbs`, async ({ page }, testInfo) => {
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
          { key: 'home', popups: true, go: async () => void (await page.goto(baseUrl)) },
          900,
          resolveSettings({ baseDir: testInfo.outputDir, dir: 'capture', screenshots: false, selfCheck: false }),
          { index: 1, total: 1 },
        );
      } else {
        await page.goto(baseUrl);

        const candidates = await page.evaluate(collectClickable, {
          dangerSource: DANGER_SOURCE,
          dangerTextSource: DANGER_TEXT_SOURCE,
          submitsFormSource: SUBMITS_FORM_SOURCE,
        });

        for (const candidate of candidates.filter((item) => item.action === 'click' && !item.unsafe)) {
          await page.locator(candidate.selector).evaluate((el: HTMLElement) => el.click());
        }
      }

      await page.waitForTimeout(250);
      expect(posts).toEqual([]);
    });
  });

test('crawl discovery under CSP finds safe controls and rejects submits without POST', async ({ page }) => {
  await withServer(async (baseUrl, posts) => {
    await page.goto(`${baseUrl}/csp`);

    const candidates = await page.evaluate(collectClickable, {
      dangerSource: DANGER_SOURCE,
      dangerTextSource: DANGER_TEXT_SOURCE,
      submitsFormSource: SUBMITS_FORM_SOURCE,
    });

    expect(candidates.find((c) => c.label === 'Continue')?.unsafe).toBe(true);
    const safe = candidates.find((c) => c.label === 'Open');
    expect(safe?.unsafe).toBe(false);
    await page.locator(safe!.selector).click();
    await page.waitForTimeout(250);
    expect(posts).toEqual([]);
  });
});

test('crawl discovery marks #1206 action words unsafe and keeps look-alikes clickable', async ({ page }) => {
  const safe = ['Refresh', 'Tickets', 'Emerge', 'Designing', 'Recovery codes', 'Restoration log', 'Signing key'];

  await page.setContent(
    [...ACTION_WORDS, ...safe].map((label) => `<button type="button">${label}</button>`).join('\n'),
  );
  const candidates = await page.evaluate(collectClickable, {
    dangerSource: DANGER_SOURCE,
    dangerTextSource: DANGER_TEXT_SOURCE,
    submitsFormSource: SUBMITS_FORM_SOURCE,
  });
  const unsafe = Object.fromEntries(candidates.map((c) => [c.label, c.unsafe]));

  expect(unsafe).toEqual({
    ...Object.fromEntries(ACTION_WORDS.map((label) => [label, true])),
    ...Object.fromEntries(safe.map((label) => [label, false])),
  });
});

test('crawl discovery marks #1208 separator variants unsafe and keeps look-alikes clickable', async ({ page }) => {
  const safe = [
    'Refresh',
    'Tickets',
    'Emerge',
    'Designing',
    'Recovery codes',
    'Restoration log',
    'Signing key',
    'Logo',
    'Log input',
    'Ticker',
    'Merger',
    'Restaurant',
    'Signed in as alice',
    'Logged in as ben',
  ];

  await page.setContent(
    [...SEPARATOR_WORDS, ...safe].map((label, i) => `<button type="button" id="b${i}">${label}</button>`).join('\n'),
  );
  const candidates = await page.evaluate(collectClickable, {
    dangerSource: DANGER_SOURCE,
    dangerTextSource: DANGER_TEXT_SOURCE,
    submitsFormSource: SUBMITS_FORM_SOURCE,
  });
  const unsafe = Object.fromEntries(candidates.map((c) => [c.selector, c.unsafe]));
  const labels = [...SEPARATOR_WORDS, ...safe];

  expect(Object.fromEntries(labels.map((label, i) => [label, unsafe[`#b${i}`]]))).toEqual({
    ...Object.fromEntries(SEPARATOR_WORDS.map((label) => [label, true])),
    ...Object.fromEntries(safe.map((label) => [label, false])),
  });
});
