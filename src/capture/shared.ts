/** Capture-side warnings go to stderr through one hook (tests spy on console.warn). */
export function warn(message: string): void {
  // eslint-disable-next-line no-console -- the one stderr channel for capture-side warnings
  console.warn(message);
}

/** True if `path` is one of `roots` or a structural descendant of one. */
export function isUnder(path: string, roots: string[]): boolean {
  return roots.some((r) => path === r || path.startsWith(r + ' > '));
}

/**
 * Selector matching every ignored element and its descendants; `''` when nothing is ignored.
 * `:is()` groups an entry that is itself a list (`.a, .b`), so ` *` reaches every member.
 */
export function skipSelector(ignore: string[]): string {
  return ignore.length ? ignore.map((s) => `${s}, :is(${s}) *`).join(', ') : '';
}
/** Non-rendered/framework-owned regions intentionally outside compared app elements. */
export const FRAMEWORK_IGNORE = [
  ...'meta title link script style base noscript template next-route-announcer'.split(' '),
  '[id="__next-route-announcer__"]',
  '[data-styleproof-hover-sink]',
];
