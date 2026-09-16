/**
 * The ONE destructive-action guard shared by every crawler: a control whose label
 * matches is recorded but never clicked. A plain string, not a RegExp, because the
 * classifiers run inside `page.evaluate` and recompile it in the browser.
 */
export const DANGER_SOURCE =
  '\\b(delete|remove|destroy|logout|log ?out|sign ?out|publish|deploy|pay|purchase|buy|checkout|archive|disconnect|revoke|reset|wipe|drop|rotate|provision|seal|regenerate|renew)\\b';
