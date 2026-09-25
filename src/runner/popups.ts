import type { Page } from '@playwright/test';
import { captureStyleMap, captureSurfaceScreenshots, saveStyleMap, trackInflightRequests } from '../capture.js';
import { warn } from '../capture/shared.js';
import type { CaptureMetadata, StyleMap } from '../capture/types.js';
import { diffStyleMaps } from '../diff.js';
import { realNow } from '../spec-clock.js';
import { captureArtifactStem } from '../surface-keys.js';
import { popupDomSnapshot, type PopupCandidate, type PopupSnapshotArgs } from './browser.js';
import { selfCheckErrorMessage } from './self-check.js';
import { captureOptionsFor, resolvePopupCaptureOptions } from './settings.js';
import type { ExpandedSurface, ResolvedPopupCaptureOptions, Settings } from './types.js';

const POPUP_TRIGGER_ATTR = 'data-styleproof-popup-trigger';

const snapshot = (page: Page, args: PopupSnapshotArgs) => page.evaluate(popupDomSnapshot, args);

/** `none`: no overlay appeared (silently ignored); `missing`: the trigger lost its identity after the reset;
 *  `leaked`: overlays absent from the pristine state are still visible, so the reset did not reset. */
type PopupOpenResult =
  | { status: 'opened'; key: string }
  | { status: 'none' }
  | { status: 'missing' }
  | { status: 'leaked'; leaked: string[] };

/**
 * Reset the surface (Escape + `go()`), VERIFY the reset against the pristine overlay
 * keys, re-bind the trigger by its recorded (path, label) identity, then open it.
 */
async function openPopupCandidate(
  page: Page,
  surface: ExpandedSurface,
  viewport: { width: number; height: number },
  options: ResolvedPopupCaptureOptions,
  candidate: PopupCandidate,
  pristine: ReadonlySet<string>,
): Promise<PopupOpenResult> {
  await page.setViewportSize(viewport);
  await page.keyboard.press('Escape').catch(() => {});
  await surface.go(page);
  const reset = await snapshot(page, {
    popupSelector: options.overlays,
    triggerSelector: options.triggers,
    attr: POPUP_TRIGGER_ATTR,
    relocatePath: candidate.path,
    relocateLabel: candidate.label,
  });
  const leaked = reset.keys.filter((key) => !pristine.has(key));
  if (leaked.length) return { status: 'leaked', leaked };
  if (!reset.found) return { status: 'missing' };

  const before = new Set(reset.keys);
  await page
    .locator(`[${POPUP_TRIGGER_ATTR}="target"]`)
    .first()
    .click({ timeout: Math.max(500, options.timeoutMs), noWaitAfter: true })
    .catch(() => undefined);

  const deadline = realNow() + options.timeoutMs;
  do {
    const { keys } = await snapshot(page, { popupSelector: options.overlays });
    const opened = keys.find((key) => !before.has(key));
    if (opened) return { status: 'opened', key: opened };
    await page.waitForTimeout(50);
  } while (realNow() < deadline);
  return { status: 'none' };
}

const leakedOverlaysDesc = (leaked: string[]): string =>
  `overlay(s) the reset (Escape + go()) could not clear: ${leaked.join('; ')}`;

/** Why a popup could not be captured safely — the caller names it rather than silently skipping. */
const SKIP_REASONS: Record<'leaked' | 'missing' | 'self-check-leaked', (leaked: string[]) => string> = {
  leaked: (leaked) =>
    `${leakedOverlaysDesc(leaked)} — capturing now would include the previous ` +
    `popup's residue. Dismiss it in the surface's go(), or capture it as an explicit variant.`,
  missing: () =>
    `its originally-enumerated trigger is no longer identifiable after the reset (Escape + go()) — ` +
    `gone from the DOM, or a shifted same-tag sibling no longer matches its recorded label; ` +
    `skipping rather than re-binding to a different trigger.`,
  'self-check-leaked': (leaked) =>
    `reopening for the self-check found ${leakedOverlaysDesc(leaked)} — the popup itself ` +
    `defeats the reset, so its determinism can't be verified and the capture is discarded.`,
};

