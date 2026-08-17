import path from 'node:path';

/**
 * Pure surface-key helpers (no map reads). Surface keys originate from artifact
 * filenames and flow into the PR-comment summary — strip Markdown/HTML control
 * characters so they cannot inject a link, image, or table into that bot comment.
 */

// Surface keys originate from artifact filenames — attacker-controlled in the
// fork capture/report split, and they flow into the PRIVILEGED PR-comment summary
// (the Action slices report.md above the first `### `). Strip the Markdown/HTML
// control characters (`` ` ``, [ ] ( ), < >, |) that could inject a link, image,
// or table into that bot comment. Escaping at the render boundary — the keys stay
// legible; only the injection surface is removed. (Crop FILENAMES are separately
// restricted to [a-z0-9-]; this is the display-side equivalent.)
export const safeKey = (s: string): string => s.replace(/[`[\]()<>|]/g, '-');

export const surfaceBase = (s: string): string => s.replace(/@\d+$/, '');
export const surfaceWidth = (s: string): number => Number(s.match(/@(\d+)$/)?.[1] ?? 0);

/**
 * Capture keys name map files under the output directory. Reject anything that
 * is not a single relative path segment: separators, traversal, drive prefixes,
 * absolute forms, NUL, and empty keys. Uniqueness alone is not filesystem-safe.
 */
export function assertSafeCaptureKey(key: string): string {
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error(`styleproof: capture key must be a non-empty single path segment`);
  }
  if (key.includes('\0')) {
    throw new Error(`styleproof: capture key must not contain NUL`);
  }
  if (key !== key.trim() || key === '.' || key === '..') {
    throw new Error(`styleproof: capture key '${key}' is not a safe single path segment`);
  }
  if (/[\\/]/.test(key) || key.includes('..') || path.isAbsolute(key) || /^[A-Za-z]:/.test(key)) {
    throw new Error(
      `styleproof: capture key '${key}' is not a safe single path segment ` +
        `(no separators, traversal, or drive/absolute forms)`,
    );
  }
  return key;
}

/**
 * Build the map/screenshot stem inside `outputDir`. Always validates the surface
 * key first so hostile keys cannot escape the output directory.
 */
export function captureArtifactStem(outputDir: string, surfaceKey: string, width: number | string): string {
  const key = assertSafeCaptureKey(surfaceKey);
  return path.join(outputDir, `${key}@${width}`);
}

/**
 * Product surface base for counting: authoritative `metadata.surfaceKey` when the
 * caller supplies it, otherwise strip a trailing `@width` from the capture key
 * (older captures without metadata).
 */
export function productSurfaceBase(captureKey: string, authoringSurfaceKey?: string): string {
  return authoringSurfaceKey ?? surfaceBase(captureKey);
}

export function pushSurfaceWidth(byBase: Map<string, number[]>, base: string, surface: string): void {
  const arr = byBase.get(base) ?? [];
  arr.push(surfaceWidth(surface));
  byBase.set(base, arr);
}

export function renderSurfaceGroups(byBase: Map<string, number[]>): string {
  return [...byBase]
    .map(([base, ws]) => {
      const widths = ws.filter((w) => w > 0).sort((a, b) => b - a);
      return widths.length ? `${safeKey(base)} @ ${widths.join(', ')}` : safeKey(base);
    })
    .join(' · ');
}

/** "landing @ 1280, 1080, 390 · landing-nav-open @ 1080" from the surface keys. */
export function formatSurfaceList(surfaces: string[]): string {
  const byBase = new Map<string, number[]>();
  for (const s of surfaces) pushSurfaceWidth(byBase, surfaceBase(s), s);
  return renderSurfaceGroups(byBase);
}

/** Unique product surface bases and capture keys among surfaces that carry a grouped change. */
export function countChangedSurfaceScope(
  groups: Array<{ surfaces: string[] }>,
  surfaceKeyOf?: (captureKey: string) => string | undefined,
): { bases: number; variants: number } {
  const variants = new Set<string>();
  for (const g of groups) for (const s of g.surfaces) variants.add(s);
  const bases = new Set([...variants].map((s) => productSurfaceBase(s, surfaceKeyOf?.(s))));
  return { bases: bases.size, variants: variants.size };
}

/** Unique product surface bases across a set of capture keys (e.g. every map in a dir). */
export function countCapturedSurfaceBases(
  captureKeys: Iterable<string>,
  surfaceKeyOf?: (captureKey: string) => string | undefined,
): number {
  return new Set([...captureKeys].map((s) => productSurfaceBase(s, surfaceKeyOf?.(s)))).size;
}

/** Headline / summary phrasing for changed-surface counts (bases first; variants when wider). */
export function formatChangedSurfaceScope(bases: number, variants: number): string {
  const baseLabel = `${bases} changed surface base${bases === 1 ? '' : 's'}`;
  if (variants > bases) return `${baseLabel} (${variants} variants)`;
  return baseLabel;
}
