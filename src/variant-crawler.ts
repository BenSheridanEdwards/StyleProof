import type { Page } from '@playwright/test';
import { captureStyleMap, type CaptureOptions, type LiveRegionCandidate, type StyleMap } from './capture.js';
import { diffStyleMaps, type Finding } from './diff.js';
import { DANGER_SOURCE } from './danger.js';
import { sha256 } from './node-util.js';
import { slug as slugOf } from './util.js';
import { pathAndSearch } from './crawl/page.js';

/** `key`: stable route/surface key in the generated manifest; `url`: absolute, or resolved against `baseUrl`. */
export type HarvestRoute = { key: string; url: string };

export type HarvestAction = 'click' | 'select-option' | 'submit-empty';

type Candidate = { action: HarvestAction; selector: string; reason: string; label: string; value?: string };

export type HarvestedVariant = Candidate & { key: string; findings: number; diffHash: string };

export type HarvestedLiveState = {
  key: string;
  selector: string;
  reason: string;
  label: string;
  fixtureRequired: true;
  role?: string;
  ariaLive?: string;
  ariaBusy?: string;
};

export type HarvestSkip = {
  reason: 'unsafe-label' | 'navigated' | 'action-failed';
  selector: string;
  label: string;
  detail?: string;
};

export type HarvestStateOutcome = 'captured' | 'skipped' | 'deduplicated' | 'timed-out' | 'requires-fixture';

export type HarvestedStateCoverage = {
  stateKey: string;
  outcome: HarvestStateOutcome;
  reason:
    | 'semantic-control'
    | 'unsafe-label'
    | 'no-computed-style-change'
    | 'duplicate-computed-style'
    | 'action-failed'
    | 'action-timeout'
    | 'live-region';
  action?: 'hover' | 'focus';
  /** Value-free structural selector; no attribute values or rendered text. */
  selector?: string;
  findings?: number;
  diffHash?: string;
  /** Typed consumer-owned fixture recommendation. Never claims the state was captured. */
  fixture?: { kind: 'consumer-owned-setup'; observeSelector: string; observeMs: 250 };
};

export type HarvestedRoute = {
  key: string;
  url: string;
  variants: HarvestedVariant[];
  liveStates: HarvestedLiveState[];
  stateCoverage: HarvestedStateCoverage[];
  skipped: HarvestSkip[];
};

export type VariantHarvest = { routes: HarvestedRoute[] };

export type VariantHarvestOptions = {
  baseUrl?: string;
  routes: HarvestRoute[];
  /** Max attempted click/select/form actions per route. Default 40. */
  maxActionsPerRoute?: number;
  /** Max attempted hover/focus candidates per route. Default 40. */
  maxStateActionsPerRoute?: number;
  ignore?: string[];
  /** Forwarded to the cheap discovery captures; forced states stay off here. */
  stabilize?: CaptureOptions['stabilize'];
};

/** `mapPath` is the runtime-only capture identity (hashed identity tokens, never raw attribute values). */
type StateCandidate = { action: 'hover' | 'focus'; selector: string; mapPath: string; unsafe: boolean };
type Discovery = { candidates: Candidate[]; states: StateCandidate[]; liveSelectors: string[] };
type StateIdentity = Pick<HarvestedStateCoverage, 'stateKey' | 'action' | 'selector'>;

const KEY_SUFFIX: Record<string, string> = {
  tab: '-tab',
  'form-validation': '-errors',
  'select-option': '-selected',
  'aria-expanded': '-expanded',
  'aria-haspopup': '-open',
};
const slug = (value: string): string => slugOf(value, 48);
const variantKey = (candidate: Candidate): string => slug(candidate.label) + (KEY_SUFFIX[candidate.reason] ?? '');
const diffHash = (findings: Finding[]): string => sha256(JSON.stringify(findings)).slice(0, 16);
const stateCoverageKey = (prefix: 'hover' | 'focus' | 'live-region', selector: string): string =>
  `${prefix}-${sha256(`${prefix}\u0000${selector}`).slice(0, 12)}`;
const skipOf = (candidate: Candidate, reason: HarvestSkip['reason'], detail: string): HarvestSkip => ({
  reason,
  selector: candidate.selector,
  label: candidate.label,
  detail,
});
const captureOptions = (options: VariantHarvestOptions): CaptureOptions => ({
  ignore: options.ignore,
  stabilize: options.stabilize,
  captureStates: false,
});

