import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mapScriptCoverage } from '../dist/script-reach.js';
import { compactScriptEvidence } from '../dist/script-reach-storage.js';
import { classifyScriptReach, scriptJoinGap } from '../dist/script-join.js';
import { assessReachMaps } from '../dist/report/reach.js';
import { budgetScriptReach, reserveScriptNotice } from '../dist/report/script-units.js';
import { scriptGapLines } from '../dist/report/script-gap-details.js';
import { readScriptChanges } from '../dist/script-join-git.js';
import { assertDeterministicScriptReach } from '../dist/runner/self-check.js';
import { scriptProjectRootPrefix } from '../dist/capture/script-project-root.js';
import { trackScriptReach } from '../dist/capture/script-reach.js';
import { generateStyleMapReport } from '../dist/report.js';
import { DEFAULT_MAX_JSON_BYTES } from '../dist/report/sections.js';
import { makeMap, writeCapture } from './helpers.mjs';
import { stampCertifyingFixture } from './certifying-fixture.mjs';

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'join-round3-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.test');
  const commit = () => {
    git('add', '.');
    git('commit', '-qm', 'fixture');
    return git('rev-parse', 'HEAD');
  };
  const dirs = ['base', 'head'].map((name) => path.join(cwd, name));
  const stamp = (shas) =>
    dirs.forEach((dir, i) => {
      fs.mkdirSync(dir);
      stampCertifyingFixture(dir, shas[i]);
    });
  const read = (baseMaps, headMaps) => readScriptChanges(...dirs, { cwd, baseMaps, headMaps });
  return { cwd, git, commit, dirs, stamp, read };
}

function capture(text, prefix = '', ranges = []) {
  const files = mapScriptCoverage(
    { functions: [{ ranges: [{ startOffset: 0, endOffset: text.length, count: 1 }, ...ranges] }] },
    text,
    {
      version: 3,
      sources: ['app.ts'],
      sourcesContent: [text],
      mappings: text
        .split('\n')
        .map((_, i) => (i ? 'AACA' : 'AAAA'))
        .join(';'),
    },
    'https://fixture.test/app.js.map',
  );
  return {
    ...makeMap(),
    scriptReach: {
      version: 1,
      window: 'navigation',
      status: 'measured',
      projectRootPrefix: prefix,
      scripts: [compactScriptEvidence({ url: '/app.js', status: 'mapped', files })],
    },
  };
}

