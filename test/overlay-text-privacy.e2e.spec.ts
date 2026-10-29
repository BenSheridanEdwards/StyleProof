import { expect, test } from '@playwright/test';
import { captureStyleMap } from '../dist/index.js';

// Issue #1142: captureText: false is the privacy opt-out, so overlay copy must not land in the map.
const HTML = `<!doctype html><html><body><main><button id="open" type="button">Open</button>
  <dialog id="who"><p>Signed in as alice@example.com</p></dialog>
  <div role="status" data-toast style="position:fixed;bottom:0;right:0">Payment of 42 GBP sent</div></main>
  <script>document.getElementById('open').addEventListener('click', () => document.getElementById('who').showModal());</script>
</body></html>`;

test('#1142 captureText: false keeps overlay text out of the map', async ({ page }) => {
  await page.setContent(HTML);
  await page.click('#open');
  const map = await captureStyleMap(page, { captureText: false });
  expect(map.overlays?.length ?? 0, 'the open dialog is detected as an overlay').toBeGreaterThan(0);
  const stored = JSON.stringify(map);
  expect(stored).not.toContain('alice@example.com');
  expect(stored).not.toContain('Payment of 42 GBP');
});

test('#1142 captureText defaults on and keeps overlay text', async ({ page }) => {
  await page.setContent(HTML);
  await page.click('#open');
  const map = await captureStyleMap(page);
  expect(JSON.stringify(map.overlays)).toContain('alice@example.com');
});
