/** Capture-side warnings go to stderr through one hook (tests spy on console.warn). */
export function warn(message: string): void {
  // eslint-disable-next-line no-console
  console.warn(message);
}

/** True if `path` is one of `roots` or a structural descendant of one. */
export function isUnder(path: string, roots: string[]): boolean {
  return roots.some((r) => path === r || path.startsWith(r + ' > '));
}

/** Selector matching every ignored element and its descendants; `''` when nothing is ignored. */
export function skipSelector(ignore: string[]): string {
  return ignore.length ? ignore.map((s) => `${s}, ${s} *`).join(', ') : '';
}
