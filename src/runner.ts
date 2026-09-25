// Spec-facing capture definitions. Public entry; the machinery lives under src/runner/.
import { test, expect, type Page } from '@playwright/test';
import { loadStyleProofConfigWithLocation } from './config.js';
import { coverageGaps, coverageKeys, mergeCoverageConfig } from './coverage.js';
import { requireLiveTextCapture, validateLiveText } from './live-text.js';
import { captureTestBudgetMs } from './surface-progress.js';
import { detectViewportWidths } from './breakpoints.js';
import { withSurfaceFailureTolerance } from './runner/self-check.js';
import { resolveSettings } from './runner/settings.js';
import {
  captureSurface,
  heartbeatUnitCount,
  writeBrowserBuildTest,
  recordCaptureTestOutcomes,
  writeCoverageLedgerTest,
} from './runner/surface-capture.js';
import type { DefineOptions, HeartbeatOrdinal } from './runner/types.js';
import { assertUniqueExpandedKeys, expandSurfaceVariants } from './runner/variants.js';

export type {
  CrawlOptions,
  DefineOptions,
  PopupCaptureOptions,
  Surface,
  SurfaceLiveState,
  SurfaceVariant,
} from './runner/types.js';
export { defineCrawlCapture } from './runner/crawl-capture.js';
export { isSelfCheckCaptureFailure, selfCheckErrorMessage } from './runner/self-check.js';
export {
  defaultSelfCheck,
  resolveBaseDir,
  resolveDataResidue,
  resolveOutputDir,
  resolvePopupCaptureOptions,
  resolveScreenshots,
} from './runner/settings.js';
export { passLiveStreams } from './runner/surface-capture.js';
export { assertUniqueExpandedKeys, expandSurfaceVariants } from './runner/variants.js';
export { captureArtifactStem } from './surface-keys.js';

/**
 * The `--grep` `styleproof-map` selects capture tests with. A REGEX LITERAL with word
 * boundaries, deliberately: a bare `--grep` string is compiled case-insensitively
 * against the whole title path, and a consumer test merely MENTIONING "StyleProof
 * capture" in prose was once swept into the base capture run and took it down.
 * Kept beside the `test.describe` titles it must agree with.
 */
export const CAPTURE_TEST_GREP = '/(?:^|\\s)styleproof capture(?:\\s|$)/';

/**
 * Generate one Playwright test per surface × width that captures the style map to
 * `<baseDir>/<dir>/<key>@<width>.json.gz`. The baseline run records each surface's
 * data responses to a HAR and the comparison run replays them (STYLEPROOF_REPLAY_FROM),
 * with the clock frozen, so captures are deterministic with no per-repo fixtures.
 */
export function defineStyleMapCapture(options: DefineOptions): void {
  requireLiveTextCapture(validateLiveText(options.liveText), options.captureText ?? false);
  const { surfaces, expected: programmaticExpected, exclude: programmaticExclude = {}, dir } = options;
  const captureSurfaces = surfaces.flatMap(expandSurfaceVariants);
  assertUniqueExpandedKeys(captureSurfaces);

  // Union semantics: config manifest + programmatic expected; config exclude wins per key.
  const loaded = loadStyleProofConfigWithLocation();
  const { expected, exclude, strict } = mergeCoverageConfig(
    loaded.config.coverage,
    programmaticExpected,
    programmaticExclude,
    loaded.configDir,
  );

  // Coverage guard: runs in the NORMAL suite (not gated on a capture dir), so a route
  // added without a surface fails the app's own tests. A surface never taken cannot be diffed.
  if (expected) {
    test.describe('styleproof coverage', () => {
      test('every expected surface is captured or explicitly excluded', () => {
        const { uncovered, staleExclusions } = coverageGaps(coverageKeys(captureSurfaces), expected, exclude);
        expect(
          uncovered,
          `StyleProof coverage gap: ${uncovered.length} expected surface(s) are neither captured ` +
            `nor excluded — add each to \`surfaces\`, or to \`exclude\` with a reason. ` +
            `Missing: ${uncovered.join(', ')}`,
        ).toEqual([]);
        expect(
          staleExclusions,
          `StyleProof: \`exclude\` lists surface(s) absent from \`expected\` ` +
            `(renamed or removed?): ${staleExclusions.join(', ')}`,
        ).toEqual([]);
      });
    });
  }
  // Strict mode with no registry at all: catches a manifest that failed to load.
  if (strict && !expected) {
    test.describe('styleproof coverage', () => {
      test('strict coverage mode requires expected surfaces', () => {
        throw new Error(
          'StyleProof coverage.strict is true but no expected surfaces were declared ' +
            '(set coverage.manifest or pass expected to defineStyleMapCapture)',
        );
      });
    });
  }

  if (!dir) return;

  const settings = resolveSettings(options);
  test.describe('styleproof capture', () => {
    // Every generated test is independent, so captures fan out across workers even when the
    // project pins `fullyParallel: false`; `parallel: false` keeps file order for specs whose
    // sibling tests read the captured maps.
    if (options.parallel !== false) test.describe.configure({ mode: 'parallel' });
    recordCaptureTestOutcomes();
    writeCoverageLedgerTest(settings, expected ?? null, exclude ?? {}, captureSurfaces);
    writeBrowserBuildTest(settings);
    // Ordinals are assigned at define time (stable across workers); test budgets derive from
    // the per-surface ceiling so the NAMED timeout always fires before the anonymous one.
    const total = heartbeatUnitCount(captureSurfaces);
    let unit = 0;
    for (const surface of captureSurfaces) {
      const capture = (page: Page, width: number, ordinal: HeartbeatOrdinal): Promise<void> =>
        withSurfaceFailureTolerance(settings, `${surface.key}@${width}`, () =>
          captureSurface(page, surface, width, settings, ordinal),
        );
      if (surface.widths?.length) {
        for (const width of surface.widths) {
          const ordinal: HeartbeatOrdinal = { index: ++unit, total };
          test(`${surface.key} @ ${width}`, ({ page }) => {
            test.setTimeout(captureTestBudgetMs(settings.surfaceTimeoutMs));
            return capture(page, width, ordinal);
          });
        }
      } else {
        // Auto widths: load once, detect the breakpoints, then sweep each band in one test.
        const ordinal: HeartbeatOrdinal = { index: ++unit, total };
        test(`${surface.key} @ auto`, async ({ page }) => {
          await surface.go(page);
          const widths = await detectViewportWidths(page);
          test.setTimeout(captureTestBudgetMs(settings.surfaceTimeoutMs, widths.length));
          for (const width of widths) await capture(page, width, ordinal);
        });
      }
    }
  });
}
