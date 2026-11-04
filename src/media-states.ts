import type { Page } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { collectMediaTexts } from './breakpoints.js';
import { warn } from './capture/shared.js';
import type { CaptureMetadata, CaptureOptions, MediaState } from './capture/types.js';
import { assertSafeCaptureKey } from './surface-keys.js';

/** Validate the JavaScript-facing option boundary as well as typed declarations. */
export function validateMediaStates(input: MediaState[] | undefined): MediaState[] {
  if (input === undefined) return [];

  if (!Array.isArray(input)) throw new Error('styleproof: mediaStates must be an array');

  const allowedValues = new Map<string, readonly string[]>([
    ['colorScheme', ['light', 'dark']],
    ['media', ['screen', 'print']],
    ['forcedColors', ['active', 'none']],
  ]);

  return Array.from(input, (declaration) => {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- JavaScript consumers can pass malformed entries at this public option boundary.
    if (!declaration || typeof declaration !== 'object' || Array.isArray(declaration)) {
      throw new Error('styleproof: each mediaStates entry must be an object');
    }

    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Validate the capture-key contract before passing a JavaScript value to the existing key validator.
    if (typeof declaration.key !== 'string') throw new Error('styleproof: mediaStates requires a string key');
    assertSafeCaptureKey(declaration.key);

    for (const [feature, value] of Object.entries(declaration)) {
      if (feature === 'key') continue;

      if (!allowedValues.get(feature)?.includes(value)) {
        throw new Error(`styleproof: invalid mediaStates feature '${feature}' (motion stays reduced)`);
      }
    }

    if (![...allowedValues.keys()].some((feature) => Object.hasOwn(declaration, feature))) {
      throw new Error('styleproof: each mediaStates entry requires at least one media feature');
    }

    return { ...declaration };
  });
}

const pagesWithDeclaredMedia = new WeakSet<Page>();

/** Establish this capture's complete media environment before navigation, clearing prior crawl states. */
export async function applyMediaState(page: Page, declaration?: MediaState): Promise<void> {
  if (!declaration && !pagesWithDeclaredMedia.has(page)) {
    await page.emulateMedia({ reducedMotion: 'reduce' });

    return;
  }

  await page.emulateMedia({
    colorScheme: declaration?.colorScheme ?? null,
    media: declaration?.media ?? null,
    forcedColors: declaration?.forcedColors ?? null,
    reducedMotion: 'reduce',
  });

  if (declaration) pagesWithDeclaredMedia.add(page);
  else pagesWithDeclaredMedia.delete(page);
}

/** Restore declarations after Chromium detaches a CDP capture session and clears print media. */
export async function restoreDeclaredMediaState(page: Page, metadata?: CaptureMetadata): Promise<void> {
  if (metadata?.mediaState) await applyMediaState(page, metadata.mediaState);
}

/** Names only parsed media features, never stylesheet text or application selectors. */
export function mediaStateFeatures(mediaTexts: string[]): string[] {
  const conditions = mediaTexts.join('\n').toLowerCase();

  return ['prefers-color-scheme', 'print', 'forced-colors', 'prefers-contrast'].filter((feature) =>
    feature === 'print'
      ? /(?:^|[\s,])print(?:$|[\s,)])/.test(conditions)
      : new RegExp(`\\(${feature}\\s*[:)]`).test(conditions),
  );
}

// Test collection runs in the parent before Playwright starts workers. Inheriting this identifier
// lets an atomic temporary-file claim deduplicate warnings across workers, retries and widths.
const mediaWarningRun = (process.env.STYLEPROOF_MEDIA_WARNING_RUN ??= randomUUID());
const warnedMediaScopes = new Set<string>();

/** One advisory warning per run. Unreadable sheets remain the breakpoint detector's responsibility. */
export async function warnUndeclaredMediaStates(
  page: Page,
  options: Pick<CaptureOptions, 'mediaStatesDeclared' | 'mediaWarningScope' | 'metadata'> = {},
): Promise<void> {
  const scope = options.mediaWarningScope ?? 'capture';
  const declared = options.mediaStatesDeclared || !!options.metadata?.mediaState;

  if (declared || warnedMediaScopes.has(scope)) return;
  const { mediaTexts } = await page.evaluate(collectMediaTexts);
  const features = mediaStateFeatures(mediaTexts);

  if (!features.length) return;
  warnedMediaScopes.add(scope);
  // Only the identifier enters the filename; a consumer-provided output path never does.
  const warningIdentifier = createHash('sha256').update(mediaWarningRun).update(scope).digest('hex');
  const warningFile = path.join(tmpdir(), `styleproof-media-warning-${warningIdentifier}`);

  try {
    closeSync(openSync(warningFile, 'wx'));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return;
    throw error;
  }

  warn(
    `styleproof: loaded stylesheets use ${features.join(', ')}; these media environments are not captured by default. ` +
      'Declare mediaStates on defineStyleMapCapture, defineCrawlCapture, or a surface to capture them. ' +
      'prefers-contrast is advisory only; forcedColors does not emulate prefers-contrast.',
  );
}
