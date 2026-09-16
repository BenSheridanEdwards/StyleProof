// Functions serialized into the page (page.evaluate / CDP Runtime.evaluate).
// Each must stay self-contained: no module-scope helpers, imports, or closures.
import type { CapturedOverlay, ElementEntry, LiveRegionCandidate, Props } from './types.js';

/** In-page shape of the window after {@link injectPathOf} runs. */
type WithPathOf = { __spPathOf?: (el: Element) => string };

export function installHoverSink(): void {
  let sink = document.querySelector<HTMLElement>('[data-styleproof-hover-sink]');
  if (!sink) {
    sink = document.createElement('div');
    sink.setAttribute('data-styleproof-hover-sink', '');
    document.body.appendChild(sink);
  }
  sink.setAttribute(
    'style',
    'position:fixed;left:0;top:0;width:1px;height:1px;z-index:2147483647;pointer-events:auto;opacity:0',
  );
}

/** Define the structural-path helper on `window` once so every serialized function shares it. */
export function injectPathOf(): void {
  (window as unknown as WithPathOf).__spPathOf = (el: Element): string => {
    if (el === document.documentElement) return 'html';
    if (el === document.body) return 'body';
    const identityCandidates = (element: Element): string[] => {
      const tag = element.tagName.toLowerCase();
      const attributes: Array<[string, string | null]> = [
        ['styleproof', element.getAttribute('data-styleproof-key')],
        ['id', element.getAttribute('id')],
        ['testid', element.getAttribute('data-testid')],
        ['test', element.getAttribute('data-test')],
        // First `data-style` token only: later tokens carry dynamic state and must not churn the path.
        ['style', element.getAttribute('data-style')?.trim().split(/\s+/)[0] ?? null],
        ...(tag === 'a' ? ([['href', element.getAttribute('href')]] as Array<[string, string | null]>) : []),
        ...(['input', 'select', 'textarea'].includes(tag)
          ? ([['name', element.getAttribute('name')]] as Array<[string, string | null]>)
          : []),
      ];
      return attributes.flatMap(([name, value]) => (value ? [`${name}:${value}`] : []));
    };
    const privacySafeHash = (value: string): string => {
      let hash = 2166136261;
      for (let characterIndex = 0; characterIndex < value.length; characterIndex++) {
        hash ^= value.charCodeAt(characterIndex);
        hash = Math.imul(hash, 16777619);
      }
      return (hash >>> 0).toString(36);
    };
    const stableSegment = (element: Element, parent: Element): string => {
      const candidate = identityCandidates(element).find(
        (identity) =>
          [...parent.children].filter((sibling) => identityCandidates(sibling).includes(identity)).length === 1,
      );
      if (candidate) return `${element.tagName.toLowerCase()}:sp-key(${privacySafeHash(candidate)})`;
      return `${element.tagName.toLowerCase()}:nth-child(${Array.prototype.indexOf.call(parent.children, element) + 1})`;
    };
    const parts: string[] = [];
    let element: Element | null = el;
    while (element && element !== document.body) {
      const parent: Element | null = element.parentElement;
      if (!parent) break;
      parts.unshift(stableSegment(element, parent));
      element = parent;
    }
    return 'body > ' + parts.join(' > ');
  };
}

export type CaptureArgs = { skipSel: string; motionOnly: boolean; captureText: boolean; captureComponent?: boolean };

export type PageCapture = {
  defaults: Record<string, Props>;
  elements: Record<string, ElementEntry>;
  shadowHosts: number;
  sameOriginFrames: number;
};

