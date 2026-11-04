import type { CDPSession, Page } from '@playwright/test';
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

      const values = allowedValues.get(feature);
      if (!values) {
        const motionNote = feature === 'reducedMotion' ? '; motion stays reduced for determinism' : '';
        throw new Error(`styleproof: unknown mediaStates feature '${feature}'${motionNote}`);
      }
      if (!values.includes(value)) {
        throw new Error(`styleproof: invalid mediaStates value for '${feature}'; allowed values: ${values.join(', ')}`);
      }
    }

    if (![...allowedValues.keys()].some((feature) => Object.hasOwn(declaration, feature))) {
      throw new Error('styleproof: each mediaStates entry requires at least one media feature');
    }

    return { ...declaration };
  });
}

const pagesWithDeclaredMedia = new WeakSet<Page>();
type StartingMedia = Required<Pick<MediaState, 'colorScheme' | 'media' | 'forcedColors'>>;
const startingPageMedia = new WeakMap<Page, StartingMedia>();

/** Establish this capture's complete media environment before navigation, clearing prior crawl states. */
export async function applyMediaState(page: Page, declaration?: MediaState, session?: CDPSession): Promise<void> {
  if (!declaration && !pagesWithDeclaredMedia.has(page)) {
    await page.emulateMedia({ reducedMotion: 'reduce' });

    return;
  }

  let startingMedia = startingPageMedia.get(page);
  if (!startingMedia) {
    startingMedia = await page.evaluate(() => ({
      colorScheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
      media: matchMedia('print').matches ? 'print' : 'screen',
      forcedColors: matchMedia('(forced-colors: active)').matches ? 'active' : 'none',
    }));
    startingPageMedia.set(page, startingMedia);
  }

  const media = {
    colorScheme: declaration?.colorScheme ?? startingMedia.colorScheme,
    media: declaration?.media ?? startingMedia.media,
    forcedColors: declaration?.forcedColors ?? startingMedia.forcedColors,
    reducedMotion: 'reduce' as const,
  };
  await page.emulateMedia(media);
  if (declaration) pagesWithDeclaredMedia.add(page);
  else pagesWithDeclaredMedia.delete(page);
  // Chromium reapplies each attached session's media type on a process swap, so an empty tracker
  // session would overwrite Playwright's print override during navigation. Send the media type only:
  // features set on a session are all cleared page-wide when that session detaches.
  await session?.send('Emulation.setEmulatedMedia', { media: media.media });
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

const warnedMediaScopes = new Set<string>();
const inspectedMediaSurfaces = new Set<string>();

/** One advisory warning per runner scope in this process. Unreadable sheets remain the breakpoint detector's responsibility. */
export async function warnUndeclaredMediaStates(
  page: Page,
  options: Pick<CaptureOptions, 'mediaStatesDeclared' | 'mediaWarningScope' | 'metadata'> = {},
): Promise<void> {
  const scope = options.mediaWarningScope;
  const declared = options.mediaStatesDeclared || !!options.metadata?.mediaState;

  if (!scope || declared || warnedMediaScopes.has(scope)) return;
  const surface = JSON.stringify([scope, options.metadata?.surfaceKey]);
  if (inspectedMediaSurfaces.has(surface)) return;
  inspectedMediaSurfaces.add(surface);
  const { mediaTexts } = await page.evaluate(collectMediaTexts);
  const features = mediaStateFeatures(mediaTexts);

  if (!features.length) return;
  warnedMediaScopes.add(scope);
  warn(
    `styleproof: loaded stylesheets use ${features.join(', ')}; these media environments are not captured by default. ` +
      'Declare mediaStates on defineStyleMapCapture, defineCrawlCapture, or a surface to capture them. ' +
      'prefers-contrast is advisory only; forcedColors does not emulate prefers-contrast.',
  );
}
