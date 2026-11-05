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
import { residualCases, tokenCases, tokenDefines } from './script-join-round8-fixture.mjs';
import { generateStyleMapReport } from '../dist/report.js';
import { writeCapture } from './helpers.mjs';

const scenarios = [
  ...tokenCases
    .filter((entry) => entry.template)
    .map(({ name, before, after, foldedAlways }) => ({
      name: name + ' retains idle substitution evidence without minification',
      before,
      after,
      minifySyntax: false,
      expected: foldedAlways ? 'unmeasured' : 'never-rendered',
      idle: !foldedAlways,
      count: 2,
    })),
  ...[false, true].map((minifySyntax) => ({
    name: `a live template substitution keeps ran with minify=${minifySyntax}`,
    before: 'window.result = `btn ${window.input ?? "red"}`;',
    after: 'window.result = `btn ${window.input ?? "orange"}`;',
    minifySyntax,
    expected: 'unknown',
    live: true,
    count: 2,
  })),
  ...residualCases.flatMap(({ name, before, residual }) =>
    [false, true].map((minifySyntax) => ({
      name: `${name} reports its residual with minify=${minifySyntax}`,
      before,
      after: before.replace('"red"', '"blue"'),
      residual,
      minifySyntax,
      expected: 'unknown',
      count: 2,
    })),
  ),
  ...tokenCases.map(({ name, before, after }) => ({
    name: name + ' in real Chromium through git',
    before,
    after,
    minifySyntax: true,
    expected: 'unmeasured',
    count: 2,
  })),
  ...[false, true].map((rendered) => ({
    name: `${rendered ? 'opened' : 'unopened'} overlay CSS-template and JSX-text edits use real Chromium execution through git`,
    before: overlaySource(rendered),
    after: overlaySource(rendered).replace('color: red;', 'color: blue;').replace('Service is down,', 'Service is up,'),
    minifySyntax: false,
    expected: rendered ? 'unmeasured' : 'never-rendered',
    count: 4,
  })),
  ...[
    [
      'unreachable declaration',
      'window.healthy = 1;\nfunction App() {\n  return "healthy";\n  const value = "down";\n}\nApp();',
    ],
    [
      'optimized idle ternary arm',
      'window.healthy = 1;\nfunction App() {\n  return true ? "healthy" : "down";\n}\nApp();',
    ],
    [
      'production-only debug JSX',
      'function App() {\n  if (process.env.NODE_ENV !== "production") {\n    return <p>Debug build down</p>;\n  }\n  return "healthy";\n}\nApp();',
    ],
    ['return after throw', 'function App() {\n  try { throw 1; return "down"; } catch {}\n}\nApp();'],
  ].map(([name, before]) => ({
    name: `${name} removed by esbuild cannot inherit execution in real Chromium through git`,
    before,
    after: before.replace('down', 'up'),
    minifySyntax: true,
    expected: 'unmeasured',
    count: 2,
  })),
  {
    name: 'a merged return cannot inherit execution from the selected zero branch',
    before: 'function App(a) {\n  if (a) return 0;\n  return 1;\n}\nwindow.result = App(true);',
    after: 'function App(a) {\n  if (a) return 0;\n  return undefined;\n}\nwindow.result = App(true);',
    minifySyntax: true,
    expected: ['never-rendered', 'unmeasured'],
    count: 2,
  },
  ...[
    [
      'idle multiline template',
      'const fallback = "ok";\nfunction App(a) {\n  return a ? `Service\n    is down` : fallback;\n}\nwindow.result = App(false);',
      'is down',
      'was down',
    ],
    [
      'idle multi-token template',
      'const fallback = "ok";\nfunction App(a) {\n  return a ? `Service\n    is down` : fallback;\n}\nwindow.result = App(false);',
      'is down',
      'was unavailable',
    ],
    [
      'idle two-line template hunk',
      'const fallback = "ok";\nfunction App(a) {\n  return a ? `Service\n    is down` : fallback;\n}\nwindow.result = App(false);',
      'Service\n    is down',
      'Service alert\n    was down',
    ],
    [
      'idle clsx template',
      'const clsx = (...args) => args.join("");\nconst open = Boolean(window.openOverlay);\nwindow.result = clsx(open && `\n    big`);',
      'big',
      'small',
    ],
    ['empty map callback', 'const xs = window.xs || [];\nwindow.result = xs.map((i) => foo +\n  5);', '5', '6'],
  ].map(([name, before, from, to]) => ({
    name: `${name} accounts for leading text before executed starts in real Chromium`,
    before,
    after: before.replace(from, to),
    minifySyntax: true,
    expected: 'never-rendered',
    count: from.includes('\n') ? 4 : 2,
  })),
];

for (const scenario of scenarios) {
  test(scenario.name, async ({ context }, testInfo) => {
    const root = testInfo.outputPath('repository');
    fs.mkdirSync(root, { recursive: true });
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    git('init', '-q');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@example.test');
    const { before, after } = scenario;
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
        minify: scenario.minifySyntax,
        define: tokenDefines,
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
    expect(units).toHaveLength(scenario.count);
    expect(units.map((unit) => unit.status)).toEqual(
      Array.isArray(scenario.expected) ? scenario.expected : Array(scenario.count).fill(scenario.expected),
    );
    if (scenario.expected === 'unmeasured' || (scenario.count === 4 && !scenario.minifySyntax)) {
      expect(units.every((unit) => unit.executionScope === 'preceding-anchor')).toBe(true);
      expect(units.every((unit) => unit.why.includes('preceding-anchor'))).toBe(true);
    }
    if (scenario.expected === 'unmeasured') {
      expect(units.every((unit) => unit.execution === 'unmeasured')).toBe(true);
      expect(units.every((unit) => unit.why.includes('it may have been removed by the bundler'))).toBe(true);
    }
    if ('idle' in scenario && scenario.idle) {
      expect(units.every((unit) => ['never-ran', 'partly-ran'].includes(unit.execution))).toBe(true);
    }
    if ('live' in scenario) expect(units.every((unit) => unit.execution === 'ran')).toBe(true);
    if ('residual' in scenario) {
      maps.forEach((map, i) => writeCapture(dirs[i], 'home@1280', map, null));
      const previous = process.cwd();
      let report;
      process.chdir(root);
      try {
        report = generateStyleMapReport({ beforeDir: dirs[0], afterDir: dirs[1], outDir: path.join(root, 'report') });
      } finally {
        process.chdir(previous);
      }
      const json = JSON.parse(fs.readFileSync(report.reportJsonPath, 'utf8'));
      expect(json.reach.scripts.every((unit: { why: string }) => unit.why.includes(scenario.residual))).toBe(true);
      expect(fs.readFileSync(report.reportMdPath, 'utf8')).toContain(scenario.residual);
    }
  });
}
