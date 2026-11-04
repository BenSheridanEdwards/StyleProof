import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { test, expect } from '@playwright/test';
import { captureStyleMap, trackScriptReach } from '../dist/capture.js';
import { classifyScriptReach } from '../dist/script-join.js';
import { changedScriptRanges } from '../dist/script-join-git.js';

for (const kind of ['readable', 'missing', 'empty-app']) {
  const readable = kind === 'readable';
  test(`a code-split vendor chunk with a ${kind} map ${readable ? 'avoids' : 'retains'} a J2 gap`, async ({
    context,
  }, testInfo) => {
    const root = testInfo.outputPath('project');
    const vendor = path.join(root, 'node_modules', 'fixture-vendor');
    fs.mkdirSync(vendor, { recursive: true });
    fs.writeFileSync(
      path.join(vendor, 'package.json'),
      JSON.stringify({ name: 'fixture-vendor', type: 'module', exports: './index.js' }),
    );
    fs.writeFileSync(path.join(vendor, 'index.js'), 'export const vendor = Math.random();');
    fs.writeFileSync(path.join(root, 'lazy.js'), 'import { vendor } from "fixture-vendor"; window.lazy = vendor;');
    const before = 'import { vendor } from "fixture-vendor"; window.result = vendor + 1;',
      after = before.replace('+ 1', '+ 2');
    const maps = [];
    for (const text of [before, after]) {
      fs.writeFileSync(path.join(root, 'app.js'), text);
      const bundle = await build({
        absWorkingDir: root,
        entryPoints: ['app.js', 'lazy.js'],
        outdir: 'assets',
        bundle: true,
        splitting: true,
        format: 'esm',
        sourcemap: 'external',
        write: false,
      });
      const assets = new Map(
        bundle.outputFiles.map((file) => ['/' + path.relative(root, file.path).replaceAll('\\', '/'), file.text]),
      );
      const page = await context.newPage();
      await page.route('https://split.test/**', (route) => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname === '/')
          return route.fulfill({
            contentType: 'text/html',
            body: '<body><script type="module" src="/assets/app.js"></script></body>',
          });
        const body = assets.get(pathname);
        if (!body || (kind === 'missing' && /\/chunk-.*\.js\.map$/.test(pathname)))
          return route.fulfill({ status: 404, body: '' });
        const content =
          kind === 'empty-app' && /\/chunk-.*\.js\.map$/.test(pathname)
            ? JSON.stringify({
                version: 3,
                sources: ['../unmapped-app.js'],
                sourcesContent: ['const absent = 1;'],
                mappings: '',
              })
            : body;
        return route.fulfill({
          contentType: 'application/javascript',
          body: content + (pathname.endsWith('.js') ? `\n//# sourceMappingURL=${path.basename(pathname)}.map` : ''),
        });
      });
      const tracker = await trackScriptReach(page, { projectRoot: root, projectRootPrefix: '' });
      try {
        await page.goto('https://split.test/');
        const map = await captureStyleMap(page, {
          captureScriptReach: true,
          scriptReach: tracker,
          captureStates: false,
          stabilize: false,
        });
        const chunk = map.scriptReach?.scripts.find((script) => /\/chunk-/.test(script.url));
        expect(chunk).toBeDefined();
        if (readable) {
          expect(chunk?.reason).toBe('no mapped app sources');
          expect(chunk).toHaveProperty('nonAppSourcesOnly', true);
        } else {
          expect(chunk?.status).toBe(kind === 'missing' ? 'unknown' : 'unmeasured');
          expect(chunk).not.toHaveProperty('nonAppSourcesOnly');
        }
        maps.push(map);
      } finally {
        await tracker.dispose();
        await page.close();
      }
    }
    const changes = changedScriptRanges(
      `@@ -1 +1 @@\n-${before}\n+${after}\n`,
      { base: before, head: after },
      'app.js',
    );
    const result = classifyScriptReach([maps[0]], [maps[1]], changes);
    expect(result.gaps).toHaveLength(readable ? 0 : 2);
    expect(result.units.map((unit) => unit.status)).toEqual(['unknown', 'unknown']);
    fs.writeFileSync(
      testInfo.outputPath('script-evidence.json'),
      JSON.stringify({ base: maps[0].scriptReach, head: maps[1].scriptReach, join: result }, null, 2),
    );
  });
}
