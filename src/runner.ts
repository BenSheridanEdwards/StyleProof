import { test } from '@playwright/test';
import path from 'node:path';
import { captureStyleMap, saveStyleMap } from './capture.js';
import type { Page } from '@playwright/test';

/**
 * A surface is one deterministic page state worth certifying: a route plus
 * the interactions that reach the state, captured at one viewport width per
 * @media band of its stylesheets.
 */
export type Surface = {
  /** Capture file name prefix; must be unique. */
  key: string;
  /** Navigate and drive the page to the state, ending settled (fonts loaded, entrance animations done). */
  go: (page: Page) => Promise<void>;
  /** Selectors for nondeterministic regions (live data, third-party embeds); skipped entirely. */
  ignore?: string[];
  /** Viewport widths to sweep — one per @media band, so breakpoint rules are verified too. */
  widths: number[];
  /** Viewport height: a number, or a function of the width (default 800). */
  height?: number | ((width: number) => number);
};

export type DefineOptions = {
  surfaces: Surface[];
  /**
   * Output directory label. Convention: drive it from an env var so the same
   * spec captures `before`, `after`, or a CI label — and skips entirely when
   * unset, keeping the spec inert during normal test runs.
   */
  dir: string | undefined;
  /** Base output directory (default `__stylemaps__` next to the invoking spec's CWD). */
  baseDir?: string;
  /**
   * Also save a full-page screenshot per capture (default true). The report
   * generator crops these to show changed regions side by side; captures
   * without screenshots still diff, but produce text-only reports.
   */
  screenshots?: boolean;
};

/**
 * Generate one Playwright test per surface × width that captures the style
 * map to `<baseDir>/<dir>/<key>@<width>.json.gz`.
 *
 * ```ts
 * // stylemap.spec.ts
 * defineStyleMapCapture({ surfaces: SURFACES, dir: process.env.STYLEMAP_DIR });
 * ```
 */
export function defineStyleMapCapture({
  surfaces,
  dir,
  baseDir = '__stylemaps__',
  screenshots = true,
}: DefineOptions): void {
  test.skip(!dir, 'set STYLEMAP_DIR=<label> to capture computed-style maps');
  test.describe('stylemap capture', () => {
    for (const surface of surfaces) {
      for (const width of surface.widths) {
        test(`${surface.key} @ ${width}`, async ({ page }) => {
          test.setTimeout(180_000);
          const height = typeof surface.height === 'function' ? surface.height(width) : (surface.height ?? 800);
          await page.setViewportSize({ width, height });
          await surface.go(page);
          const map = await captureStyleMap(page, { ignore: surface.ignore ?? [] });
          const stem = path.join(baseDir, dir as string, `${surface.key}@${width}`);
          saveStyleMap(`${stem}.json.gz`, map);
          if (screenshots) {
            // captureStyleMap froze animations/transitions, so this is the
            // same settled state the map describes.
            await page.screenshot({ path: `${stem}.png`, fullPage: true, animations: 'disabled' });
          }
        });
      }
    }
  });
}
