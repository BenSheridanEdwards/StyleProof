import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineStyleMapCapture, loadStyleMap } from '../dist/index.js';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-runner-limits-'));
const html = `<!doctype html><html><head><style>button:hover { color: rgb(200, 0, 0); }</style></head><body>
<button onclick="document.querySelector('dialog').showModal()">Open</button>
<dialog>Details</dialog></body></html>`;

// The deliberately tiny budget must remain incomplete on both self-check reads.
// Missing propagation to either read produces a mismatch or an incorrectly complete map.
defineStyleMapCapture({
  dir: 'capture',
  baseDir: directory,
  screenshots: false,
  selfCheck: true,
  parallel: false,
  maxForcedStateScanWork: 1,
  surfaces: [
    {
      key: 'inherited',
      widths: [720],
      go: async (page) => {
        await page.setContent(html);
      },
      popups: { max: 1 },
      variants: [{ key: 'variant' }],
    },
    {
      key: 'override',
      widths: [720],
      go: async (page) => {
        await page.setContent(html);
      },
      maxForcedStateScanWork: 100,
      variants: [{ key: 'complete' }, { key: 'limited', maxForcedStateScanWork: 1 }],
    },
    {
      key: 'live',
      widths: [720],
      go: async (page) => {
        await page.setContent(html);
      },
      liveStates: [{ key: 'loaded', maxForcedStateScanWork: 100 }],
    },
  ],
});

test('runner budgets reach primary, self-check, variants, live states, and popups', () => {
  const capture = (key: string) => loadStyleMap(path.join(directory, 'capture', `${key}@720.json.gz`));
  for (const key of ['inherited', 'inherited-variant', 'inherited-popup-01', 'override-limited']) {
    expect(capture(key).statesSkipped, `${key} retains the incomplete resource bound`).toBe(true);
  }
  for (const key of ['override', 'override-complete', 'live-loaded']) {
    expect(capture(key).statesSkipped, `${key} has the explicit complete resource allowance`).toBeFalsy();
  }
});