function revisions(t, file = 'app.ts') {
  const f = fixture(t);
  const before = 'const value = 1;\n',
    after = 'const value = 2;\n';
  fs.mkdirSync(path.dirname(path.join(f.cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(f.cwd, file), before);
  const base = f.commit();
  fs.writeFileSync(path.join(f.cwd, file), after);
  const head = f.commit();
  f.stamp([base, head]);
  return { ...f, before, after };
}

test('five thousand unjudged paths cannot evict twenty style findings or overflow either report', (t) => {
  const f = fixture(t);
  const before = 'const value = 1;\n',
    after = 'const value = 2;\n';
  fs.writeFileSync(path.join(f.cwd, 'app.ts'), before);
  const base = f.commit();
  fs.writeFileSync(path.join(f.cwd, 'app.ts'), after);
  fs.mkdirSync(path.join(f.cwd, 'data'));
  for (let i = 0; i < 5000; i++)
    fs.writeFileSync(
      path.join(f.cwd, 'data', `design-token-configuration-section-${String(i).padStart(5, '0')}.json`),
      '{}\n',
    );
  const head = f.commit();
  f.stamp([base, head]);
  for (const [side, text] of [before, after].entries()) {
    const map = capture(text);
    map.reach = { version: 2, scope: 'compared', sheets: [], rules: [] };
    map.elements = makeMap({
      elements: Object.fromEntries(
        Array.from({ length: 20 }, (_, i) => [
          `body > div:nth-child(${i + 1})`,
          { tag: 'div', rect: [0, i * 10, 10, 10], style: { color: side ? 'blue' : 'red' } },
        ]),
      ),
    }).elements;
    writeCapture(f.dirs[side], 'home@1280', map, null);
  }
  const previous = process.cwd();
  process.chdir(f.cwd);
  let output;
  try {
    output = generateStyleMapReport({ beforeDir: f.dirs[0], afterDir: f.dirs[1], outDir: path.join(f.cwd, 'report') });
  } finally {
    process.chdir(previous);
  }
  const raw = fs.readFileSync(output.reportJsonPath, 'utf8'),
    json = JSON.parse(raw);
  assert.equal(json.surfaces.flatMap((surface) => surface.findings ?? []).length, 20);
  assert.ok(Buffer.byteLength(raw) <= DEFAULT_MAX_JSON_BYTES, `${Buffer.byteLength(raw)} JSON bytes`);
  const gap = json.reach.gaps.find((gap) => gap.reason.startsWith('changed files J2 does not judge:'));
  assert.equal(gap.pathCount, 5000);
  assert.ok(gap.reason.length < 1000);
  assert.ok(gap.paths.length < 5000);
  assert.ok(json.reach.gaps.some((gap) => /J2 gap paths truncated: \d+ more/.test(gap.reason)));
  const markdown = fs.readFileSync(output.reportMdPath, 'utf8');
  assert.ok(Buffer.byteLength(markdown) < 100_000, `${Buffer.byteLength(markdown)} Markdown bytes`);
  assert.match(markdown, /J2 gap paths truncated/);
  assert.match(markdown, /1 run-level gap\(s\)/);
});

test('a self-check rewrite preserves root provenance and cannot drop a healthy surface head line', (t) => {
  const f = revisions(t);
  const healthy = capture(f.after),
    rewritten = capture(f.after),
    other = capture(f.after);
  other.scriptReach.scripts[0].files[0].executed = [];
  assertDeterministicScriptReach(rewritten, other, 'overlay');
  assert.equal(rewritten.scriptReach.projectRootPrefix, '');
  const diff = f.read([capture(f.before)], [healthy, rewritten]);
  const head = classifyScriptReach([capture(f.before)], [healthy, rewritten], diff.changes).units.filter(
    (u) => u.side === 'head',
  );
  assert.equal(head.length, 1);
  assert.equal(head[0].sourceKey, 'app.ts');
  assert.equal(head[0].range.start.line, 1);
});

test('prefix-less evidence without mapped scripts cannot conflict with a measured surface', (t) => {
  const f = revisions(t);
  const empty = {
    ...makeMap(),
    scriptReach: {
      version: 1,
      window: 'navigation',
      status: 'unmeasured',
      reason: 'script evidence not reproducible',
      scripts: [],
    },
  };
  const diff = f.read([capture(f.before)], [capture(f.after), empty]);
  assert.equal(diff.changes.filter((change) => change.side === 'head').length, 1);
  assert.ok(!diff.gaps.some((gap) => /prefix.*conflicting/.test(gap.reason)));
});

test('a side without usable prefix keeps git-path source ranges as explicitly unmeasured units', (t) => {
  const f = revisions(t, 'apps/web/app.ts');
  const base = capture(f.before, 'apps/web'),
    head = capture(f.after, undefined);
  delete head.scriptReach.projectRootPrefix;
  const diff = f.read([base], [head]);
  const units = classifyScriptReach([base], [head], diff.changes).units;
  const unit = units.find((u) => u.side === 'head');
  assert.ok(unit, 'head app.ts:1 must not vanish');
  assert.equal(unit.sourceKey, 'apps/web/app.ts');
  assert.equal(unit.range.start.line, 1);
  assert.equal(unit.status, 'unmeasured');
  assert.match(unit.why, /project-root prefix/);
});

test('unmeasured tracker early returns retain a supplied project-root prefix', async () => {
  const nonChromium = { context: () => ({ browser: () => ({ browserType: () => ({ name: () => 'webkit' }) }) }) };
  const tracker = await trackScriptReach(nonChromium, { projectRoot: process.cwd(), projectRootPrefix: 'apps/web' });
  assert.equal((await tracker.stop()).projectRootPrefix, 'apps/web');
});

test('a slow successful git prefix lookup has enough budget to retain its provenance', (t) => {
  const f = fixture(t),
    bin = path.join(f.cwd, 'tools');
  fs.mkdirSync(bin);
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const quote = (s) => "'" + s.replaceAll("'", `'"'"'`) + "'";
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nsleep 1.2\nexec ${quote(realGit)} "$@"\n`, { mode: 0o755 });
  const previous = process.env.PATH;
  process.env.PATH = bin + path.delimiter + previous;
  try {
    assert.equal(scriptProjectRootPrefix(f.cwd), '');
  } finally {
    process.env.PATH = previous;
  }
});

test('a failed cached root lookup is retained as a named evidence gap', async () => {
  const page = { context: () => ({ browser: () => ({ browserType: () => ({ name: () => 'webkit' }) }) }) };
  const tracker = await trackScriptReach(page, { projectRoot: process.cwd(), projectRootPrefix: null });
  const evidence = await tracker.stop();
  assert.match(evidence.projectRootIssue ?? '', /project-root prefix.*(?:failed|unavailable|timed out)/);
  const map = { ...makeMap(), scriptReach: evidence };
  assert.ok(classifyScriptReach([map], [map], []).gaps.some((gap) => /project-root prefix/.test(gap.reason)));
});

test('an idle arrow body on later lines cannot clear a mixed column-zero header', () => {
  const text = 'const Fault = (tone) => {\n  return tone;\n};\nwindow.result = 1;';
  const map = capture(text, '', [{ startOffset: text.indexOf('(tone)'), endOffset: text.indexOf('};') + 1, count: 0 }]);
  const firstLine = text.split('\n')[0],
    start = firstLine.indexOf('tone');
  const changes = [
    [0, firstLine.length],
    [start, start + 4],
  ].map(([from, to]) => ({
    sourceKey: 'app.ts',
    side: 'head',
    range: { start: { line: 1, column: from }, end: { line: 1, column: to } },
    text: firstLine,
    contentHash: map.scriptReach.scripts[0].files[0].contentHash,
  }));
  assert.deepEqual(
    classifyScriptReach([map], [map], changes).units.map((u) => [u.execution, u.status]),
    [
      ['partly-ran', 'never-rendered'],
      ['partly-ran', 'never-rendered'],
    ],
  );
});

test('residual naming avoids adversarial backtracking before its CPU use exceeds ten milliseconds', () => {
  const text = '(a='.repeat(682),
    map = capture(text);
  map.scriptReach.scripts[0].files[0].executed = [...text.matchAll(/a/g)].map((token) => [1, token.index, token.index]);
  const started = process.cpuUsage();
  const [unit] = classifyScriptReach(
    [map],
    [map],
    [
      {
        sourceKey: 'app.ts',
        side: 'head',
        range: { start: { line: 1, column: 0 }, end: { line: 1, column: text.length } },
        text,
        contentHash: map.scriptReach.scripts[0].files[0].contentHash,
      },
    ],
  ).units;
  const used = process.cpuUsage(started);
  assert.ok(used.user + used.system < 10_000, `residual CPU: ${used.user + used.system} microseconds`);
  assert.match(unit.why, /residual naming skipped/);
});

test('an anchor for another source on the same original line cannot represent an idle header run', () => {
  const text = 'const Fault = (tone) => {\n  return tone;\n};\nwindow.result = 1;';
  const files = mapScriptCoverage(
    {
      functions: [
        {
          ranges: [
            { startOffset: 0, endOffset: text.length, count: 1 },
            { startOffset: text.indexOf('(tone)'), endOffset: text.indexOf('};') + 1, count: 0 },
          ],
        },
      ],
    },
    text,
    { version: 3, sources: ['app.ts', 'other.ts'], sourcesContent: [text, text], mappings: 'AAAA;ACAA;ADCA;AACA' },
    'https://fixture.test/app.js.map',
  );
  assert.ok(files.find((file) => file.sourceKey === 'app.ts').mixed.some((span) => span.start.line === 1));
});

test('residual candidates at the naming cap stay below ten milliseconds of CPU', () => {
  for (const text of ['(a='.repeat(42), '{a='.repeat(42), 'a('.repeat(63)]) {
    const map = capture(text);
    map.scriptReach.scripts[0].files[0].executed = [...text.matchAll(/a/g)].map((token) => [
      1,
      token.index,
      token.index,
    ]);
    const started = process.cpuUsage();
    const [unit] = classifyScriptReach(
      [map],
      [map],
      [
        {
          sourceKey: 'app.ts',
          side: 'head',
          range: { start: { line: 1, column: 0 }, end: { line: 1, column: text.length } },
          text,
          contentHash: map.scriptReach.scripts[0].files[0].contentHash,
        },
      ],
    ).units;
    const used = process.cpuUsage(started);
    assert.ok(used.user + used.system < 10_000, `capped residual CPU: ${used.user + used.system} microseconds`);
    assert.equal(unit.status, 'unknown');
    assert.doesNotMatch(unit.why, /residual naming skipped/);
  }
});

test('thousands of separate J2 gaps reserve bounded metadata and name the first omitted record', () => {
  const map = capture('const x = 1;');
  const gaps = Array.from({ length: 5000 }, (_, i) => scriptJoinGap(`gap ${String(i).padStart(5, '0')}`));
  const original = assessReachMaps([map], [map], 'warn', { changes: [], gaps });
  const reserved = reserveScriptNotice(original);
  assert.ok(Buffer.byteLength(JSON.stringify(reserved)) < 5000);
  const { reach } = budgetScriptReach(original, reserved, 64_000);
  const listed = reach.gaps.filter((gap) => /^gap \d/.test(gap.reason));
  const notice = reach.gaps.find((gap) => gap.reason.startsWith('J2 gaps truncated:'));
  assert.match(notice.reason, new RegExp(`first: gap ${String(listed.length).padStart(5, '0')}`));
  assert.ok(listed.length < 5000);
  const markdown = scriptGapLines(reach.gaps.filter((gap) => gap.join === 'J2')).join('\n');
  assert.ok(markdown.includes(notice.reason));
  assert.ok(Buffer.byteLength(markdown) < 64_000);
});

test('long omitted gap previews cannot exceed the post-findings byte allowance', () => {
  const map = capture('const x = 1;');
  const gaps = ['a', 'b', '😀'.repeat(120), '😀'.repeat(120)].map((reason) => scriptJoinGap(reason));
  const original = assessReachMaps([map], [map], 'warn', { changes: [], gaps });
  const reserved = reserveScriptNotice(original),
    baseBytes = Buffer.byteLength(JSON.stringify(reserved, null, 2));
  for (const available of [100, 600, 2500, 64_000]) {
    const { reach } = budgetScriptReach(original, reserved, available);
    const bytes = Buffer.byteLength(JSON.stringify(reach, null, 2));
    assert.ok(bytes <= baseBytes + available, `${bytes - baseBytes} detail bytes within ${available}`);
  }
});
