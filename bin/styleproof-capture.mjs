#!/usr/bin/env node
/**
 * Capture a single URL's computed-style map — one shot, no spec, no config.
 *
 *   styleproof-capture <url> [options]
 *
 * For a page you just want to point at: a deployed URL, a static export, or a
 * standalone HTML mockup. Writes `<key>@<width>.json.gz` (+ `.png`) into --out,
 * the same shape a surface capture writes, so `styleproof-diff <a> <b>` compares
 * it against any other capture. Capture a design mockup once, then diff each
 * build against it to measure how close the implementation is.
 *
 * (Use styleproof-map — the spec-driven flow — for your own app's surfaces, where
 * you also want the coverage guard, the map store, and record/replay.)
 *
 * Exit code 0 = captured, 2 = usage error, 3 = capture failed (e.g. browser
 * missing, page unreachable, cross-origin CSS with no explicit --widths).
 */
import { chromium } from '@playwright/test';
import { isHelpArg, showHelpAndExit } from '../dist/cli-errors.js';
import { UsageError, parseCaptureUrlArgs, runCaptureUrl, loadSetupSteps } from '../dist/capture-url.js';
import { crawlAndCapture } from '../dist/crawl-surfaces.js';
import { selectCrawlLinks, dedupIdentity } from '../dist/crawl.js';
import { writeCaptureManifest } from '../dist/map-store.js';

const COMMAND = 'styleproof-capture';

const HELP = `${COMMAND} — capture a page's computed-style map(s) (no spec, no config)

usage: ${COMMAND} <url> [options]

one state (default): capture the page as it loads
  --key <name>      capture file prefix, <key>@<width>.json.gz (default: page)
  --wait <selector> wait for this selector to be visible before capturing
  --widths <csv>    viewport widths, e.g. 1440,1024,768. Omit to detect the
                    page's own @media breakpoints (fails on cross-origin CSS —
                    pass widths for those). The crawl auto-detects too.

whole surface: --crawl
  --crawl           EXHAUSTIVE: drive every non-destructive control, recurse into
                    what opens, and capture every discovered surface under a derived
                    key — runs to natural termination, no budget. For a design that's
                    mostly modals/drawers/popovers. Destructive-looking controls
                    (delete/deploy/pay/revoke…) are never clicked.
  --require-full-coverage
                    exit 4 unless every class the page's stylesheets define was
                    rendered in a captured surface — the machine check that
                    NOTHING in the design was missed (coverage is always printed).
                    An unreadable cross-origin sheet is residue too: its vocabulary
                    can't be proven covered, so it also fails the check.
  --setup <file>    JSON steps (goto/fill/click/waitFor) run after EVERY fresh
                    navigation — how input-gated states (login, unlock) become
                    crawlable. \${ENV_VAR} in value/url is read from the
                    environment, so secrets never live in the file or the maps.
  --no-data-states  skip the automatic loading/error captures of the entry page
                    (on by default: data requests stalled → loading skeleton;
                    fulfilled with 500 → error render)
  --workers <n>     concurrent sweep workers (default 4); same surface set as a
                    serial crawl — pass 1 for byte-stable key attribution
  --no-follow-links crawl the entry page's interactive surface only. By default
                    every same-origin page the nav links to is crawled too,
                    each keyed by its route (about, pricing, blog-post, ...)
  --until-covered   stop the crawl early the moment every stylesheet class has
                    been rendered — a coverage-oriented sweep for design mockups
  --max-depth <n>   throttle recursion depth (default: 16 — backstop for
                    append-generator UIs)
  --max-actions <n> throttle controls tried per state (default: unbounded)
  --max-states <n>  throttle total surfaces (default: unbounded)
  --no-reset-storage  don't clear localStorage between steps (default: clear)

common:
  --out <dir>       output directory (default: styleproof-capture)
  --ignore <sel>    skip a nondeterministic region (repeatable)
  --height <px>     viewport height (default: 800)
  --no-screenshots  write lean .json.gz maps only (screenshots on by default)
  -h, --help        show this help

Then diff against another capture — zero diff = pixel-identical:
  ${COMMAND} https://example.com --crawl --out design
  styleproof-diff design .styleproof/maps/current

exit: 0 captured, 2 usage error, 3 capture failed, 4 coverage gap (--require-full-coverage).
`;

