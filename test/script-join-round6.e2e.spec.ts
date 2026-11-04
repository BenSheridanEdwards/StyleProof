import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { transform } from 'esbuild';
import { test, expect } from '@playwright/test';
import { captureStyleMap, trackScriptReach } from '../dist/capture.js';
import { classifyScriptReach } from '../dist/script-join.js';
import { readScriptChanges } from '../dist/script-join-git.js';
import { stampCertifyingFixture } from './certifying-fixture.mjs';
import { overlaySource } from './script-join-round6-fixture.mjs';

for (const rendered of [false, true]) {
  test(`${rendered ? 'opened' : 'unopened'} overlay CSS-template and JSX-text edits use real Chromium execution through git`, async ({
    context,
  }, testInfo) => {
    const root = testInfo.outputPath('repository');
    fs.mkdirSync(root, { recursive: true });
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    git('init', '-q');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@example.test');
    const before = overlaySource(rendered),
      after = before.replace('color: red;', 'color: blue;').replace('Service is down,', 'Service is up,');
    const maps = [],
      dirs = [];
    for (const [i, text] of [before, after].entries()) {
      fs.writeFileSync(path.join(root, 'app.tsx'), text);
      git('add', 'app.tsx');
      git('commit', '-qm', 'fixture');
      const dir = path.join(root, i ? 'head' : 'base');
      fs.mkdirSync(dir);
      dirs.push(dir);
      stampCertifyingFixture(dir, git('rev-parse', 'HEAD'));
      const bundle = await transform(text, {
        loader: 'tsx',
        target: 'es2022',
        sourcefile: 'app.tsx',
        sourcemap: 'external',
        jsxFactory: 'h',
      });
      const page = await context.newPage();
      await page.route('https://overlay.test/**', (route) => {
        const pathname = new URL(route.request().url()).pathname;
        return route.fulfill({
          contentType: pathname === '/' ? 'text/html' : 'application/javascript',
          body:
            pathname === '/app.js'
              ? bundle.code + '\n//# sourceMappingURL=app.js.map'
              : pathname === '/app.js.map'
                ? bundle.map
                : '<body><script src="/app.js"></script></body>',
        });
      });
      const tracker = await trackScriptReach(page, { projectRoot: root, projectRootPrefix: '' });
      try {
        await page.goto('https://overlay.test/');
        maps.push(
          await captureStyleMap(page, {
            captureScriptReach: true,
            scriptReach: tracker,
            captureStates: false,
            stabilize: false,
          }),
        );
      } finally {
        await tracker.dispose();
        await page.close();
      }
    }
    const diff = readScriptChanges(dirs[0], dirs[1], { cwd: root, baseMaps: [maps[0]], headMaps: [maps[1]] });
    expect(diff.gaps).toEqual([]);
    const units = classifyScriptReach([maps[0]], [maps[1]], diff.changes).units;
    expect(units).toHaveLength(4);
    expect(units.map((unit) => unit.status)).toEqual(Array(4).fill(rendered ? 'unknown' : 'never-rendered'));
    expect(units.every((unit) => unit.executionScope === 'preceding-anchor')).toBe(true);
    expect(units.every((unit) => unit.why.includes('preceding-anchor'))).toBe(true);
  });
}
