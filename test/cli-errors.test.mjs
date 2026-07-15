import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nonLinuxUploadWarning } from '../dist/cli-errors.js';

test('nonLinuxUploadWarning warns on a non-Linux platform', () => {
  const darwin = nonLinuxUploadWarning('darwin');
  assert.ok(darwin, 'darwin returns a warning');
  assert.match(darwin, /capturing on darwin/);
  assert.match(darwin, /ubuntu-latest.*captures on linux/s);
  assert.match(nonLinuxUploadWarning('win32'), /capturing on win32/);
});

test('nonLinuxUploadWarning is silent on Linux — a Linux capture matches Linux CI', () => {
  assert.equal(nonLinuxUploadWarning('linux'), null);
});

test('nonLinuxUploadWarning honours the suppression flag on any platform', () => {
  assert.equal(nonLinuxUploadWarning('darwin', true), null);
  assert.equal(nonLinuxUploadWarning('linux', true), null);
});
