/**
 * Run-level crawl confidence: did the crawl hit an authentication boundary, and
 * is the result still allowed to claim full certification?
 *
 * A green visual capture is misleading when the crawler stopped at a sign-in
 * form or auth redirect. This module turns redacted {@link classifyAuthBoundary}
 * diagnostics into a run-level status (`complete` | `incomplete-auth` |
 * `incomplete-unknown`) and an acknowledgement ledger so unacknowledged walls
 * fail closed while reasoned exclusions mark scope as explicitly limited —
 * never inventing a coverage percentage for inaccessible surfaces.
 * `incomplete-unknown` is available on the resolver when callers pass
 * `unknownIncompleteness`; the crawl itself does not currently emit it.
 *
 * Secrets never appear here: observations carry only classifier diagnostics
 * (selectors already redacted, pathnames only). Values, cookies, tokens,
 * headers, query strings, fragments, and secret DOM text are out of scope.
 */

import { isAuthPath, type AuthBoundaryDiagnostic } from './auth-boundary.js';

/** Run-level crawl completeness for certification. */
export type CrawlConfidenceStatus = 'complete' | 'incomplete-auth' | 'incomplete-unknown';

/**
 * One auth boundary observed during a crawl — route + redacted diagnostics only.
 * Never includes field values, cookies, tokens, headers, or secret text.
 */
export type AuthBoundaryObservation = {
  /**
   * Redacted pathname of the page (or requested route) where the boundary was
   * seen. Query, fragment, and credentials are never retained.
   */
  route?: string;
  /** Deterministic diagnostics from {@link classifyAuthBoundary}. */
  diagnostics: AuthBoundaryDiagnostic[];
};

/** `observationKey → non-empty reason` — walls deliberately outside certification. */
export type AuthBoundaryExclude = Record<string, string>;

/**
 * Run-level confidence attached to {@link CrawlReport}. Backward compatible for
 * consumers that ignore the field: absence of walls yields `status: 'complete'`.
 */
export type CrawlConfidence = {
  status: CrawlConfidenceStatus;
  /** Every distinct auth boundary observed (redacted). */
  authBoundaries: AuthBoundaryObservation[];
  /** Observed boundaries matched by a reasoned exclusion. */
  acknowledged: Array<AuthBoundaryObservation & { key: string; reason: string }>;
  /** Observed boundaries with no exclusion — fail closed when non-empty. */
  unacknowledged: Array<AuthBoundaryObservation & { key: string }>;
  /**
   * Exclusion keys that matched nothing this run — a rotted opt-out ledger
   * (mirrors inventory / data-residue stale acknowledgements).
   */
  staleExclusions: string[];
  /**
   * True only when status is `complete` (no auth walls observed). Acknowledged
   * exclusions keep `status: 'incomplete-auth'` and never claim full certification.
   */
  certifiesFully: boolean;
  /**
   * True when unacknowledged auth boundaries remain — CI/crawl must fail closed.
   */
  blocked: boolean;
};

/**
 * Stable identity for one observation, for exclusion matching and CLI output.
 * Format: `<route>·<sorted diagnostic reasons>` (route defaults to `unknown`).
 */
export function authBoundaryKey(observation: AuthBoundaryObservation): string {
  const route = observation.route && observation.route.trim() ? observation.route.trim() : 'unknown';
  const reasons = [...new Set(observation.diagnostics.map((d) => d.reason))].sort().join('+');
  return reasons ? `${route}·${reasons}` : route;
}

/**
 * Validate an exclusion ledger. Every reason must be a non-empty string after
 * trim — empty reasons are rejected so silence cannot clear a fail-closed wall.
 */
