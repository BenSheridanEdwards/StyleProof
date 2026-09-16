#!/usr/bin/env node
// Harvest one-step UI state variants from a running app and write a manifest.
import fs from 'node:fs';
import { chromium } from '@playwright/test';
import { harvestStyleVariants } from '../dist/variant-crawler.js';
import { defaultLinkKey } from '../dist/crawl.js';
import { defineCli, number } from './cli.mjs';

const NAME = 'styleproof-variants';
const cli = defineCli({
  name: NAME,
  alias: 'variants',
  usage: [`${NAME} --base-url <url> --route <path-or-key=path> [options]`],
  positionals: true,
  flags: {
    'base-url': { value: 'url', help: 'running app origin, e.g. http://localhost:3000', required: true },
    route: { value: 'route', help: 'route path, absolute URL, or key=path.', repeat: true },
    out: { value: 'file', help: 'manifest output', default: 'styleproof.variants.generated.json' },
    'max-actions': { value: 'n', help: 'max attempted actions per route', default: 40 },
    'max-state-actions': { value: 'n', help: 'max attempted hover/focus candidates per route', default: 40 },
    width: { value: 'px', help: 'viewport width', default: 1280 },
    height: { value: 'px', help: 'viewport height', default: 800 },
    strict: { help: 'exit 1 if live-state fixtures or skipped candidates remain' },
  },
});

const { opts, args } = cli.parse();
const routes = [...opts.route, ...args];
if (!routes.length) {
  console.error(`${NAME}: at least one --route is required`);
  process.exit(2);
}
const limit = (flag) => number(NAME, flag, opts[flag], { integer: true, min: 0, max: 200 });
const maxActionsPerRoute = limit('max-actions');
const maxStateActionsPerRoute = limit('max-state-actions');
const viewport = { width: number(NAME, 'width', opts.width), height: number(NAME, 'height', opts.height) };
const baseUrl = opts['base-url'];

function parseRoute(input) {
  const eq = input.indexOf('=');
  if (eq > 0) return { key: input.slice(0, eq), url: input.slice(eq + 1) };
  return { key: defaultLinkKey(new URL(input, baseUrl)), url: input };
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport });
  const harvest = await harvestStyleVariants(page, {
    baseUrl,
    routes: routes.map(parseRoute),
    maxActionsPerRoute,
    maxStateActionsPerRoute,
  });
  fs.writeFileSync(opts.out, JSON.stringify(harvest, null, 2) + '\n');
  const sum = (pick) => harvest.routes.reduce((total, route) => total + pick(route).length, 0);
  const variants = sum((route) => route.variants);
  const liveStates = sum((route) => route.liveStates);
  const skipped = sum((route) => route.skipped);
  const outcomes = harvest.routes.flatMap((route) => route.stateCoverage);
  const unresolved = outcomes.filter((entry) =>
    ['skipped', 'timed-out', 'requires-fixture'].includes(entry.outcome),
  ).length;
  console.log(`${NAME}: wrote ${opts.out}`);
  console.log(`${variants} variant(s), ${liveStates} live-state candidate(s), ${skipped} skipped candidate(s)`);
  console.log(
    `state coverage: ${['captured', 'deduplicated', 'skipped', 'timed-out', 'requires-fixture']
      .map((outcome) => `${outcomes.filter((entry) => entry.outcome === outcome).length} ${outcome}`)
      .join(', ')}`,
  );
  if (opts.strict && (liveStates || skipped || unresolved)) process.exit(1);
} finally {
  await browser.close();
}
