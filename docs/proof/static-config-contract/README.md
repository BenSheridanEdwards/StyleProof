# Static configuration contract proof

These are fresh, self-attested local command results for source commit
`41ae5c19fbf05ceeecb7096ad484a43b7e46bc6b`. The candidate was not published.

The identical regression test runs against main commit
`b9bc0169dcd3082f7655477c52623e1b224737e6` and the repaired source:

- [Before](before.log): 1 passed, 9 failed. The JSON path was selected, but an
  incorrect deprecation warning told users to migrate to the broken format.
  Module configs fell through to JSON or defaults, and init generated an
  unsupported TypeScript config.
- [After](after.log): all 10 passed. JSON remains supported. Every reserved
  module filename is rejected before parsing JSON or executing module code,
  including when JSON also exists. Fresh init generates no project config file.
- [Packed package smoke](packed-node-smoke.log): actual Node 18.20.8, 20.20.2,
  and 22.22.2 pass against an installed tarball, without a repository symlink.
  The replay script below checks initialization, the JSON spec path,
  all three module rejections without side effects, and malformed JSON.

Run the regression with `npm run build` followed by
`node --test test/config-release-contract.test.mjs`. Run the packed smoke with
`node packed-smoke.mjs <installed-styleproof-package-directory>` after installing
the candidate tarball and its Playwright peer into a clean consumer.

[Provenance](provenance.json) records source/test/artifact hashes, package hash,
verified package contents, and broader results: 1,407 unit tests passed;
253 Chromium tests passed with one expected non-Chromium skip.

Screenshots and video are not applicable: this contract is a CLI/configuration
boundary with no rendered UI. These logs do not certify a public release or
replace hosted checks on the final PR head.

## Packed consumer replay

Save this code as `packed-smoke.mjs` and run it with each Node version against
the installed candidate package directory. It is documentation, not a package
runtime entry point.

```javascript
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const packageRoot = process.argv[2];
assert.ok(fs.existsSync(path.join(packageRoot, 'package.json')));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-packed-config-'));
const moduleNames = ['styleproof.config.ts', 'styleproof.config.mjs', 'styleproof.config.js'];
const run = (binary, args) => spawnSync(process.execPath, [path.join(packageRoot, 'bin', binary), ...args], {
  cwd: root, encoding: 'utf8', timeout: 15000,
});
try {
  const init = run('styleproof-init.mjs', ['--external-server']);
  assert.equal(init.status, 0, init.stderr);
  assert.ok(fs.existsSync(path.join(root, 'e2e/styleproof.spec.ts')));
  for (const name of moduleNames) assert.equal(fs.existsSync(path.join(root, name)), false);
  const json = path.join(root, 'styleproof.config.json');
  fs.writeFileSync(json, JSON.stringify({ spec: 'custom-proof.spec.ts' }));
  const mapped = run('styleproof-map.mjs', ['--no-upload']);
  assert.equal(mapped.status, 2, mapped.stderr);
  assert.match(mapped.stderr, /no StyleProof spec at custom-proof\.spec\.ts/);
  assert.doesNotMatch(mapped.stderr, /deprecated/);
  for (const name of moduleNames) {
    const file = path.join(root, name);
    const sentinel = path.join(root, 'executed.txt');
    fs.writeFileSync(file, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(sentinel)}, 'executed'); export default {};`);
    const result = run('styleproof-map.mjs', ['--no-upload']);
    assert.equal(result.status, 2, result.stderr);
    assert.ok(result.stderr.startsWith(`styleproof-map: ${name}: module configuration`), result.stderr);
    assert.equal(fs.existsSync(sentinel), false);
    fs.unlinkSync(file);
  }
  fs.writeFileSync(json, '{');
  const malformed = run('styleproof-map.mjs', ['--no-upload']);
  assert.equal(malformed.status, 2, malformed.stderr);
  assert.match(malformed.stderr, /invalid JSON/);
  console.log(`${process.version}: PASS packed init, static JSON spec, all three module rejections without execution, malformed JSON`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
```

## Hosted timing failure and test repair

The first hosted run on `aae57a9b` found an existing test race in the third
phase of the transient-state test: a 75 ms toast was expected to survive a
50 ms observation before testing the separate pre-capture guard.
[The failed job](https://github.com/BenSheridanEdwards/StyleProof/actions/runs/34530151971/job/103048631057)
records the failure before that intended guard was reached.

Test-only commit `dd4a58f2d94cec6c644ef41a35720a14d95a8bee` observes a persistent
toast, removes it explicitly, then requires the same pre-capture failure. The
first successful observation and the negative continuous-visibility case are
unchanged; no production timing, threshold, assertion, or retry is relaxed.

[Twenty repeated runs](transient-repeat.log) pass with four workers and no
retries. The log retains harmless conflicting color-environment warnings.
The affected Chromium shard also passed all 84 tests locally. These are
additional test-only results; the earlier full-suite and packed-package
results above remain bound to the original source commit.
