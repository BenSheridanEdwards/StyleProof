// Functions in this file run INSIDE the browser via page.evaluate: each must stay
// self-contained (no module-scope helpers, imports, or closures).
import type { AuthBoundaryMetadata } from '../auth-boundary.js';
import type { IncompleteUiMetadata } from '../incomplete-ui.js';
import type { RawCandidate } from './types.js';

/** Every visible, enabled, non-navigating control worth trying. `dangerSource` is the shared
 *  destructive-label pattern, passed as a string because a Node RegExp cannot be serialized. */
/* c8 ignore start */ // fallow-ignore-next-line complexity
export function collectClickable(dangerSource: string): RawCandidate[] {
  const SEMANTIC = 'button,summary,[role="button"],[role="tab"],[role="menuitem"],[role="combobox"],select,form';
  // Neutral text inputs get a deterministic value; credential fields are NEVER auto-filled (--setup territory).
  const FILLABLE =
    'input:not([type]),input[type="text"],input[type="search"],input[type="email"],input[type="tel"],input[type="url"],input[type="number"],textarea';
  const CRED_AUTOCOMPLETE = /username|current-password|new-password|one-time-code/i;
  const AUTO_VALUE: Record<string, string> = {
    email: 'sample@example.com',
    url: 'https://example.com',
    tel: '5550100',
    number: '1',
  };
  const DANGER = new RegExp(dangerSource, 'i');
  const tag = (el: Element): string => el.tagName.toLowerCase();
  const visible = (el: Element): boolean => {
    const b = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return (
      b.width > 0 && b.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden' && cs.pointerEvents !== 'none'
    );
  };
  const unique = (s: string): boolean => document.querySelectorAll(s).length === 1;
  const ancestry = (el: Element): Element[] => {
    const chain: Element[] = [];
    for (let cur: Element | null = el; cur && cur !== document.documentElement; cur = cur.parentElement)
      chain.unshift(cur);
    return chain;
  };
  const nthOfType = (el: Element): number => {
    let i = 1;
    for (let sib = el.previousElementSibling; sib; sib = sib.previousElementSibling)
      if (sib.tagName === el.tagName) i++;
    return i;
  };
  const selectorFor = (el: Element): string => {
    const id = el.getAttribute('id');
    if (id && unique(`#${CSS.escape(id)}`)) return `#${CSS.escape(id)}`;
    for (const attr of ['data-testid', 'data-test', 'aria-label', 'name']) {
      const v = el.getAttribute(attr);
      const s = `${tag(el)}[${attr}=${JSON.stringify(v)}]`;
      if (v && unique(s)) return s;
    }
    return ancestry(el)
      .map((a) => `${tag(a)}:nth-of-type(${nthOfType(a)})`)
      .join(' > ');
  };
  // `title` is a source so an icon-only control with a native tooltip still labels meaningfully — and still trips the guard.
  const labelFor = (el: Element): string => {
    const own =
      ['aria-label', 'name', 'text', 'title']
        .map((a) => (a === 'text' ? el.textContent : el.getAttribute(a)))
        .find((v) => v) ?? '';
    return own.replace(/\s+/g, ' ').trim().slice(0, 80) || tag(el);
  };
  // Tag path only — no classes (they carry state) and no indices (they drift on re-render).
  const identityFor = (el: Element): string =>
    `${ancestry(el).map(tag).join('>')}|${labelFor(el)}|${el.getAttribute('role') ?? ''}`;
  const disabled = (el: Element): boolean => Boolean(el.closest(':disabled,[aria-disabled="true"]'));
  const seen = new Set<string>();
  const claim = (el: Element): string | null => {
    const selector = selectorFor(el);
    if (seen.has(selector)) return null;
    seen.add(selector);
    return selector;
  };

  // Semantic controls first, then anything styled clickable (`grab` too: draggable cards are click
  // targets and el.click() never drags). `cursor` inherits, so keep only the OUTERMOST pointer
  // element of a subtree — descendants bubble to the same handler. Document order pools an ancestor first.
  const pool = new Set<Element>(document.querySelectorAll(SEMANTIC));
  for (const el of document.querySelectorAll('body *')) {
    const cursor = pool.has(el) ? '' : getComputedStyle(el).cursor;
    if (cursor !== 'pointer' && cursor !== 'grab') continue;
    let anc = el.parentElement;
    while (anc && anc !== document.body && !pool.has(anc)) anc = anc.parentElement;
    if (!anc || anc === document.body) pool.add(el);
  }

  const out: RawCandidate[] = [];
  for (const el of document.querySelectorAll(FILLABLE)) {
    const readOnly = (el as HTMLInputElement).readOnly;
    if (CRED_AUTOCOMPLETE.test(el.getAttribute('autocomplete') ?? '') || disabled(el) || readOnly || !visible(el))
      continue;
    const selector = claim(el);
    if (!selector) continue;
    const label = labelFor(el);
    out.push({
      action: 'fill-input',
      selector,
      identity: identityFor(el),
      label: label === tag(el) ? (el.getAttribute('placeholder') ?? 'input') : label,
      reason: 'auto-fill',
      value: AUTO_VALUE[el.getAttribute('type') ?? 'text'] ?? 'sample text',
      unsafe: false,
    });
  }
  for (const el of pool) {
    // Links navigate — the link crawl owns them.
    if ((el instanceof HTMLAnchorElement && el.href) || disabled(el) || !visible(el)) continue;
    const selector = claim(el);
    if (!selector) continue;
    const label = labelFor(el);
    const common = { selector, identity: identityFor(el), label, unsafe: DANGER.test(label) };
    if (el instanceof HTMLSelectElement) {
      const next = [...el.options].find((o) => !o.disabled && o.value !== el.value);
      if (next) out.push({ action: 'select-option', ...common, reason: 'select-option', value: next.value });
    } else {
      out.push({ action: 'click', ...common, reason: el.getAttribute('role') === 'tab' ? 'tab' : 'click' });
    }
  }
  return out;
}
/* c8 ignore stop */

