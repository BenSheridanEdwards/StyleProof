import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { crawlAndCapture } from '../dist/crawl-surfaces.js';

// An auth-boundary observation failure is fatal: a crawl that cannot observe a state must never
// report itself complete. The failure here fires only at depth 2 — inside the IN-PLACE descent
// under an opened panel — where the nested sweep used to be wrapped in a blanket fail-soft catch.
// `CSS.escape` is used by the boundary observer's selector builder (for a visible button with an
// id) and by nothing that runs earlier in the recording path, so only the observation throws.
const NESTED_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; font-family: sans-serif; }
    .panel, .inner { display: none; padding: 12px; }
    .panel.open, .inner.open { display: block; }
  </style></head><body>
    <main class="shell">
      <button type="button" class="open-panel">Open panel</button>
      <div class="panel">
        panel
        <button type="button" class="open-inner">Open inner</button>
        <div class="inner"><button type="button" id="inner-action">Inner action</button></div>
      </div>
    </main>
    <script>
      document.querySelector('.open-panel').onclick = () => document.querySelector('.panel').classList.add('open');
      document.querySelector('.open-inner').onclick = () => {
        document.querySelector('.inner').classList.add('open');
        CSS.escape = () => { throw new Error('observer broke'); };
      };
    </script>
  </body></html>`;

test('an auth-boundary observation failure inside an in-place descent fails the crawl', async ({ page }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-nested-observe-'));
  const file = path.join(root, 'nested.html');
  fs.writeFileSync(file, NESTED_HTML);
  try {
    await expect(
      crawlAndCapture(page, {
        url: 'file://' + file,
        out: path.join(root, 'out'),
        ignore: [],
        widths: [900],
        height: 700,
        screenshots: false,
        maxDepth: 8,
        maxActionsPerState: 50,
        maxStates: 20,
        resetStorage: true,
        dataStates: false,
        workers: 1,
      }),
    ).rejects.toThrow(/auth-boundary observation failed after recording surface/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
