import type { NavigableItem } from '../inventory.js';
import type { DataResidueEntry } from '../data-residue.js';
import type { ServedRuleTracker } from './reach.js';

export type Props = Record<string, string>;
/** Document-space bounding box: [x, y, width, height], rounded. */
export type Rect = [number, number, number, number];

export type ElementEntry = {
  tag: string;
  cls: string;
  rect?: Rect;
  /** Expanded full-page box for report/pixel coordinates and visible-structure gating; falls back to `rect`. */
  screenshotRect?: Rect;
  style: Props;
  /** CSS Typed OM computed values where they differ from the used value in `style`; absent on legacy captures. */
  computedValueStyle?: Props;
  /**
   * What the element renders that computed styles cannot hold (#1005): for an `<img>`, `currentSrc` and
   * `srcset` as privacy-safe digests (origin plus a hash, never the URL) and `sizes`; and `@keyframes <name>` (or `<pseudo> @keyframes <name>`) holding the body of each CSS animation
   * it runs, as the browser resolved it. Absent on maps captured before #1005.
   */
  rendered?: Props;
  pseudo?: Record<string, Props>;
  /** Length of the element's own rendered text (never the text itself) — a privacy-safe reflow signal. */
  ownTextLength?: number;
  /** Own rendered text; present when `captureText` is on (default). Advisory, never fed to the certification diff. */
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
  /**
   * `live` when replay was requested but no HAR existed for this capture, so it ran against the
   * live backend: its inputs were not pinned, and a `replayed` ledger does not prove it.
   */
  inputs?: 'live';
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
  /**
   * Captured viewport, document origin, driven document height, and full-page height
   * measured with screenshot scrollers expanded. Missing scroll offsets mean zero;
   * a missing `screenshotHeight` leaves the gate's page extent unbounded below.
   */
  viewport?: {
    width: number;
    height: number;
    scrollX?: number;
    scrollY?: number;
    documentHeight?: number;
    screenshotHeight?: number;
  };
  defaults: Record<string, Props>;
  elements: Record<string, ElementEntry>;
  states: Record<string, Record<string, Record<string, Props>>>;
  /**
   * CSS Typed OM computed values of the four horizontal margins (`margin-left`/`-right`,
   * `margin-inline-start`/`-end`) of forced-state targets, keyed like `states` (owner → state →
   * target; never `::before`/`::after`). A target is recorded when it is in that state's delta or
   * when any of the four computed values differs from rest; a missing target means its computed
   * margins equal its resting ones. Absent on legacy captures, when Typed OM was unavailable, and
   * when the forced-state layer was skipped. "Resting" here is the state layer's own snapshot, while
   * the diff reads a missing target's rest from the element layer's earlier `computedValueStyle`;
   * this assumes both reads see the same settled page (a margin still changing is normally caught
   * as volatile).
   */
  stateComputedValueStyle?: Record<string, Record<string, Record<string, Props>>>;
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
  /** Served CSS rules and which matched while the map was read; only with `captureReach: true` (Change Reach, #991). */
  reach?: ServedRules;
};

/** One served CSS leaf rule (a style rule, `@keyframes`, `@font-face`…) in the Change Reach ledger. */
export type ServedRule = {
  /** At-rule chain and prelude, preserving strings/escapes (`@media (min-width: 1440px) > .panel`); repeats get ` #2`… */
  key: string;
  /** Digest of the declaration block, collapsing whitespace only outside strings, comments and escapes. */
  hash: string;
  /** Index into `ServedRules.sheets`. */
  sheet: number;
  /** Matched an element while the map was read, at rest or in a forced state. Never set on `@keyframes`/`@font-face`. */
  used?: true;
  /** Custom properties the rule declares, each mapped to a digest of its value. */
  vars?: Record<string, string>;
  /** Custom properties the rule reads through `var()`. */
  uses?: string[];
  /** Custom properties it declares from other custom properties: name → the properties its value reads. */
  aliases?: Record<string, string[]>;
  /** Identifiers in its `animation`/`font` declarations: the `@keyframes`/`@font-face` names it can reference. */
  refs?: string[];
};

export type ServedRules = {
  /** Ledger format. 2 records `aliases`; a ledger without it (captured before #995) cannot show which tokens feed which aliases. */
  version?: 2;
  /** Where each stylesheet came from: its URL path, `inline`, or `constructed`. */
  sheets: string[];
  rules: ServedRule[];
  /** Stylesheets whose text could not be read; their rules are missing, so reach over them is unknown. */
  unreadable?: number;
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
  /**
   * Which elements each forced-state read compares (default `'document'`: every element, target first).
   * `'stylesheet'` derives the read scope from the page's own `:hover`/`:focus`/`:focus-visible`/`:active`
   * selectors: the control's subtree when no state rule can reach past its descendants, its parent's
   * subtree when a sibling combinator (`~`/`+`) appears in a state selector, and the whole document when
   * any state selector uses `:has()`, `:focus-within`, shadow selectors, an `:nth-*(… of S)` list, an
   * `@scope` prelude, or a stylesheet that cannot be read. Layout ripple (a forced state resizing the
   * control and so another element's resolved `width`) is reported on the control itself, not on the
   * moved neighbour. Use it for populated pages where whole-document reads exhaust the work budget.
   */
  forcedStateScope?: ForcedStateScope;
  /** Record each element's own text on `ElementEntry.text` (default true). Used for own-text identity pairing (#753) and the advisory content layer. Set `false` to opt out (privacy / huge live text). */
  captureText?: boolean;
  /** Opt-in React layer: record the rendering component + primitive props. Advisory. */
  captureComponent?: boolean;
  /** Opt-in Change Reach ledger: record served CSS rules and which matched into `StyleMap.reach` (default off). */
  captureReach?: boolean;
  /**
   * A `trackServedRules(page)` armed BEFORE navigation. Without one, `captureReach` arms its own after
   * the page loaded, and linked stylesheets read as `unreadable` because Chromium did not keep their text.
   */
  servedRules?: ServedRuleTracker;
  /** Internal: in-flight data request count from a tracker armed BEFORE navigation. */
  pendingRequests?: () => number;
  /** Internal: capture-phase callback for the per-surface timeout. */
  onPhase?: (phase: 'settle' | 'capture') => void;
  /** Internal: fail closed unless this recipe-observed transient stays visible through extraction. */
  requiredVisibleState?: { selector: string; stateKey: string };
  /** Internal: metadata persisted with the capture. */
  metadata?: CaptureMetadata;
};

export type ForcedStateScope = 'document' | 'stylesheet';

export type ForcedStateLimits = Pick<
  CaptureOptions,
  'maxForcedStateElements' | 'maxForcedStateScanWork' | 'forcedStateScope'
>;
