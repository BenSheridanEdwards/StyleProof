/**
 * The ONE destructive-action guard, shared by every surface-discovery crawler
 * (the exhaustive surface crawler in `crawl-surfaces.ts` and the one-step variant
 * harvester in `variant-crawler.ts`). Mapping must never mutate: a control whose
 * label matches this pattern is recorded but never clicked.
 *
 * Kept as a plain string (not a `RegExp`) because both crawlers build their
 * candidate list inside `page.evaluate` — the classifier function is serialized
 * into the browser, so it cannot close over a `RegExp` from Node. The source is
 * passed in as an argument and recompiled in the browser; this module is the
 * single source of truth for what "destructive" means.
 */
export const DANGER_SOURCE =
  '\\b(delete|remove|destroy|logout|log ?out|sign ?out|publish|deploy|pay|purchase|buy|checkout|archive|disconnect|revoke|reset|wipe|drop|rotate|provision|seal|regenerate|renew)\\b';
