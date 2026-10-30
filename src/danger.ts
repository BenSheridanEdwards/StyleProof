/**
 * The ONE destructive-action guard shared by every crawler: a control whose label
 * matches is recorded but never clicked. A plain string, not a RegExp, because the
 * classifiers run inside `page.evaluate` and recompile it in the browser.
 */
export const DANGER_SOURCE =
  '\\b(delete|remove|destroy|logout|log ?out|sign ?out|publish|deploy|pay(?:ments?)?|purchases?|buy|check ?out|place ?order|archive|disconnect|revoke|reset|wipe|drop|rotate|provision|seal|regenerate|renew|send(?:s|ing)?|submit(?:s|ted|ting)?|sav(?:e[sd]?|ing)|confirm(?:s|ed|ing)?|approv(?:e[sd]?|ing)|invit(?:e[sd]?|ing)|transfer(?:s|red|ring)?|cancel(?:s|led|ed|ling|ing)?)\\b';

export const SUBMITS_FORM_SOURCE = String((el: Element): boolean => {
  const submits = (control: Element | null | undefined): boolean => {
    // SAFETY: discovery supplies the serialized predicate; DOM selectors restrict control types.
    const c = control as HTMLButtonElement | HTMLInputElement | null | undefined;

    return Boolean(
      c?.form && (c.tagName === 'BUTTON' || c.tagName === 'INPUT') && (c.type === 'submit' || c.type === 'image'),
    );
  };

  // SAFETY: selectors restrict descendants to controls or labels with a DOM control property.
  return (
    submits(el.closest?.('button,input')) ||
    submits((el.closest?.('label') as HTMLLabelElement | null)?.control) ||
    [...(el.querySelectorAll?.('button,input,label') ?? [])].some((c) =>
      submits(c.tagName === 'LABEL' ? (c as HTMLLabelElement).control : c),
    )
  );
});
