/** Expand overflow scrollers so Playwright `fullPage` covers below-the-fold content. */
import type { Page } from '@playwright/test';

type StyleShot = {
  el: HTMLElement;
  overflow: string;
  overflowY: string;
  height: string;
  maxHeight: string;
};

/** A scroller's offset before expansion, put back on restore so the captured state is unchanged. */
type ScrollShot = { el: HTMLElement; top: number; left: number };

type RestoreState = { shots: StyleShot[]; scrolls: ScrollShot[]; count: number };

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
  const scrolls: ScrollShot[] = [];
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
    w[restoreKey] = { shots, scrolls, count: 0 };
    return 0;
  }

  for (const scroller of scrollers) scrolls.push({ el: scroller, top: scroller.scrollTop, left: scroller.scrollLeft });

  scrollers.sort((a, b) => depthOf(b) - depthOf(a));
  for (const scroller of scrollers) unlockScrollerChain(scroller);
  for (const root of [document.documentElement, document.body]) {
    if (root) unlock(root as HTMLElement, null);
  }

  w[restoreKey] = { shots, scrolls, count: scrollers.length };
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
  // Unlocking overflow drops a scroller's offset; put it back so later reads see the driven state.
  for (const s of state.scrolls ?? []) {
    s.el.scrollTop = s.top;
    s.el.scrollLeft = s.left;
  }
  delete w[restoreKey];
}

type DocRect = [number, number, number, number];

/**
 * Document-space rects for every element, keyed by the capture path, measured in the
 * expanded layout. Nested helpers only: Playwright serializes this via `Function#toString`.
 */
function measureExpandedRects(): Record<string, DocRect> {
  const pathOf = (window as unknown as { __spPathOf?: (el: Element) => string }).__spPathOf;
  const out: Record<string, DocRect> = {};
  if (!pathOf) return out;
  for (const el of [document.documentElement, document.body, ...document.querySelectorAll('body *')]) {
    if (!el) continue;
    const r = el.getBoundingClientRect();
    out[pathOf(el)] = [
      Math.round(r.x + window.scrollX),
      Math.round(r.y + window.scrollY),
      Math.round(r.width),
      Math.round(r.height),
    ];
  }
  return out;
}

/**
 * Re-measure element rects in the geometry {@link captureFullPageScreenshot} draws.
 *
 * The style walk measures rects in the page as driven, where a nested scroller may be
 * scrolled (a surface's own click scrolls its target into view) or clip content below
 * it. The full-page screenshot expands those scrollers, so its pixels sit elsewhere and
 * report crops cut the wrong region (an added element reads as "renders identically").
 * Pages with no nested scroller keep their rects untouched. Rects only; styles are not reread.
 */
export async function alignRectsToFullPageGeometry(
  page: Page,
  elements: Record<string, { rect?: DocRect }>,
): Promise<void> {
  try {
    const expanded = await page.evaluate(expandInnerScrollContainers);
    if (!expanded) return;
    const rects = await page.evaluate(measureExpandedRects);
    for (const [p, entry] of Object.entries(elements)) {
      const rect = rects[p];
      if (entry.rect && rect) entry.rect = rect;
    }
  } finally {
    await page.evaluate(restoreInnerScrollContainers).catch(() => undefined);
  }
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