const argv = process.argv.slice(2);
if (isHelpArg(argv[0])) showHelpAndExit(HELP);

let opts;
let setupSteps;
try {
  opts = parseCaptureUrlArgs(argv);
  setupSteps = opts.setupFile ? loadSetupSteps(opts.setupFile) : undefined;
  opts.setup = setupSteps; // one-shot capture honours setup steps too
} catch (e) {
  if (e instanceof UsageError) {
    console.error(`${COMMAND}: ${e.message}\nNext: run ${COMMAND} --help to see supported options.`);
    process.exit(2);
  }
  throw e;
}

// Read the freshly-loaded page's same-origin nav links, keyed by route.
async function harvestPageLinks(page, url) {
  await page.goto(url, { waitUntil: 'load' });
  const hrefs = await page.$$eval('a[href]', (els) => els.map((e) => e.getAttribute('href'))).catch(() => []);
  return selectCrawlLinks(hrefs, { base: page.url() });
}

function printCoverage(cov, label) {
  const unreadable = cov.unreadable ?? [];
  if (unreadable.length > 0) {
    console.log(
      `⚠ coverage${label}: ${unreadable.length} stylesheet(s) unreadable — class coverage not provable against them ` +
        `(cross-origin, no CORS; make them same-origin / CORS-readable, or pin --widths):\n    ${unreadable.join(' ')}`,
    );
  }
  if (cov.missing.length === 0) {
    if (unreadable.length === 0)
      console.log(
        `✓ coverage${label}: all ${cov.defined} stylesheet classes rendered in at least one captured surface`,
      );
  } else {
    console.log(
      `⚠ coverage${label}: ${cov.rendered}/${cov.defined} stylesheet classes rendered — ${cov.missing.length} never seen ` +
        `(dead CSS, or a state the crawl could not reach):\n    ${cov.missing.join(' ')}`,
    );
  }
}

function pageCrawlOptions(browser, url, prefix, statesLeft) {
  return {
    url,
    out: opts.out,
    widths: opts.widths, // empty = auto-detect the page's real breakpoints
    ignore: opts.ignore,
    height: opts.height,
    screenshots: opts.screenshots,
    waitSelector: opts.waitSelector,
    maxDepth: opts.maxDepth,
    maxActionsPerState: opts.maxActionsPerState,
    maxStates: statesLeft,
    resetStorage: opts.resetStorage,
    setup: setupSteps,
    dataStates: opts.dataStates,
    stopWhenCovered: opts.untilCovered,
    workers: opts.workers,
    keyPrefix: prefix,
    // each worker page in its OWN context, so storage resets can't interfere
    newPage: async () => (await browser.newContext()).newPage(),
    // Stream each surface as it is captured, so progress is visible live and an
    // interrupted run still shows exactly what it mapped.
    onSurface: (s, ok) =>
      console.log(`  ${'·'.repeat(s.depth)}${s.key} (${s.elements} elements)${ok ? '' : ' — CAPTURE FAILED'}`),
  };
}

// Aggregate coverage: pages share stylesheets, so a class unrendered on one
// page but rendered on another IS covered. defined = rendered ∪ missing.
function aggregateCoverage(reports) {
  const rendered = new Set(reports.flatMap((r) => r.coverage.renderedClasses));
  const missing = [...new Set(reports.flatMap((r) => r.coverage.missing))].filter((c) => !rendered.has(c)).sort();
  const unreadable = [...new Set(reports.flatMap((r) => r.coverage.unreadable ?? []))];
  return { defined: rendered.size + missing.length, rendered: rendered.size, missing, unreadable };
}

function printCrawlSummary(reports) {
  const surfaces = reports.reduce((n, r) => n + r.surfaces.length, 0);
  const captured = reports.reduce((n, r) => n + r.captured, 0);
  const tried = reports.reduce((n, r) => n + r.actionsTried, 0);
  const skipped = reports.reduce((n, r) => n + r.skipped, 0);
  const failed = reports.flatMap((r) => r.failed);
  const widths = opts.widths.length ? `${opts.widths.length} width(s)` : 'auto widths';
  console.log(
    `✓ ${captured}/${surfaces} surface(s) across ${reports.length} page(s) × ${widths} → ${opts.out}  ` +
      `(${tried} actions tried, ${skipped} skipped${failed.length ? `, ${failed.length} capture-failed` : ''})`,
  );
}

