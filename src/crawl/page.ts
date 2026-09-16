// Node-side page driving for the surface crawl: navigation, settling, setup steps,
// in-place actions, verified resets, and capture.
import type { Locator, Page, Response } from '@playwright/test';
import { captureStyleMap, saveStyleMap, captureSurfaceScreenshots, trackInflightRequests } from '../capture.js';
import { realNow } from '../spec-clock.js';
import { sha256 } from '../node-util.js';
import { classifyAuthBoundary, type AuthBoundaryMetadata } from '../auth-boundary.js';
import { classifyIncompleteUi, type IncompleteUiDiagnostic } from '../incomplete-ui.js';
import { redactedRoutePath, type AuthBoundaryObservation } from '../crawl-confidence.js';
import { captureArtifactStem } from '../surface-keys.js';
import { collectBoundaryMetadata, domShape } from './browser.js';
import type { Fingerprint, QueueEntry, SetupStep, SurfaceCrawlOptions } from './types.js';

export function pathAndSearch(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

export type BoundaryObservation = { auth: AuthBoundaryObservation | null; incompleteUi: IncompleteUiDiagnostic[] };

/** Observe auth walls and blocked continuations in one evaluate. A throw here is part of the
 *  certification contract — callers must never swallow it into a false complete. */
export async function observeBoundaries(page: Page): Promise<BoundaryObservation> {
  const meta = await page.evaluate(collectBoundaryMetadata);
  const diagnostics = classifyAuthBoundary(meta.auth);
  const route = redactedRoutePath(page.url());
  return {
    auth: diagnostics.length ? { ...(route ? { route } : {}), diagnostics } : null,
    incompleteUi: classifyIncompleteUi(meta.incompleteUi),
  };
}

/** Structural fingerprint of the page's CURRENT state — the dedup key for surfaces. */
export async function fingerprint(page: Page): Promise<Fingerprint> {
  const fp = await page.evaluate(domShape);
  return { sig: sha256(fp.shape).slice(0, 16), elements: fp.elements, classes: fp.classes };
}

/** Wait for the element count to stop changing (covers content painted by a click-triggered fetch);
 *  `minElements` also waits for an async-mounted app to be non-trivial. realNow, not Date.now: a
 *  frozen spec-process clock would never pass this deadline. */
export async function settleDom(page: Page, maxMs = 1200, minElements = -1): Promise<void> {
  let prev = -1;
  const deadline = realNow() + maxMs;
  while (realNow() < deadline) {
    const n = await page.evaluate(() => document.body.getElementsByTagName('*').length);
    if (n === prev && n > minElements) return;
    prev = n;
    await page.waitForTimeout(90);
  }
}

// No networkidle gate: a single cross-origin font sheet keeps the network "busy" ~1s per load.
// Fonts ARE part of the compared computed style, so wait for document.fonts.ready instead.
async function waitSettled(page: Page): Promise<void> {
  await settleDom(page, 4000, 5);
  await page.evaluate(() => document.fonts.ready.then(() => true)).catch(() => {});
}

/** Dispatch the click IN-PAGE: `el.click()` fires the app's real handler but skips Playwright's
 *  actionability waits, which flake on an opening modal. We only need to REACH the state. */
async function clickInPage(target: Locator): Promise<void> {
  await target.waitFor({ state: 'attached', timeout: 5000 });
  await target.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
  const dispatched = await target
    .evaluate((el) => {
      if (!(el instanceof HTMLElement)) return false;
      el.click();
      return true;
    })
    .catch(() => false);
  if (!dispatched) await target.click({ timeout: 3000 }); // non-HTMLElement (SVG etc.)
}

const ACTIONS: Record<string, (target: Locator, value: string) => Promise<unknown>> = {
  'select-option': (target, value) => target.selectOption(value),
  'fill-input': (target, value) => target.fill(value, { timeout: 5000 }),
  click: clickInPage,
};

export async function perform(page: Page, s: { action: string; selector: string; value?: string }): Promise<void> {
  await (ACTIONS[s.action] ?? ACTIONS.click)(page.locator(s.selector).first(), s.value ?? '');
}

const first = (page: Page, s: SetupStep): Locator => page.locator(s.selector ?? '').first();
const SETUP_RUNNERS: Record<SetupStep['action'], (page: Page, s: SetupStep) => Promise<unknown>> = {
  goto: (page, s) => page.goto(s.url ?? '', { waitUntil: 'load' }),
  fill: (page, s) => first(page, s).fill(s.value ?? '', { timeout: 10000 }),
  click: (page, s) => perform(page, { action: 'click', selector: s.selector ?? '' }),
  waitFor: (page, s) => first(page, s).waitFor({ state: 'visible', timeout: 10000 }),
};

/** Run the caller's deterministic setup steps. A non-optional step that fails throws loudly —
 *  a half-established gate must never silently crawl the ungated page instead. */
export async function runSetup(page: Page, steps: SetupStep[]): Promise<void> {
  for (const s of steps) {
    try {
      await SETUP_RUNNERS[s.action](page, s);
    } catch (e) {
      if (s.optional) continue;
      throw new Error(`setup step failed (${s.action} ${s.selector ?? s.url ?? ''})`, { cause: e });
    }
  }
}

/** Reveal scroll-gated content (IntersectionObserver mounts) with one bounded, identical pass per
 *  load, so replay and fingerprints stay stable and an infinite feed can't spin it. */
async function scrollReveal(page: Page): Promise<void> {
  await page
    .evaluate(async () => {
      const step = Math.max(200, window.innerHeight);
      for (let i = 0, y = 0; i < 20 && y <= document.body.scrollHeight; i++, y += step) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 60));
      }
      window.scrollTo(0, 0);
    })
    .catch(() => {});
}

