import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test, expect, type Page } from '@playwright/test';
import { captureStyleMap, trackScriptReach } from '../dist/capture.js';
import { classifyScriptReach } from '../dist/script-join.js';
import { readScriptChanges } from '../dist/script-join-git.js';
import { stampCertifyingFixture } from './certifying-fixture.mjs';

async function record(page: Page, text: string, projectRoot: string, projectRootPrefix: string) {
  const sourceMap = {
    version: 3,
    sources: ['app.js'],
    sourcesContent: [text],
    mappings: text
      .split('\n')
      .map((_, i) => (i ? 'AACA' : 'AAAA'))
      .join(';'),
  };
  await page.route('https://join.test/**', (route) => {
    const pathname = new URL(route.request().url()).pathname;
    return route.fulfill({
      contentType: pathname === '/' ? 'text/html' : 'application/javascript',
      body:
        pathname === '/'
          ? '<script src="/app.js"></script>'
          : pathname.endsWith('.map')
            ? JSON.stringify(sourceMap)
            : text + '\n//# sourceMappingURL=app.js.map',
    });
  });
  const tracker = await trackScriptReach(page, { projectRoot, projectRootPrefix });
  try {
    await page.goto('https://join.test/');
    return await captureStyleMap(page, {
      captureScriptReach: true,
      scriptReach: tracker,
      captureStates: false,
      stabilize: false,
    });
  } finally {
    await tracker.dispose();
    await page.unroute('https://join.test/**');
  }
}

test('a never-called arrow header stays mixed when its idle run is anchored on other original lines', async ({
  page,
}) => {
  const text = 'const Fault = (tone) => {\n  return tone;\n};\nwindow.result = 1;';
  const captured = await record(page, text, process.cwd(), '');
  const firstLine = text.split('\n')[0],
    start = firstLine.indexOf('tone');
  const file = captured.scriptReach!.scripts.flatMap((s) => s.files ?? []).find((f) => f.sourceKey === 'app.js')!;
  const changes = [
    [0, firstLine.length],
    [start, start + 4],
  ].map(([from, to]) => ({
    sourceKey: 'app.js',
    side: 'head' as const,
    range: { start: { line: 1, column: from }, end: { line: 1, column: to } },
    text: firstLine,
    contentHash: file.contentHash!,
  }));
  expect(
    classifyScriptReach([captured], [captured], changes).units.map((u) => [u.execution, u.status, u.executionScope]),
  ).toEqual([
    ['partly-ran', 'never-rendered', 'line'],
    ['partly-ran', 'never-rendered', 'line'],
  ]);
});

test('pre-owned Chromium coverage retains the supplied root prefix without taking the profiler', async ({ page }) => {
  await page.coverage.startJSCoverage();
  const tracker = await trackScriptReach(page, { projectRoot: process.cwd(), projectRootPrefix: 'apps/web' });
  try {
    const evidence = await tracker.stop();
    expect(evidence.status).toBe('unmeasured');
    expect(evidence.projectRootPrefix).toBe('apps/web');
    expect(evidence.reason).toMatch(/page.coverage active/);
    await page.coverage.stopJSCoverage();
  } finally {
    await tracker.dispose();
  }
});

test('real captured revisions join through git multi-line hunks, a recorded prefix and type-change patch pairing', async ({
  page,
}, testInfo) => {
  const root = testInfo.outputPath('repository'),
    project = path.join(root, 'apps/web');
  fs.mkdirSync(project, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.test');
  git('config', 'diff.interHunkContext', '5');
  const commit = () => {
    git('add', '.');
    git('commit', '-qm', 'fixture');
    return git('rev-parse', 'HEAD');
  };
  const before = 'const first = 1;\nconst second = 2;\nwindow.result = first + second;';
  const after = 'const first = 3;\nconst second = 4;\nwindow.result = first + second;';
  fs.writeFileSync(path.join(project, 'app.js'), before);
  fs.writeFileSync(path.join(project, 'link.js'), 'app.js');
  const base = commit(),
    baseMap = await record(page, before, project, 'apps/web');
  fs.writeFileSync(path.join(project, 'app.js'), after);
  fs.unlinkSync(path.join(project, 'link.js'));
  fs.symlinkSync('app.js', path.join(project, 'link.js'));
  const head = commit(),
    headMap = await record(page, after, project, 'apps/web');
  const dirs = ['base', 'head'].map((name) => path.join(root, 'maps', name));
  for (const [i, dir] of dirs.entries()) {
    fs.mkdirSync(dir, { recursive: true });
    stampCertifyingFixture(dir, [base, head][i]);
  }
  const diff = readScriptChanges(dirs[0], dirs[1], { cwd: root, baseMaps: [baseMap], headMaps: [headMap] });
  const units = classifyScriptReach([baseMap], [headMap], diff.changes).units.filter(
    (unit) => unit.sourceKey === 'app.js',
  );
  expect(
    units.map((unit) => [unit.side, unit.range.start.line, unit.changeScope, unit.execution, unit.status]),
  ).toEqual([
    ['base', 1, 'line', 'ran', 'unknown'],
    ['base', 2, 'line', 'ran', 'unknown'],
    ['head', 1, 'line', 'ran', 'unknown'],
    ['head', 2, 'line', 'ran', 'unknown'],
  ]);
  expect(diff.gaps.some((gap) => /git source diff unavailable/.test(gap.reason))).toBe(false);
  expect(diff.changes.some((change) => change.sourceKey === 'link.js')).toBe(true);
});
