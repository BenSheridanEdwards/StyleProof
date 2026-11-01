import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { crawlAndCapture } from '../dist/crawl-surfaces.js';
import { captureSurface } from '../dist/runner/surface-capture.js';
import { resolveSettings } from '../dist/runner/settings.js';
import { applyStateRecipe } from '../dist/state-recipes.js';
import { harvestStyleVariants } from '../dist/variant-crawler.js';

// A destructive word that sits outside the accessible name the crawl used to read: visible text under a
// neutral aria-label, a title or value behind other text, an aria-labelledby target, hidden or icon text.
const DANGEROUS = [
  '<span id="label-reference">Delete</span><label for="d-label-labelledby"><span aria-labelledby="label-reference"></span>Account</label><button id="d-label-labelledby">→</button>',
  '<x-danger-shadow role="button" tabindex="0" id="d-shadow"></x-danger-shadow>',
  '<button id="d-shadow-desc"><x-remove-shadow></x-remove-shadow></button>',
  '<button class="danger-before" id="d-before"></button>',
  '<button class="danger-after" id="d-after"></button>',
  '<label for="d-fa-label">Delete</label><x-form-control role="button" tabindex="0" id="d-fa-label">→</x-form-control>',

  '<button id="d-adjacent"><span>Delete</span><span>3</span></button>',
  '<button id="d-adjacent-sr"><span>Remove</span><span class="sr-only">item</span></button>',
  '<span id="dl-target" hidden>Reset</span><button id="d-desc-labelledby"><span aria-labelledby="dl-target"></span>→</button>',
  '<button id="d-split-word">De<b>lete</b></button>',
  '<label for="d-label-adjacent"><span>Delete</span><span>3</span></label><button id="d-label-adjacent">→</button>',
  '<span id="d-lbl-adjacent"><span>Remove</span><span>item</span></span><button id="d-labelledby-adjacent" aria-labelledby="d-lbl-adjacent">→</button>',
  `<button id="d-joined-cap">${`<span>${'a'.repeat(10000)}</span>`.repeat(2)}</button>`,
  '<label for="d-label-for">Delete account</label><button id="d-label-for">→</button>',
  `<button id="d-many-desc" aria-label="Open"><svg>${'<path></path>'.repeat(30)}</svg><img alt="Delete"></button>`,
  `<button id="d-long-text" aria-label="Next"><span hidden>${'neutral filler words '.repeat(100)}</span>Delete</button>`,
  `<button id="d-desc-cap" aria-label="Open">${'<span title="neutral"></span>'.repeat(101)}</button>`,
  `<button id="d-source-cap" aria-label="Next"><span hidden>${'neutral '.repeat(2600)}</span></button>`,
  '<button id="d-aria-text" aria-label="Account">Sign in</button>',
  '<div id="d-role-text" role="button" tabindex="0" aria-label="Profile">Log out</div>',
  '<button id="d-title" title="Delete">\u22ef</button>',
  '<button id="d-title-aria" aria-label="Options" title="Remove"></button>',
  '<input id="d-value" type="submit" value="Restore">',
  '<input id="d-image-alt" type="image" aria-label="Next" alt="Merge" width="8" height="8" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">',
  '<span id="d-lbl">Remove</span><button id="d-labelledby" aria-labelledby="d-lbl">\u2192</button>',
  '<span id="d-lbl2">Open</span><button id="d-labelledby-text" aria-labelledby="d-lbl2">Reset</button>',
  '<button id="d-sr" aria-label="More"><svg aria-hidden="true" width="8" height="8"></svg><span style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Delete</span></button>',
  '<button id="d-hidden" aria-label="Close panel"><span hidden>Cancel</span>\u00d7</button>',
  '<button id="d-svg-title" aria-label="Icon"><svg width="8" height="8"><title>Send</title></svg></button>',
  '<button id="d-img-alt"><img alt="Tick" width="8" height="8" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></button>',
];

