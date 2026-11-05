import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { transform } from 'esbuild';
import { captureStyleMap, trackScriptReach, trackServedRules, saveStyleMap } from '../dist/capture.js';
import { readScriptChanges } from '../dist/script-join-git.js';
import { classifyClassReach } from '../dist/class-join.js';
import { assessReachDirs } from '../dist/report/reach.js';
import { stampCertifyingFixture } from './certifying-fixture.mjs';

for (const collision of [false, true])
  test(`real Git/Chromium J3 ${collision ? 'collision stays unknown' : 'unopened constant is never-rendered'}`, async ({
    context,
  }, testInfo) => {
    const root = testInfo.outputPath('repository'),
      project = path.join(root, 'apps/web');
    fs.mkdirSync(project, { recursive: true });
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    git('init', '-q');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@example.test');
    const source = [
      "const OK = 'old';",
      "const FAULT = 'old';",
      `document.querySelector('main').className = ${collision ? 'OK' : "'steady'"};`,
      "if (location.search) { const el = document.createElement('span'); el.className = FAULT; document.body.append(el); }",
    ].join('\n');
    const maps = [],
      dirs = ['base', 'head'].map((side) => path.join(root, 'maps', side));
    for (const [index, side] of ['base', 'head'].entries()) {
      const text = side === 'base' ? source : source.replaceAll("'old'", "'new'");
      fs.writeFileSync(path.join(project, 'app.js'), text);
      git('add', 'apps');
      git('commit', '-qm', 'fixture');
      const sha = git('rev-parse', 'HEAD');
      const bundle = await transform(text, { sourcemap: 'external', sourcefile: 'app.js' });
      const page = await context.newPage();
      await page.route('https://class.test/**', (route) => {
        const name = new URL(route.request().url()).pathname;
        return route.fulfill({
          contentType: name === '/' ? 'text/html' : 'application/javascript',
          body:
            name === '/'
              ? '<style>.old{color:red}.new{color:blue}.steady{color:black}</style><main>Healthy</main><script src="/app.js"></script>'
              : name.endsWith('.map')
                ? bundle.map
                : bundle.code + '\n//# sourceMappingURL=app.js.map',
        });
      });
      const scriptReach = await trackScriptReach(page, { projectRoot: project }),
        servedRules = await trackServedRules(page);
      try {
        await page.goto('https://class.test/');
        const map = await captureStyleMap(page, {
          captureReach: true,
          captureScriptReach: true,
          servedRules,
          scriptReach,
          captureStates: false,
          stabilize: false,
        });
        maps.push(map);
        fs.mkdirSync(dirs[index], { recursive: true });
        saveStyleMap(path.join(dirs[index], 'home@1280.json.gz'), map);
        stampCertifyingFixture(dirs[index], sha);
      } finally {
        await scriptReach.dispose();
        await servedRules.dispose();
        await page.close();
      }
    }
    const diff = readScriptChanges(dirs[0], dirs[1], { cwd: project, baseMaps: [maps[0]], headMaps: [maps[1]] });
    expect(diff.gaps).toEqual([]);
    expect(diff.changes.every((change) => change.sourceKey === 'app.js')).toBe(true);
    const result = classifyClassReach([maps[0]], [maps[1]], diff.changes, [{ base: maps[0], head: maps[1] }]);
    expect(result.gaps).toEqual([]);
    expect(result.units).toHaveLength(4);
    expect(result.units.every((unit) => unit.status === (collision ? 'unknown' : 'never-rendered'))).toBe(true);
    // The report adapter must use capture filenames for surface pairing and captured SHAs for the diff.
    const original = process.cwd();
    try {
      process.chdir(project);
      const report = assessReachDirs(dirs[0], dirs[1], 'gate')!;
      expect(report.classCounts?.[collision ? 'unknown' : 'never-rendered']).toBe(4);
      expect(report.classCounts?.reached).toBe(0);
      expect(report.blocking).toBe(0);
      expect(report.complete).toBe(false);
    } finally {
      process.chdir(original);
    }
  });
