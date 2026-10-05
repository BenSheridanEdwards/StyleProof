/** Expand overflow scrollers so Playwright `fullPage` covers below-the-fold content. */
import type { Page } from '@playwright/test';

type StyleShot = {
  el: HTMLElement;
  overflow: string;
  overflowY: string;
  height: string;
  maxHeight: string;
};

type RestoreState = { shots: StyleShot[]; count: number };

/**
 * Temporarily unlock every vertical overflow scroller (and its height-clipped
 * ancestors) so `document` scroll height includes their content. Playwright's
 * `fullPage` screenshot follows document scroll height only — nested
 * `overflow: auto|scroll` regions are otherwise clipped to the first viewport.
 * Idempotent until {@link restoreInnerScrollContainers} runs.
 *
 * The restore key is a string literal inside this function (not a module const):
 * Playwright serializes `page.evaluate` callbacks and drops closed-over bindings.
 */
export function expandInnerScrollContainers(): number {
  const restoreKey = '__spFullPageRestore';
  const w = window as unknown as Record<string, RestoreState | undefined>;
  if (w[restoreKey]) return w[restoreKey]!.count;

  const shots: StyleShot[] = [];
  const saved = new Set<HTMLElement>();

  const unlock = (el: HTMLElement, height: string | null): void => {
    if (!saved.has(el)) {
      shots.push({
        el,
        overflow: el.style.overflow,
        overflowY: el.style.overflowY,
        height: el.style.height,
        maxHeight: el.style.maxHeight,
      });
      saved.add(el);
    }
    el.style.overflow = 'visible';
    el.style.overflowY = 'visible';
    el.style.maxHeight = 'none';
    el.style.height = height ?? 'auto';
  };

  const depth = (el: Element): number => {
    let d = 0;
    for (let cur = el.parentElement; cur; cur = cur.parentElement) d += 1;
    return d;
  };

  const scrollers: HTMLElement[] = [];
  for (const node of document.querySelectorAll('body *')) {
    const el = node as HTMLElement;
    const overflowY = getComputedStyle(el).overflowY;
    if (
      (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') &&
      el.scrollHeight > el.clientHeight + 1
    ) {
      scrollers.push(el);
    }
  }

  if (scrollers.length === 0) {
    w[restoreKey] = { shots, count: 0 };
    return 0;
  }

  // Deepest first so nested scrollers reveal their content before a parent measures.
  scrollers.sort((a, b) => depth(b) - depth(a));

  for (const scroller of scrollers) {
    unlock(scroller, `${scroller.scrollHeight}px`);
    let cur = scroller.parentElement;
    while (cur && cur !== document.documentElement) {
      unlock(cur, null);
      if (cur === document.body) break;
      cur = cur.parentElement;
    }
  }

  for (const root of [document.documentElement, document.body]) {
    if (root) unlock(root as HTMLElement, null);
  }

  w[restoreKey] = { shots, count: scrollers.length };
  return scrollers.length;
}

/** Undo {@link expandInnerScrollContainers}. Safe when nothing was expanded. */
export function restoreInnerScrollContainers(): void {
  const restoreKey = '__spFullPageRestore';
  const w = window as unknown as Record<string, RestoreState | undefined>;
  const state = w[restoreKey];
  if (!state) return;
  for (const shot of state.shots.slice().reverse()) {
    shot.el.style.overflow = shot.overflow;
    shot.el.style.overflowY = shot.overflowY;
    shot.el.style.height = shot.height;
    shot.el.style.maxHeight = shot.maxHeight;
  }
  delete w[restoreKey];
}

/** Full-page screenshot that includes content inside nested overflow scrollers. */
export async function captureFullPageScreenshot(page: Page, path: string): Promise<void> {
  try {
    await page.evaluate(expandInnerScrollContainers);
    await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  } finally {
    await page.evaluate(restoreInnerScrollContainers).catch(() => undefined);
  }
}
