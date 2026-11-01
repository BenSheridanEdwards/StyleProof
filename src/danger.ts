/**
 * The ONE destructive-action guard shared by every crawler: a control whose label
 * matches is recorded but never clicked. A plain string, not a RegExp, because the
 * classifiers run inside `page.evaluate` and recompile it in the browser.
 */
// SEP normalises typographic hyphens and non-breaking/zero-width spaces used in real app labels.
const SEP =
  '[\\s\\u00A0\\u202F\\u2000-\\u200F\\u2060\\u2066-\\u2069\\u2043\\u180E\\u034F\\uFEFF\\u00AD\\u2010-\\u2015\\u2212\\uFE58\\uFE63\\uFF0D_-]{0,4}';

export const DANGER_SOURCE = `(?<![a-z])(delete|remove|destroy|log(?:ging)?${SEP}(?:in|out|on)|sign(?:ing)?${SEP}(?:in|up|out)|publish|deploy|pay(?:ments?)?|purchases?|buy|check${SEP}out|place${SEP}order|archive|disconnect|revoke|reset|wipe|drop|rotate|provision|seal|regenerate|renew|send(?:s|ing)?|submit(?:s|ted|ting)?|sav(?:e[sd]?|ing)|confirm(?:s|ed|ing)?|approv(?:e[sd]?|ing)|invit(?:e[sd]?|ing)|transfer(?:s|red|ring)?|cancel(?:s|led|ed|ling|ing)?|(?:un)?tick(?:s|ed|ing)?|(?:un)?merg(?:e[sd]?|ing)|authori[sz](?:e[sd]?|ing)|(?<![a-z]['’])re${SEP}start(?:s|ed|ing)?|reboot(?:s|ed|ing)?|recover(?:s|ed|ing)?|(?<![a-z]['’])re${SEP}stor(?:e[sd]?|ing))(?![a-z])`;

/** Shared by Node checks and the serialized browser label gatherer. */
export function normalizeDangerText(value: string): string {
  return value
    .replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, '')
    .normalize('NFKC')
    .replace(/[\u00B7\u2027\u30FB\u2219\u22C5]/g, '-');
}

/** Independent, bounded label sources for safety only; never use these for reported labels. */
const dangerTextSource = String((el: Element | null, label?: string): string[] | null => {
  if (label !== undefined) return [label, normalizeDangerText(label)];

  if (!el) return null;

  const sources: string[] = [];
  const descendants = new Set<Element>();
  let overflow = false;

  const add = (value: string | null): void => {
    if (!value) return;

    if (value.length > 20000) {
      overflow = true;

      return;
    }

    sources.push(value.replace(/\s+/g, ' ').trim(), normalizeDangerText(value).replace(/\s+/g, ' ').trim());
  };

  const addText = (target: Element): void => {
    add(target.textContent);
    const doc = target.ownerDocument;

    if (!doc?.createTreeWalker) return;
    const walker = doc.createTreeWalker(target, 4); // NodeFilter.SHOW_TEXT, also across browser realms.
    const parts: string[] = [];
    let length = 0;

    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent ?? '';

      length += text.length + (parts.length ? 1 : 0);

      if (length > 20000) {
        overflow = true;

        return;
      }

      parts.push(text);
    }

    add(parts.join(' '));
  };

  const addDescendants = (target: Element, includeReferences = false): void => {
    for (const child of target.querySelectorAll('[aria-label],[title],[alt],[aria-labelledby]')) {
      descendants.add(child);

      if (descendants.size > 100) {
        overflow = true;

        return;
      }

      for (const attr of ['aria-label', 'title', 'alt']) add(child.getAttribute(attr));

      if (includeReferences) addReferences(child);
    }
  };

  const addLabel = (target: Element): void => {
    addText(target);
    add(target.getAttribute('aria-label'));
    addDescendants(target);
  };

  add(el.getAttribute('aria-label'));
  const root = el.getRootNode();
  // SAFETY: Document and ShadowRoot are the DOM roots exposing getElementById.
  const labelRoot = 'getElementById' in root ? (root as Document | ShadowRoot) : el.ownerDocument;

  const addReferences = (target: Element): void => {
    for (const id of (target.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean)) {
      const label = labelRoot.getElementById(id);

      if (label) addLabel(label);
    }
  };

  addReferences(el);
  addText(el);
  add(el.getAttribute('title'));

  if (el.localName === 'input' || el.localName === 'button') {
    // SAFETY: native input and button elements expose their current value.
    add((el as HTMLInputElement | HTMLButtonElement).value);
  }

  if (el.localName === 'input' && el.getAttribute('type')?.toLowerCase() === 'image') add(el.getAttribute('alt'));
  add(el.getAttribute('name'));

  if (['button', 'input', 'meter', 'output', 'progress', 'select', 'textarea'].includes(el.localName)) {
    // SAFETY: these native labelable elements expose associated labels.
    const labels = (el as HTMLButtonElement).labels;

    for (const label of labels ?? []) addLabel(label);
  }

  addDescendants(el, true);

  return overflow ? null : sources;
});

export const DANGER_TEXT_SOURCE = `((normalizeDangerText) => (${dangerTextSource}))(${String(normalizeDangerText)})`;

export const SUBMITS_FORM_SOURCE = String((el: Element): boolean => {
  const submits = (control: Element | null | undefined): boolean => {
    // SAFETY: native controls expose form/type; custom controls use attributes below.
    const c = control as HTMLButtonElement | HTMLInputElement | null | undefined;

    if (!c) return false;

    if (c.localName === 'button' || c.localName === 'input')
      return Boolean(c.form && (c.type === 'submit' || c.type === 'image'));
    const definition = typeof customElements === 'undefined' ? undefined : customElements.get(c.localName);

    if (!definition || !('formAssociated' in definition) || definition.formAssociated !== true) return false;
    const owner = c.getAttribute('form');

    return Boolean(
      !['button', 'reset'].includes((c.getAttribute('type') ?? '').toLowerCase()) &&
      (owner ? (c.ownerDocument ?? document).getElementById(owner)?.localName === 'form' : c.closest('form')),
    );
  };

  for (let c: Element | null = el; c; c = c.parentElement) if (submits(c)) return true;

  // SAFETY: label selectors/localName identify elements with a control property.
  return (
    submits(el.closest?.('button,input')) ||
    submits((el.closest?.('label') as HTMLLabelElement | null)?.control) ||
    [...(el.querySelectorAll?.('*') ?? [])].some((c) =>
      submits(c.localName === 'label' ? (c as HTMLLabelElement).control : c),
    )
  );
});