// Runs in the browser (self-contained): one-step action candidates, hover/focus state candidates,
// and live-region selectors in one bounded scan. State candidates and live selectors carry no
// text, label, role, or attribute value; labels exist only transiently for the destructive check.
// `dangerSource` is the shared destructive-label pattern, a string because a RegExp cannot be serialized.
// fallow-ignore-next-line complexity
function collectDiscovery({ dangerSource, maxStates }: { dangerSource: string; maxStates: number }): Discovery {
  const CONTROLS =
    '[aria-expanded],[aria-haspopup],button,summary,[role="button"],[role="tab"],[role="menuitem"],[role="combobox"],select,form';
  const STATE_CONTROLS =
    'button,input,select,textarea,summary,a[href],[tabindex],[role="button"],[role="tab"],[role="menuitem"],[role="combobox"]';
  const REASONS: [string, string][] = [
    ['[role="tab"]', 'tab'],
    ['form', 'form-validation'],
    ['select', 'select-option'],
    ['[aria-expanded]', 'aria-expanded'],
    ['[aria-haspopup]', 'aria-haspopup'],
  ];
  const dangerous = new RegExp(dangerSource, 'i');
  const capturePath = (window as unknown as { __spPathOf?: (element: Element) => string }).__spPathOf;
  const visible = (el: Element): boolean => {
    const box = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return box.width > 0 && box.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
  };
  const usable = (el: Element): boolean => visible(el) && !el.matches(':disabled,[aria-disabled="true"]');
  const unique = (selector: string): boolean => document.querySelectorAll(selector).length === 1;
  const pathSelector = (el: Element): string => {
    const parts: string[] = [];
    let cur: Element | null = el;
    while (cur && cur !== document.documentElement) {
      let index = 1;
      for (let sib = cur.previousElementSibling; sib; sib = sib.previousElementSibling) {
        if (sib.tagName === cur.tagName) index++;
      }
      parts.unshift(`${cur.tagName.toLowerCase()}:nth-of-type(${index})`);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  };
  // Preference: unique id, then a unique data-testid/data-test/aria-label/name, then the positional path.
  const selectorFor = (el: Element): string => {
    const id = el.getAttribute('id');
    const byAttr = ['data-testid', 'data-test', 'aria-label', 'name'].map((attr) => {
      const value = el.getAttribute(attr);
      return value ? `${el.tagName.toLowerCase()}[${attr}=${JSON.stringify(value)}]` : '';
    });
    return [id ? `#${CSS.escape(id)}` : '', ...byAttr].find((s) => s && unique(s)) || pathSelector(el);
  };
  // aria-label > name > text > title: `title` keeps an icon-only control's tooltip name so the destructive guard still sees it.
  const labelFor = (el: Element): string => {
    let own = el.textContent || el.getAttribute('title') || '';
    for (const attr of ['name', 'aria-label']) own = el.getAttribute(attr) || own;
    return own.trim().replace(/\s+/g, ' ').slice(0, 80) || el.tagName.toLowerCase();
  };
  const structuralPath = (element: Element): string => {
    const segments: string[] = [];
    for (let cur: Element | null = element; cur && cur !== document.documentElement; cur = cur.parentElement) {
      const siblings = cur.parentElement ? [...cur.parentElement.children] : [];
      const position = Math.max(1, siblings.indexOf(cur) + 1);
      segments.unshift(cur === document.body ? 'body' : `${cur.tagName.toLowerCase()}:nth-child(${position})`);
    }
    return segments.join(' > ');
  };
  const safetyLabel = (element: Element): string =>
    [
      element.getAttribute('aria-label'),
      element.getAttribute('title'),
      element.getAttribute('name'),
      element.textContent,
    ]
      .filter((value): value is string => Boolean(value))
      .join(' ')
      .replace(/\s+/g, ' ')
      .slice(0, 240);

  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  for (const el of document.querySelectorAll(CONTROLS)) {
    if ((el instanceof HTMLAnchorElement && el.href) || !usable(el)) continue;
    const selector = selectorFor(el);
    if (seen.has(selector)) continue;
    seen.add(selector);
    const label = labelFor(el);
    if (dangerous.test(label)) {
      candidates.push({ action: 'click', selector, reason: 'unsafe-label', label });
    } else if (el instanceof HTMLFormElement) {
      if (el.noValidate || !el.querySelector('input[required],textarea[required],select[required]')) continue;
      candidates.push({ action: 'submit-empty', selector, reason: 'form-validation', label });
    } else if (el instanceof HTMLSelectElement) {
      const next = [...el.options].find((o) => !o.disabled && o.value !== el.value);
      if (next)
        candidates.push({ action: 'select-option', selector, reason: 'select-option', label, value: next.value });
    } else {
      const reason = REASONS.find(([s]) => el.matches(s))?.[1] ?? 'semantic-click';
      candidates.push({ action: 'click', selector, reason, label });
    }
  }

  const states: StateCandidate[] = [];
  for (const element of document.querySelectorAll(STATE_CONTROLS)) {
    if (!usable(element)) continue;
    const selector = structuralPath(element);
    const mapPath = capturePath?.(element) ?? selector;
    const unsafe = dangerous.test(safetyLabel(element));
    if (states.length < maxStates) states.push({ action: 'hover', selector, mapPath, unsafe });
    if (states.length < maxStates && element instanceof HTMLElement && element.tabIndex >= 0) {
      states.push({ action: 'focus', selector, mapPath, unsafe });
    }
  }
  const liveSelectors = [...document.querySelectorAll('[aria-live],[role="status"],[role="alert"],[aria-busy="true"]')]
    .filter(visible)
    .map(structuralPath)
    .filter((selector, index, all) => all.indexOf(selector) === index);
  return { candidates, states, liveSelectors: liveSelectors.slice(0, 200) };
}

async function perform(page: Page, candidate: Candidate): Promise<void> {
  const target = page.locator(candidate.selector).first();
  if (candidate.action === 'select-option') {
    await target.selectOption(candidate.value ?? '');
  } else if (candidate.action === 'submit-empty') {
    await target.evaluate((node) => {
      const form = node as HTMLFormElement;
      for (const control of form.querySelectorAll('input, textarea, select')) {
        if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) control.value = '';
        if (control instanceof HTMLSelectElement) control.selectedIndex = -1;
      }
      form.requestSubmit();
    });
  } else {
    await target.click();
  }
}

