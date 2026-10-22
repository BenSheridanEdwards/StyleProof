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

/** Plant a fake `moduleName` package in `root`'s node_modules, with `version`
 *  in its package.json when given. */
function writeModule(root, moduleName, source, version) {
  const moduleRoot = path.join(root, 'node_modules', ...moduleName.split('/'));
  fs.mkdirSync(moduleRoot, { recursive: true });
  fs.writeFileSync(
    path.join(moduleRoot, 'package.json'),
    JSON.stringify({ name: moduleName, version, main: 'index.cjs' }),
  );
  fs.writeFileSync(path.join(moduleRoot, 'index.cjs'), source);
}

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
  const emptyConsumerRoot = mkTmp('styleproof-preflight-empty-');
  const resolvedConsumerRoot = mkTmp('styleproof-preflight-resolved-');
  try {
    // Shadow any Playwright dependency available from an ancestor workspace. The
    // consumer boundary is the fixture's node_modules, not wherever TMPDIR happens
    // to live on this host.
    for (const moduleName of ['playwright-core', '@playwright/test']) {
      writeModule(emptyConsumerRoot, moduleName, 'module.exports = {};\n');
    }
    const unresolvable = resolveBrowserExecutablePath(emptyConsumerRoot, 'chromium');
    assert.equal(unresolvable.kind, 'unresolvable');
    assert.match(unresolvable.reason, /playwright-core/);

    writeModule(
      resolvedConsumerRoot,
      'playwright-core',
      'module.exports = { chromium: { executablePath: () => "/fake/ms-playwright/chromium-1187/chrome" } };\n',
    );
    writeModule(resolvedConsumerRoot, '@playwright/test', 'module.exports = {};\n');
    const resolved = resolveBrowserExecutablePath(resolvedConsumerRoot, 'chromium');
    assert.equal(resolved.kind, 'resolved');
    assert.equal(
      resolved.executablePath,
      '/fake/ms-playwright/chromium-1187/chrome',
      'a Playwright with no readable version keeps the reported path',
    );

    const noWebkit = resolveBrowserExecutablePath(resolvedConsumerRoot, 'webkit');
    assert.equal(noWebkit.kind, 'unresolvable', 'a module without the browser type is unresolvable, not a crash');
  } finally {
    rmTmp(emptyConsumerRoot);
    rmTmp(resolvedConsumerRoot);
  }
});

// Issue #980: Playwright 1.49+ reports the full `chromium-<rev>` build from
// chromium.executablePath(), but a headless launch with no channel (every
// StyleProof capture by default) opens the separate `chromium_headless_shell-<rev>`
// build. The preflight must verify the build the capture actually launches.
// Releases before 1.49 have no headless shell and launch the full build.

/** A consumer whose fake playwright-core `playwrightVersion` reports the full
 *  Chromium build at `<root>/ms-playwright/chromium-1187/…`, with nothing
 *  installed yet. */
function withFakeChromiumConsumer(
  run,
  playwrightVersion = '1.49.0',
  fullBuildRelativePath = path.join('chrome-linux64', 'chrome'),
) {
  const consumerRoot = mkTmp('styleproof-preflight-chromium-');
  const browsersRoot = path.join(consumerRoot, 'ms-playwright');
  const fullBuildExecutable = path.join(browsersRoot, 'chromium-1187', fullBuildRelativePath);
  writeModule(
    consumerRoot,
    'playwright-core',
    `module.exports = { chromium: { executablePath: () => ${JSON.stringify(fullBuildExecutable)} } };\n`,
    playwrightVersion,
  );
  const install = (relativePath) => {
    const installedFile = path.join(browsersRoot, relativePath);
    fs.mkdirSync(path.dirname(installedFile), { recursive: true });
    fs.writeFileSync(installedFile, '');
  };
  const preflight = (configText) => {
    const resolution = resolveBrowserExecutablePath(consumerRoot, 'chromium', configText);
    assert.equal(resolution.kind, 'resolved');
    return evaluateBrowserPreflight('chromium', resolution.executablePath);
  };
  try {
    run({ install, preflight });
  } finally {
    rmTmp(consumerRoot);
  }
}

test('browser preflight: only the full chromium build installed is missing the headless shell a capture launches', () => {
  withFakeChromiumConsumer(({ install, preflight }) => {
    install(path.join('chromium-1187', 'chrome-linux64', 'chrome'));
    const fullBuildOnly = preflight(undefined);
    assert.equal(fullBuildOnly.status, 'missing', 'the full build alone cannot serve a headless capture');
    assert.equal(fullBuildOnly.revisionDirectory, 'chromium_headless_shell-1187');
    assert.match(fullBuildOnly.message, /chromium_headless_shell-1187/, 'the remedy names the headless shell build');
    assert.equal(fullBuildOnly.remedyCommand, 'npx playwright install chromium');
  });
});

test('browser preflight: an empty cache is still missing the chromium headless shell', () => {
  withFakeChromiumConsumer(({ preflight }) => {
    const emptyCache = preflight(undefined);
    assert.equal(emptyCache.status, 'missing');
    assert.equal(emptyCache.revisionDirectory, 'chromium_headless_shell-1187');
  });
});

