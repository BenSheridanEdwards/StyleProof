import type { Page } from '@playwright/test';
import type { IncompleteUiDiagnostic } from '../incomplete-ui.js';
import type { AuthBoundaryObservation, CrawlConfidence } from '../crawl-confidence.js';

export type CrawlAction = 'click' | 'select-option' | 'fill-input';
export type CrawlStep = { action: CrawlAction; selector: string; label: string; reason: string; value?: string };
export type CrawledSurface = { key: string; depth: number; path: CrawlStep[]; elements: number };
export type IncompleteUiObservation = { surface: string; diagnostics: IncompleteUiDiagnostic[] };

/** Did the crawl SEE everything the design styles? Full coverage = empty `missing` AND empty `unreadable`. */
export type CrawlCoverage = {
  defined: number;
  rendered: number;
  /** Classes the page's own stylesheets select on that never rendered — dead CSS, or an unreached state. */
  missing: string[];
  /** Stylesheets the browser could not parse (cross-origin, no CORS): coverage cannot be PROVEN against them. */
  unreadable: string[];
  /** Rendered class names, so a multi-page caller can aggregate coverage across shared stylesheets. */
  renderedClasses: string[];
};

export type CrawlReport = {
  surfaces: CrawledSurface[];
  actionsTried: number;
  skipped: number;
  /** Surfaces captured to disk at every width; `failed` names the rest. */
  captured: number;
  failed: string[];
  coverage: CrawlCoverage;
  /** Always present: `status: 'complete'` without auth walls. */
  confidence: CrawlConfidence;
  /** Privacy-safe blocked continuations observed on each captured surface. */
  incompleteUi: IncompleteUiObservation[];
};

/** One deterministic step run after every fresh navigation — how input-gated states become
 *  crawlable. `${ENV_VAR}` interpolation happens at load time, so secrets never live in files
 *  or maps. `optional` skips the step silently when its selector is absent. */
export type SetupStep = {
  action: 'goto' | 'fill' | 'click' | 'waitFor';
  url?: string;
  selector?: string;
  value?: string;
  optional?: boolean;
};

export type SurfaceCrawlOptions = {
  url: string;
  out: string;
  widths: number[];
  ignore: string[];
  height: number;
  screenshots: boolean;
  waitSelector?: string;
  /** Deterministic steps (login, unlock) run after EVERY fresh navigation. */
  setup?: SetupStep[];
  /** Also capture the entry page's `loading` and `error` data states (default true). */
  dataStates?: boolean;
  /** Stop as soon as every stylesheet class has rendered — a fast coverage check, not an exhaustive map. */
  stopWhenCovered?: boolean;
  /** Throttles: recursion depth (base = 0), fresh controls per state, total surfaces. */
  maxDepth: number;
  maxActionsPerState: number;
  maxStates: number;
  /** Clear localStorage/sessionStorage on each reset so replay is deterministic. */
  resetStorage: boolean;
  /** Called as each surface is recorded (captured=false when its full capture failed). */
  onSurface?: (surface: CrawledSurface, captured: boolean) => void;
  /** Concurrent sweep workers (default 4). Same surface SET as a serial crawl; use 1 for byte-stable dup-key suffixes. */
  workers?: number;
  /** Factory for worker pages — each in its OWN browser context so storage resets cannot interfere. */
  newPage?: () => Promise<Page>;
  /** Namespace for derived surface keys (multi-page sweeps): root = prefix, sub-states = `<prefix>-<label>`. */
  keyPrefix?: string;
  /** Auth boundaries deliberately outside scope (`key → non-empty reason`). Exclusions never claim full certification. */
  authBoundaryExclude?: Record<string, string>;
};

// Exhaustive by default — these ceilings are safety backstops, not budgets. Depth 16 is exhaustive
// for real UI; the cap terminates append-generator chains (a composer adding a fresh-identity row
// per click), and the coverage verifier still names anything left unrendered.
export const CRAWL_DEFAULTS = {
  height: 900,
  screenshots: true,
  maxDepth: 16,
  maxActionsPerState: 100000,
  maxStates: 100000,
  resetStorage: true,
  workers: 4,
};

/** `selector` is positional (what gets clicked in this state); `identity` is semantic (tag path +
 *  label, no classes or indices) and is what the driven-once dedup keys on. */
export type RawCandidate = CrawlStep & { identity: string; unsafe: boolean };

export type Fingerprint = { sig: string; elements: number; classes: string[] };

/** retryOnly: reached through a CONSUMING action (approve/dismiss) — swept with the parent's
 *  persistent mode-switchers only, never fresh candidates, so decision lattices don't multiply. */
export type QueueEntry = { path: CrawlStep[]; depth: number; sig: string; retryOnly: boolean; viaRetry: boolean };

export type CrawlState = {
  /** Fingerprints already captured — a surface is captured once. */
  seen: Set<string>;
  used: Set<string>;
  /** Control identities already driven — once, from the shallowest state they appear in. */
  tried: Set<string>;
  /** Family-retry registry: state-changing controls keyed by the state they were first driven from. */
  changersFrom: Map<string, { c: RawCandidate; persists: boolean }[]>;
  /** Union of class names rendered in captured surfaces — the coverage numerator. */
  classes: Set<string>;
  surfaces: CrawledSurface[];
  queue: QueueEntry[];
  captured: number;
  failed: string[];
  authObservations: AuthBoundaryObservation[];
  incompleteUiObservations: IncompleteUiObservation[];
};
