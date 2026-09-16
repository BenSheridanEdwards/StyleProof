#!/usr/bin/env node
// Capture one URL's computed-style map(s) with no spec and no config: a deployed
// page, a static export, or a design mockup. Output has the same shape as a
// surface capture, so styleproof-diff compares it against any other capture.
// Exit 0 = captured, 2 = usage error, 3 = capture failed (see HELP for 4-6).
import { chromium } from '@playwright/test';
import {
  UsageError,
  parseCaptureUrlArgs,
  runCaptureUrl,
  loadSetupSteps,
  loadAuthBoundaryExclude,
  loadIncompleteUiExclude,
} from '../dist/capture-url.js';
import { crawlAndCapture } from '../dist/crawl-surfaces.js';
import { selectCrawlLinks, dedupIdentity, uniqueKeyFor } from '../dist/crawl.js';
import { clearCaptureOutput, writeCaptureManifest } from '../dist/map-store.js';
import { loadStyleProofConfigWithLocation } from '../dist/config.js';
import path from 'node:path';
import fs from 'node:fs';
import { crawlCaptureExitCode } from '../dist/crawl-confidence.js';
import {
  buildConfidenceLedger,
  bundleSurfaceKeys,
  writeConfidenceLedger,
  CONFIDENCE_LEDGER,
} from '../dist/confidence-ledger.js';
import * as report from '../dist/crawl/report.js';
import { errorMessage } from './cli.mjs';

const COMMAND = 'styleproof-capture';

const HELP = `${COMMAND} — capture a page's computed-style map(s) (no Playwright spec)

usage: ${COMMAND} <url> [options]

Honors optional repo-root styleproof.config.json crawl.setup / crawl.authBoundaryExclude /
crawl.incompleteUiExclude
(flag > env > config). Secrets stay in env via \${ENV} placeholders in the setup file.

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
  --auth-boundary-exclude <file>
                    JSON object of auth-boundary keys → non-empty reasons.
                    Acknowledges walls outside certification scope (route path,
                    formAction, redirectTo, or full observation id). Empty
                    reasons are rejected. Does not claim full certification.
  --incomplete-ui-exclude <file>
                    JSON object of blocked surface keys → non-empty reasons.
                    Acknowledges blocked continuations outside certification scope.
                    Empty reasons are rejected; scope remains explicitly limited.
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

exit: 0 captured, 2 usage error, 3 capture failed, 4 coverage gap (--require-full-coverage),
      5 unacknowledged auth boundary, 6 unacknowledged incomplete UI.
      Precedence: coverage 4, incomplete UI 6, auth 5.
styleproof-capture is a compatibility alias for the unified CLI: styleproof crawl
`;

const argv = process.argv.slice(2);
if (argv[0] === '-h' || argv[0] === '--help') {
  process.stdout.write(HELP);
  process.exit(0);
}

// The three crawl input files resolve flag > env (STYLEPROOF_<X> or STYLEPROOF_CRAWL_<X>) >
// styleproof.config crawl.<key>; a config-sourced path resolves from the config dir so head and
// base worktrees agree. The parsed `<key>File` field holds the path, `<key>` the loaded value.
const CRAWL_FILES = [
  ['--setup', 'setup', loadSetupSteps],
  ['--auth-boundary-exclude', 'authBoundaryExclude', loadAuthBoundaryExclude],
  ['--incomplete-ui-exclude', 'incompleteUiExclude', loadIncompleteUiExclude],
];

let opts;
try {
  opts = parseCaptureUrlArgs(argv);
  const loaded = loadStyleProofConfigWithLocation(process.cwd());
  for (const [flag, key, load] of CRAWL_FILES) {
    const envName = flag.slice(2).toUpperCase().replaceAll('-', '_');
    const configured = loaded.config.crawl?.[key];
    const file =
      opts[`${key}File`] ||
      process.env[`STYLEPROOF_${envName}`] ||
      process.env[`STYLEPROOF_CRAWL_${envName}`] ||
      configured;
    if (!file) continue;
    const resolved = path.resolve(file === configured ? loaded.configDir : process.cwd(), file);
    if (!fs.existsSync(resolved)) throw new UsageError(`${flag}: cannot read ${resolved}`);
    opts[`${key}File`] = resolved;
    opts[key] = load(resolved);
  }
} catch (e) {
  if (!(e instanceof UsageError)) throw e;
  console.error(`${COMMAND}: ${e.message}\nNext: run ${COMMAND} --help to see supported options.`);
  process.exit(2);
}

// Read the freshly-loaded page's same-origin nav links, keyed by route.
async function harvestPageLinks(page, url) {
  await page.goto(url, { waitUntil: 'load' });
  const hrefs = await page.$$eval('a[href]', (els) => els.map((e) => e.getAttribute('href'))).catch(() => []);
  return selectCrawlLinks(hrefs, { base: page.url() });
}

// Empty widths = auto-detect the page's real breakpoints. Each worker page gets its OWN context so
// storage resets can't interfere; surfaces stream as they are captured, so an interrupted run still
// shows what it mapped.
const pageCrawlOptions = (browser, url, prefix, statesLeft) => ({
  ...opts,
  url,
  maxStates: statesLeft,
  stopWhenCovered: opts.untilCovered,
  keyPrefix: prefix,
  newPage: async () => (await browser.newContext()).newPage(),
  onSurface: (s, ok) =>
    console.log(`  ${'·'.repeat(s.depth)}${s.key} (${s.elements} elements)${ok ? '' : ' — CAPTURE FAILED'}`),
});