test('browser preflight: a shell install marker without its executable is missing', () => {
  withFakeChromiumConsumer(({ install, preflight }) => {
    install(path.join('chromium_headless_shell-1187', 'INSTALLATION_COMPLETE'));
    const markerOnly = preflight(undefined);
    assert.equal(markerOnly.status, 'missing');
    assert.equal(markerOnly.revisionDirectory, 'chromium_headless_shell-1187');
    assert.equal(markerOnly.remedyCommand, 'npx playwright install chromium');
    assert.match(markerOnly.executablePath, /chrome-headless-shell-linux64[/\\]chrome-headless-shell$/);
  }, '1.61.1');
});

test('browser preflight: a shell executable without its install marker is missing', () => {
  withFakeChromiumConsumer(({ install, preflight }) => {
    install(path.join('chromium_headless_shell-1187', 'chrome-headless-shell-linux64', 'chrome-headless-shell'));
    assert.equal(preflight(undefined).status, 'missing');
  });
});

test('browser preflight: only the chromium headless shell installed verifies without a reinstall', () => {
  withFakeChromiumConsumer(({ install, preflight }) => {
    install(path.join('chromium_headless_shell-1187', 'INSTALLATION_COMPLETE'));
    install(path.join('chromium_headless_shell-1187', 'chrome-headless-shell-linux64', 'chrome-headless-shell'));
    const shellOnly = preflight(undefined);
    assert.equal(shellOnly.status, 'verified', 'a headless capture launches the shell, so no install is needed');
    assert.equal(shellOnly.revisionDirectory, 'chromium_headless_shell-1187');
  });
});

for (const configText of [
  'use: { headless: false }',
  'use: { "headless": false }',
  "use: { channel: 'chromium' }",
  'use: { "channel": "chromium" }',
  "use: { 'channel': 'chromium' }",
  "use: { channel: 'chrome-for-testing' }",
  'use: { "channel": "chrome-for-testing" }',
]) {
  test(`browser preflight: ${configText} requires the full chromium build`, () => {
    withFakeChromiumConsumer(({ install, preflight }) => {
      install(path.join('chromium_headless_shell-1187', 'INSTALLATION_COMPLETE'));
      install(path.join('chromium_headless_shell-1187', 'chrome-headless-shell-linux64', 'chrome-headless-shell'));
      const shellOnly = preflight(configText);
      assert.equal(shellOnly.status, 'missing', 'the shell cannot serve a full-build capture');
      assert.equal(shellOnly.revisionDirectory, 'chromium-1187');
      install(path.join('chromium-1187', 'chrome-linux64', 'chrome'));
      assert.equal(preflight(configText).status, 'verified');
    });
  });
}

for (const [fullBuildPath, shellPath] of [
  ['chrome-linux/chrome', 'chrome-linux/headless_shell'],
  ['chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-mac/headless_shell'],
  ['chrome-win/chrome.exe', 'chrome-win/headless_shell.exe'],
  ['chrome-linux64/chrome', 'chrome-headless-shell-linux64/chrome-headless-shell'],
  [
    'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-headless-shell-mac-x64/chrome-headless-shell',
  ],
  [
    'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-headless-shell-mac-arm64/chrome-headless-shell',
  ],
  ['chrome-win64/chrome.exe', 'chrome-headless-shell-win64/chrome-headless-shell.exe'],
]) {
  test(`browser preflight: verifies the shell executable for ${fullBuildPath}`, () => {
    withFakeChromiumConsumer(
      ({ install, preflight }) => {
        install(path.join('chromium_headless_shell-1187', 'INSTALLATION_COMPLETE'));
        assert.equal(preflight().status, 'missing', 'the marker alone cannot verify this layout');
        install(path.join('chromium_headless_shell-1187', shellPath));
        const installed = preflight();
        assert.equal(installed.status, 'verified');
        assert.ok(installed.executablePath.endsWith(path.normalize(shellPath)));
      },
      '1.61.1',
      path.normalize(fullBuildPath),
    );
  });
}

test('browser preflight: an unknown shell layout is unresolvable even with the full build installed', () => {
  const consumerRoot = mkTmp('styleproof-preflight-unknown-');
  try {
    const executablePath = path.join(consumerRoot, 'chromium-1187', 'unknown-layout', 'chrome');
    fs.mkdirSync(path.dirname(executablePath), { recursive: true });
    fs.writeFileSync(executablePath, '');
    writeModule(
      consumerRoot,
      'playwright-core',
      `module.exports = { chromium: { executablePath: () => ${JSON.stringify(executablePath)} } };`,
      '1.61.1',
    );
    const resolution = resolveBrowserExecutablePath(consumerRoot, 'chromium');
    assert.equal(resolution.kind, 'unresolvable');
    assert.match(resolution.reason, /unknown Chromium headless shell layout/);
  } finally {
    rmTmp(consumerRoot);
  }
});

test('browser preflight: a Playwright release without the headless shell verifies the full chromium build', () => {
  withFakeChromiumConsumer(({ install, preflight }) => {
    install(path.join('chromium-1187', 'chrome-linux64', 'chrome'));
    const fullBuildOnly = preflight(undefined);
    assert.equal(fullBuildOnly.status, 'verified', 'a headless capture on this release launches the full build');
    assert.equal(fullBuildOnly.revisionDirectory, 'chromium-1187');
  }, '1.48.2');
});
