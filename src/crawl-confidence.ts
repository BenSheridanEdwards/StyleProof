/**
 * Run-level crawl confidence: redacted auth-boundary diagnostics become a status plus an
 * acknowledgement ledger — unacknowledged walls fail closed, reasoned exclusions mark scope as
 * limited, and no coverage percentage is ever invented. Observations carry only classifier
 * diagnostics (selectors already redacted, pathnames only); secrets never appear here.
 */
import { isAuthPath, redactedPath as redactedRoutePath, type AuthBoundaryDiagnostic } from './auth-boundary.js';

/** Redact a URL or path down to pathname only (shared with crawl observation). */
export { redactedRoutePath };

export type CrawlConfidenceStatus = 'complete' | 'incomplete-auth' | 'incomplete-unknown';

/** One auth boundary observed during a crawl — redacted route + diagnostics only. */
export type AuthBoundaryObservation = { route?: string; diagnostics: AuthBoundaryDiagnostic[] };

/** `observationKey → non-empty reason` — walls deliberately outside certification. */
export type AuthBoundaryExclude = Record<string, string>;

/** Run-level confidence attached to a crawl report; absence of walls yields `status: 'complete'`.
 *  `certifiesFully` is true only with no walls (exclusions never upgrade it); `blocked` is true while
 *  unacknowledged walls remain (fail closed); `staleExclusions` are keys that matched nothing. */
export type CrawlConfidence = {
  status: CrawlConfidenceStatus;
  authBoundaries: AuthBoundaryObservation[];
  acknowledged: Array<AuthBoundaryObservation & { key: string; reason: string }>;
  unacknowledged: Array<AuthBoundaryObservation & { key: string }>;
  staleExclusions: string[];
  certifiesFully: boolean;
  blocked: boolean;
};

/** Stable identity for one observation: `<route>·<sorted diagnostic reasons>` (route defaults to `unknown`). */
export function authBoundaryKey(observation: AuthBoundaryObservation): string {
  const route = observation.route?.trim() || 'unknown';
  const reasons = [...new Set(observation.diagnostics.map((d) => d.reason))].sort().join('+');
  return reasons ? `${route}·${reasons}` : route;
}

/** Validate an exclusion ledger. Every reason must be non-empty after trim — silence cannot clear a wall. */
export function normalizeAuthBoundaryExclude(exclude: Record<string, string> | undefined): AuthBoundaryExclude {
  const out: AuthBoundaryExclude = {};
  for (const [rawKey, rawReason] of Object.entries(exclude ?? {})) {
    const key = typeof rawKey === 'string' ? rawKey.trim() : '';
    if (!key) throw new Error('authBoundaryExclude: exclusion key must be a non-empty string');
    if (typeof rawReason !== 'string' || !rawReason.trim()) {
      throw new Error(
        `authBoundaryExclude: exclusion for "${key}" needs a non-empty reason — ` +
          `empty reasons cannot clear an authentication boundary`,
      );
    }
    out[key] = rawReason.trim();
  }
  return out;
}

