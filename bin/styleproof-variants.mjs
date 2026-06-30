#!/usr/bin/env node
/**
 * Harvest one-step UI state variants from a running app.
 *
 *   styleproof-variants --base-url http://localhost:3000 --route / --route /settings
 */
import fs from 'node:fs';
import { chromium } from '@playwright/test';
import { harvestStyleVariants } from '../dist/variant-crawler.js';
import { defaultLinkKey } from '../dist/crawl.js';
import { isHelpArg, showHelpAndExit, unknownFlagMessage } from '../dist/cli-errors.js';

const HELP = `styleproof-variants — discover one-step UI state variants

usage: styleproof-variants --base-url <url> --route <path-or-key=path> [options]

options:
  --base-url <url>       running app origin, e.g. http://localhost:3000
  --route <route>        route path, absolute URL, or key=path. Repeatable.
  --out <file>           manifest output (default: styleproof.variants.generated.json)
  --max-actions <n>      max attempted actions per route (default: 40)
  --width <px>           viewport width (default: 1280)
  --height <px>          viewport height (default: 800)
  --strict               exit 1 if live-state fixtures or skipped candidates remain
  -h, --help             show this help
`;

const argv = process.argv.slice(2);
let baseUrl = '';
let out = 'styleproof.variants.generated.json';
let maxActions = 40;
let width = 1280;
let height = 800;
let strict = false;
const routeArgs = [];

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (isHelpArg(a)) showHelpAndExit(HELP);
  else if (a === '--base-url') baseUrl = argv[++i];
  else if (a.startsWith('--base-url=')) baseUrl = a.slice(11);
  else if (a === '--route') routeArgs.push(argv[++i]);
  else if (a.startsWith('--route=')) routeArgs.push(a.slice(8));
  else if (a === '--out') out = argv[++i];
  else if (a.startsWith('--out=')) out = a.slice(6);
  else if (a === '--max-actions') maxActions = Number(argv[++i]);
  else if (a.startsWith('--max-actions=')) maxActions = Number(a.slice(14));
  else if (a === '--width') width = Number(argv[++i]);
  else if (a.startsWith('--width=')) width = Number(a.slice(8));
  else if (a === '--height') height = Number(argv[++i]);
  else if (a.startsWith('--height=')) height = Number(a.slice(9));
  else if (a === '--strict') strict = true;
  else if (a.startsWith('--')) {
    console.error(unknownFlagMessage('styleproof-variants', a));
    process.exit(2);
  } else {
    routeArgs.push(a);
  }
}

if (!baseUrl) {
  console.error('styleproof-variants: --base-url is required');
  process.exit(2);
}
if (!routeArgs.length) {
  console.error('styleproof-variants: at least one --route is required');
  process.exit(2);
}
if (![maxActions, width, height].every(Number.isFinite)) {
  console.error('styleproof-variants: --max-actions, --width, and --height must be numbers');
  process.exit(2);
}

function parseRoute(input) {
  const eq = input.indexOf('=');
  if (eq > 0) return { key: input.slice(0, eq), url: input.slice(eq + 1) };
  return { key: defaultLinkKey(new URL(input, baseUrl)), url: input };
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width, height } });
  const harvest = await harvestStyleVariants(page, {
    baseUrl,
    routes: routeArgs.map(parseRoute),
    maxActionsPerRoute: maxActions,
  });
  fs.writeFileSync(out, JSON.stringify(harvest, null, 2) + '\n');
  const variants = harvest.routes.reduce((sum, route) => sum + route.variants.length, 0);
  const liveStates = harvest.routes.reduce((sum, route) => sum + route.liveStates.length, 0);
  const skipped = harvest.routes.reduce((sum, route) => sum + route.skipped.length, 0);
  console.log(`styleproof-variants: wrote ${out}`);
  console.log(`${variants} variant(s), ${liveStates} live-state candidate(s), ${skipped} skipped candidate(s)`);
  if (strict && (liveStates || skipped)) process.exit(1);
} finally {
  await browser.close();
}
