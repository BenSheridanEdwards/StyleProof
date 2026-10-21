import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadStyleProofConfig, loadStyleProofConfigAsync } from '../dist/config.js';
import { mkNonGitTmp, mkTmp, rmTmp, spawnSyncBounded } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_URL = new URL('../dist/config.js', import.meta.url).href;

/** Node 18/20 reject `--experimental-strip-types`, so a typed `.ts` cannot load there. */
const TYPE_STRIPPING_UNAVAILABLE = (() => {
  const probe = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '-e', '0'], {
    encoding: 'utf8',
  });
  return probe.status === 0 ? false : 'Node does not support --experimental-strip-types';
})();

const BANNER_MJS = "console.log('fixture banner loaded'); export const strict = true;";

const SHAPES = [
  [
    'JS-shaped',
    false,
    `import { strict } from './banner.mjs';
     console.log('fixture config loaded');
     export default { coverage: { strict }, requireApproval: true };`,
  ],
  [
    'typed',
    TYPE_STRIPPING_UNAVAILABLE,
    `import { strict } from './banner.mjs';
     const requireApproval: boolean = true;
     console.log('fixture config loaded');
     export default { coverage: { strict }, requireApproval };`,
  ],
];

/** Sync-load in a fresh Node so the forwarded config output is observable on its stdout. */
function loadInChild(root, timeout) {
  return spawnSyncBounded(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { loadStyleProofConfig } from ${JSON.stringify(CONFIG_URL)};
       const config = loadStyleProofConfig(${JSON.stringify(root)});
       process.stdout.write(JSON.stringify({ strict: config.coverage.strict }));`,
    ],
    { encoding: 'utf8', timeout },
  );
}

function writeConfigRoot(prefix, source) {
  const root = mkTmp(prefix);
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(root, 'banner.mjs'), BANNER_MJS);
  fs.writeFileSync(path.join(root, 'styleproof.config.ts'), source);
  return root;
}

for (const [shape, skip, source] of SHAPES) {
  test(
    `sync ${shape} .ts config that logs, directly and through an import, loads like the async loader`,
    { skip },
    async () => {
      const root = writeConfigRoot('styleproof-sync-ts-', source);
      try {
        const sync = loadStyleProofConfig(root);
        assert.equal(sync.coverage?.strict, true);
        assert.equal(sync.requireApproval, true);
        assert.deepEqual(sync, await loadStyleProofConfigAsync(root));
      } finally {
        rmTmp(root);
      }
    },
  );

  test(`sync ${shape} .ts config forwards its stdout and stderr to the caller`, { skip }, () => {
    const root = writeConfigRoot('styleproof-sync-ts-output-', `console.error('fixture warning');\n${source}`);
    try {
      const result = loadInChild(root);
      assert.equal(result.status, 0, result.error?.message || result.stderr.slice(-1000));
      assert.equal(result.stdout, 'fixture banner loaded\nfixture config loaded\n{"strict":true}');
      assert.match(result.stderr, /fixture warning/);
    } finally {
      rmTmp(root);
    }
  });

  for (const [label, policy, reason] of [
    ['invalid policy', "coverage: { strict: 'yes' }", '"coverage.strict" must be a boolean'],
    ['function-valued policy', 'requireApproval() {}', '"requireApproval" must be a boolean'],
    ['toJSON omission', "coverage: { strict: 'yes' }, toJSON() { return {}; }", '"coverage.strict" must be a boolean'],
  ]) {
    test(`sync ${shape} .ts config fails closed on ${label} with the async loader's reason`, { skip }, async () => {
      const typed = shape === 'typed' ? 'const policy: Record<string, unknown> =' : 'const policy =';
      const root = writeConfigRoot('styleproof-sync-ts-invalid-', `${typed} { ${policy} };\nexport default policy;`);
      try {
        const expected = { message: `styleproof.config.ts: ${reason}` };
        assert.throws(() => loadStyleProofConfig(root), expected);
        await assert.rejects(() => loadStyleProofConfigAsync(root), expected);
      } finally {
        rmTmp(root);
      }
    });
  }
}

test('sync .ts config finishes with a live handle and flushes queued output', () => {
  const root = writeConfigRoot(
    'styleproof-sync-ts-handles-',
    `setInterval(() => {}, 100);
     console.log('x'.repeat(65536));
     export default { coverage: { strict: true } };`,
  );
  try {
    const result = loadInChild(root, 20_000);
    assert.equal(result.status, 0, result.error?.message || result.stderr.slice(-1000));
    assert.equal(result.stdout, 'x'.repeat(65536) + '\n{"strict":true}');
  } finally {
    rmTmp(root);
  }
});

for (const [cli, args, expected] of [
  ['styleproof-affected', [], /--graph <depcruise\.json> is required/],
  ['styleproof-diff', ['before', 'after'], /no capture at/],
]) {
  test(`${cli} gets past config loading with a .ts config that logs`, () => {
    const root = mkNonGitTmp('styleproof-sync-ts-cli-');
    try {
      fs.writeFileSync(path.join(root, 'banner.mjs'), BANNER_MJS);
      fs.writeFileSync(path.join(root, 'styleproof.config.ts'), SHAPES[0][2]);
      const result = spawnSyncBounded(process.execPath, [path.join(here, '..', 'bin', `${cli}.mjs`), ...args], {
        cwd: root,
        encoding: 'utf8',
      });
      assert.doesNotMatch(result.stderr, /could not be evaluated/);
      assert.match(result.stderr, expected);
      assert.match(result.stdout, /fixture config loaded/);
    } finally {
      rmTmp(root);
    }
  });
}
