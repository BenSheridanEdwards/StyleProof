import { test } from '@playwright/test';
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {
  captureStyleMap,
  captureSurfaceScreenshots,
  saveStyleMap,
  trackDataResidue,
  trackInflightRequests,
} from '../capture.js';
import { warn } from '../capture/shared.js';
import type { CaptureMetadata, StyleMap } from '../capture/types.js';
import { COVERAGE_LEDGER, translateExpected, type CoverageLedger, type DeterminismBasis } from '../coverage.js';
import type { DataResidueEntry } from '../data-residue.js';
import { writeBrowserBuildSidecar, writeCaptureManifest } from '../map-store.js';
import { realNow } from '../spec-clock.js';
import { formatSurfaceHeartbeat, runWithSurfaceTimeout, type CapturePhase } from '../surface-progress.js';
import { captureArtifactStem } from '../surface-keys.js';
import { capturePopupSurfaces } from './popups.js';
import { assertDeterministic } from './self-check.js';
import { captureOptionsFor } from './settings.js';
import type { ExpandedSurface, HeartbeatOrdinal, Settings } from './types.js';

/**
 * Let SSE (EventSource) requests bypass HAR record/replay: a long-lived stream cannot
 * round-trip through a HAR entry, and aborting it on replay drops the app into a
 * DIFFERENT but stable no-stream state the settle cannot catch. Registered AFTER
 * routeFromHAR so it matches first; other requests `fallback()` to the HAR.
 */
export async function passLiveStreams(page: Page, url: string): Promise<void> {
  await page.route(url, async (route) => {
    if ((route.request().headers()['accept'] ?? '').includes('text/event-stream')) await route.continue();
    else await route.fallback();
  });
}

/** Replay the baseline's recorded data (or record ours) for the data URLs only, then freeze the clock. */
async function pinInputs(page: Page, harName: string, s: Settings): Promise<void> {
  let intercepting = true;
  if (!s.replayFrom) {
    await page.routeFromHAR(path.join(s.outDir, harName), { url: s.replayUrl, update: true, updateContent: 'embed' });
  } else if (fs.existsSync(path.join(s.replayFrom, harName))) {
    // notFound:'abort' — an unrecorded request fails deterministically rather than hitting the live backend.
    await page.routeFromHAR(path.join(s.replayFrom, harName), { url: s.replayUrl, update: false, notFound: 'abort' });
  } else {
    warn(`styleproof: no replay HAR at ${path.join(s.replayFrom, harName)} — capturing live (NON-deterministic)`);
    intercepting = false;
  }
  if (intercepting) await passLiveStreams(page, s.replayUrl);
  if (s.freezeClock) await page.clock.setFixedTime(new Date(s.clockTime));
}

/** One heartbeat unit per declared surface×width; an auto-width surface is ONE unit. */
export function heartbeatUnitCount(surfaces: ReadonlyArray<{ widths?: number[] }>): number {
  return surfaces.reduce((sum, surface) => sum + (surface.widths?.length || 1), 0);
}

function attachDataResidue(map: StyleMap, residue: DataResidueEntry[]): void {
  if (!residue.length) return;
  map.dataResidue = residue;
  for (const r of residue) {
    warn(
      `styleproof: surface '${r.surface}' — data request ${r.endpoint} FAILED during capture (${r.reason}). ` +
        `The captured state renders this endpoint's fallback branch; states driven by its real responses are ` +
        `uncaptured and unproven. Fixture it (page.route / liveStates) or acknowledge it in styleproof.data-residue.json.`,
    );
  }
}

/**
 * Drive one surface at one width to a settled state and save its style map (+ screenshots).
 * The per-surface ceiling enforced HERE names the surface and phase when one hangs; each
 * completed capture logs one heartbeat line. The caller owns the Playwright test timeout.
 */
