import type { Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';

/**
 * Computed-style capture: the browser's final resolved value for every CSS
 * longhand on every element, keyed by DOM structure (never by class name, so
 * a CSS-to-Tailwind migration can rewrite classes freely while the map stays
 * comparable). Three layers per capture:
 *
 *   elements — every element's computed style, pruned against per-tag UA
 *              defaults (measured in a clean iframe) to keep files small,
 *              plus ::before / ::after / ::marker / ::placeholder.
 *   states   — for interactive elements, what :hover, :focus(-visible) and
 *              :active change (forced via CDP, no mouse involved), captured
 *              as a delta over the element's subtree. Screenshots cannot see
 *              these; this is where dropped `hover:` variants get caught.
 *   motion   — transition/animation longhands are captured before the
 *              freeze-CSS below nulls them, so declared motion is verified
 *              too, while every other captured value is a settled end state.
 */

type Props = Record<string, string>;
type ElementEntry = { tag: string; cls: string; style: Props; pseudo?: Record<string, Props> };
export type StyleMap = {
  defaults: Record<string, Props>;
  elements: Record<string, ElementEntry>;
  states: Record<string, Record<string, Record<string, Props>>>;
};

export type CaptureOptions = {
  /**
   * Selectors for nondeterministic regions (live data, embeds, ads). The
   * matching elements and their descendants are skipped entirely.
   */
  ignore?: string[];
};

const INTERACTIVE = 'a, button, input, textarea, select, summary, [role="button"], [tabindex]';
// Freeze motion so every captured value is a settled end state, not a frame
// of an animation or a mid-flight transition after a forced :hover.
const FREEZE_CSS = '*,*::before,*::after{animation:none!important;transition:none!important}';

type CaptureArgs = { ignore: string[]; motionOnly: boolean };

// Serialized into the browser by page.evaluate; cannot call module helpers.
function capturePage({ ignore, motionOnly }: CaptureArgs) {
  const MOTION = /^(transition|animation)/;
  const PSEUDOS = ['::before', '::after', '::marker', '::placeholder'];
  const skipSel = ignore.length ? ignore.map((s) => `${s}, ${s} *`).join(', ') : '';

  const pathOf = (el: Element): string => {
    if (el === document.documentElement) return 'html';
    if (el === document.body) return 'body';
    const parts: string[] = [];
    let n: Element | null = el;
    while (n && n !== document.body) {
      const parent: Element | null = n.parentElement;
      if (!parent) break;
      parts.unshift(`${n.tagName.toLowerCase()}:nth-child(${Array.prototype.indexOf.call(parent.children, n) + 1})`);
      n = parent;
    }
    return 'body > ' + parts.join(' > ');
  };

  // Per-tag UA defaults from a stylesheet-free iframe, used to prune the maps.
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:absolute;left:-9999px;width:100px;height:100px;border:0';
  document.body.appendChild(frame);
  const fdoc = frame.contentDocument as Document;
  const defaults: Record<string, Props> = {};
  const defaultFor = (tag: string): Props => {
    if (!(tag in defaults)) {
      const probe = fdoc.createElement(tag);
      fdoc.body.appendChild(probe);
      const cs = fdoc.defaultView!.getComputedStyle(probe);
      const o: Props = {};
      for (let i = 0; i < cs.length; i++) o[cs.item(i)] = cs.getPropertyValue(cs.item(i));
      defaults[tag] = o;
      probe.remove();
    }
    return defaults[tag];
  };

  const snap = (cs: CSSStyleDeclaration, def: Props | null): Props => {
    const o: Props = {};
    for (let i = 0; i < cs.length; i++) {
      const p = cs.item(i);
      if (motionOnly !== MOTION.test(p)) continue;
      const v = cs.getPropertyValue(p);
      if (!def || def[p] !== v) o[p] = v;
    }
    return o;
  };

  const elements: Record<string, { tag: string; cls: string; style: Props; pseudo?: Record<string, Props> }> = {};
  const all = [document.documentElement, document.body, ...document.querySelectorAll('body *')];
  for (const el of all) {
    if (el === frame || (skipSel && el.matches(skipSel))) continue;
    const tag = el.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'link' || tag === 'noscript') continue;
    const entry: { tag: string; cls: string; style: Props; pseudo?: Record<string, Props> } = {
      tag,
      cls: el.getAttribute('class') || '',
      style: snap(getComputedStyle(el), defaultFor(tag)),
    };
    for (const ps of PSEUDOS) {
      if (ps === '::marker' && getComputedStyle(el).display !== 'list-item') continue;
      if (ps === '::placeholder' && !(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) continue;
      const cs = getComputedStyle(el, ps);
      if ((ps === '::before' || ps === '::after') && cs.getPropertyValue('content') === 'none') continue;
      const props = snap(cs, defaultFor(tag));
      if (Object.keys(props).length) (entry.pseudo ??= {})[ps] = props;
    }
    elements[pathOf(el)] = entry;
  }
  frame.remove();
  return { defaults, elements };
}

type SubtreeArgs = { selector: string; index: number };

/** Full (unpruned) computed styles for an element and its descendants, pseudo-elements included. */
// Serialized into the browser by page.evaluate; cannot call module helpers.
function snapSubtree({ selector, index }: SubtreeArgs) {
  const el = document.querySelectorAll(selector)[index];
  const pathOf = (n: Element): string => {
    if (n === document.documentElement) return 'html';
    if (n === document.body) return 'body';
    const parts: string[] = [];
    let c: Element | null = n;
    while (c && c !== document.body) {
      const parent: Element | null = c.parentElement;
      if (!parent) break;
      parts.unshift(`${c.tagName.toLowerCase()}:nth-child(${Array.prototype.indexOf.call(parent.children, c) + 1})`);
      c = parent;
    }
    return 'body > ' + parts.join(' > ');
  };
  const out: Record<string, Record<string, string>> = {};
  if (!el) return out;
  for (const n of [el, ...el.querySelectorAll('*')]) {
    for (const ps of [null, '::before', '::after']) {
      const cs = getComputedStyle(n, ps);
      if (ps && cs.getPropertyValue('content') === 'none') continue;
      const o: Record<string, string> = {};
      for (let i = 0; i < cs.length; i++) {
        const p = cs.item(i);
        if (/^(transition|animation)/.test(p)) continue; // frozen by FREEZE_CSS
        o[p] = cs.getPropertyValue(p);
      }
      out[pathOf(n) + (ps || '')] = o;
    }
  }
  return out;
}

type Snap = Record<string, Props>;

function deltaBetween(base: Snap, forced: Snap): Record<string, Props> {
  const delta: Record<string, Props> = {};
  for (const key of new Set([...Object.keys(base), ...Object.keys(forced)])) {
    const a = base[key] || {};
    const b = forced[key] || {};
    const d: Props = {};
    for (const p of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (a[p] !== b[p]) d[p] = b[p] ?? '(gone)';
    }
    if (Object.keys(d).length) delta[key] = d;
  }
  return delta;
}

const STATE_SETS: Record<string, string[]> = {
  hover: ['hover'],
  focus: ['focus', 'focus-visible'],
  active: ['active'],
};

type PathArgs = { selector: string; skipSel: string };

/** Structural paths for every selector match, index-aligned with CDP's DOM.querySelectorAll. */
function pathsForSelector({ selector, skipSel }: PathArgs) {
  const pathOf = (el: Element): string => {
    if (el === document.documentElement) return 'html';
    if (el === document.body) return 'body';
    const parts: string[] = [];
    let n: Element | null = el;
    while (n && n !== document.body) {
      const parent: Element | null = n.parentElement;
      if (!parent) break;
      parts.unshift(`${n.tagName.toLowerCase()}:nth-child(${Array.prototype.indexOf.call(parent.children, n) + 1})`);
      n = parent;
    }
    return 'body > ' + parts.join(' > ');
  };
  return [...document.querySelectorAll(selector)].map((el) => (skipSel && el.matches(skipSel) ? null : pathOf(el)));
}

// Forced pseudo-class states on interactive elements, via CDP so no real
// mouse or focus is involved and parent-state descendant rules still apply.
async function captureForcedStates(page: Page, ignore: string[]): Promise<StyleMap['states']> {
  const client = await page.context().newCDPSession(page);
  await client.send('DOM.enable');
  await client.send('CSS.enable');
  const { root } = await client.send('DOM.getDocument');
  const { nodeIds } = await client.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: INTERACTIVE });
  const skipSel = ignore.length ? ignore.map((s) => `${s}, ${s} *`).join(', ') : '';
  const paths = await page.evaluate(pathsForSelector, { selector: INTERACTIVE, skipSel });
  if (paths.length !== nodeIds.length) {
    throw new Error(`stylemap: CDP saw ${nodeIds.length} interactive elements, page saw ${paths.length}`);
  }

  const states: StyleMap['states'] = {};
  for (let i = 0; i < nodeIds.length; i++) {
    const p = paths[i];
    if (!p) continue;
    const baseSnap: Snap = await page.evaluate(snapSubtree, { selector: INTERACTIVE, index: i });
    for (const [stateName, forcedPseudoClasses] of Object.entries(STATE_SETS)) {
      await client.send('CSS.forcePseudoState', { nodeId: nodeIds[i], forcedPseudoClasses });
      const forcedSnap: Snap = await page.evaluate(snapSubtree, { selector: INTERACTIVE, index: i });
      await client.send('CSS.forcePseudoState', { nodeId: nodeIds[i], forcedPseudoClasses: [] });
      const delta = deltaBetween(baseSnap, forcedSnap);
      if (Object.keys(delta).length) (states[p] ??= {})[stateName] = delta;
    }
  }
  await client.detach();
  return states;
}

