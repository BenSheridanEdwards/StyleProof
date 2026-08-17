import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeSpecPathEnv,
  encodeSpecPath,
  harnessMissingAtRef,
  SPEC_PATH_ENV,
  validateRepoRelativeSpecPath,
} from '../bin/spec-path-env.mjs';

test('spec path environment round-trips hostile Unicode and shell syntax as data', () => {
  const path = "tests/${{ github.token }}/$()`'\u2028proof.spec.ts";
  const encoded = encodeSpecPath(path);
  assert.match(encoded, /^[A-Za-z0-9+/]+=*$/);
  assert.equal(decodeSpecPathEnv({ [SPEC_PATH_ENV]: encoded }), path);
});

test('spec path environment rejects malformed base64, invalid UTF-8, repository escapes, and oversized values', () => {
  assert.throws(() => decodeSpecPathEnv({ [SPEC_PATH_ENV]: '${{ nope }}' }), /not valid base64/);
  assert.throws(() => decodeSpecPathEnv({ [SPEC_PATH_ENV]: 'YR==' }), /canonical base64/);
  assert.throws(() => decodeSpecPathEnv({ [SPEC_PATH_ENV]: '/w==' }), /not valid UTF-8/);
  assert.throws(() => validateRepoRelativeSpecPath('../outside.spec.ts'), /inside the repository/);
  assert.throws(() => validateRepoRelativeSpecPath('/tmp/outside.spec.ts'), /inside the repository/);
  for (const drivePath of ['C:../outside.spec.ts', 'C:..\\outside.spec.ts', 'D:proof.spec.ts']) {
    assert.throws(() => validateRepoRelativeSpecPath(drivePath), /inside the repository/);
  }
  assert.equal(validateRepoRelativeSpecPath('a'.repeat(4096)), 'a'.repeat(4096));
  assert.throws(() => validateRepoRelativeSpecPath('a'.repeat(4097)), /4096 UTF-8 bytes/);
});

test('first-adoption harness selection treats spec and Playwright config independently', () => {
  const spec = 'e2e/styleproof.spec.ts';
  const scenarios = [
    { files: [spec, 'playwright.styleproof.config.ts'], missing: false },
    { files: [spec], missing: true },
    { files: ['playwright.styleproof.config.ts'], missing: true },
    { files: [], missing: true },
  ];
  for (const scenario of scenarios) {
    const existing = new Set(scenario.files);
    assert.equal(
      harnessMissingAtRef(spec, '', (file) => existing.has(file)),
      scenario.missing,
    );
  }

  const probed = [];
  assert.equal(
    harnessMissingAtRef(spec, 'packages/hud', (file) => {
      probed.push(file);
      return true;
    }),
    false,
  );
  assert.deepEqual(probed, ['packages/hud/e2e/styleproof.spec.ts', 'packages/hud/playwright.styleproof.config.ts']);
});
