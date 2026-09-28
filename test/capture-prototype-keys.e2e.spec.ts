import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { captureStyleMap } from '../dist/index.js';

// Regression: page-supplied tag names feed the `probeCache`/`defaults` caches inside the
// in-page capture. With plain-object caches, a tag whose name collides with an
// Object.prototype member — `constructor`, `watch`, `unwatch`, `__proto__` — reads an
// INHERITED value instead of probing: `defaultFor` then returns a function/prototype as
// the "UA defaults", so snap() records every computed property as non-default (~370
// bogus props per element) — false-positive diffs on real pages. The caches are now
// null-prototype lookups.
test('prototype-named elements do not read inherited members as UA defaults', async ({ page }) => {
  const file = path.join(os.tmpdir(), `styleproof-proto-keys-${Math.random().toString(36).slice(2)}.html`);
  fs.writeFileSync(
    file,
    '<!doctype html><html><body>' +
      '<constructor>x</constructor>' +
      '<watch>x</watch>' +
      '<unwatch>x</unwatch>' +
      // `<__proto__>` in markup parses as text (tag names must start with a
      // letter); createElement accepts it and is how hostile markup reaches it.
      '<script>document.body.appendChild(document.createElement("__proto__"))</script>' +
      '<div style="color: rgb(1, 2, 3)">x</div>' +
      '</body></html>',
  );
  try {
    await page.goto('file://' + file, { waitUntil: 'load' });
    const map = await captureStyleMap(page, { stabilize: false, captureStates: false });
    const entries = Object.entries(map.elements);
    const byTag = (tag: string) => entries.find(([, entry]) => entry.tag === tag)?.[1];

    // An unstyled element matches UA defaults — its pruned style map stays near-empty.
    // With the bug, every computed property lands in the map instead.
    for (const tag of ['constructor', 'watch', 'unwatch', '__proto__']) {
      const entry = byTag(tag);
      expect(entry, `<${tag}> should still be captured`).toBeDefined();
      expect(
        Object.keys(entry!.style).length,
        `<${tag}> recorded ${Object.keys(entry!.style).length} props — inherited-prototype keys must not poison the UA-default probe`,
      ).toBeLessThan(20);
    }
    const ctl = byTag('div');
    expect(ctl?.style.color).toBe('rgb(1, 2, 3)');
  } finally {
    fs.rmSync(file, { force: true });
  }
});