/** A document-navigation 3xx as redacted auth metadata. Fetch/XHR redirects (session probes) must
 *  not mark the crawl incomplete-auth; classifyAuthBoundary discards headers/query. */
function authRedirect(res: Response): AuthBoundaryMetadata | null {
  const req = res.request();
  const status = res.status();
  if (req.resourceType() !== 'document' || !req.isNavigationRequest() || status < 300 || status >= 400) return null;
  const headers = res.headers();
  const location = headers['location'] ?? headers['Location'];
  if (!location) return null;
  const route = redactedRoutePath(res.url());
  return { ...(route ? { route } : {}), redirectTo: location, redirectStatus: status };
}

/** Load the URL from a clean slate (storage cleared by the armed init script) and wait for the app
 *  to mount. Pins the viewport to widths[0] so DISCOVERY always happens at one width. */
export async function gotoFresh(page: Page, opts: SurfaceCrawlOptions, sink?: AuthBoundaryMetadata[]): Promise<void> {
  await page.setViewportSize({ width: opts.widths[0] ?? 1280, height: opts.height });
  const onResponse = (res: Response): void => {
    const meta = authRedirect(res);
    if (meta) sink?.push(meta);
  };
  if (sink) page.on('response', onResponse);
  try {
    await page.goto(opts.url, { waitUntil: 'load' });
    // A same-origin URL can still 302 off-origin (SSO). External content is never captured as the app.
    const wanted = URL.canParse(opts.url) ? new URL(opts.url).origin : null;
    const landed = new URL(page.url()).origin;
    if (wanted && landed !== wanted) {
      throw new Error(
        `styleproof crawl: ${opts.url} redirected off-origin to ${landed} — external content is never captured`,
      );
    }
    // An optional waitSelector only accelerates the generic settle; it must not fail the crawl.
    if (opts.waitSelector)
      await page
        .locator(opts.waitSelector)
        .first()
        .waitFor({ state: 'visible' })
        .catch(() => {});
    await waitSettled(page);
    if (opts.setup?.length) {
      await runSetup(page, opts.setup);
      await settleDom(page);
    }
    await scrollReveal(page);
    await settleDom(page);
  } finally {
    if (sink) page.off('response', onResponse);
  }
}

/** Reset to a known state and VERIFY arrival by fingerprint (retry once). False means the path won't
 *  reproduce right now — the caller abandons that sweep rather than mis-attributing children. */
export async function resetToState(
  page: Page,
  opts: SurfaceCrawlOptions,
  to: Pick<QueueEntry, 'path' | 'sig'>,
): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await gotoFresh(page, opts);
      for (const s of to.path) {
        await perform(page, s);
        await settleDom(page);
      }
      if ((await fingerprint(page)).sig === to.sig) return true;
    } catch {
      /* retry */
    }
  }
  return false;
}

/** Capture the page's CURRENT state at every width, resizing in place — a fragile click-path is
 *  never replayed a second time just to capture. */
export async function captureInPlace(page: Page, key: string, opts: SurfaceCrawlOptions): Promise<void> {
  for (const width of opts.widths) {
    await page.setViewportSize({ width, height: opts.height });
    const requests = trackInflightRequests(page);
    try {
      const capture = { ignore: opts.ignore, pendingRequests: requests.pending, metadata: { surfaceKey: key } };
      const stem = captureArtifactStem(opts.out, key, width);
      saveStyleMap(`${stem}.json.gz`, await captureStyleMap(page, capture));
      if (opts.screenshots) await captureSurfaceScreenshots(page, stem, { ignore: opts.ignore });
    } finally {
      requests.dispose();
    }
  }
}

/** Clear storage before the app's code runs on EVERY load, so each gotoFresh is a clean slate in one navigation. */
export async function armResetStorage(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.clear();
      sessionStorage.clear();
    } catch {
      /* storage unavailable (e.g. file://) */
    }
  });
}
