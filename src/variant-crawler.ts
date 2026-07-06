import { createHash } from 'node:crypto';
import type { Page } from '@playwright/test';
import { captureStyleMap, type CaptureOptions, type LiveRegionCandidate } from './capture.js';
import { diffStyleMaps, type Finding } from './diff.js';
import { DANGER_SOURCE } from './danger.js';

export type HarvestRoute = {
  /** Stable route/surface key in the generated manifest. */
  key: string;
  /** Absolute URL or path resolved against `baseUrl`. */
  url: string;
};

export type HarvestAction = 'click' | 'select-option' | 'submit-empty';

export type HarvestedVariant = {
  key: string;
  action: HarvestAction;
  selector: string;
  reason: string;
  label: string;
  findings: number;
  diffHash: string;
  value?: string;
};

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

export type HarvestedRoute = {
  key: string;
  url: string;
  variants: HarvestedVariant[];
  liveStates: HarvestedLiveState[];
  skipped: HarvestSkip[];
};

export type VariantHarvest = {
  routes: HarvestedRoute[];
};

export type VariantHarvestOptions = {
  baseUrl?: string;
  routes: HarvestRoute[];
  /** Max attempted actions per route. Default 40. */
  maxActionsPerRoute?: number;
  /** Extra selectors to skip during capture. */
  ignore?: string[];
  /** Forwarded to the cheap discovery captures; forced states stay off here. */
  stabilize?: CaptureOptions['stabilize'];
};

type Candidate = {
  action: HarvestAction;
  selector: string;
  reason: string;
  label: string;
  value?: string;
};

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'state'
  );
}

function routeUrl(route: HarvestRoute, baseUrl?: string): string {
  if (!baseUrl) return route.url;
  return new URL(route.url, baseUrl).href;
}

function pathAndSearch(url: string): string {
  const parsed = new URL(url);
  return parsed.pathname + parsed.search;
}

function diffHash(findings: Finding[]): string {
  return createHash('sha256').update(JSON.stringify(findings)).digest('hex').slice(0, 16);
}

function variantKey(candidate: Candidate): string {
  if (candidate.reason === 'tab') return `${slug(candidate.label)}-tab`;
  if (candidate.reason === 'form-validation') return `${slug(candidate.label)}-errors`;
  if (candidate.reason === 'select-option') return `${slug(candidate.label)}-selected`;
  if (candidate.reason === 'aria-expanded') return `${slug(candidate.label)}-expanded`;
  if (candidate.reason === 'aria-haspopup') return `${slug(candidate.label)}-open`;
  return slug(candidate.label);
}

function liveKey(candidate: LiveRegionCandidate): string {
  return slug(candidate.cls || candidate.role || candidate.ariaLive || candidate.reason || candidate.tag);
}

function liveSelector(candidate: LiveRegionCandidate): string {
  return candidate.path;
}

// `dangerSource` is the shared destructive-label pattern (see {@link DANGER_SOURCE}),
// passed in because this function is serialized into the browser and can't close over
// a Node `RegExp`.
// fallow-ignore-next-line complexity
function collectCandidates(dangerSource: string): Candidate[] {
  const controls = [
    '[aria-expanded]',
    '[aria-haspopup]',
    'button',
    'summary',
    '[role="button"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="combobox"]',
    'select',
    'form',
  ].join(',');
  const dangerous = new RegExp(dangerSource, 'i');
  const esc = (value: string): string => CSS.escape(value);
  const quote = (value: string): string => JSON.stringify(value);
  const visible = (el: Element): boolean => {
    const box = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return box.width > 0 && box.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
  };
  const unique = (selector: string): boolean => document.querySelectorAll(selector).length === 1;
  const pathSelector = (el: Element): string => {
    const parts: string[] = [];
    let cur: Element | null = el;
    while (cur && cur !== document.documentElement) {
      const tag = cur.tagName.toLowerCase();
      let index = 1;
      for (let sib = cur.previousElementSibling; sib; sib = sib.previousElementSibling) {
        if (sib.tagName === cur.tagName) index++;
      }
      parts.unshift(`${tag}:nth-of-type(${index})`);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  };
  const selectorFor = (el: Element): string => {
    const attrs = ['data-testid', 'data-test', 'aria-label', 'name'];
    const id = el.getAttribute('id');
    if (id && unique(`#${esc(id)}`)) return `#${esc(id)}`;
    for (const attr of attrs) {
      const value = el.getAttribute(attr);
      if (!value) continue;
      const selector = `${el.tagName.toLowerCase()}[${attr}=${quote(value)}]`;
      if (unique(selector)) return selector;
    }
    return pathSelector(el);
  };
  const labelFor = (el: Element): string => {
    // Include `title` so an icon-only control (no text, no aria-label) announcing
    // itself via a native tooltip — `<button title="Delete">🗑</button>` — still
    // yields a real label. Without it the label is "button", slipping past the
    // destructive guard below that this harvester's clicks must respect.
    const own = (
      el.getAttribute('aria-label') ||
      el.getAttribute('name') ||
      el.textContent ||
      el.getAttribute('title') ||
      ''
    ).trim();
    return own.replace(/\s+/g, ' ').slice(0, 80) || el.tagName.toLowerCase();
  };
  const reasonFor = (el: Element): string => {
    if (el.getAttribute('role') === 'tab') return 'tab';
    if (el.tagName.toLowerCase() === 'form') return 'form-validation';
    if (el.tagName.toLowerCase() === 'select') return 'select-option';
    if (el.hasAttribute('aria-expanded')) return 'aria-expanded';
    if (el.hasAttribute('aria-haspopup')) return 'aria-haspopup';
    return 'semantic-click';
  };

  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const el of [...document.querySelectorAll(controls)]) {
    if (el instanceof HTMLAnchorElement && el.href) continue;
    if (el.matches(':disabled,[aria-disabled="true"]')) continue;
    if (!visible(el)) continue;
    const selector = selectorFor(el);
    if (seen.has(selector)) continue;
    seen.add(selector);
    const label = labelFor(el);
    if (dangerous.test(label)) {
      out.push({ action: 'click', selector, reason: 'unsafe-label', label });
      continue;
    }
    if (el instanceof HTMLFormElement) {
      if (el.noValidate || !el.querySelector('input[required],textarea[required],select[required]')) continue;
      out.push({ action: 'submit-empty', selector, reason: 'form-validation', label });
    } else if (el instanceof HTMLSelectElement) {
      const next = [...el.options].find((o) => !o.disabled && o.value !== el.value);
      if (next) out.push({ action: 'select-option', selector, reason: 'select-option', label, value: next.value });
    } else {
      out.push({ action: 'click', selector, reason: reasonFor(el), label });
    }
  }
  return out;
}

