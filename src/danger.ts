/**
 * The ONE destructive-action guard shared by every crawler: a control whose label
 * matches is recorded but never clicked. A plain string, not a RegExp, because the
 * classifiers run inside `page.evaluate` and recompile it in the browser.
 */
// SEP normalises typographic hyphens and non-breaking/zero-width spaces used in real app labels.
const SEP =
  '[\\s\\u00A0\\u202F\\u2000-\\u200F\\u2060\\u2066-\\u2069\\u2043\\u180E\\u034F\\uFEFF\\u00AD\\u2010-\\u2015\\u2212\\uFE58\\uFE63\\uFF0D_-]{0,4}';

export const DANGER_SOURCE = `\\b(delete|remove|destroy|log(?:ging)?${SEP}(?:in|out|on)|sign(?:ing)?${SEP}(?:in|up|out)|publish|deploy|pay(?:ments?)?|purchases?|buy|check${SEP}out|place${SEP}order|archive|disconnect|revoke|reset|wipe|drop|rotate|provision|seal|regenerate|renew|send(?:s|ing)?|submit(?:s|ted|ting)?|sav(?:e[sd]?|ing)|confirm(?:s|ed|ing)?|approv(?:e[sd]?|ing)|invit(?:e[sd]?|ing)|transfer(?:s|red|ring)?|cancel(?:s|led|ed|ling|ing)?|(?:un)?tick(?:s|ed|ing)?|(?:un)?merg(?:e[sd]?|ing)|authori[sz](?:e[sd]?|ing)|re${SEP}start(?:s|ed|ing)?|reboot(?:s|ed|ing)?|recover(?:s|ed|ing)?|re${SEP}stor(?:e[sd]?|ing))\\b`;

/** Independent, bounded label sources for safety only; never use these for reported labels. */
export const DANGER_TEXT_SOURCE = String((el: Element): string[] => {
  const sources: string[] = [];

  const add = (value: string | null): void => {
    if (value) sources.push(value.replace(/\s+/g, ' ').trim().slice(0, 1000));
  };

  add(el.getAttribute('aria-label'));

  for (const id of (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean)) {
    const target = el.ownerDocument.getElementById(id);

    if (target) {
      add(target.textContent);
      add(target.getAttribute('aria-label'));
    }
  }

  add(el.textContent);
  add(el.getAttribute('title'));

  if (el.localName === 'input' || el.localName === 'button') {
    // SAFETY: native input and button elements expose their current value.
    add((el as HTMLInputElement | HTMLButtonElement).value);
  }

  if (el.localName === 'input' && el.getAttribute('type')?.toLowerCase() === 'image') add(el.getAttribute('alt'));
  add(el.getAttribute('name'));

  for (const child of [...(el.querySelectorAll?.('*') ?? [])].slice(0, 20)) {
    for (const attr of ['aria-label', 'title', 'alt']) add(child.getAttribute(attr));
  }

  return sources;
});

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
