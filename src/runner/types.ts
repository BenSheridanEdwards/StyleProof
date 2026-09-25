import type { Page } from '@playwright/test';
import type { CaptureMetadata, ForcedStateLimits, ProductStateIdentity } from '../capture/types.js';
import type { LiveTextDeclaration, LiveTextInput } from '../live-text.js';
import type { LinkMatch } from '../crawl.js';
import type { StateRecipe } from '../state-recipes.js';

/** One deterministic page state worth certifying, captured at one viewport width per @media band. */
export type Surface = ForcedStateLimits & {
  /** Capture file name prefix; must be unique. */
  key: string;
  /** Reach the state; StyleProof settles it (in-flight data, fonts, animations) before reading. */
  go: (page: Page) => Promise<void>;
  /** Explicit consumer-owned semantic state identity; never inferred from the page. */
  productState?: ProductStateIdentity;
  /** Selectors for nondeterministic regions; skipped entirely. */
  ignore?: string[];
  /** Viewport widths to sweep. Omit to detect the app's @media bands from the loaded CSSOM. */
  widths?: number[];
  /** Viewport height: a number, or a function of the width (default 800). */
  height?: number | ((width: number) => number);
  /** Deterministic states of this surface, each its own capture (`<surface>-<variant>@<width>`). */
  variants?: SurfaceVariant[];
  /** Live product states (loading, loaded, empty, …); the bare base is dropped in favour of these. */
  liveStates?: SurfaceLiveState[];
  /** Independent interaction recipes, each its own capture after the parent `go`. Validated at expansion. */
  stateRecipes?: StateRecipe[];
  /** Auto-open visible click-triggered popups after the base capture, as `<surface>-popup-XX`. */
  popups?: boolean | PopupCaptureOptions;
};

export type SurfaceVariant = ForcedStateLimits & {
  /** Capture key suffix, joined as `<surface.key>-<variant.key>`. */
  key: string;
  productState?: ProductStateIdentity;
  /** Seed the state before the parent surface navigates (route mocks, storage, flags). */
  setup?: (page: Page) => Promise<void>;
  /** Drive or assert the variant after the parent surface reaches its base state. */
  go?: (page: Page) => Promise<void>;
  /** Extra ignored selectors, appended to the parent surface's. */
  ignore?: string[];
  widths?: number[];
  height?: number | ((width: number) => number);
};

export type SurfaceLiveState = SurfaceVariant;

export type PopupCaptureOptions = {
  enabled?: boolean;
  /** Max visible trigger controls to try per surface/width (default 20). */
  max?: number;
  /** CSS selector for visible controls to click. */
  triggers?: string;
  /** CSS selector for visible popup/overlay roots that mean a click opened state. */
  overlays?: string;
  /** Max ms to wait for a clicked control to reveal an overlay (default 750). */
  timeoutMs?: number;
};

export type ResolvedPopupCaptureOptions = Required<PopupCaptureOptions>;