// Enqueue every not-yet-seen page the just-crawled page links to, giving each a
// unique route-key prefix ('base' is reserved for the entry crawl's root).
function enqueueLinkedPages(links, sweep) {
  for (const link of links) {
    const id = dedupIdentity(link.url);
    if (sweep.seenPages.has(id)) continue;
    sweep.seenPages.add(id);
    const prefix = uniqueKeyFor(link.key, sweep.usedPrefixes);
    sweep.queue.push({ url: new URL(link.url, sweep.entry).href, prefix });
  }
}

// The entry page failing is a broken run (rethrow); a LINKED page failing (e.g. an
// off-origin redirect) returns null after warning, and the sweep continues.
async function crawlPage(browser, page, url, prefix, statesLeft) {
  try {
    return await crawlAndCapture(page, pageCrawlOptions(browser, url, prefix, statesLeft));
  } catch (e) {
    if (prefix === '') throw e;
    console.log(`⚠ ${url}: ${errorMessage(e)} — page skipped`);
    return null;
  }
}

// Page-level breadth-first sweep: the entry page's whole interactive surface, then every
// same-origin page its nav links to (and theirs), each namespaced by its route key.
async function sweepPages(browser, page) {
  const entry = new URL(opts.url);
  const sweep = {
    entry,
    queue: [{ url: opts.url, prefix: '' }],
    seenPages: new Set([dedupIdentity(entry.pathname + entry.search)]),
    usedPrefixes: new Set(['base']),
  };
  const reports = [];
  const scopeGaps = [];
  const gap = (prefix, reason) => ({ surface: `page:${prefix}`, reason });
  let statesLeft = opts.maxStates;
  while (sweep.queue.length > 0 && statesLeft > 0) {
    const { url, prefix } = sweep.queue.shift();
    const crawled = await crawlPage(browser, page, url, prefix, statesLeft);
    if (!crawled) {
      scopeGaps.push(gap(prefix, 'linked page was discovered but could not be crawled'));
      continue;
    }
    reports.push(crawled);
    statesLeft -= crawled.surfaces.length;
    if (opts.followLinks) enqueueLinkedPages(await harvestPageLinks(page, url), sweep);
  }
  if (sweep.queue.length > 0) {
    console.log(`⚠ --max-states reached: ${sweep.queue.length} linked page(s) left uncrawled — raise --max-states`);
    const reason = 'linked page was discovered but left uncrawled because --max-states was reached';
    scopeGaps.push(...sweep.queue.map(({ prefix }) => gap(prefix, reason)));
  }
  return { reports, scopeGaps };
}

// Print the verdicts, persist the confidence ledger into the bundle (styleproof-report
// renders it as the completeness badge), and return the exit code.
function reportCrawl(reports, scopeGaps) {
  // A manifest gives a two-directory diff the same-environment guard on both sides.
  writeCaptureManifest({ dir: opts.out, screenshots: opts.screenshots });
  const cov = report.aggregateCoverage(reports);
  const conf = report.aggregateConfidence(reports);
  const incompleteUi = report.aggregateIncompleteUi(reports, opts.incompleteUiExclude);
  const lines = [
    report.crawlSummaryLine(reports, opts),
    ...report.coverageLines(cov, reports.length > 1 ? ` (${reports.length} pages)` : ''),
    ...report.confidenceLines(conf, scopeGaps),
    ...report.incompleteUiLines(incompleteUi),
  ];
  for (const line of lines) console.log(line);
  const capturedKeys = new Set(bundleSurfaceKeys(opts.out));
  writeConfidenceLedger(
    opts.out,
    buildConfidenceLedger({
      capturedKeys,
      coverage: null, // a crawl declares no `expected` registry — basis stays unasserted
      auth: { acknowledged: conf.ack, unacknowledged: conf.unack },
      incompleteUi: incompleteUi.map((entry) => ({ ...entry, surface: `${entry.surface}·incomplete-ui` })),
      captureGaps: report.captureGaps(reports, capturedKeys, scopeGaps),
    }),
  );
  console.log(`  confidence ledger → ${CONFIDENCE_LEDGER}`);
  return crawlCaptureExitCode({
    requireFullCoverage: opts.requireFullCoverage,
    hasCoverageResidue: cov.missing.length > 0 || cov.unreadable.length > 0,
    incompleteUiBlocked: incompleteUi.some((entry) => !entry.acknowledgedReason),
    authBlocked: conf.blocked,
  });
}

async function runCrawl() {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const { reports, scopeGaps } = await sweepPages(browser, page);
    const code = reportCrawl(reports, scopeGaps);
    if (code !== 0) process.exit(code);
  } finally {
    await browser.close();
  }
}

try {
  clearCaptureOutput(opts.out);
  if (opts.crawl) {
    await runCrawl();
    process.exit(0);
  }
  const results = await runCaptureUrl(opts, () => chromium.launch());
  for (const r of results) console.log(`captured ${r.map}${r.screenshot ? ` (+ ${r.screenshot})` : ''}`);
  console.log(`✓ ${results.length} capture(s) → ${opts.out}`);
  process.exit(0);
} catch (e) {
  console.error(`${COMMAND}: capture failed: ${errorMessage(e)}`);
  console.error(
    'Next: check the URL is reachable and run `npx playwright install chromium` if the browser is missing.',
  );
  process.exit(3);
}