/**
 * Capture the page's complete style map. Drive the page to the state you
 * want first (navigate, open menus, settle fonts/animations) — the capture
 * reads whatever is in front of it.
 */
export async function captureStyleMap(page: Page, options: CaptureOptions = {}): Promise<StyleMap> {
  const ignore = options.ignore ?? [];
  // Motion longhands first (FREEZE_CSS would null them), then everything else.
  const motion = await page.evaluate(capturePage, { ignore, motionOnly: true });
  await page.addStyleTag({ content: FREEZE_CSS });
  const base = await page.evaluate(capturePage, { ignore, motionOnly: false });
  for (const [p, entry] of Object.entries(base.elements)) {
    const m = motion.elements[p];
    if (!m) continue;
    Object.assign(entry.style, m.style);
    for (const [ps, props] of Object.entries(m.pseudo ?? {})) {
      if (entry.pseudo?.[ps]) Object.assign(entry.pseudo[ps], props);
    }
  }
  const states = await captureForcedStates(page, ignore);
  return { defaults: base.defaults, elements: base.elements, states };
}

/** Write a style map to disk; gzipped when the path ends in `.gz`. */
export function saveStyleMap(filePath: string, map: StyleMap): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const json = JSON.stringify(map);
  fs.writeFileSync(filePath, filePath.endsWith('.gz') ? gzipSync(json) : json);
}

/** Read a style map written by {@link saveStyleMap} (`.json` or `.json.gz`). */
export function loadStyleMap(filePath: string): StyleMap {
  const raw = fs.readFileSync(filePath);
  return JSON.parse(filePath.endsWith('.gz') ? gunzipSync(raw).toString('utf8') : raw.toString('utf8'));
}
