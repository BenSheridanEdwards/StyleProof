import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { createContentFixture } from './browser-lanes-fixtures.mjs';

export function localProcess(root, { browser = true, npmExit = 0 } = {}) {
  const write = (file, content) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  };
  for (const file of ['scripts/pre-push-e2e.mjs', 'scripts/browser-lanes.mjs']) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    copyFileSync(new URL(`../../${file}`, import.meta.url), join(root, file));
  }
  write('node_modules/@playwright/test/package.json', '{"type":"module","exports":"./index.mjs"}');
  write(
    'node_modules/@playwright/test/index.mjs',
    `export const chromium = { executablePath: () => ${JSON.stringify(join(root, 'chrome'))} };\n`,
  );
  if (browser) write('chrome', 'browser presence fixture; never executed');
  write('fake-bin/npm', `#!/bin/sh\nprintf '%s\\n' "$@" > npm-args\nexit ${npmExit}\n`);
  chmodSync(join(root, 'fake-bin/npm'), 0o755);
  const run = (input = '', extraEnv = {}) => {
    rmSync(join(root, 'npm-args'), { force: true });
    return spawnSync(process.execPath, ['scripts/pre-push-e2e.mjs'], {
      cwd: root,
      input,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${join(root, 'fake-bin')}:${process.env.PATH}`, ...extraEnv },
    });
  };
  const npmArgs = () => (existsSync(join(root, 'npm-args')) ? readFileSync(join(root, 'npm-args'), 'utf8') : null);
  return { root, write, run, npmArgs };
}

export function registerLocalBrowserCase(row) {
  test(`L ${row.id}: ${row.title} invokes the full browser gate`, (t) => {
    const f = createContentFixture(t, row);
    const process = localProcess(f.directory, { npmExit: 37 });
    const result = process.run(`${f.head} ${f.head} refs/heads/pushed ${f.base}\n`);
    assert.notEqual(f.baseTree, f.headTree, 'the real root trees differ');
    assert.equal(result.status, 37, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /skipped/);
    assert.equal(process.npmArgs(), 'run\ntest:e2e\n--\n--workers=4\n');
  });
}