// Look-alikes and status text across the same label sources: these stay clickable.
const SAFE = [
  '<x-safe-shadow role="button" tabindex="0" id="s-shadow"></x-safe-shadow>',
  '<button class="safe-before" id="s-before"></button>',

  '<button id="s-adjacent"><span>Profile</span><span>3</span></button>',
  '<label for="s-label-for">Profile</label><button id="s-label-for">→</button>',
  '<button id="s-aria-text" aria-label="Account">Profile</button>',
  '<button id="s-title" title="Refresh">\u21bb</button>',
  '<button id="s-status" aria-label="Signed in as alice">A</button>',
  '<span id="s-lbl">Recovery codes</span><button id="s-labelledby" aria-labelledby="s-lbl">\u2192</button>',
  '<input id="s-image-alt" type="image" alt="Tickets" width="8" height="8" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">',
  '<button id="s-sr" aria-label="Menu"><span hidden>Logged in as ben</span>\u2630</button>',
  '<button id="s-img-alt"><img alt="Signal strength" width="8" height="8" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></button>',
];
// The control is the last element with an id in each snippet (an aria-labelledby target comes first).
const ids = (markup: string[]) => markup.map((m) => [...m.matchAll(/id="([^"]+)"/g)].at(-1)![1]);
const DANGEROUS_IDS = ids(DANGEROUS);
const SAFE_IDS = ids(SAFE);

function html(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>.danger-before::before { content: "Delete"; } .danger-after::after { content: "Send"; } .safe-before::before { content: "→"; } button:hover { outline: 3px solid blue; } .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }</style></head><body><main>
    ${[...DANGEROUS, ...SAFE].join('\n    ')}
    <script>
    for (const [name, text] of [['x-danger-shadow', 'Delete'], ['x-remove-shadow', 'Remove'], ['x-safe-shadow', 'Profile']]) {
      customElements.define(name, class extends HTMLElement {
        constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<span>' + text + '</span>'; }
      });
    }
    customElements.define('x-form-control', class extends HTMLElement { static formAssociated = true; });
    for (const el of document.querySelectorAll('[id^="d-"]:not(span),[id^="s-"]:not(span)')) el.addEventListener('click', (e) => { e.preventDefault(); fetch((el.id.startsWith('d-') ? '/side-effect/' : '/safe/') + el.id, { method: 'POST', body: 'x' }); });</script>
  </main></body></html>`;
}

async function withServer(run: (baseUrl: string, posts: string[]) => Promise<void>): Promise<void> {
  const posts: string[] = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'POST') posts.push(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(req.method === 'POST' ? '<!doctype html><p>posted</p>' : html());
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

const sideEffects = (posts: string[]) => posts.filter((p) => p.startsWith('/side-effect/'));
const safeClicked = (posts: string[]) => new Set(posts.filter((p) => p.startsWith('/safe/')).map((p) => p.slice(6)));

test('fixture ids parse', () => {
  expect(DANGEROUS_IDS).toHaveLength(DANGEROUS.length);
  expect(SAFE_IDS).toHaveLength(SAFE.length);
});

test('crawl never clicks a control whose danger word is outside its accessible name', async ({ page }) => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-hidden-labels-'));
  try {
    await withServer(async (baseUrl, posts) => {
      const report = await crawlAndCapture(page, {
        url: baseUrl,
        out,
        ignore: [] as string[],
        widths: [720],
        height: 700,
        screenshots: false,
        maxDepth: 2,
        maxActionsPerState: 60,
        maxStates: 10,
        resetStorage: true,
        dataStates: false,
        workers: 1,
      });
      await page.waitForTimeout(250);
      expect(sideEffects(posts)).toEqual([]);
      const unsafe = report.incompleteUi
        .flatMap((o) => o.diagnostics)
        .filter((d) => d.kind === 'unsafe-control')
        .map((d) => d.selector);
      for (const id of DANGEROUS_IDS) expect(unsafe).toContain(`#${id}`);
      for (const id of SAFE_IDS) expect(unsafe).not.toContain(`#${id}`);
      expect([...safeClicked(posts)].sort()).toEqual([...SAFE_IDS].sort());
    });
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('variant discovery never clicks a control whose danger word is outside its accessible name', async ({ page }) => {
  await withServer(async (baseUrl, posts) => {
    await harvestStyleVariants(page, {
      baseUrl,
      routes: [{ key: 'home', url: '/' }],
      maxActionsPerRoute: 100,
      maxStateActionsPerRoute: 0,
    });
    await page.waitForTimeout(250);
    expect(sideEffects(posts)).toEqual([]);
    expect([...safeClicked(posts)].sort()).toEqual([...SAFE_IDS].sort());
  });
});

test('popup discovery never clicks a control whose danger word is outside its accessible name', async ({
  page,
}, testInfo) => {
  await withServer(async (baseUrl, posts) => {
    await captureSurface(
      page,
      { key: 'home', popups: true, go: async () => void (await page.goto(baseUrl)) },
      900,
      resolveSettings({ baseDir: testInfo.outputDir, dir: 'capture', screenshots: false, selfCheck: false }),
      { index: 1, total: 1 },
    );
    await page.waitForTimeout(250);
    expect(sideEffects(posts)).toEqual([]);
  });
});

test('state recipes refuse a target whose danger word is outside its accessible name', async ({ page }) => {
  await withServer(async (baseUrl, posts) => {
    await page.goto(baseUrl);
    for (const id of DANGEROUS_IDS) {
      const error = await applyStateRecipe(page, { action: 'hover', selector: `#${id}`, stateKey: id }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error, id).toBeInstanceOf(Error);
      expect(String((error as Error).message), id).toContain('destructive-action guard');
    }
    for (const id of SAFE_IDS) await applyStateRecipe(page, { action: 'hover', selector: `#${id}`, stateKey: id });
    expect(sideEffects(posts)).toEqual([]);
  });
});