function popupMetadata(surface: ExpandedSurface, popupId: string): CaptureMetadata {
  return {
    surfaceKey: surface.metadata?.surfaceKey ?? surface.key,
    variantKey: surface.metadata?.variantKey ? `${surface.metadata.variantKey}/${popupId}` : popupId,
    variantKind: 'popup',
    ...(surface.metadata?.productState ? { productState: surface.metadata.productState } : {}),
    ...(surface.metadata?.inputs ? { inputs: surface.metadata.inputs } : {}),
  };
}

type PopupRun = {
  page: Page;
  surface: ExpandedSurface;
  viewport: { width: number; height: number };
  s: Settings;
  options: ResolvedPopupCaptureOptions;
  pristine: ReadonlySet<string>;
  pending: () => number;
};

function captureOpenedPopupMap(run: PopupRun, popupId: string): Promise<StyleMap> {
  return captureStyleMap(run.page, {
    ...captureOptionsFor(run.surface, run.s, run.pending),
    captureComponent: run.s.captureComponent,
    metadata: popupMetadata(run.surface, popupId),
  });
}

/** Reopen and throw on drift/no-reopen; returns leaked keys when the popup itself defeats the reset. */
async function assertPopupDeterministic(
  run: PopupRun,
  candidate: PopupCandidate,
  popupId: string,
  first: StyleMap,
): Promise<string[] | undefined> {
  const reopened = await openPopupCandidate(run.page, run.surface, run.viewport, run.options, candidate, run.pristine);
  if (reopened.status === 'leaked') return reopened.leaked;
  if (reopened.status !== 'opened') {
    throw new Error(
      `styleproof self-check failed: ${run.surface.key}-${popupId} popup did not reopen` +
        (reopened.status === 'missing' ? ' (its trigger disappeared from the DOM or changed identity)' : ''),
    );
  }
  const again = await captureOpenedPopupMap(run, popupId);
  const drift = diffStyleMaps(first, again);
  if (drift.length) {
    throw new Error(
      selfCheckErrorMessage(`${run.surface.key}-${popupId}`, drift, first.volatile, first.liveCandidates),
    );
  }
  return undefined;
}

async function capturePopupCandidate(run: PopupRun, candidate: PopupCandidate): Promise<void> {
  const { page, surface, s } = run;
  const popupId = `popup-${String(candidate.index + 1).padStart(2, '0')}`;
  const skip = (reason: string): void => {
    warn(`styleproof: skipped ${surface.key}-${popupId}@${run.viewport.width} — ${reason}`);
  };
  const opened = await openPopupCandidate(page, surface, run.viewport, run.options, candidate, run.pristine);
  if (opened.status === 'none') return;
  if (opened.status !== 'opened')
    return skip(SKIP_REASONS[opened.status](opened.status === 'leaked' ? opened.leaked : []));

  const map = await captureOpenedPopupMap(run, popupId);
  if (s.selfCheck) {
    const leaked = await assertPopupDeterministic(run, candidate, popupId, map);
    if (leaked) return skip(SKIP_REASONS['self-check-leaked'](leaked));
  }
  if (s.liveText) map.metadata = { ...map.metadata, liveText: s.liveText };
  const stem = captureArtifactStem(s.outDir, `${surface.key}-${popupId}`, run.viewport.width);
  saveStyleMap(`${stem}.json.gz`, map);
  if (s.screenshots) await captureSurfaceScreenshots(page, stem, { ignore: surface.ignore ?? [] });
}

/** Enumerate the surface's popup triggers once, then capture each opened popup as `<surface>-popup-XX`. */
export async function capturePopupSurfaces(
  page: Page,
  surface: ExpandedSurface,
  viewport: { width: number; height: number },
  s: Settings,
): Promise<void> {
  const options = resolvePopupCaptureOptions(surface.popups ?? s.popups);
  if (!options.enabled || options.max === 0) return;

  await surface.go(page);
  const { keys, candidates } = await snapshot(page, {
    triggerSelector: options.triggers,
    popupSelector: options.overlays,
    attr: POPUP_TRIGGER_ATTR,
    max: options.max,
  });
  // Overlays legitimately visible in the settled state; every reopen is verified back to this baseline.
  const pristine: ReadonlySet<string> = new Set(keys);
  for (const candidate of candidates) {
    const requests = trackInflightRequests(page);
    try {
      await capturePopupCandidate(
        { page, surface, viewport, s, options, pristine, pending: requests.pending },
        candidate,
      );
    } finally {
      requests.dispose();
    }
  }
}
