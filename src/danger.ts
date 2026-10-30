/**
 * The ONE destructive-action guard shared by every crawler: a control whose label
 * matches is recorded but never clicked. A plain string, not a RegExp, because the
 * classifiers run inside `page.evaluate` and recompile it in the browser.
 */
export const DANGER_SOURCE =
  '\\b(delete|remove|destroy|logout|log ?out|sign ?out|publish|deploy|pay(?:ments?)?|purchases?|buy|check ?out|place ?order|archive|disconnect|revoke|reset|wipe|drop|rotate|provision|seal|regenerate|renew|send(?:s|ing)?|submit(?:s|ted|ting)?|sav(?:e[sd]?|ing)|confirm(?:s|ed|ing)?|approv(?:e[sd]?|ing)|invit(?:e[sd]?|ing)|transfer(?:s|red|ring)?|cancel(?:s|led|ed|ling|ing)?)\\b';

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
