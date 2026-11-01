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
    .replace(/[\u00B7\u2022\u2027\u2E31\u30FB\u2219\u22C5]/g, '-');
}

/** Decode one CSS string token, including escaped newlines and replacement code points. */
function cssStringText(part: string): string {
  return part.slice(1, -1).replace(/\\([0-9a-fA-F]{1,6}[ \t\r\n\f]?|\r\n|[\s\S])/g, (_, escape: string) => {
    if (/^[0-9a-fA-F]/.test(escape)) {
      const code = parseInt(escape.trim(), 16);

      return String.fromCodePoint(code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? 0xfffd : code);
    }

    return /^[\r\n\f]/.test(escape) ? '' : escape;
  });
}

/** Keep string and attribute text, including alt text; other functions and keywords are non-text. */
export function cssContentText(content: string, el?: Element): string | null {
  const tokens = /("(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*')|attr\(\s*([-\w]+)\s*\)|[-\w]+|[()]/gi;
  const parts: string[] = [];
  let depth = 0;

  for (const token of content.matchAll(tokens)) {
    if (token[0] === '(') depth++;
    else if (token[0] === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      if (token[1]) parts.push(cssStringText(token[1]));
      else if (token[2]) parts.push(el?.getAttribute(token[2]) ?? '');
    }
  }

  return parts.length ? parts.join('') : null;
}

/** Collect native and form-associated custom control labels in the current root. */
function addAssociatedLabels(el: Element, labelRoot: Document | ShadowRoot, addLabel: (label: Element) => void): void {
  if (['button', 'input', 'meter', 'output', 'progress', 'select', 'textarea'].includes(el.localName)) {
    // SAFETY: these native labelable elements expose associated labels.
    const labels = (el as HTMLButtonElement).labels;

    for (const label of labels ?? []) addLabel(label);
  }

  const definition = typeof customElements === 'undefined' ? undefined : customElements.get(el.localName);

  if (definition && 'formAssociated' in definition && definition.formAssociated === true) {
    for (const label of labelRoot.querySelectorAll('label[for]')) {
      if (el.id && label.getAttribute('for') === el.id) addLabel(label);
    }

    const ancestor = el.closest('label');

    if (ancestor) addLabel(ancestor);
  }
}

/** Independent, bounded label sources for safety only; never use these for reported labels. */
const dangerTextSource = String((el: Element | null, label?: string): string[] | null => {
  if (label !== undefined) return [label, normalizeDangerText(label)];

  if (!el) return null;

  const sources: string[] = [];
  const descendants = new Set<Element>();
  const visited = new Set<Element>();
  const labelsVisited = new Set<Element>();
  let overflow = false;

  const add = (value: string | null): void => {
    if (!value) return;

    if (value.length > 20000) {
      overflow = true;

      return;
    }

    sources.push(value.replace(/\s+/g, ' ').trim(), normalizeDangerText(value).replace(/\s+/g, ' ').trim());
  };

  const addText = (target: Element | ShadowRoot): void => {
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

  const addGeneratedText = (target: Element): void => {
    if (!('getComputedStyle' in globalThis)) return;

    for (const pseudo of ['::before', '::after']) {
      const content = getComputedStyle(target, pseudo).content ?? '';

      add(cssContentText(content, target));
    }
  };

  const addDescendants = (target: Element | ShadowRoot): void => {
    for (const child of target.querySelectorAll('*')) {
      visit(child);

      if (overflow) return;
    }
  };

  const visit = (target: Element): void => {
    if (visited.has(target) || overflow) return;
    visited.add(target);

    if (visited.size > 200) {
      overflow = true;

      return;
    }

    if (['aria-label', 'title', 'alt', 'aria-labelledby'].some((attr) => target.getAttribute(attr) !== null)) {
      descendants.add(target);

      if (descendants.size > 100) overflow = true;

      for (const attr of ['aria-label', 'title', 'alt']) add(target.getAttribute(attr));
      addReferences(target);
    }

    addGeneratedText(target);

    if (target.shadowRoot) {
      addText(target.shadowRoot);
      addDescendants(target.shadowRoot);
    }
  };

  const addLabel = (target: Element): void => {
    if (labelsVisited.has(target) || overflow) return;
    labelsVisited.add(target);
    addText(target);
    visit(target);
    addDescendants(target);
  };

  add(el.getAttribute('aria-label'));
  const root = el.getRootNode();
  // SAFETY: Document and ShadowRoot are the DOM roots exposing getElementById.
  const labelRoot = 'getElementById' in root ? (root as Document | ShadowRoot) : el.ownerDocument;

  const addReferences = (target: Element): void => {
    for (const id of (target.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean)) {
      const targetRoot = target.getRootNode();
      // SAFETY: only Document and ShadowRoot expose getElementById.
      const referenceRoot = 'getElementById' in targetRoot ? (targetRoot as Document | ShadowRoot) : labelRoot;
      const label = referenceRoot.getElementById(id);

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

  addAssociatedLabels(el, labelRoot, addLabel);

  visit(el);
  addDescendants(el);

  return overflow ? null : sources;
});

export const DANGER_TEXT_SOURCE = `((normalizeDangerText, cssStringText, addAssociatedLabels) => { const cssContentText = ${String(cssContentText)}; return (${dangerTextSource}); })(${String(normalizeDangerText)}, ${String(cssStringText)}, ${String(addAssociatedLabels)})`;

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
