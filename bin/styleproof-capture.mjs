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
                    NOTHING in the design was missed (coverage is always printed)
  --setup <file>    JSON steps (goto/fill/click/waitFor) run after EVERY fresh
                    navigation — how input-gated states (login, unlock) become
                    crawlable. \${ENV_VAR} in value/url is read from the
                    environment, so secrets never live in the file or the maps.
  --no-data-states  skip the automatic loading/error captures of the entry page
                    (on by default: data requests stalled → loading skeleton;
                    fulfilled with 500 → error render)
  --max-depth <n>   throttle recursion depth (default: unbounded)
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

async function runCrawl() {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const crawlOpts = {
      url: opts.url,
      out: opts.out,
      widths: opts.widths, // empty = auto-detect the page's real breakpoints
      ignore: opts.ignore,
      height: opts.height,
      screenshots: opts.screenshots,
      waitSelector: opts.waitSelector,
      maxDepth: opts.maxDepth,
      maxActionsPerState: opts.maxActionsPerState,
      maxStates: opts.maxStates,
      resetStorage: opts.resetStorage,
      setup: setupSteps,
      dataStates: opts.dataStates,
      // Stream each surface as it is captured, so progress is visible live and an
      // interrupted run still shows exactly what it mapped.
      onSurface: (s, ok) =>
        console.log(`  ${'·'.repeat(s.depth)}${s.key} (${s.elements} elements)${ok ? '' : ' — CAPTURE FAILED'}`),
    };
    const report = await crawlAndCapture(page, crawlOpts);
    console.log(
      `✓ ${report.captured}/${report.surfaces.length} surface(s) × ${crawlOpts.widths.length} width(s) → ${opts.out}  ` +
        `(${report.actionsTried} actions tried, ${report.skipped} skipped${report.failed.length ? `, ${report.failed.length} capture-failed` : ''})`,
    );
    const cov = report.coverage;
    if (cov.missing.length === 0) {
      console.log(`✓ coverage: all ${cov.defined} stylesheet classes rendered in at least one captured surface`);
    } else {
      console.log(
        `⚠ coverage: ${cov.rendered}/${cov.defined} stylesheet classes rendered — ${cov.missing.length} never seen ` +
          `(dead CSS, or a state the crawl could not reach):\n    ${cov.missing.join(' ')}`,
      );
      if (opts.requireFullCoverage) process.exit(4);
    }
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
