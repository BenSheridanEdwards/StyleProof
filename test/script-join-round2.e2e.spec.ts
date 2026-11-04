import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { transform } from 'esbuild';
import { captureStyleMap, trackScriptReach } from '../dist/capture.js';
import { classifyScriptReach } from '../dist/script-join.js';
import { sha256 } from '../dist/node-util.js';
import { resolveSettings } from '../dist/runner/settings.js';
import { captureSurface } from '../dist/runner/surface-capture.js';

test('Chromium cheap maps retain an unanchored ternary branch for whole-line and token changes', async ({ page }) => {
  const text = "const label = window.fault ? 'red' : 'blue'; window.result = label;";
  const bundle = await transform(text, { sourcemap: 'external', sourcefile: 'app.js' });
  const map = { ...JSON.parse(bundle.map), mappings: 'AAAA' };
  await page.route('https://coarse.test/**', (route) => {
    const pathname = new URL(route.request().url()).pathname;
    return route.fulfill({
      body:
        pathname === '/app.js'
          ? bundle.code + '\n//# sourceMappingURL=app.js.map'
          : pathname === '/app.js.map'
            ? JSON.stringify(map)
            : '<script src="/app.js"></script>',
      contentType: pathname === '/' ? 'text/html' : 'application/javascript',
    });
  });
  const tracker = await trackScriptReach(page);
  try {
    await page.goto('https://coarse.test/');
    const captured = await captureStyleMap(page, {
      captureScriptReach: true,
      scriptReach: tracker,
      captureStates: false,
      stabilize: false,
    });
    const start = text.indexOf("'red'");
    const changes = [
      [0, text.length],
      [start, start + 5],
    ].map(([from, to]) => ({
      sourceKey: 'app.js',
      side: 'head' as const,
      range: { start: { line: 1, column: from }, end: { line: 1, column: to } },
      contentHash: sha256(text),
      text,
    }));
    expect(
      classifyScriptReach([captured], [captured], changes).units.map((unit) => [
        unit.execution,
        unit.status,
        unit.executionScope,
      ]),
    ).toEqual([
      ['partly-ran', 'never-rendered', 'line'],
      ['partly-ran', 'never-rendered', 'line'],
    ]);
  } finally {
    await tracker.dispose();
  }
});

test('one runner resolves provenance once across surfaces and their self-check pages', async ({ page }, testInfo) => {
  const root = testInfo.outputPath("repository's root");
  fs.mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  const realGit = process.env
    .PATH!.split(path.delimiter)
    .map((dir) => path.join(dir, 'git'))
    .find((file) => fs.existsSync(file))!;
  const bin = path.join(root, 'tools');
  fs.mkdirSync(bin);
  const log = path.join(root, 'calls.jsonl');
  const shellQuote = (value: string) => "'" + value.replaceAll("'", `'"'"'`) + "'";
  fs.writeFileSync(
    path.join(bin, 'git'),
    ['#!/bin/sh', String.raw`printf '%s\n' "$*" >> ${shellQuote(log)}`, `exec ${shellQuote(realGit)} "$@"`].join('\n'),
    { mode: 0o755 },
  );
  const previous = process.env.PATH;
  process.env.PATH = bin + path.delimiter + previous;
  try {
    await page.route('https://root.test/', (route) =>
      route.fulfill({ body: '<body>healthy</body>', contentType: 'text/html' }),
    );
    const settings = resolveSettings(
      {
        dir: path.join(root, 'maps'),
        captureScriptReach: true,
        selfCheck: true,
        screenshots: false,
        freezeClock: false,
      },
      root,
    );
    for (const key of ['first', 'second'])
      await captureSurface(
        page,
        {
          key,
          go: async () => {
            await page.goto('https://root.test/');
          },
        },
        800,
        settings,
        { index: 1, total: 1 },
      );
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n');
    expect(calls.filter((args) => args === 'rev-parse --show-toplevel')).toHaveLength(1);
  } finally {
    process.env.PATH = previous;
  }
});
