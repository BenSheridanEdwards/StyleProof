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
import { UsageError, parseCaptureUrlArgs, runCaptureUrl } from '../dist/capture-url.js';

const COMMAND = 'styleproof-capture';

const HELP = `${COMMAND} — capture a single URL's computed-style map (one shot, no spec)

usage: ${COMMAND} <url> [options]

options:
  --key <name>      capture file prefix, <key>@<width>.json.gz (default: page)
  --widths <csv>    viewport widths to sweep, e.g. 1440,1024,768. Omit to detect
                    the page's own @media breakpoints (fails loudly on a
                    cross-origin/unreadable stylesheet — pass widths for those)
  --out <dir>       output directory (default: styleproof-capture)
  --wait <selector> wait for this selector to be visible before capturing
  --ignore <sel>    skip a nondeterministic region (repeatable)
  --height <px>     viewport height (default: 800)
  --no-screenshots  write lean .json.gz maps only (screenshots on by default)
  -h, --help        show this help

Then diff it against another capture:
  ${COMMAND} https://example.com/pricing --key pricing --widths 1440,768 --out design
  styleproof-diff design .styleproof/maps/current

exit: 0 captured, 2 usage error, 3 capture failed.
`;

const argv = process.argv.slice(2);
if (isHelpArg(argv[0])) showHelpAndExit(HELP);

let opts;
try {
  opts = parseCaptureUrlArgs(argv);
} catch (e) {
  if (e instanceof UsageError) {
    console.error(`${COMMAND}: ${e.message}\nNext: run ${COMMAND} --help to see supported options.`);
    process.exit(2);
  }
  throw e;
}

try {
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