function liveStatesFrom(candidates: LiveRegionCandidate[] = []): HarvestedLiveState[] {
  return candidates.map((candidate) => ({
    key: slug(candidate.cls || candidate.role || candidate.ariaLive || candidate.reason || candidate.tag),
    selector: candidate.path,
    reason: candidate.reason,
    label: candidate.cls || candidate.role || candidate.tag,
    fixtureRequired: true,
    ...(candidate.role ? { role: candidate.role } : {}),
    ...(candidate.ariaLive ? { ariaLive: candidate.ariaLive } : {}),
    ...(candidate.ariaBusy ? { ariaBusy: candidate.ariaBusy } : {}),
  }));
}

async function tryCandidate(
  page: Page,
  url: string,
  before: StyleMap,
  candidate: Candidate,
  options: VariantHarvestOptions,
  seenDiffs: Set<string>,
): Promise<{ variant?: HarvestedVariant; skip?: HarvestSkip }> {
  await page.goto(url, { waitUntil: 'load' });
  const start = pathAndSearch(page.url());
  try {
    await perform(page, candidate);
    const afterUrl = pathAndSearch(page.url());
    if (afterUrl !== start) return { skip: skipOf(candidate, 'navigated', `${start} -> ${afterUrl}`) };
    const findings = diffStyleMaps(before, await captureStyleMap(page, captureOptions(options)));
    if (!findings.length) return {};
    const hash = diffHash(findings);
    if (seenDiffs.has(hash)) return {};
    seenDiffs.add(hash);
    const { action, selector, reason, label, value } = candidate;
    const variant = {
      key: variantKey(candidate),
      action,
      selector,
      reason,
      label,
      findings: findings.length,
      diffHash: hash,
    };
    return { variant: { ...variant, ...(value ? { value } : {}) } };
  } catch (e) {
    return { skip: skipOf(candidate, 'action-failed', e instanceof Error ? e.message : String(e)) };
  }
}

function capturedStateOutcome(
  identity: StateIdentity,
  hash: string,
  findings: number,
  seenDiffs: Set<string>,
): HarvestedStateCoverage {
  if (seenDiffs.has(hash))
    return { ...identity, outcome: 'deduplicated', reason: 'duplicate-computed-style', diffHash: hash };
  seenDiffs.add(hash);
  return { ...identity, outcome: 'captured', reason: 'semantic-control', findings, diffHash: hash };
}