export function normalizeAuthBoundaryExclude(exclude: Record<string, string> | undefined): AuthBoundaryExclude {
  if (!exclude) return {};
  const out: AuthBoundaryExclude = {};
  for (const [rawKey, rawReason] of Object.entries(exclude)) {
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

/** Redact a URL or path down to pathname only (shared with crawl observation). */
export function redactedRoutePath(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const input = value.trim();
  if (!input) return undefined;
  try {
    if (input.startsWith('/') || /^https?:\/\//i.test(input)) {
      const url = new URL(input, 'https://styleproof.invalid');
      const pathname = url.pathname || '/';
      return pathname.startsWith('/') ? pathname : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Merge raw observations that share a key (same route + reasons), concatenating
 * diagnostics and de-duplicating by JSON identity.
 */
function appendUniqueDiagnostics(target: AuthBoundaryDiagnostic[], incoming: AuthBoundaryDiagnostic[]): void {
  const seen = new Set(target.map((d) => JSON.stringify(d)));
  for (const d of incoming) {
    const s = JSON.stringify(d);
    if (seen.has(s)) continue;
    seen.add(s);
    target.push(d);
  }
}

export function mergeAuthBoundaryObservations(observations: AuthBoundaryObservation[]): AuthBoundaryObservation[] {
  // Group by redacted route so multiple signals on one page become one observation.
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
    appendUniqueDiagnostics(prev.diagnostics, obs.diagnostics);
  }
  for (const obs of byRoute.values()) {
    obs.diagnostics.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return [...byRoute.values()].sort((a, b) => authBoundaryKey(a).localeCompare(authBoundaryKey(b)));
}

/**
 * Whether HTTP auth-redirect diagnostics collected during navigation should be
 * retained after optional setup.
 *
 * Intermediate redirects are dropped only when setup ran, the landed DOM has no
 * auth wall, AND the final pathname is known and not auth-semantic (successful
 * unlock away from login/oauth). Unrelated setup on an OAuth-only /login (no
 * password field) must not drop the redirect. No setup, still-gated DOM, or
 * auth-semantic landed path all retain (fail closed).
 *
 * @param landedPathname Redacted pathname only — never query, fragment, or secrets.
 */
export function shouldRetainAuthRedirects(
  hadSetup: boolean,
  landedHasAuthBoundary: boolean,
  landedPathname?: string | null,
): boolean {
  if (!hadSetup) return true;
  if (landedHasAuthBoundary) return true;
  const path = typeof landedPathname === 'string' ? landedPathname.trim() : '';
  // Only drop when we can prove we left auth: known non-auth path + no DOM wall.
  if (path && !isAuthPath(path)) return false;
  return true;
}

/**
 * Resolve run-level confidence from observations + optional reasoned exclusions.
 *
 * - No walls → `complete` (full certification).
 * - Any wall → `incomplete-auth` (even when every wall is excluded — exclusions
 *   mark scope limited and never upgrade to full certification).
 * - `unknownIncompleteness` with no auth walls → `incomplete-unknown`.
 *   Note: `incomplete-unknown` is resolver-only today — callers may pass
 *   `unknownIncompleteness`; the crawl path does not auto-produce it.
 * - `blocked` iff any wall is unacknowledged (fail closed).
 */

/**
 * Collapse text for single-line CLI/log rendering: strip C0 controls, DEL, and
 * Unicode line/paragraph separators so exclusion reasons cannot inject multiline
 * log lines. Stored/API reason strings keep their original semantics; only the
 * terminal rendering path should use this.
 */
export function cliSafeLine(value: string): string {
  // C0 controls + DEL + Unicode line/paragraph separators → space
  return Array.from(String(value), (ch) => {
    const c = ch.codePointAt(0)!;
    if (c <= 0x1f || c === 0x7f || c === 0x2028 || c === 0x2029) return ' ';
    return ch;
  })
    .join('')
    .replace(/ +/g, ' ')
    .trim();
}

/**
 * Crawl CLI exit precedence after a successful capture run.
 * Coverage residue (`--require-full-coverage`) exits 4 and intentionally wins
 * over unacknowledged auth (exit 5) so a coverage gap is not masked by auth.
 * Auth blocked → 5; otherwise 0.
 */
export function crawlCaptureExitCode(input: {
  requireFullCoverage: boolean;
  hasCoverageResidue: boolean;
  authBlocked: boolean;
}): 0 | 4 | 5 {
  if (input.requireFullCoverage && input.hasCoverageResidue) return 4;
  if (input.authBlocked) return 5;
  return 0;
}

export function resolveCrawlConfidence(input: {
  observations: AuthBoundaryObservation[];
  exclude?: Record<string, string>;
  /** Other incompleteness with no auth signal (reserved; optional callers). */
  unknownIncompleteness?: boolean;
}): CrawlConfidence {
  const exclude = normalizeAuthBoundaryExclude(input.exclude);
  const authBoundaries = mergeAuthBoundaryObservations(input.observations);
  const matchedExcludeKeys = new Set<string>();
  const acknowledged: CrawlConfidence['acknowledged'] = [];
  const unacknowledged: CrawlConfidence['unacknowledged'] = [];

  for (const obs of authBoundaries) {
    const key = authBoundaryKey(obs);
    const reason = matchExclusion(obs, key, exclude);
    if (reason !== undefined) {
      matchedExcludeKeys.add(reason.matchedKey);
      acknowledged.push({ ...obs, key, reason: reason.reason });
    } else {
      unacknowledged.push({ ...obs, key });
    }
  }

  const staleExclusions = Object.keys(exclude)
    .filter((k) => !matchedExcludeKeys.has(k))
    .sort();

  let status: CrawlConfidenceStatus;
  if (authBoundaries.length > 0) status = 'incomplete-auth';
  else if (input.unknownIncompleteness) status = 'incomplete-unknown';
  else status = 'complete';

  const blocked = unacknowledged.length > 0;
  return {
    status,
    authBoundaries,
    acknowledged,
    unacknowledged,
    staleExclusions,
    certifiesFully: status === 'complete',
    blocked,
  };
}

/**
 * Match an observation against the exclusion ledger. Accepts:
 * - full observation key (`/login·password-input`)
 * - route pathname alone (`/login`)
 * - auth formAction / redirectTo path from diagnostics
 */
function matchExclusion(
  obs: AuthBoundaryObservation,
  key: string,
  exclude: AuthBoundaryExclude,
): { matchedKey: string; reason: string } | undefined {
  const candidates = new Set<string>([key]);
  if (obs.route) candidates.add(obs.route);
  for (const d of obs.diagnostics) {
    if (d.kind === 'auth-form') candidates.add(d.formAction);
    if (d.kind === 'auth-redirect') {
      candidates.add(d.redirectTo);
      if (d.route) candidates.add(d.route);
    }
  }
  for (const c of candidates) {
    if (c in exclude) return { matchedKey: c, reason: exclude[c] };
  }
  return undefined;
}
