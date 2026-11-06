import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { transform } from 'esbuild';
import { captureStyleMap, trackScriptReach, trackServedRules, saveStyleMap } from '../dist/capture.js';
import { assessReachDirs } from '../dist/report/reach.js';
import { stampCertifyingFixture } from './certifying-fixture.mjs';

for (const visualChange of [false, true])
  test(`real Git/Chromium nested inline type cannot lower J2, visual change=${visualChange}`, async ({
    context,
  }, testInfo) => {
    const root = testInfo.outputPath('repository');
    fs.mkdirSync(root, { recursive: true });
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    git('init', '-q');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@example.test');
    const sources = [
      "type Ev = { class: 'old'; id: string };\nfunction onPrimary(e: Record<string, Ev>) { document.body.dataset.mode = e.row.class; document.querySelector('main')!.style.color='red'; }\nonPrimary({row:{class:'old',id:'x'}});",
      `function onPrimary(e: Record<string, { class: 'old'; id: string }>) { document.body.dataset.mode = e.row.class; document.querySelector('main')!.style.color='${visualChange ? 'blue' : 'red'}'; }\nonPrimary({row:{class:'old',id:'x'}});`,
    ];
    const dirs = ['base', 'head'].map((side) => path.join(root, 'maps', side));
    for (const [i, source] of sources.entries()) {
      fs.writeFileSync(path.join(root, 'app.ts'), source);
      git('add', 'app.ts');
      git('commit', '-qm', 'fixture');
      const sha = git('rev-parse', 'HEAD');
      const bundle = await transform(source, { loader: 'ts', sourcefile: 'app.ts', sourcemap: 'external' });
      const page = await context.newPage();
      await page.route('https://inline.test/**', (route) => {
        const p = new URL(route.request().url()).pathname;
        return route.fulfill({
          contentType: p === '/' ? 'text/html' : 'application/javascript',
          body:
            p === '/'
              ? '<style>.old{color:red}.steady{color:black}</style><main class="steady">Stable</main><script src="/app.js"></script>'
              : p.endsWith('.map')
                ? bundle.map
                : bundle.code + '\n//# sourceMappingURL=app.js.map',
        });
      });
      const scriptReach = await trackScriptReach(page, { projectRoot: root }),
        servedRules = await trackServedRules(page);
      try {
        await page.goto('https://inline.test/');
        expect(await page.evaluate(() => document.body.dataset.mode)).toBe('old');
        expect(await page.locator('main').evaluate((el) => getComputedStyle(el).color)).toBe(
          i === 1 && visualChange ? 'rgb(0, 0, 255)' : 'rgb(255, 0, 0)',
        );
        const map = await captureStyleMap(page, {
          captureReach: true,
          captureScriptReach: true,
          scriptReach,
          servedRules,
          captureStates: false,
          stabilize: false,
        });
        expect(map.elements.body.cls).not.toContain('old');
        fs.mkdirSync(dirs[i], { recursive: true });
        saveStyleMap(path.join(dirs[i], 'home@1280.json.gz'), map);
        stampCertifyingFixture(dirs[i], sha);
      } finally {
        await scriptReach.dispose();
        await servedRules.dispose();
        await page.close();
      }
    }
    const previous = process.cwd();
    try {
      process.chdir(root);
      const report = assessReachDirs(dirs[0], dirs[1], 'gate')!;
      const head = report.scripts.filter((u) => u.side === 'head');
      expect(head.length).toBeGreaterThan(0);
      fs.writeFileSync(path.join(root, 'reach.json'), JSON.stringify(report, null, 2));
      expect(head.every((u) => u.status !== 'never-rendered')).toBe(true);
      expect(report.classes.every((u) => !u.explicit)).toBe(true);
    } finally {
      process.chdir(previous);
    }
  });