// Pre-existing, grandfathered in the health baseline.
// fallow-ignore-next-line complexity
export function capturePage({ skipSel, motionOnly, captureText, captureComponent }: CaptureArgs): PageCapture {
  const MOTION = /^(transition|animation)/;
  const PSEUDOS = ['::before', '::after', '::marker', '::placeholder'];
  const pathOf = (window as unknown as Required<WithPathOf>).__spPathOf;

  // Per-tag (and per-tag-per-pseudo) UA defaults from a stylesheet-free iframe prune the maps.
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:absolute;left:-9999px;width:100px;height:100px;border:0';
  document.body.appendChild(frame);
  const fdoc = frame.contentDocument as Document;
  const defaults: Record<string, Props> = {};
  const probeCache: Record<string, Element> = {};
  const probeFor = (tag: string): Element => {
    if (!(tag in probeCache)) {
      const probe = fdoc.createElement(tag);
      fdoc.body.appendChild(probe);
      probeCache[tag] = probe;
    }
    return probeCache[tag];
  };
  const defaultFor = (tag: string, pseudo?: string): Props => {
    const key = pseudo ? `${tag}${pseudo}` : tag;
    if (!(key in defaults)) {
      const cs = fdoc.defaultView!.getComputedStyle(probeFor(tag), pseudo ?? null);
      const o: Props = {};
      for (let i = 0; i < cs.length; i++) o[cs.item(i)] = cs.getPropertyValue(cs.item(i));
      defaults[key] = o;
    }
    return defaults[key];
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

  // React keeps the fiber on each DOM node under a hashed key; walk up to the nearest component fiber.
  type Fiber = { type: unknown; return: Fiber | null; memoizedProps?: Record<string, unknown> };
  const nameOfType = (t: unknown): string => {
    if (typeof t === 'function') {
      const f = t as { displayName?: string; name?: string };
      return f.displayName || f.name || '';
    }
    if (t && typeof t === 'object') {
      const w = t as {
        displayName?: string;
        render?: { displayName?: string; name?: string };
        type?: { displayName?: string; name?: string };
      };
      const inner = w.render || w.type;
      return w.displayName || inner?.displayName || inner?.name || '';
    }
    return '';
  };
  const sanitizeProps = (mp: Record<string, unknown>): Record<string, string> => {
    const props: Record<string, string> = {};
    for (const k of Object.keys(mp)) {
      if (k === 'children' || k === 'className' || k === 'style') continue;
      const ty = typeof mp[k];
      if (ty === 'string' || ty === 'number' || ty === 'boolean') props[k] = String(mp[k]).slice(0, 80);
    }
    return props;
  };
  const reactComponent = (el: Element): ElementEntry['component'] => {
    const fiberKey = Object.keys(el).find(
      (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'),
    );
    if (!fiberKey) return undefined;
    let fiber = (el as unknown as Record<string, Fiber | undefined>)[fiberKey] ?? null;
    for (let hops = 0; fiber && hops < 30; fiber = fiber.return, hops++) {
      const name = nameOfType(fiber.type);
      if (!name || name === 'Symbol(react.fragment)') continue;
      const out: { name: string; props?: Record<string, string> } = { name };
      const mp = fiber.memoizedProps;
      if (mp && typeof mp === 'object') {
        const props = sanitizeProps(mp);
        if (Object.keys(props).length) out.props = props;
      }
      return out;
    }
    return undefined;
  };
  const elements: Record<string, ElementEntry> = {};
  const all = [document.documentElement, document.body, ...document.querySelectorAll('body *')];
  let shadowHosts = 0;
  let sameOriginFrames = 0;
  for (const el of all) {
    if (el === frame || (skipSel && el.matches(skipSel))) continue;
    const tag = el.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'link' || tag === 'noscript') continue;
    if (!motionOnly && (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot) shadowHosts++;
    if (!motionOnly && (tag === 'iframe' || tag === 'frame')) {
      try {
        if ((el as HTMLIFrameElement).contentDocument) sameOriginFrames++;
      } catch {
        // cross-origin: genuinely untraversable, not counted
      }
    }
    const usedStyle = getComputedStyle(el);
    const entry: ElementEntry = {
      tag,
      cls: el.getAttribute('class') || '',
      style: snap(usedStyle, defaultFor(tag)),
    };
    if (!motionOnly) {
      const typedComputedStyle = el.computedStyleMap?.();
      if (typedComputedStyle) {
        const computedValueStyle: Props = {};
        for (let propertyIndex = 0; propertyIndex < usedStyle.length; propertyIndex++) {
          const propertyName = usedStyle.item(propertyIndex);
          const usedValue = usedStyle.getPropertyValue(propertyName);
          const computedValue = typedComputedStyle.get(propertyName)?.toString();
          if (computedValue && computedValue !== usedValue) computedValueStyle[propertyName] = computedValue;
        }
        if (Object.keys(computedValueStyle).length > 0) entry.computedValueStyle = computedValueStyle;
      }
      // Document-space box so report crops locate the element regardless of scroll position.
      const r = el.getBoundingClientRect();
      entry.rect = [
        Math.round(r.x + window.scrollX),
        Math.round(r.y + window.scrollY),
        Math.round(r.width),
        Math.round(r.height),
      ];
      // Own text only (direct text nodes), so a parent and child never both report the same string.
      let ownText = '';
      for (const node of Array.prototype.slice.call(el.childNodes)) {
        if (node.nodeType === 3 /* TEXT_NODE */) ownText += node.textContent ?? '';
      }
      ownText = ownText.replace(/\s+/g, ' ').trim();
      entry.ownTextLength = ownText.length;
      if (captureText && ownText) entry.text = ownText;
      if (captureComponent) {
        try {
          const comp = reactComponent(el);
          if (comp) entry.component = comp;
        } catch {
          // non-React node or inaccessible fiber — component stays absent
        }
      }
    }
    for (const ps of PSEUDOS) {
      if (ps === '::marker' && getComputedStyle(el).display !== 'list-item') continue;
      if (ps === '::placeholder' && !(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) continue;
      const cs = getComputedStyle(el, ps);
      if ((ps === '::before' || ps === '::after') && cs.getPropertyValue('content') === 'none') continue;
      const props = snap(cs, defaultFor(tag, ps));
      if (Object.keys(props).length) (entry.pseudo ??= {})[ps] = props;
    }
    elements[pathOf(el)] = entry;
  }
  frame.remove();
  return { defaults, elements, shadowHosts, sameOriginFrames };
}

export type SkipArgs = { skipSel: string };

export function detectLiveCandidates({ skipSel }: SkipArgs): LiveRegionCandidate[] {
  const pathOf = (window as unknown as Required<WithPathOf>).__spPathOf;
  const reasonsFor = (role: string, ariaLive: string, ariaBusy: string): string[] => {
    const reasons: string[] = [];
    if (ariaLive && ariaLive !== 'off') reasons.push(`aria-live=${ariaLive}`);
    if (['alert', 'log', 'marquee', 'status', 'timer'].includes(role)) reasons.push(`role=${role}`);
    if (ariaBusy === 'true') reasons.push('aria-busy=true');
    return reasons;
  };
  return [document.documentElement, document.body, ...document.querySelectorAll('body *')]
    .filter((el) => !skipSel || !el.matches(skipSel))
    .flatMap((el): LiveRegionCandidate[] => {
      const role = (el.getAttribute('role') ?? '').trim().toLowerCase();
      const ariaLive = (el.getAttribute('aria-live') ?? '').trim().toLowerCase();
      const ariaBusy = (el.getAttribute('aria-busy') ?? '').trim().toLowerCase();
      const reasons = reasonsFor(role, ariaLive, ariaBusy);
      return reasons.length
        ? [
            {
              path: pathOf(el),
              tag: el.tagName.toLowerCase(),
              cls: el.getAttribute('class') || '',
              reason: reasons.join(', '),
              ...(role ? { role } : {}),
              ...(ariaLive ? { ariaLive } : {}),
              ...(ariaBusy ? { ariaBusy } : {}),
            },
          ]
        : [];
    });
}

export function detectOverlayCandidates({ skipSel }: SkipArgs): CapturedOverlay[] {
  const pathOf = (window as unknown as Required<WithPathOf>).__spPathOf;
  const visible = (el: Element): boolean => {
    if ((el as HTMLElement).hidden || el.getAttribute('aria-hidden') === 'true') return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  };
  const textOf = (el: Element): string => (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const toastish = (el: Element): boolean => {
    const haystack = [
      el.id,
      el.getAttribute('class'),
      el.getAttribute('data-testid'),
      el.getAttribute('data-hot-toast'),
      el.getAttribute('data-sonner-toast'),
      el.getAttribute('data-toast'),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return /\b(toast|hot-toast|sonner)\b/.test(haystack);
  };
  const reasonsFor = (el: Element, role: string, ariaModal: string): string[] => {
    const reasons: string[] = [];
    if (el instanceof HTMLDialogElement && el.open) reasons.push('dialog[open]');
    if (el.hasAttribute('popover')) reasons.push('popover');
    if (['dialog', 'alertdialog', 'menu', 'listbox', 'tooltip'].includes(role)) reasons.push(`role=${role}`);
    if (ariaModal === 'true') reasons.push('aria-modal=true');
    if (toastish(el)) reasons.push('toast');
    if (el.hasAttribute('data-hot-toast')) reasons.push('data-hot-toast');
    if (el.hasAttribute('data-sonner-toast')) reasons.push('data-sonner-toast');
    if ((role === 'status' || role === 'alert') && toastish(el)) reasons.push(`role=${role}`);
    return [...new Set(reasons)];
  };

  return [document.documentElement, document.body, ...document.querySelectorAll('body *')]
    .filter((el) => (!skipSel || !el.matches(skipSel)) && visible(el))
    .flatMap((el): CapturedOverlay[] => {
      const role = (el.getAttribute('role') ?? '').trim().toLowerCase();
      const ariaModal = (el.getAttribute('aria-modal') ?? '').trim().toLowerCase();
      const ariaLive = (el.getAttribute('aria-live') ?? '').trim().toLowerCase();
      const reasons = reasonsFor(el, role, ariaModal);
      if (!reasons.length) return [];
      const text = textOf(el);
      return [
        {
          path: pathOf(el),
          tag: el.tagName.toLowerCase(),
          cls: el.getAttribute('class') || '',
          reason: reasons.join(', '),
          ...(role ? { role } : {}),
          ...(ariaModal ? { ariaModal } : {}),
          ...(ariaLive ? { ariaLive } : {}),
          ...(text ? { text } : {}),
        },
      ];
    });
}

export type StateScopeArgs = {
  selector: string;
  skipSel: string;
  skipPaths: string[];
  maxElements: number;
  baselineKey: string;
  saveBaseline: boolean;
};
export type StateScopeResult = { delta: Record<string, Props>; truncated: boolean; scanned: number };

/**
 * Read a target-first, bounded document scope; baselines stay in-page so each
 * forced read returns only its delta over CDP. Serialized via Runtime.evaluate.
 */
// fallow-ignore-next-line complexity
export function snapSubtree({ selector, skipSel, skipPaths, maxElements, baselineKey, saveBaseline }: StateScopeArgs) {
  const target = document.querySelector(selector);
  const pathOf = (window as unknown as Required<WithPathOf>).__spPathOf;
  const stateWindow = window as unknown as Record<string, Record<string, Record<string, string>> | undefined>;
  if (!target) return { delta: {}, truncated: true, scanned: 0 };

  const seen = new Set<Element>();
  const elements: Array<{ element: Element; path: string }> = [];
  const targetFirst = [target, ...target.querySelectorAll('*')];
  const documentOrder = [document.documentElement, document.body, ...document.querySelectorAll('body *')];
  let truncated = false;
  for (const element of [...targetFirst, ...documentOrder]) {
    if (seen.has(element)) continue;
    seen.add(element);
    const elementPath = pathOf(element);
    if (
      (skipSel && element.matches(skipSel)) ||
      skipPaths.some((root) => elementPath === root || elementPath.startsWith(root + ' > '))
    )
      continue;
    if (elements.length >= maxElements) {
      truncated = true;
      break;
    }
    elements.push({ element, path: elementPath });
  }

  const baseline = stateWindow[baselineKey];
  const result: Record<string, Record<string, string>> = {};
  for (const { element, path: elementPath } of elements) {
    for (const pseudo of [null, '::before', '::after']) {
      const style = getComputedStyle(element, pseudo);
      const key = elementPath + (pseudo || '');
      if (pseudo && style.getPropertyValue('content') === 'none') {
        if (!saveBaseline && baseline?.[key]) {
          result[key] = Object.fromEntries(Object.keys(baseline[key]).map((property) => [property, '(gone)']));
        }
        continue;
      }
      const resting = baseline?.[key] ?? {};
      const properties: Record<string, string> = {};
      const present = new Set<string>();
      for (let index = 0; index < style.length; index++) {
        const property = style.item(index);
        if (/^(transition|animation)/.test(property)) continue;
        const value = style.getPropertyValue(property);
        present.add(property);
        if (saveBaseline || resting[property] !== value) properties[property] = value;
      }
      if (!saveBaseline) {
        for (const property of Object.keys(resting)) {
          if (!present.has(property)) properties[property] = '(gone)';
        }
      }
      if (saveBaseline || Object.keys(properties).length) result[key] = properties;
    }
  }

  if (saveBaseline) {
    stateWindow[baselineKey] = result;
    return { delta: {}, truncated, scanned: elements.length };
  }
  if (!baseline) return { delta: {}, truncated: true, scanned: elements.length };
  return { delta: result, truncated, scanned: elements.length };
}

export function clearStateBaseline(baselineKey: string): void {
  delete (window as unknown as Record<string, unknown>)[baselineKey];
}

export type MarkArgs = { selector: string; skipSel: string; attr: string };
export type MarkedInteractive = { id: string; path: string };

/**
 * Mark interactive elements once so CDP and page.evaluate address the same node
 * (positional nodeId ↔ querySelectorAll alignment is flaky on hydrated apps).
 * `path` is empty when {@link injectPathOf} has not run (screenshot-only callers).
 */
export function markInteractiveElements({ selector, skipSel, attr }: MarkArgs): MarkedInteractive[] {
  const pathOf = (window as unknown as WithPathOf).__spPathOf ?? ((): string => '');
  let i = 0;
  return [...document.querySelectorAll(selector)].flatMap((el) => {
    if (skipSel && el.matches(skipSel)) return [];
    const id = `sp-${i++}`;
    el.setAttribute(attr, id);
    return [{ id, path: pathOf(el) }];
  });
}

export function clearInteractiveMarks(attr: string): void {
  for (const el of document.querySelectorAll(`[${attr}]`)) el.removeAttribute(attr);
}

/** Colour-valued `:root` custom properties, normalised via a probe to the browser's `rgb(...)` form. */
export function capturePageTokens(): Record<string, string> {
  const root = document.documentElement;
  const cs = getComputedStyle(root);
  const probe = document.createElement('span');
  probe.style.cssText = 'position:absolute;left:-9999px';
  document.body.appendChild(probe);
  const tokens: Record<string, string> = {};
  for (let i = 0; i < cs.length; i++) {
    const name = cs.item(i);
    if (!name.startsWith('--')) continue;
    const raw = cs.getPropertyValue(name).trim();
    if (!raw) continue;
    probe.style.color = '';
    probe.style.color = raw; // invalid (non-colour) values leave it empty
    if (!probe.style.color) continue;
    tokens[name] = getComputedStyle(probe).color;
  }
  probe.remove();
  return tokens;
}