// Enqueue every not-yet-seen page the just-crawled page links to, giving each a
// unique route-key prefix ('base' is reserved for the entry crawl's root).
function enqueueLinkedPages(links, sweep) {
  for (const link of links) {
    const id = dedupIdentity(link.url);
    if (sweep.seenPages.has(id)) continue;
    sweep.seenPages.add(id);
    let prefix = link.key;
    for (let i = 2; sweep.usedPrefixes.has(prefix); i++) prefix = `${link.key}-${i}`;
    sweep.usedPrefixes.add(prefix);
    sweep.queue.push({ url: new URL(link.url, sweep.entry).href, prefix });
  }
}

// Crawl one page of the sweep. The entry page failing is a broken run (rethrow);
// a LINKED page failing (e.g. an off-origin redirect) returns null after warning,
// and the sweep continues.
async function crawlPage(browser, page, url, prefix, statesLeft) {
  try {
    return await crawlAndCapture(page, pageCrawlOptions(browser, url, prefix, statesLeft));
  } catch (e) {
    if (prefix === '') throw e;
    console.log(`⚠ ${url}: ${e instanceof Error ? e.message : String(e)} — page skipped`);
    return null;
  }
}

async function runCrawl() {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    // Page-level breadth-first sweep: crawl the entry page's whole interactive
    // surface, then every same-origin page its nav links to (and theirs), each
    // namespaced by its route key so a shared --out directory never collides.
    const entry = new URL(opts.url);
    const sweep = {
      entry,
      queue: [{ url: opts.url, prefix: '' }],
      seenPages: new Set([dedupIdentity(entry.pathname + entry.search)]),
      usedPrefixes: new Set(['base']), // 'base' is the entry crawl's root key
    };
    const reports = [];
    let statesLeft = opts.maxStates;

    while (sweep.queue.length > 0 && statesLeft > 0) {
      const { url, prefix } = sweep.queue.shift();
      const report = await crawlPage(browser, page, url, prefix, statesLeft);
      if (!report) continue; // linked page skipped loudly (e.g. off-origin redirect)
      reports.push(report);
      statesLeft -= report.surfaces.length;
      if (opts.followLinks) enqueueLinkedPages(await harvestPageLinks(page, url), sweep);
    }
    if (sweep.queue.length > 0)
      console.log(`⚠ --max-states reached: ${sweep.queue.length} linked page(s) left uncrawled — raise --max-states`);

    // Stamp a manifest so a two-directory diff against this crawl output has the
    // same-environment guard on both sides (v4 refuses a manifest-less side).
    writeCaptureManifest({ dir: opts.out, screenshots: opts.screenshots });
    printCrawlSummary(reports);
    const cov = aggregateCoverage(reports);
    printCoverage(cov, reports.length > 1 ? ` (${reports.length} pages)` : '');
    // Residue under --require-full-coverage → exit 4: a never-seen class OR an
    // unreadable sheet (whose vocabulary can't be proven covered at all).
    if (opts.requireFullCoverage && (cov.missing.length > 0 || cov.unreadable.length > 0)) process.exit(4);
  } finally {
    await browser.close();
  }
}

try {
  if (opts.crawl) {
    await runCrawl();
    process.exit(0);
  }
  const results = await runCaptureUrl(opts, () => chromium.launch());
  for (const r of results) console.log(`captured ${r.map}${r.screenshot ? ` (+ ${r.screenshot})` : ''}`);
  console.log(`✓ ${results.length} capture(s) → ${opts.out}`);
  process.exit(0);
} catch (e) {
  console.error(`${COMMAND}: capture failed: ${e instanceof Error ? e.message : String(e)}`);
  console.error(
    'Next: check the URL is reachable and run `npx playwright install chromium` if the browser is missing.',
  );
  process.exit(3);
}
