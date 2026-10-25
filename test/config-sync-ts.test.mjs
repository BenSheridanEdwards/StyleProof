import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadStyleProofConfig, loadStyleProofConfigAsync } from '../dist/config.js';
import { mkTmp, rmTmp, spawnSyncBounded } from './helpers.mjs';

const CONFIG_URL = new URL('../dist/config.js', import.meta.url).href;
const TYPE_STRIPPING_UNAVAILABLE = (() => {
  const probe = spawnSyncBounded(process.execPath, ['--experimental-strip-types', '--no-warnings', '-e', '0'], {
    encoding: 'utf8',
  });
  const text = `${probe.stderr ?? ''}${probe.stdout ?? ''}`;
  return probe.status !== 0 || /bad option|unknown option|is not allowed/i.test(text)
    ? 'Node does not support --experimental-strip-types'
    : false;
})();

function configFixture(t, source) {
  const root = mkTmp('styleproof-sync-ts-');
  t.after(() => rmTmp(root));
  fs.mkdirSync(path.join(root, '.git'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(root, 'styleproof.config.ts'), source);
  fs.writeFileSync(path.join(root, 'styleproof.config.json'), '{"coverage":{"strict":false}}');
  return root;
}

function loadSyncInChild(root, prelude = '') {
  return spawnSyncBounded(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { loadStyleProofConfig } from ${JSON.stringify(CONFIG_URL)};
       ${prelude}
       const config = loadStyleProofConfig(${JSON.stringify(root)});
       process.stdout.write(JSON.stringify(config));`,
    ],
    { cwd: root, encoding: 'utf8' },
  );
}

for (const typed of [false, true]) {
  const label = typed ? 'typed' : 'JS-shaped';
  const options = { skip: typed && TYPE_STRIPPING_UNAVAILABLE };

  test(`sync ${label} ts config forwards logs once and matches async policy`, options, async (t) => {
    const root = configFixture(
      t,
      `console.log('fixture logged');
       console.error('fixture warning');
       export default { requireApproval: true${typed ? ' as boolean' : ''}, coverage: { strict: true } };`,
    );
    const result = loadSyncInChild(root);
    assert.equal(result.status, 0, result.error?.message || result.stderr);
    const lines = result.stdout.trimEnd().split('\n');
    assert.deepEqual(lines.slice(0, -1), ['fixture logged']);
    assert.equal(result.stderr, 'fixture warning\n');
    const asyncConfig = await loadStyleProofConfigAsync(root);
    assert.deepEqual(loadStyleProofConfig(root), asyncConfig);
    assert.deepEqual(JSON.parse(lines.at(-1)), JSON.parse(JSON.stringify(asyncConfig)));
    assert.deepEqual(JSON.parse(lines.at(-1)), { requireApproval: true, coverage: { strict: true } });
  });

  test(`sync ${label} ts config rejects policy hidden by toJSON like async`, options, async (t) => {
    const root = configFixture(
      t,
      `export default { coverage: { strict: 'yes'${typed ? ' as string' : ''} }, toJSON() { return {}; } };`,
    );
    await assert.rejects(() => loadStyleProofConfigAsync(root), /coverage\.strict.*boolean/);
    assert.throws(() => loadStyleProofConfig(root), /coverage\.strict.*boolean/);
  });
}

test('sync ts config forwards an imported module log and matches async policy', async (t) => {
  const root = configFixture(
    t,
    "import { strict } from './lib.mjs'; export default { requireApproval: true, coverage: { strict } };",
  );
  fs.writeFileSync(path.join(root, 'lib.mjs'), "console.log('fixture-lib'); export const strict = true;");
  const result = loadSyncInChild(root);
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  const lines = result.stdout.trimEnd().split('\n');
  assert.deepEqual(lines.slice(0, -1), ['fixture-lib']);
  const asyncConfig = await loadStyleProofConfigAsync(root);
  assert.deepEqual(loadStyleProofConfig(root), asyncConfig);
  assert.deepEqual(JSON.parse(lines.at(-1)), JSON.parse(JSON.stringify(asyncConfig)));
});

test('sync ts config rejects a function-valued policy before serialization', (t) => {
  const root = configFixture(t, 'export default { requireApproval() {} };');
  assert.throws(() => loadStyleProofConfig(root), /requireApproval.*boolean/);
});

test('sync ts config preserves policy arrays despite inherited toJSON', (t) => {
  const root = configFixture(
    t,
    `const roots = ['styles'];
     Object.setPrototypeOf(roots, Object.create(Array.prototype, { toJSON: { value() { return []; } } }));
     export default { ancestorBaseline: { roots } };`,
  );
  assert.deepEqual(loadStyleProofConfig(root).ancestorBaseline.roots, ['styles']);
});

for (const [label, source, reason] of [
  ['evaluation error', "throw new Error('fixture evaluation failed'); export default {};", /fixture evaluation failed/],
  ['syntax error', 'export default {', /SyntaxError/],
]) {
  test(`sync ts config fails closed on ${label} instead of reading sibling JSON`, (t) => {
    const root = configFixture(t, source);
    assert.throws(
      () => loadStyleProofConfig(root),
      (error) => {
        assert.match(error.message, /styleproof\.config\.ts could not be evaluated/);
        assert.match(error.message, reason);
        assert.equal(error.code, 'STYLEPROOF_UNLOADABLE_TS');
        return true;
      },
    );
  });
}

for (const typed of [false, true]) {
  const label = typed ? 'typed' : 'JS-shaped';
  const options = { skip: typed && TYPE_STRIPPING_UNAVAILABLE };
  const policy = `export default { requireApproval: true${typed ? ' as boolean' : ''} };`;

  // The async loader is not called on these: in process it would set the runner's exit code or crash it.
  test(`sync ${label} ts config fails closed when it sets a non-zero process.exitCode`, options, (t) => {
    const root = configFixture(t, `process.exitCode = 7; ${policy}`);
    assert.throws(
      () => loadStyleProofConfig(root),
      (error) => {
        assert.equal(error.code, 'STYLEPROOF_UNLOADABLE_TS');
        assert.match(error.message, /styleproof\.config\.ts could not be evaluated/);
        assert.match(error.message, /process\.exitCode to 7/);
        return true;
      },
    );
    const result = loadSyncInChild(root);
    assert.equal(result.status, 1, result.stderr);
    assert.doesNotMatch(result.stdout, /requireApproval/);
  });

  test(`sync ${label} ts config fails closed on an unhandled promise rejection`, options, (t) => {
    const root = configFixture(t, `Promise.reject(new Error('fixture rejected')); ${policy}`);
    assert.throws(
      () => loadStyleProofConfig(root),
      (error) => {
        assert.equal(error.code, 'STYLEPROOF_UNLOADABLE_TS');
        assert.match(error.message, /unhandled promise rejection/);
        assert.match(error.message, /fixture rejected/);
        return true;
      },
    );
  });
}

test('sync ts config still loads when it handles its own rejection and resets exitCode', async (t) => {
  const root = configFixture(
    t,
    "const p = Promise.reject(new Error('handled')); p.catch(() => {}); process.exitCode = 0; " +
      'export default { requireApproval: true };',
  );
  const config = loadStyleProofConfig(root);
  assert.equal(config.requireApproval, true);
  assert.deepEqual(config, await loadStyleProofConfigAsync(root));
});

test('sync ts config preserves final failure logs without duplicating attempts', (t) => {
  const root = configFixture(
    t,
    "console.log('fixture failed'); throw new Error('fixture evaluation failed'); export default {};",
  );
  const result = loadSyncInChild(root);
  assert.equal(result.status, 1, result.error?.message);
  assert.equal(result.stdout, 'fixture failed\n');
  assert.match(result.stderr, /styleproof\.config\.ts could not be evaluated/);
  assert.match(result.stderr, /fixture evaluation failed/);
});

test('sync ts config retains plain-attempt logs and reason when type stripping is unavailable', (t) => {
  const root = configFixture(
    t,
    "console.log('fixture plain failed'); throw new Error('fixture plain reason'); export default {};",
  );
  const result = loadSyncInChild(
    root,
    `import childProcess from 'node:child_process';
     import { syncBuiltinESMExports } from 'node:module';
     const spawnSync = childProcess.spawnSync;
     childProcess.spawnSync = (command, args, options) => args.includes('--experimental-strip-types')
       ? { status: 9, stdout: '', stderr: 'node: bad option: --experimental-strip-types' }
       : spawnSync(command, args, options);
     syncBuiltinESMExports();`,
  );
  assert.equal(result.status, 1, result.error?.message);
  assert.equal(result.stdout, 'fixture plain failed\n');
  assert.match(result.stderr, /styleproof\.config\.ts could not be evaluated/);
  assert.match(result.stderr, /Error: fixture plain reason/);
  assert.doesNotMatch(result.stderr, /node: bad option/);
});

test(
  'sync typed ts config does not mistake stdout for an unsupported Node option',
  {
    skip: TYPE_STRIPPING_UNAVAILABLE,
  },
  (t) => {
    const root = configFixture(
      t,
      `console.log('bad option');
       throw new Error('fixture evaluation failed');
       export default { requireApproval: true as boolean };`,
    );
    const result = loadSyncInChild(root);
    assert.equal(result.status, 1, result.error?.message);
    assert.match(result.stderr, /Error: fixture evaluation failed/);
    assert.equal(result.stdout, 'bad option\n');
  },
);

test('sync ts config cannot substitute stdout JSON for a missing result', (t) => {
  const root = configFixture(t, "console.log('{}'); process.exit(0); export default { requireApproval: true };");
  const result = loadSyncInChild(root);
  assert.equal(result.status, 1, result.error?.message || result.stderr);
  assert.match(result.stderr, /styleproof\.config\.ts could not be evaluated/);
  assert.equal(result.stdout, '{}\n');
});

test('sync ts config drains queued logs and schema warnings with live handles', (t) => {
  const root = configFixture(
    t,
    `setInterval(() => {}, 100);
     setTimeout(() => process.exit(7), 2000);
     console.log('x'.repeat(65536));
     console.error('y'.repeat(65536));
     export default { coverage: { strict: true }, unexpected: true };`,
  );
  const result = loadSyncInChild(root);
  assert.equal(result.status, 0, result.error?.message || result.stderr.slice(-1000));
  assert.equal(result.stdout, 'x'.repeat(65536) + '\n{"coverage":{"strict":true}}');
  assert.ok(result.stderr.startsWith('y'.repeat(65536) + '\n'));
  assert.match(result.stderr, /styleproof\.config\.ts.*unknown key\(s\) ignored: unexpected/);
  assert.equal(result.stderr.match(/unknown key\(s\) ignored/g)?.length, 1);
  assert.doesNotMatch(result.stderr, /\.styleproof-config-eval-/);
});

for (const [command, args, reason] of [
  ['styleproof-affected', [], /--graph .* is required/],
  ['styleproof-diff', ['missing-before', 'missing-after'], /no capture at missing-before/],
]) {
  test(`${command} gets past a logging ts config to its input error`, (t) => {
    const root = configFixture(t, "console.log('fixture CLI loaded'); export default { requireApproval: true };");
    const bin = fileURLToPath(new URL(`../bin/${command}.mjs`, import.meta.url));
    const result = spawnSyncBounded(process.execPath, [bin, ...args], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 2, result.error?.message || result.stderr);
    assert.match(result.stderr, reason);
    assert.doesNotMatch(result.stderr, /could not be evaluated/);
    assert.match(result.stdout, /fixture CLI loaded/);
  });
}
