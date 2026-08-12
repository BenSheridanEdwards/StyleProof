import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  browsersRequiredByCaptureConfig,
  evaluateBrowserPreflight,
  playwrightInstallRemedyCommand,
  readCapturePlaywrightConfigText,
  resolveBrowserExecutablePath,
  revisionDirectoryFromExecutablePath,
} from '../dist/browser-preflight.js';
import { mkTmp, rmTmp } from './helpers.mjs';

// Issue #366: a re-provisioned runner comes up with an empty ms-playwright
// cache and every capture dies minutes in at `browserType.launch: Executable
// doesn't exist`. The preflight must catch that BEFORE the first capture and
// hand back the exact remedy, naming the missing revision.

test('evaluateBrowserPreflight: a missing executable returns the exact remedy naming the revision', () => {
  const missingExecutablePath = '/nonexistent/ms-playwright/chromium_headless_shell-1234/chrome-linux/headless_shell';
  const verdict = evaluateBrowserPreflight('chromium', missingExecutablePath);
  assert.equal(verdict.status, 'missing');
  assert.equal(verdict.browserName, 'chromium');
  assert.equal(verdict.revisionDirectory, 'chromium_headless_shell-1234');
  assert.equal(verdict.executablePath, missingExecutablePath);
  assert.equal(verdict.remedyCommand, 'npx playwright install chromium');
  assert.match(verdict.message, /chromium_headless_shell-1234/, 'the remedy names the missing revision');
  assert.match(verdict.message, /npx playwright install chromium/, 'the remedy is the exact command to run');
  assert.match(verdict.message, new RegExp(missingExecutablePath), 'the remedy names the expected executable');
});

test('evaluateBrowserPreflight: an existing executable verifies with its revision', () => {
  const cacheRoot = mkTmp('styleproof-preflight-cache-');
  try {
    const executablePath = path.join(cacheRoot, 'ms-playwright', 'webkit-2092', 'pw_run.sh');
    fs.mkdirSync(path.dirname(executablePath), { recursive: true });
    fs.writeFileSync(executablePath, '#!/bin/sh\n');
    const verdict = evaluateBrowserPreflight('webkit', executablePath);
    assert.equal(verdict.status, 'verified');
    assert.equal(verdict.browserName, 'webkit');
    assert.equal(verdict.revisionDirectory, 'webkit-2092');
    assert.equal(verdict.executablePath, executablePath);
  } finally {
    rmTmp(cacheRoot);
  }
});

test('evaluateBrowserPreflight: an injected existence result keeps the verdict pure', () => {
  const verdict = evaluateBrowserPreflight('chromium', '/anywhere/chromium-1000/chrome', true);
  assert.equal(verdict.status, 'verified');
});

test('revisionDirectoryFromExecutablePath: names the browser-build directory across platforms', () => {
  assert.equal(
    revisionDirectoryFromExecutablePath(
      '/cache/ms-playwright/chromium_headless_shell-1234/chrome-linux/headless_shell',
    ),
    'chromium_headless_shell-1234',
  );
  assert.equal(
    revisionDirectoryFromExecutablePath(
      '/cache/ms-playwright/chromium-1187/chrome-mac/Chromium.app/Contents/MacOS/Chromium',
    ),
    'chromium-1187',
  );
  assert.equal(revisionDirectoryFromExecutablePath('/cache/ms-playwright/webkit-2092/pw_run.sh'), 'webkit-2092');
  assert.equal(
    revisionDirectoryFromExecutablePath('/opt/custom/chrome'),
    'chrome',
    'no revision-shaped segment falls back to the executable name',
  );
});

test('browsersRequiredByCaptureConfig: chromium always; webkit only when the config mentions it', () => {
  assert.deepEqual(browsersRequiredByCaptureConfig(undefined), ['chromium']);
  assert.deepEqual(browsersRequiredByCaptureConfig("projects: [{ use: { browserName: 'chromium' } }]"), ['chromium']);
  assert.deepEqual(browsersRequiredByCaptureConfig("projects: [{ name: 'safari', use: { browserName: 'webkit' } }]"), [
    'chromium',
    'webkit',
  ]);
});

test('playwrightInstallRemedyCommand: the exact command for the missing browsers', () => {
  assert.equal(playwrightInstallRemedyCommand(['chromium']), 'npx playwright install chromium');
  assert.equal(playwrightInstallRemedyCommand(['chromium', 'webkit']), 'npx playwright install chromium webkit');
});

test('readCapturePlaywrightConfigText: prefers the dedicated styleproof config, else the repo config', () => {
  const consumerRoot = mkTmp('styleproof-preflight-config-');
  try {
    assert.equal(readCapturePlaywrightConfigText(consumerRoot), undefined, 'no config file reads as undefined');
    fs.writeFileSync(path.join(consumerRoot, 'playwright.config.ts'), '// repo config\n');
    assert.equal(readCapturePlaywrightConfigText(consumerRoot), '// repo config\n');
    fs.writeFileSync(path.join(consumerRoot, 'playwright.styleproof.config.ts'), '// capture config\n');
    assert.equal(
      readCapturePlaywrightConfigText(consumerRoot),
      '// capture config\n',
      'the dedicated capture config wins over the repo config',
    );
  } finally {
    rmTmp(consumerRoot);
  }
});

test('resolveBrowserExecutablePath: unresolvable without a consumer Playwright, resolved with one', () => {
  const consumerRoot = mkTmp('styleproof-preflight-resolve-');
  try {
    const unresolvable = resolveBrowserExecutablePath(consumerRoot, 'chromium');
    assert.equal(unresolvable.kind, 'unresolvable');
    assert.match(unresolvable.reason, /playwright-core/);

    const fakePlaywrightCoreRoot = path.join(consumerRoot, 'node_modules', 'playwright-core');
    fs.mkdirSync(fakePlaywrightCoreRoot, { recursive: true });
    fs.writeFileSync(
      path.join(fakePlaywrightCoreRoot, 'package.json'),
      '{"name":"playwright-core","main":"index.cjs"}\n',
    );
    fs.writeFileSync(
      path.join(fakePlaywrightCoreRoot, 'index.cjs'),
      'module.exports = { chromium: { executablePath: () => "/fake/ms-playwright/chromium-1187/chrome" } };\n',
    );
    const resolved = resolveBrowserExecutablePath(consumerRoot, 'chromium');
    assert.equal(resolved.kind, 'resolved');
    assert.equal(resolved.executablePath, '/fake/ms-playwright/chromium-1187/chrome');

    const noWebkit = resolveBrowserExecutablePath(consumerRoot, 'webkit');
    assert.equal(noWebkit.kind, 'unresolvable', 'a module without the browser type is unresolvable, not a crash');
  } finally {
    rmTmp(consumerRoot);
  }
});