async function tryStateCandidate(
  page: Page,
  url: string,
  before: StyleMap,
  forcedStateMap: StyleMap,
  candidate: StateCandidate,
  options: VariantHarvestOptions,
  seenDiffs: Set<string>,
): Promise<HarvestedStateCoverage> {
  const stateKey = stateCoverageKey(candidate.action, candidate.mapPath);
  const identity: StateIdentity = { stateKey, action: candidate.action, selector: candidate.selector };
  if (candidate.unsafe) return { ...identity, outcome: 'skipped', reason: 'unsafe-label' };
  const forcedDelta = forcedStateMap.states[candidate.mapPath]?.[candidate.action];
  if (forcedDelta) {
    const hash = sha256(JSON.stringify(forcedDelta)).slice(0, 16);
    const findings = Object.values(forcedDelta).reduce((sum, properties) => sum + Object.keys(properties).length, 0);
    return capturedStateOutcome(identity, hash, findings, seenDiffs);
  }
  try {
    await page.goto(url, { waitUntil: 'load' });
    await page.mouse.move(-1, -1);
    const target = page.locator(candidate.selector).first();
    if (candidate.action === 'hover') await target.hover({ timeout: 1_000 });
    else await target.focus({ timeout: 1_000 });
    const findings = diffStyleMaps(before, await captureStyleMap(page, captureOptions(options)));
    if (findings.length === 0) return { ...identity, outcome: 'deduplicated', reason: 'no-computed-style-change' };
    return capturedStateOutcome(identity, diffHash(findings), findings.length, seenDiffs);
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    return {
      ...identity,
      outcome: timedOut ? 'timed-out' : 'skipped',
      reason: timedOut ? 'action-timeout' : 'action-failed',
    };
  }
}

function fixtureRecommendations(selectors: string[]): HarvestedStateCoverage[] {
  return selectors.map((selector) => ({
    stateKey: stateCoverageKey('live-region', selector),
    outcome: 'requires-fixture',
    reason: 'live-region',
    selector,
    fixture: { kind: 'consumer-owned-setup', observeSelector: selector, observeMs: 250 },
  }));
}

function candidateLimit(value: number | undefined, field: string): number {
  const resolved = value ?? 40;
  if (!Number.isInteger(resolved) || resolved < 0 || resolved > 200) {
    throw new Error(`styleproof variants: ${field} must be an integer from 0 to 200`);
  }
  return resolved;
}

async function harvestVariants(
  page: Page,
  url: string,
  before: StyleMap,
  candidates: Candidate[],
  options: VariantHarvestOptions,
): Promise<{ variants: HarvestedVariant[]; skipped: HarvestSkip[] }> {
  const variants: HarvestedVariant[] = [];
  const skipped: HarvestSkip[] = [];
  const seenDiffs = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.reason === 'unsafe-label') {
      skipped.push(skipOf(candidate, 'unsafe-label', 'label matched the built-in destructive-action guard'));
      continue;
    }
    const result = await tryCandidate(page, url, before, candidate, options, seenDiffs);
    if (result.variant) variants.push(result.variant);
    if (result.skip) skipped.push(result.skip);
  }
  return { variants, skipped };
}

async function harvestRoute(
  page: Page,
  route: HarvestRoute,
  options: VariantHarvestOptions,
  maxActions: number,
  maxStates: number,
): Promise<HarvestedRoute> {
  const url = options.baseUrl ? new URL(route.url, options.baseUrl).href : route.url;
  await page.goto(url, { waitUntil: 'load' });
  await page.mouse.move(-1, -1);
  const before = await captureStyleMap(page, captureOptions(options));
  const discovery = await page.evaluate(collectDiscovery, { dangerSource: DANGER_SOURCE, maxStates });
  const forcedStateMap = await captureStyleMap(page, { ...captureOptions(options), captureStates: true });
  const { variants, skipped } = await harvestVariants(
    page,
    url,
    before,
    discovery.candidates.slice(0, maxActions),
    options,
  );
  const stateCoverage = fixtureRecommendations(discovery.liveSelectors);
  const seenStateDiffs = new Set<string>();
  for (const candidate of discovery.states.slice(0, maxStates)) {
    stateCoverage.push(await tryStateCandidate(page, url, before, forcedStateMap, candidate, options, seenStateDiffs));
  }
  return {
    key: route.key,
    url: route.url,
    variants,
    liveStates: liveStatesFrom(before.liveCandidates),
    stateCoverage,
    skipped,
  };
}

/** Discover one-step UI states by trying semantic controls and keeping only actions whose
 *  rendered computed-style map differs from the route baseline. */
export async function harvestStyleVariants(page: Page, options: VariantHarvestOptions): Promise<VariantHarvest> {
  const maxActions = candidateLimit(options.maxActionsPerRoute, 'maxActionsPerRoute');
  const maxStates = candidateLimit(options.maxStateActionsPerRoute, 'maxStateActionsPerRoute');
  const routes: HarvestedRoute[] = [];
  for (const route of options.routes) routes.push(await harvestRoute(page, route, options, maxActions, maxStates));
  return { routes };
}