/** The DOM's structural shape — every element's tag + class in document order. No text or computed
 *  styles, so a ticking clock never reads as a new state while any mount/unmount/class flip does. */
/* c8 ignore start */
export function domShape(): { shape: string; elements: number; classes: string[] } {
  const SKIP = new Set(['SCRIPT', 'STYLE', 'META', 'LINK', 'NOSCRIPT', 'TEMPLATE']);
  // StyleProof's own hover-sink and framework route announcers are not page: counting them made a
  // state's in-place fingerprint differ from its reset+replay fingerprint.
  const ARTIFACT = '[data-styleproof-hover-sink],next-route-announcer,#__next-route-announcer__';
  const parts: string[] = [];
  const classes = new Set<string>();
  // html/body first: state classes there (theme, modal-open) restyle the page without touching a descendant.
  for (const el of [document.documentElement, document.body, ...document.body.getElementsByTagName('*')]) {
    if (SKIP.has(el.tagName) || el.matches(ARTIFACT)) continue;
    const cls = el.getAttribute('class') ?? '';
    parts.push(`${el.tagName}.${cls}`);
    for (const c of cls.split(/\s+/)) if (c) classes.add(c);
  }
  return { shape: parts.join('\n'), elements: parts.length, classes: [...classes] };
}
/* c8 ignore stop */

/** Every class name the page's OWN stylesheets select on (parsed CSSOM) — the vocabulary coverage
 *  is checked against. A sheet the browser can't parse is named in `unreadable`, never skipped. */
/* c8 ignore start */
export function collectDefinedClasses(): { classes: string[]; unreadable: string[] } {
  const out = new Set<string>();
  const unreadable: string[] = [];
  const scan = (rules?: CSSRuleList): void => {
    for (const rule of rules ?? []) {
      const r = rule as CSSStyleRule & CSSGroupingRule;
      for (const m of r.selectorText?.matchAll(/\.([A-Za-z_][A-Za-z0-9_-]*)/g) ?? []) out.add(m[1]);
      if (r.cssRules) scan(r.cssRules);
    }
  };
  for (const sheet of document.styleSheets) {
    try {
      scan(sheet.cssRules); // throws for a cross-origin sheet with no CORS
    } catch {
      unreadable.push(sheet.href ?? '<inline>');
    }
  }
  return { classes: [...out], unreadable };
}
/* c8 ignore stop */

/** Structural auth-boundary and blocked-continuation metadata in ONE walk. Never reads `value`,
 *  `textContent`, cookies, or storage; the classifiers strip any selector that could leak values. */
/* c8 ignore start */ // fallow-ignore-next-line complexity
export function collectBoundaryMetadata(): { auth: AuthBoundaryMetadata[]; incompleteUi: IncompleteUiMetadata[] } {
  const BLOCKED =
    'form,[role="form"],:disabled,[aria-disabled="true"],[inert],[required],[aria-expanded="false"],details:not([open]),button,input[type="submit"],input[type="button"],input[type="reset"],[role="button"]';
  const sel = (el: Element): string => {
    const id = el.getAttribute('id');
    const byId = id ? `#${CSS.escape(id)}` : '';
    return byId && document.querySelectorAll(byId).length === 1 ? byId : el.tagName.toLowerCase();
  };
  const visible = (el: Element): boolean => {
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0;
  };
  const auth: AuthBoundaryMetadata[] = [];
  for (const input of document.querySelectorAll('input')) {
    if (input.type === 'hidden') continue;
    const formAction = input.form?.getAttribute('action') ?? null;
    auth.push({
      selector: sel(input),
      inputType: input.type || 'text',
      autocomplete: input.getAttribute('autocomplete'),
      ...(formAction ? { formAction } : {}),
    });
  }
  for (const form of document.querySelectorAll('form')) {
    const formAction = form.getAttribute('action');
    if (formAction) auth.push({ selector: sel(form), formAction });
  }
  const incompleteUi = [...document.querySelectorAll(BLOCKED)].filter(visible).map((el) => {
    const input =
      el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
    return {
      selector: sel(el),
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role'),
      type: el instanceof HTMLInputElement ? el.type : null,
      disabled: 'disabled' in el && (el as HTMLButtonElement).disabled === true,
      ariaDisabled: el.getAttribute('aria-disabled') === 'true',
      inert: el.hasAttribute('inert'),
      pointerEventsNone: getComputedStyle(el).pointerEvents === 'none',
      required: input && el.required,
      valuePresent: input ? el.value.length > 0 : undefined,
      ariaExpanded: el.hasAttribute('aria-expanded') ? el.getAttribute('aria-expanded') === 'true' : null,
      detailsOpen: el instanceof HTMLDetailsElement ? el.open : null,
    };
  });
  return { auth, incompleteUi };
}
/* c8 ignore stop */
