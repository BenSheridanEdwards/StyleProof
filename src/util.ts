// Pure helpers shared across the library (no Node runtime imports, so the
// component catalog modules stay browser-bundleable).

export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Forward slashes only, so keys and manifests agree across platforms. */
export const toSlash = (value: string): string => value.replace(/\\/g, '/');

/** Lower-case kebab slug, capped at `max` characters; never empty. */
export function slug(value: string, max = 24): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, max) || 'state'
  );
}
