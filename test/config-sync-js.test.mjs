import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadStyleProofConfig, loadStyleProofConfigAsync } from '../dist/config.js';
import { mkTmp, rmTmp, spawnSyncBounded } from './helpers.mjs';

const CONFIG_URL = new URL('../dist/config.js', import.meta.url).href;

for (const extension of ['mjs', 'js']) {
  test(`sync ${extension} config preserves policy, module semantics, and precedence from a nested cwd`, async () => {
    const root = mkTmp('styleproof-sync-js-');
    try {
      fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
      fs.mkdirSync(path.join(root, '.git'));
      const nested = path.join(root, 'packages', 'widgets');
      fs.mkdirSync(nested, { recursive: true });
      fs.writeFileSync(path.join(root, 'policy.mjs'), 'export const strict = true;');
      fs.writeFileSync(path.join(root, 'styleproof.config.json'), '{"coverage":{"strict":false}}');
      const filename = `styleproof.config.${extension}`;
      fs.writeFileSync(
        path.join(root, filename),
        `import { strict } from './policy.mjs';
         import { basename } from 'node:path';
         import { fileURLToPath } from 'node:url';
         await Promise.resolve();
         console.log('fixture config loaded');
         if (basename(fileURLToPath(import.meta.url)) !== ${JSON.stringify(filename)}) throw new Error('config identity changed');
         export default { coverage: { strict }, productState: { requireIdentity: true, critical: 'required.json' } };`,
      );
      const sync = loadStyleProofConfig(nested);
      assert.equal(sync.coverage?.strict, true);
      assert.equal(sync.productState?.requireIdentity, true);
      assert.equal(sync.productState?.critical, 'required.json');
      assert.deepEqual(sync, await loadStyleProofConfigAsync(nested));
    } finally {
      rmTmp(root);
    }
  });

  for (const [label, source, message] of [
    ['syntax error', 'export default {', /could not load/],
    ['evaluation error', "throw new Error('fixture evaluation failed');", /fixture evaluation failed/],
    ['invalid schema', "export default { coverage: { strict: 'yes' } };", /coverage.strict.*boolean/],
    ['function-valued policy', 'export default { requireApproval() {} };', /requireApproval.*boolean/],
    [
      'toJSON omission',
      'export default { coverage: { strict: "yes" }, toJSON() { return {}; } };',
      /coverage.strict.*boolean/,
    ],
  ]) {
    test(`sync ${extension} config fails closed on ${label} instead of reading sibling JSON`, () => {
      const root = mkTmp('styleproof-sync-js-invalid-');
      try {
        fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
        fs.writeFileSync(path.join(root, 'styleproof.config.json'), '{"coverage":{"strict":false}}');
        fs.writeFileSync(path.join(root, `styleproof.config.${extension}`), source);
        assert.throws(() => loadStyleProofConfig(root), message);
      } finally {
        rmTmp(root);
      }
    });
  }
}

test('sync JavaScript config finishes with live handles and flushes queued logs and warnings', () => {
  const root = mkTmp('styleproof-sync-js-handles-');
  try {
    fs.writeFileSync(
      path.join(root, 'styleproof.config.mjs'),
      `setInterval(() => {}, 100);
       setTimeout(() => process.exit(7), 2000);
       console.log('x'.repeat(65536));
       console.error('y'.repeat(65536));
       export default { coverage: { strict: true }, unexpected: true };`,
    );
    const result = spawnSyncBounded(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { loadStyleProofConfig } from ${JSON.stringify(CONFIG_URL)};
       const config = loadStyleProofConfig(${JSON.stringify(root)});
       process.stdout.write(JSON.stringify({ strict: config.coverage.strict }));`,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.error?.message || result.stderr.slice(-1000));
    assert.equal(result.stdout, 'x'.repeat(65536) + '\n{"strict":true}');
    assert.ok(result.stderr.startsWith('y'.repeat(65536) + '\n'));
    assert.match(result.stderr, /unknown key\(s\) ignored: unexpected/);
  } finally {
    rmTmp(root);
  }
});

test('sync JavaScript config retains the actual nested caller cwd for dynamic policy', () => {
  const root = mkTmp('styleproof-sync-js-cwd-');
  try {
    const nested = path.join(root, 'packages', 'widgets');
    fs.mkdirSync(nested, { recursive: true });
    fs.mkdirSync(path.join(root, '.git'));
    fs.writeFileSync(
      path.join(root, 'styleproof.config.mjs'),
      "import { basename } from 'node:path'; export default { requireApproval: basename(process.cwd()) === 'widgets' };",
    );
    const result = spawnSyncBounded(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { loadStyleProofConfig, loadStyleProofConfigAsync } from ${JSON.stringify(CONFIG_URL)};
       process.chdir(${JSON.stringify(nested)});
       const sync = loadStyleProofConfig(); const async = await loadStyleProofConfigAsync();
       process.stdout.write(JSON.stringify({ sync: sync.requireApproval, async: async.requireApproval }));`,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.deepEqual(JSON.parse(result.stdout), { sync: true, async: true });
  } finally {
    rmTmp(root);
  }
});

test('sync JavaScript config honors CommonJS package semantics for .js', async () => {
  const root = mkTmp('styleproof-sync-cjs-');
  try {
    fs.writeFileSync(path.join(root, 'package.json'), '{"type":"commonjs"}');
    fs.writeFileSync(path.join(root, 'policy.cjs'), 'module.exports = { strict: true };');
    fs.writeFileSync(
      path.join(root, 'styleproof.config.js'),
      "module.exports = { coverage: require('./policy.cjs') };",
    );
    assert.equal(loadStyleProofConfig(root).coverage?.strict, true);
    assert.deepEqual(loadStyleProofConfig(root), await loadStyleProofConfigAsync(root));
  } finally {
    rmTmp(root);
  }
});

test('sync JavaScript config preserves the async loader namespace-export fallback', async () => {
  const root = mkTmp('styleproof-sync-js-namespace-');
  try {
    fs.writeFileSync(path.join(root, 'styleproof.config.mjs'), 'export const coverage = { strict: true };');
    assert.equal(loadStyleProofConfig(root).coverage?.strict, true);
    assert.deepEqual(loadStyleProofConfig(root), await loadStyleProofConfigAsync(root));
  } finally {
    rmTmp(root);
  }
});

test('sync JavaScript config validates policy before nested toJSON can omit it', () => {
  const root = mkTmp('styleproof-sync-js-tojson-');
  try {
    fs.writeFileSync(
      path.join(root, 'styleproof.config.mjs'),
      'export default { productState: { requireIdentity() {}, toJSON() { return {}; } } };',
    );
    assert.throws(() => loadStyleProofConfig(root), /requireIdentity.*boolean/);
  } finally {
    rmTmp(root);
  }
});

test('sync JavaScript config retains validated source roots despite inherited toJSON', () => {
  const root = mkTmp('styleproof-sync-js-roots-');
  try {
    fs.writeFileSync(
      path.join(root, 'styleproof.config.mjs'),
      `const roots = ['styles'];
       Object.setPrototypeOf(roots, Object.create(Array.prototype, { toJSON: { value() { return []; } } }));
       export default { ancestorBaseline: { roots } };`,
    );
    assert.deepEqual(loadStyleProofConfig(root).ancestorBaseline.roots, ['styles']);
  } finally {
    rmTmp(root);
  }
});
