import type { NavigableItem } from '../inventory.js';
import type { DataResidueEntry } from '../data-residue.js';

export type Props = Record<string, string>;
/** Document-space bounding box: [x, y, width, height], rounded. */
export type Rect = [number, number, number, number];

export type ElementEntry = {
  tag: string;
  cls: string;
  rect?: Rect;
  style: Props;
  /** CSS Typed OM computed values where they differ from the used value in `style`; absent on legacy captures. */
  computedValueStyle?: Props;
  pseudo?: Record<string, Props>;
  /** Length of the element's own rendered text (never the text itself) — a privacy-safe reflow signal. */
  ownTextLength?: number;
  /** Own rendered text; only with `captureText: true`. Advisory, never fed to the certification diff. */
  text?: string;
  /** React component + sanitized primitive props; only with `captureComponent: true`. Advisory. */
  component?: { name: string; props?: Record<string, string> };
};

/** Report-only provenance for a surface expanded from a state recipe. */
export type StateRecipeCaptureProvenance = {
  stateKey: string;
  action: 'hover' | 'focus' | 'press' | 'click' | 'route';
  /** Validated value-free interaction selector; absent for route recipes. */
  selector?: string;
  key?: string;
  observationMs?: number;
  /** Deterministic network error status; the route pattern is runtime-only. */
  status?: number;
};

/** Consumer-owned semantic identity for the product state a capture reached. */
export type ProductStateIdentity = {
  /** Stable privacy-safe logical state identifier. Never rendered copy or a selector. */
  id: string;
  /** Consumer-controlled revision of the fixtures/state contract behind the identifier. */
  revision: string;
};

export type CaptureMetadata = {
  surfaceKey?: string;
  variantKey?: string;
  variantKind?: 'variant' | 'live-state' | 'popup' | 'state-recipe';
  stateRecipe?: StateRecipeCaptureProvenance;
  /** Explicit same-product-state evidence used by the certification comparison. */
  productState?: ProductStateIdentity;
  /** Consumer-declared live/age/clock text. Advisory unless `freeze` is true. */
  liveText?: { freeze: boolean; selectors: string[] };
};

export type LiveRegionCandidate = {
  path: string;
  tag: string;
  cls: string;
  reason: string;
  role?: string;
  ariaLive?: string;
  ariaBusy?: string;
};

export type CapturedOverlay = {
  path: string;
  tag: string;
  cls: string;
  reason: string;
  role?: string;
  ariaModal?: string;
  ariaLive?: string;
  text?: string;
};

/**
 * One capture: every element's computed style pruned against per-tag UA defaults
 * (`elements`), the forced :hover/:focus/:active deltas (`states`), and diagnostics.
 * Shadow DOM and iframe content are NOT traversed (warned at capture time).
 */
export type StyleMap = {
  /** Runner-supplied context; ignored by the certification diff. */
  metadata?: CaptureMetadata;
  /** Report-only viewport. */
  viewport?: { width: number; height: number };
  defaults: Record<string, Props>;
  elements: Record<string, ElementEntry>;
  states: Record<string, Record<string, Record<string, Props>>>;
  /** True when the forced-state layer was not fully captured — the diff must not read it as identical. */
  statesSkipped?: boolean;
  /** Paths still changing when the settle budget ran out; excluded here and skipped by the diff. */
  volatile?: string[];
  /** Semantic live-region candidates (`aria-live`, `role=status`, …). Diagnostics only. */
  liveCandidates?: LiveRegionCandidate[];
  /** Visible overlay roots present in `elements` — proof that an open state was reached. */
  overlays?: CapturedOverlay[];
  /** Colour-valued `:root` custom properties normalised to `rgb(...)`, so reports can name the token. */
  tokens?: Record<string, string>;
  /** Navigable inventory; only with `inventory: true`. Diffed by the inventory guard, never the style diff. */
  inventory?: NavigableItem[];
  /** Data-boundary requests that FAILED during capture (fallback branch rendered). Only when armed and non-empty. */
  dataResidue?: DataResidueEntry[];
};

export type CaptureOptions = {
  /** Selectors for nondeterministic regions; the elements and their descendants are skipped. */
  ignore?: string[];
  /** Harvest the navigable inventory into `StyleMap.inventory` (default off). */
  inventory?: boolean;
  /** Settle (poll until the motion-frozen map stops changing and, by default, data requests finish) and
   *  auto-exclude live regions (default on). `false` captures the frame `go()` left; an object tunes the poll. */
  stabilize?: boolean | { interval?: number; quietFor?: number; timeout?: number; waitForRequests?: boolean };
  /** Capture forced :hover/:focus/:active deltas (default true); off persists `statesSkipped`. */
  captureStates?: boolean;
  /** Cap on interactive elements forced-state-captured per surface (default 800). */
  maxInteractive?: number;
  /** Maximum elements per forced-state document read (default 2000). Positive safe integer. */
  maxForcedStateElements?: number;
  /** Maximum element reads across all controls/states (default 32000). Positive safe integer. */
  maxForcedStateScanWork?: number;
  /** Opt-in content layer: record each element's own text on `ElementEntry.text`. Advisory. */
  captureText?: boolean;
  /** Opt-in React layer: record the rendering component + primitive props. Advisory. */
  captureComponent?: boolean;
  /** Internal: in-flight data request count from a tracker armed BEFORE navigation. */
  pendingRequests?: () => number;
  /** Internal: capture-phase callback for the per-surface timeout. */
  onPhase?: (phase: 'settle' | 'capture') => void;
  /** Internal: fail closed unless this recipe-observed transient stays visible through extraction. */
  requiredVisibleState?: { selector: string; stateKey: string };
  /** Internal: metadata persisted with the capture. */
  metadata?: CaptureMetadata;
};

export type ForcedStateLimits = Pick<CaptureOptions, 'maxForcedStateElements' | 'maxForcedStateScanWork'>;
