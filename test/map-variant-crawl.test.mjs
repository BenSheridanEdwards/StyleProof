import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync(new URL('../bin/styleproof-map.mjs', import.meta.url), 'utf8');
const crawlFunction = source.slice(source.indexOf('function runVariantCrawl('), source.indexOf('// An absolute --dir'));

test('Windows variant crawl falls back to bundled bin when cmd spawn returns EINVAL', () => {
  const env = { STYLEPROOF_WORKERS: '2' };
  const calls = [];
  const context = {
    crawlEnabled: true,
    crawl: { baseUrl: 'http://localhost:3000', out: 'variants.json', routes: ['/'] },
    NAME: 'styleproof-map',
    console: { error() {} },
    process: { platform: 'win32' },
    spawnSync(command, args, options) {
      calls.push({ command, args, options });
      return { error: Object.assign(new Error('spawn EINVAL'), { code: 'EINVAL' }) };
    },
    runBin(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0 };
    },
    fail(name, message) {
      assert.fail(message);
    },
  };
  vm.createContext(context);
  vm.runInContext(crawlFunction, context);
  assert.equal(context.runVariantCrawl(env), 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].command, 'styleproof-variants');
  assert.deepEqual(Array.from(calls[1].args), [
    '--base-url',
    'http://localhost:3000',
    '--out',
    'variants.json',
    '--route',
    '/',
  ]);
  assert.equal(calls[1].options.env, env);
});