/** Merge observations that share a redacted route, de-duplicating diagnostics by JSON identity. */
export function mergeAuthBoundaryObservations(observations: AuthBoundaryObservation[]): AuthBoundaryObservation[] {
  const byRoute = new Map<string, AuthBoundaryObservation>();
  for (const obs of observations) {
    if (!obs.diagnostics.length) continue;
    const route = redactedRoutePath(obs.route);
    // Never fall back to raw obs.route — omit route when redaction fails.
    const groupKey = route ?? `unknown:${authBoundaryKey({ diagnostics: obs.diagnostics })}`;
    const prev = byRoute.get(groupKey);
    if (!prev) {
      byRoute.set(groupKey, { ...(route ? { route } : {}), diagnostics: [...obs.diagnostics] });
      continue;
    }
    const seen = new Set(prev.diagnostics.map((d) => JSON.stringify(d)));
    for (const d of obs.diagnostics) if (!seen.has(JSON.stringify(d))) prev.diagnostics.push(d);
  }
  for (const obs of byRoute.values()) {
    obs.diagnostics.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return [...byRoute.values()].sort((a, b) => authBoundaryKey(a).localeCompare(authBoundaryKey(b)));
}

/** Whether HTTP auth-redirect diagnostics survive optional setup. Dropped only when setup ran, the
 *  landed DOM has no auth wall, AND the landed pathname is known and not auth-semantic (a proven
 *  unlock); everything else retains (fail closed). */
export function shouldRetainAuthRedirects(
  hadSetup: boolean,
  landedHasAuthBoundary: boolean,
  landedPathname?: string | null,
): boolean {
  if (!hadSetup || landedHasAuthBoundary) return true;
  const path = typeof landedPathname === 'string' ? landedPathname.trim() : '';
  return !(path && !isAuthPath(path));
}

/** Collapse text for single-line CLI rendering: C0 controls, DEL, and Unicode line/paragraph
 *  separators become spaces so an exclusion reason cannot inject log lines. */
export function cliSafeLine(value: string): string {
  return Array.from(String(value), (ch) => {
    const c = ch.codePointAt(0)!;
    return c <= 0x1f || c === 0x7f || c === 0x2028 || c === 0x2029 ? ' ' : ch;
  })
    .join('')
    .replace(/ +/g, ' ')
    .trim();
}

/** Crawl CLI exit precedence: coverage residue 4 wins, then incomplete UI 6, then unacknowledged auth 5. */
export function crawlCaptureExitCode(input: {
  requireFullCoverage: boolean;
  hasCoverageResidue: boolean;
  incompleteUiBlocked?: boolean;
  authBlocked: boolean;
}): 0 | 4 | 5 | 6 {
  if (input.requireFullCoverage && input.hasCoverageResidue) return 4;
  if (input.incompleteUiBlocked) return 6;
  if (input.authBlocked) return 5;
  return 0;
}

/** Match by full key, route pathname, or an auth formAction / redirectTo path from the diagnostics. */
function matchExclusion(
  obs: AuthBoundaryObservation,
  key: string,
  exclude: AuthBoundaryExclude,
): { matchedKey: string; reason: string } | undefined {
  const fromDiagnostics = obs.diagnostics.flatMap((d) =>
    d.kind === 'auth-form' ? [d.formAction] : d.kind === 'auth-redirect' ? [d.redirectTo, d.route] : [],
  );
  const matchedKey = [key, obs.route, ...fromDiagnostics].find((c): c is string => Boolean(c && c in exclude));
  return matchedKey ? { matchedKey, reason: exclude[matchedKey] } : undefined;
}

/** No walls → `complete`; any wall → `incomplete-auth` (even when every wall is excluded);
 *  `unknownIncompleteness` with no walls → `incomplete-unknown`; `blocked` iff any wall is unacknowledged. */
export function resolveCrawlConfidence(input: {
  observations: AuthBoundaryObservation[];
  exclude?: Record<string, string>;
  /** Other incompleteness with no auth signal (reserved; the crawl does not emit it). */
  unknownIncompleteness?: boolean;
}): CrawlConfidence {
  const exclude = normalizeAuthBoundaryExclude(input.exclude);
  const authBoundaries = mergeAuthBoundaryObservations(input.observations);
  const matchedExcludeKeys = new Set<string>();
  const acknowledged: CrawlConfidence['acknowledged'] = [];
  const unacknowledged: CrawlConfidence['unacknowledged'] = [];
  for (const obs of authBoundaries) {
    const key = authBoundaryKey(obs);
    const match = matchExclusion(obs, key, exclude);
    if (match) {
      matchedExcludeKeys.add(match.matchedKey);
      acknowledged.push({ ...obs, key, reason: match.reason });
    } else {
      unacknowledged.push({ ...obs, key });
    }
  }
  const status: CrawlConfidenceStatus = authBoundaries.length
    ? 'incomplete-auth'
    : input.unknownIncompleteness
      ? 'incomplete-unknown'
      : 'complete';
  return {
    status,
    authBoundaries,
    acknowledged,
    unacknowledged,
    staleExclusions: Object.keys(exclude)
      .filter((k) => !matchedExcludeKeys.has(k))
      .sort(),
    certifiesFully: status === 'complete',
    blocked: unacknowledged.length > 0,
  };
}
