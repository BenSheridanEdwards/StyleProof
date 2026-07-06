import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { defineStyleMapCapture, loadStyleMap } from '../dist/index.js';

// Popup reset + identity binding (issue #183): on a surface whose go() does NOT
// navigate (SPA variants), the run must never capture popup N+1 with popup N's
// residue, and never key a capture under a trigger it didn't originally enumerate.
// Every skip must be loud (a styleproof: warning naming the popup and why).
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-popup-reset-'));
const WIDTH = 720;

// The loud-skip channel is console.warn from the runner (in this worker process);
// collect it so the tests can assert skips are NAMED, not silent.
const warnings: string[] = [];
// eslint-disable-next-line no-console
const realWarn = console.warn.bind(console);
// eslint-disable-next-line no-console
console.warn = (...args: unknown[]) => {
  warnings.push(args.map(String).join(' '));
  realWarn(...args);
};

/** A go() that loads once and is a no-op afterwards — the SPA-shaped surface where
 *  the Escape-only reset used to leak between popup candidates. */
function spaGo(html: string) {
  return async (page: Page) => {
    if (await page.evaluate(() => document.querySelector('main') !== null)) return;
    await page.setContent(html);
  };
}

const STYLE = `
  <style>
    body { margin: 0; font-family: system-ui, sans-serif; }
    main { min-height: 480px; padding: 40px; }
    .actions { display: flex; gap: 12px; }
    button { padding: 12px 18px; }
    [data-toast] { position: fixed; inset: 24px 24px auto auto; padding: 16px; background: rgb(254, 249, 195); }
    [data-toast][hidden] { display: none; }
  </style>
`;

// (a) A toast Escape can't dismiss, followed by another popup candidate: the toast
// itself captures cleanly, but the NEXT candidate must be skipped loudly — never
// captured with the toast's residue on screen.
const LEAK_HTML = `
  ${STYLE}
  <main>
    <div class="actions">
      <button id="open-first" type="button">Open first</button>
      <button id="show-toast" type="button">Show toast</button>
      <button id="open-second" type="button">Open second</button>
    </div>
    <dialog id="first">First dialog</dialog>
    <div id="toast" data-toast role="status" hidden>Saved!</div>
    <dialog id="second">Second dialog</dialog>
  </main>
  <script>
    document.getElementById('open-first').addEventListener('click', () => document.getElementById('first').showModal());
    document.getElementById('show-toast').addEventListener('click', () => { document.getElementById('toast').hidden = false; });
    document.getElementById('open-second').addEventListener('click', () => document.getElementById('second').showModal());
  </script>
`;

// (b) The trigger set shifts after the first popup opens (its click injects a new
// button EARLIER in DOM order, shifting every enumeration index): the second
// candidate must stay bound to the originally-enumerated trigger, not re-bind
// positionally to whatever now sits at its index.
const SHIFT_HTML = `
  ${STYLE}
  <main>
    <div id="extra"></div>
    <div class="actions">
      <button id="open-alpha" type="button">Open alpha</button>
      <button id="open-beta" type="button">Open beta</button>
    </div>
    <dialog id="alpha">Alpha dialog</dialog>
    <dialog id="beta">Beta dialog</dialog>
  </main>
  <script>
    document.getElementById('open-alpha').addEventListener('click', () => {
      if (!document.getElementById('decoy')) {
        const decoy = document.createElement('button');
        decoy.id = 'decoy';
        decoy.type = 'button';
        decoy.textContent = 'Decoy';
        document.getElementById('extra').appendChild(decoy);
      }
      document.getElementById('alpha').showModal();
    });
    document.getElementById('open-beta').addEventListener('click', () => document.getElementById('beta').showModal());
  </script>
`;

// A popup that itself defeats the reset (a toast): with self-check on, its reopen
// can't be verified, so the capture must be discarded loudly — not saved unproven
// and not failed with a misleading "did not reopen" error.
const TOAST_ONLY_HTML = `
  ${STYLE}
  <main>
    <div class="actions">
      <button id="show-toast" type="button">Show toast</button>
    </div>
    <div id="toast" data-toast role="status" hidden>Saved!</div>
  </main>
  <script>
    document.getElementById('show-toast').addEventListener('click', () => { document.getElementById('toast').hidden = false; });
  </script>
`;

test.describe('popup leak capture', () => {
  defineStyleMapCapture({
    surfaces: [{ key: 'leak-demo', widths: [WIDTH], popups: true, go: spaGo(LEAK_HTML) }],
    dir: 'leak',
    baseDir: ROOT,
    screenshots: false,
    selfCheck: false,
  });
});

test.describe('popup trigger-shift capture', () => {
  defineStyleMapCapture({
    surfaces: [{ key: 'shift-demo', widths: [WIDTH], popups: true, go: spaGo(SHIFT_HTML) }],
    dir: 'shift',
    baseDir: ROOT,
    screenshots: false,
    selfCheck: false,
  });
});

test.describe('popup self-check leak capture', () => {
  defineStyleMapCapture({
    surfaces: [{ key: 'toast-selfcheck', widths: [WIDTH], popups: true, go: spaGo(TOAST_ONLY_HTML) }],
    dir: 'toast-selfcheck',
    baseDir: ROOT,
    screenshots: false,
    selfCheck: true,
  });
});

test.afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

function overlayTexts(dir: string, key: string): string[] {
  const map = loadStyleMap(path.join(ROOT, dir, `${key}@${WIDTH}.json.gz`));
  return (map.overlays ?? []).map((overlay) => overlay.text ?? '');
}

test('a leaked toast skips the next popup candidate loudly instead of contaminating it', () => {
  // The dialog (popup-01) and the toast (popup-02) both capture cleanly...
  expect(overlayTexts('leak', 'leak-demo-popup-01').join(' ')).toContain('First dialog');
  expect(overlayTexts('leak', 'leak-demo-popup-02').join(' ')).toContain('Saved!');
  // ...but the second dialog opens after the toast leaked past Escape + go(), so it
  // is skipped — no map — and the skip names the popup and the leaked overlay.
  expect(fs.existsSync(path.join(ROOT, 'leak', `leak-demo-popup-03@${WIDTH}.json.gz`))).toBe(false);
  const skip = warnings.find((w) => w.includes(`leak-demo-popup-03@${WIDTH}`));
  expect(skip, 'the skipped candidate is named in a styleproof: warning').toBeTruthy();
  expect(skip).toContain('Saved!');
});

test('a shifted trigger set cannot re-key a popup under a different trigger', () => {
  // Opening alpha injects a decoy button earlier in DOM order, shifting every
  // positional index. popup-02 must still be beta's dialog, not alpha's again.
  expect(overlayTexts('shift', 'shift-demo-popup-01').join(' ')).toContain('Alpha dialog');
  const beta = overlayTexts('shift', 'shift-demo-popup-02').join(' ');
  expect(beta).toContain('Beta dialog');
  expect(beta).not.toContain('Alpha dialog');
  expect(
    warnings.filter((w) => w.includes('shift-demo')),
    'identity binding needs no skips on this surface',
  ).toEqual([]);
});

test('a popup that defeats the reset is discarded loudly under self-check, not saved unproven', () => {
  expect(fs.existsSync(path.join(ROOT, 'toast-selfcheck', `toast-selfcheck-popup-01@${WIDTH}.json.gz`))).toBe(false);
  const skip = warnings.find((w) => w.includes(`toast-selfcheck-popup-01@${WIDTH}`));
  expect(skip, 'the discarded popup is named in a styleproof: warning').toBeTruthy();
  expect(skip).toContain('discarded');
});
