import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { transform } from 'esbuild';
import { captureStyleMap, trackScriptReach } from '../dist/capture.js';
import { classifyScriptReach } from '../dist/script-join.js';
import { changedScriptRanges } from '../dist/script-join-git.js';

for (const [name, expression, from, to, execution, status] of [
  ['evaluated nullish operand', 'a ?? b', 'a ?? b', 'c ?? b', 'ran', 'unknown'],
  ['selected ternary arm', 'a ? a : b', '? a', '? c', 'ran', 'unknown'],
  ['selected ternary alternative', 'window.input ? b : a', ': a', ': c', 'ran', 'unknown'],
  // Its generated extent includes an executed continuation without a mapping start.
  ['unopened nullish fallback', 'a ?? b', '?? b', '?? c', 'partly-ran', 'never-rendered'],
] as const) {
  test(`J2 judges the ${name} from real source-mapped Chromium evidence`, async ({ context }, testInfo) => {
    const repository = testInfo.outputPath('repository');
    const projectRoot = path.join(repository, 'packages/app');
    fs.mkdirSync(projectRoot, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repository });
    const base = `var a = window.input ?? 1, c = a, b = 9; window.result = ${expression};`;
    const texts = { base, head: base.replace(from, to) };
    const captures = [];

    for (const side of ['base', 'head'] as const) {
      const bundle = await transform(texts[side], { sourcemap: 'external', sourcefile: 'app.js' });
      const page = await context.newPage();
      await page.route('https://join.test/**', (route) => {
        const pathname = new URL(route.request().url()).pathname;

        return route.fulfill({
          body:
            pathname === '/app.js'
              ? bundle.code + '\n//# sourceMappingURL=app.js.map'
              : pathname === '/app.js.map'
                ? bundle.map
                : '<script src="/app.js"></script>',
          contentType: pathname === '/' ? 'text/html' : 'application/javascript',
        });
      });
      const scriptReach = await trackScriptReach(page, { projectRoot });

      try {
        await page.goto('https://join.test/');
        captures.push(
          await captureStyleMap(page, {
            captureScriptReach: true,
            scriptReach,
            captureStates: false,
            stabilize: false,
          }),
        );
      } finally {
        await scriptReach.dispose();
        await page.close();
      }
    }

    expect(captures.map((capture) => capture.scriptReach?.projectRootPrefix)).toEqual(['packages/app', 'packages/app']);
    const changes = changedScriptRanges(`@@ -1 +1 @@\n-${texts.base}\n+${texts.head}\n`, texts, 'app.js');
    const result = classifyScriptReach([captures[0]], [captures[1]], changes);
    expect(result.units.map((unit) => [unit.side, unit.execution, unit.status])).toEqual([
      ['base', execution, status],
      ['head', execution, status],
    ]);
  });
}
