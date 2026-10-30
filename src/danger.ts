/**
 * The ONE destructive-action guard shared by every crawler: a control whose label
 * matches is recorded but never clicked. A plain string, not a RegExp, because the
 * classifiers run inside `page.evaluate` and recompile it in the browser.
 */
export const DANGER_SOURCE =
  '\\b(delete|remove|destroy|logout|log ?out|sign ?out|publish|deploy|pay(?:ments?)?|purchases?|buy|check ?out|place ?order|archive|disconnect|revoke|reset|wipe|drop|rotate|provision|seal|regenerate|renew|send(?:s|ing)?|submit(?:s|ted|ting)?|sav(?:e[sd]?|ing)|confirm(?:s|ed|ing)?|approv(?:e[sd]?|ing)|invit(?:e[sd]?|ing)|transfer(?:s|red|ring)?|cancel(?:s|led|ed|ling|ing)?)\\b';