async function discoverCandidates(page: Page): Promise<Candidate[]> {
  return page.evaluate(collectCandidates, DANGER_SOURCE);
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

function captureOptions(options: VariantHarvestOptions): CaptureOptions {
  return {
    ignore: options.ignore,
    stabilize: options.stabilize,
    captureStates: false,
  };
}

function liveStatesFrom(candidates: LiveRegionCandidate[] = []): HarvestedLiveState[] {
  return candidates.map((candidate) => ({
    key: liveKey(candidate),
    selector: liveSelector(candidate),
    reason: candidate.reason,
    label: candidate.cls || candidate.role || candidate.tag,
    fixtureRequired: true,
    ...(candidate.role ? { role: candidate.role } : {}),
    ...(candidate.ariaLive ? { ariaLive: candidate.ariaLive } : {}),
    ...(candidate.ariaBusy ? { ariaBusy: candidate.ariaBusy } : {}),
  }));
}

function unsafeSkip(candidate: Candidate): HarvestSkip {
  return {
    reason: 'unsafe-label',
    selector: candidate.selector,
    label: candidate.label,
    detail: 'label matched the built-in destructive-action guard',
  };
}

async function tryCandidate(
  page: Page,
  url: string,
  before: Awaited<ReturnType<typeof captureStyleMap>>,
  candidate: Candidate,
  options: VariantHarvestOptions,
  seenDiffs: Set<string>,
): Promise<{ variant?: HarvestedVariant; skip?: HarvestSkip }> {
  await page.goto(url, { waitUntil: 'load' });
  const start = pathAndSearch(page.url());
  try {
    await perform(page, candidate);
    const afterUrl = pathAndSearch(page.url());
    if (afterUrl !== start) {
      return {
        skip: {
          reason: 'navigated',
          selector: candidate.selector,
          label: candidate.label,
          detail: `${start} -> ${afterUrl}`,
        },
      };
    }
    const after = await captureStyleMap(page, captureOptions(options));
    const findings = diffStyleMaps(before, after);
    if (!findings.length) return {};
    const hash = diffHash(findings);
    if (seenDiffs.has(hash)) return {};
    seenDiffs.add(hash);
    return {
      variant: {
        key: variantKey(candidate),
        action: candidate.action,
        selector: candidate.selector,
        reason: candidate.reason,
        label: candidate.label,
        findings: findings.length,
        diffHash: hash,
        ...(candidate.value ? { value: candidate.value } : {}),
      },
    };
  } catch (e) {
    return {
      skip: {
        reason: 'action-failed',
        selector: candidate.selector,
        label: candidate.label,
        detail: e instanceof Error ? e.message : String(e),
      },
    };
  }
}

/**
 * Discover one-step UI states by trying semantic controls and keeping only
 * actions whose rendered computed-style map differs from the route baseline.
 */
export async function harvestStyleVariants(page: Page, options: VariantHarvestOptions): Promise<VariantHarvest> {
  const maxActions = options.maxActionsPerRoute ?? 40;
  const routes: HarvestedRoute[] = [];
  for (const route of options.routes) {
    const url = routeUrl(route, options.baseUrl);
    await page.goto(url, { waitUntil: 'load' });
    const before = await captureStyleMap(page, captureOptions(options));
    const candidates = await discoverCandidates(page);
    const liveStates = liveStatesFrom(before.liveCandidates);
    const variants: HarvestedVariant[] = [];
    const skipped: HarvestSkip[] = [];
    const seenDiffs = new Set<string>();
    for (const candidate of candidates.slice(0, maxActions)) {
      if (candidate.reason === 'unsafe-label') {
        skipped.push(unsafeSkip(candidate));
        continue;
      }
      const result = await tryCandidate(page, url, before, candidate, options, seenDiffs);
      if (result.variant) variants.push(result.variant);
      if (result.skip) skipped.push(result.skip);
    }
    routes.push({ key: route.key, url: route.url, variants, liveStates, skipped });
  }
  return { routes };
}
