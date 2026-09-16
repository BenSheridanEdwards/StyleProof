// Functions and snippets serialized into the page. Each must stay self-contained.

/** A trigger enumerated once per surface: `index` names the capture (`popup-XX`); `path` +
 *  `label` are the identity every reopen re-binds to (never the index — the trigger set can
 *  shift between opens; the label pins identity where the positional path alone cannot). */
export type PopupCandidate = { index: number; path: string; label: string };
export type PopupDomSnapshot = { keys: string[]; candidates: PopupCandidate[]; found: boolean };

export type PopupSnapshotArgs = {
  popupSelector: string;
  triggerSelector?: string;
  attr?: string;
  max?: number;
  /** Re-bind mode: mark ONLY the trigger whose path AND label match (`found: false` = skip loudly). */
  relocatePath?: string;
  relocateLabel?: string;
};

/** Visible overlay keys, plus either an enumeration of marked triggers or one re-bound trigger. */
export function popupDomSnapshot({
  popupSelector,
  triggerSelector,
  attr,
  max = 0,
  relocatePath,
  relocateLabel,
}: PopupSnapshotArgs): PopupDomSnapshot {
  const qsa = (sel: string): Element[] => {
    try {
      return [...document.querySelectorAll(sel)];
    } catch {
      return [];
    }
  };
  const visible = (el: Element): boolean => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  };
  const pathOf = (el: Element): string => {
    const parts: string[] = [];
    let cur: Element | null = el;
    while (cur && cur !== document.documentElement) {
      const parent = cur.parentElement;
      const tag = cur.tagName.toLowerCase();
      const id = cur.id ? `#${cur.id}` : '';
      const role = cur.getAttribute('role');
      const sameTag = parent ? [...parent.children].filter((child) => child.tagName === cur!.tagName) : [cur];
      const nth = sameTag.length > 1 ? `:nth-of-type(${sameTag.indexOf(cur) + 1})` : '';
      parts.unshift(`${tag}${id}${role ? `[role="${role}"]` : ''}${nth}`);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  };
  const clean = (value: string | null): string => (value ?? '').replace(/\s+/g, ' ').trim();
  // Accessible name (aria-label, name, text, title) — same precedence as the crawlers.
  const labelOf = (el: Element): string => {
    const sources = [el.getAttribute('aria-label'), el.getAttribute('name'), el.textContent, el.getAttribute('title')];
    const own = clean(sources.find(Boolean) ?? null).slice(0, 80);
    return own || el.tagName.toLowerCase();
  };
  const KEY_ATTRS = [
    'role',
    'aria-modal',
    'aria-live',
    'data-state',
    'data-hot-toast',
    'data-sonner-toast',
    'data-toast',
  ];
  const popupKey = (el: Element): string =>
    [pathOf(el), ...KEY_ATTRS.map((name) => el.getAttribute(name) ?? ''), clean(el.textContent).slice(0, 120)].join(
      '|',
    );
  const popups = qsa(popupSelector).filter(visible);
  const keys = popups.map(popupKey);
  if (!triggerSelector || !attr) return { keys, candidates: [], found: false };

  for (const el of qsa(`[${attr}]`)) el.removeAttribute(attr);

  if (relocatePath) {
    const target = qsa(triggerSelector).find((el) => pathOf(el) === relocatePath && labelOf(el) === relocateLabel);
    if (target) target.setAttribute(attr, 'target');
    return { keys, candidates: [], found: Boolean(target) };
  }

  const safeTrigger = (el: Element): boolean => {
    const tag = el.tagName.toLowerCase();
    if (el.matches(':disabled, [aria-disabled="true"]')) return false;
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return false;
    if (tag === 'a') return (el as HTMLAnchorElement).getAttribute('href')?.startsWith('#') ?? false;
    return true;
  };

  const candidates = qsa(triggerSelector)
    .filter((el) => visible(el) && !popups.some((popup) => popup !== el && popup.contains(el)) && safeTrigger(el))
    .slice(0, max);
  candidates.forEach((el, index) => el.setAttribute(attr, String(index)));
  return {
    keys,
    candidates: candidates.map((el, index) => ({ index, path: pathOf(el), label: labelOf(el) })),
    found: false,
  };
}

// Framework-neutral SPA route discovery: report every URL the app lands on through the
// history API (pushState/replaceState/popstate). `hashchange` is deliberately NOT observed —
// in-page `<a href="#section">` anchors are content, not routes.
export const NAV_OBSERVER_FN = '__styleproofObservedNav';
export const NAV_OBSERVER_SNIPPET = `(() => {
  const report = () => {
    try { window.${NAV_OBSERVER_FN}(location.href); } catch { /* binding not yet installed */ }
  };
  for (const fn of ['pushState', 'replaceState']) {
    const orig = history[fn];
    history[fn] = function (...args) {
      const ret = orig.apply(this, args);
      report();
      return ret;
    };
  };
  addEventListener('popstate', report);
})();`;
