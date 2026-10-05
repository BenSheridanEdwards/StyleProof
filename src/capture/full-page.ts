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
 * Helpers stay nested: Playwright serializes this callback via `Function#toString`
 * and drops module-level closures.
 */
function expandInnerScrollContainers(): number {
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

  const depthOf = (el: Element): number => {
    let depth = 0;
    for (let cur = el.parentElement; cur; cur = cur.parentElement) depth += 1;
    return depth;
  };

  const isVerticalScroller = (el: HTMLElement): boolean => {
    const overflowY = getComputedStyle(el).overflowY;
    if (overflowY !== 'auto' && overflowY !== 'scroll' && overflowY !== 'overlay') return false;
    return el.scrollHeight > el.clientHeight + 1;
  };

  const unlockScrollerChain = (scroller: HTMLElement): void => {
    unlock(scroller, `${scroller.scrollHeight}px`);
    let cur = scroller.parentElement;
    while (cur && cur !== document.documentElement) {
      unlock(cur, null);
      if (cur === document.body) break;
      cur = cur.parentElement;
    }
  };

  const scrollers = [...document.querySelectorAll('body *')]
    .map((node) => node as HTMLElement)
    .filter(isVerticalScroller);

  if (scrollers.length === 0) {
    w[restoreKey] = { shots, count: 0 };
    return 0;
  }

  scrollers.sort((a, b) => depthOf(b) - depthOf(a));
  for (const scroller of scrollers) unlockScrollerChain(scroller);
  for (const root of [document.documentElement, document.body]) {
    if (root) unlock(root as HTMLElement, null);
  }

  w[restoreKey] = { shots, count: scrollers.length };
  return scrollers.length;
}

/** Undo {@link expandInnerScrollContainers}. Safe when nothing was expanded. */
function restoreInnerScrollContainers(): void {
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