export async function captureSurface(
  page: Page,
  surface: ExpandedSurface,
  width: number,
  s: Settings,
  ordinal: HeartbeatOrdinal,
): Promise<void> {
  // Declared BEFORE go(): JS animation libraries read prefers-reduced-motion at mount.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await pinInputs(page, `${surface.key}@${width}.har`, s);
  const height = typeof surface.height === 'function' ? surface.height(width) : (surface.height ?? 800);
  await page.setViewportSize({ width, height });
  // Both trackers are armed BEFORE go() so the surface's own load requests are seen. Residue
  // is keyed on the BASE surface key so liveStates splits and widths dedupe to one entry.
  const requests = trackInflightRequests(page);
  const residue = trackDataResidue(page, s.replayUrl, surface.metadata?.surfaceKey ?? surface.key);
  const captureKey = `${surface.key}@${width}`;
  const startedAtMs = realNow(); // realNow: the spec-process clock may be frozen
  let phase: CapturePhase = 'navigate';
  let selfCheckMs: number | undefined;
  try {
    await runWithSurfaceTimeout(
      captureKey,
      s.surfaceTimeoutMs,
      () => phase,
      async (surfaceRun) => {
        await surface.go(page);
        const map = await captureStyleMap(page, {
          ...captureOptionsFor(surface, s, requests.pending),
          captureComponent: s.captureComponent,
          inventory: s.inventory,
          requiredVisibleState: surface.requiredVisibleState,
          metadata: surface.metadata,
          // The self-check re-run gets no callback, so a breach there is named 'self-check'.
          onPhase: (captureStylePhase) => {
            phase = captureStylePhase;
          },
        });
        if (s.selfCheck) {
          phase = 'self-check';
          const selfCheckStartedAtMs = realNow();
          await assertDeterministic(page, surface, map, s, requests.pending);
          selfCheckMs = realNow() - selfCheckStartedAtMs;
          phase = 'capture';
        }
        // After the self-check so both runs' failures are folded (deduped in the watcher).
        attachDataResidue(map, residue.residue());
        if (s.liveText) map.metadata = { ...map.metadata, liveText: s.liveText };

        // Timeout fence: abandoned work must not write artifacts after rejection.
        if (!surfaceRun.isActive()) return;
        const stem = captureArtifactStem(s.outDir, surface.key, width);
        saveStyleMap(`${stem}.json.gz`, map);
        if (s.screenshots) await captureSurfaceScreenshots(page, stem, { ignore: surface.ignore ?? [] });
      },
    );
    // One stable, greppable line per completed capture (failures already name themselves).
    process.stderr.write(
      `${formatSurfaceHeartbeat({ ...ordinal, captureKey, captureMs: realNow() - startedAtMs, selfCheckMs })}\n`,
    );
    // Popup discovery runs OUTSIDE the per-surface window; each interaction is bounded by `popups.timeoutMs`.
    await capturePopupSurfaces(page, surface, { width, height }, s);
  } finally {
    requests.dispose();
    residue.dispose();
  }
}

/**
 * Emit a test that records the coverage ledger so the GATE can state its completeness
 * basis. `expected: null` records that the spec declared no registry.
 */
export function writeCoverageLedgerTest(
  settings: Settings,
  expected: string[] | null,
  exclude: Record<string, string>,
  captureSurfaces: ReadonlyArray<{ key: string; metadata?: CaptureMetadata }>,
): void {
  test('styleproof coverage ledger', () => {
    fs.mkdirSync(settings.outDir, { recursive: true });
    const determinism: DeterminismBasis = settings.selfCheck
      ? 'self-checked'
      : settings.replayFrom
        ? 'replayed'
        : 'unproven';
    // Pre-translated into the keys captured to disk (the gate reads map filenames only).
    // `dataResidue` travels verbatim; an absent field (older bundles) still reads as warn.
    const ledger: CoverageLedger = {
      version: 1,
      expected: expected == null ? null : translateExpected(expected, captureSurfaces),
      exclude,
      determinism,
      dataResidue: settings.dataResidue,
    };
    fs.writeFileSync(path.join(settings.outDir, COVERAGE_LEDGER), JSON.stringify(ledger, null, 2));
  });
}

/**
 * Record the real browser build, then stamp the manifest in the SAME test (the manifest
 * reads the sidecar back, and parallel tests have no ordering). Stamped at the runner
 * level so a raw `npx playwright test` run also produces a manifest-bearing dir.
 */
export function writeBrowserBuildTest(settings: Settings): void {
  test('styleproof browser build', ({ page }) => {
    writeBrowserBuildSidecar(settings.outDir, page.context().browser()?.version());
    writeCaptureManifest({ dir: settings.outDir, screenshots: settings.screenshots });
  });
}