export type DefineOptions = ForcedStateLimits & {
  surfaces: Surface[];
  /** Every surface key the app knows it has; a coverage-guard test (in the NORMAL suite) fails on any uncovered key. */
  expected?: string[];
  /** Expected keys deliberately not captured, each with a reason; a stale entry also fails the guard. */
  exclude?: Record<string, string>;
  /** Output directory label; the spec is inert when unset. */
  dir: string | undefined;
  /** Base output directory (default `__stylemaps__`). */
  baseDir?: string;
  /** Save a full-page screenshot per capture (default true). */
  screenshots?: boolean;
  /** Replay a baseline run's recorded HARs (or STYLEPROOF_REPLAY_FROM); otherwise this run records them. */
  replayFrom?: string;
  /** URL glob for the data boundary to record/replay (default `**\/api/**`, or STYLEPROOF_REPLAY_URL). */
  replayUrl?: string;
  /** Freeze the browser clock (default true); `false` also restores the spec-process clock. */
  freezeClock?: boolean;
  /** Fixed instant for the frozen clock (default `2025-01-01T00:00:00Z`). */
  clockTime?: string | number | Date;
  /** Capture twice and fail on drift. Default: on when recording, off when replaying; STYLEPROOF_SELFCHECK=1 forces on. */
  selfCheck?: boolean;
  /** Per-surface capture ceiling in ms (default 300000; STYLEPROOF_SURFACE_TIMEOUT_MS overrides when unset). */
  surfaceTimeoutMs?: number;
  /** Navigate-phase budget in ms (default 60000, capped by surfaceTimeoutMs; STYLEPROOF_NAVIGATE_TIMEOUT_MS overrides when unset). */
  navigateTimeoutMs?: number;
  /** Run capture tests in parallel across workers (default true). */
  parallel?: boolean;
  /** Opt-in content layer (advisory, never gates). */
  captureText?: boolean;
  /** Opt-in React component layer (advisory, never gates). */
  captureComponent?: boolean;
  /** Opt-in automatic popup capture for every surface. */
  popups?: boolean | PopupCaptureOptions;
  /** Opt-in inventory guard: harvest navigable affordances into `StyleMap.inventory`. */
  inventory?: boolean;
  /** Data-residue guard: `'gate'` (default) blocks the diff on an unacknowledged failing endpoint; `'warn'` only records. */
  dataResidue?: 'warn' | 'gate';
  /** Declare live/age/clock text; `{ freeze: true }` makes drift fail-closed. Requires `captureText: true`. */
  liveText?: LiveTextInput;
};

/** The capture settings every capturer shares (everything bar the surface set). */
export type CaptureConfig = Omit<DefineOptions, 'surfaces' | 'expected' | 'exclude'>;

/** Resolved per-capture settings. */
export type Settings = Required<
  Omit<DefineOptions, 'surfaces' | 'replayFrom' | 'expected' | 'exclude' | 'popups' | 'parallel' | 'liveText'>
> & {
  dir: string;
  /** `resolveOutputDir(baseDir, dir)`, computed once. */
  outDir: string;
  replayFrom?: string;
  popups: ResolvedPopupCaptureOptions;
  /** Baseline-only: record per-surface failures instead of failing the run (self-check still fails). */
  tolerateSurfaceFailures: boolean;
  liveText: LiveTextDeclaration | null;
};

export type ExpandedSurface = Omit<Surface, 'variants' | 'liveStates' | 'stateRecipes' | 'productState'> & {
  metadata?: CaptureMetadata;
  requiredVisibleState?: { selector: string; stateKey: string };
};

/** Static heartbeat ordinal of one capture unit (assigned at define time, stable across workers). */
export type HeartbeatOrdinal = { index: number; total: number };

/** Options for `defineCrawlCapture`: where to crawl, how to filter/key links, plus the shared capture settings. */
export type CrawlOptions = CaptureConfig & {
  /** URL to crawl for surface links (e.g. `/`); its same-origin `<a href>`s become the surface set. */
  from: string;
  /** Narrow the discovered links (substring, RegExp, or predicate). Default: every same-origin link. */
  match?: LinkMatch;
  /** Derive a surface key from a link URL. Default: path+query slug. */
  key?: (url: URL) => string;
  /** Viewport widths for every discovered surface; omit to auto-detect each surface's @media bands. */
  widths?: number[];
  height?: number | ((width: number) => number);
  /** App-specific settle hook after navigating to each link (the crawl's parity with a surface `go`). */
  settle?: (page: Page) => Promise<void>;
  ignore?: string[];
  variants?: SurfaceVariant[];
  liveStates?: SurfaceLiveState[];
  stateRecipes?: StateRecipe[];
  popups?: boolean | PopupCaptureOptions;
  /** Max ms to wait for the crawl root's links to render (default 15000). */
  linkTimeout?: number;
  /** Also capture routes observed through the history API (default true; bounded to 64 routes / 3 passes). */
  observeNavigation?: boolean;
  /** The route universe: the DISCOVERED link set is reconciled against it both ways, inside the capture test. */
  expected?: string[];
  /** Keys deliberately not reconciled (conditionally rendered links), each with a reason. */
  exclude?: Record<string, string>;
};
