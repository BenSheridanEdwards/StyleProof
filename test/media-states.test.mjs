import fileSystem from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  mkTmp as makeTemporaryDirectory,
  rmTmp as removeTemporaryDirectory,
  spawnSyncToCompletion as spawnSynchronouslyToCompletion,
} from './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateMediaStates, mediaStateFeatures, applyMediaState } from '../dist/media-states.js';
import { expandSurfaceVariants, assertUniqueExpandedKeys } from '../dist/runner.js';
import { captureOptionsFor, resolveSettings } from '../dist/runner/settings.js';

const surface = { key: 'home', go: async () => {} };
const dark = { key: 'dark', colorScheme: 'dark' };

test('mediaStates validates supported features and copies declarations', () => {
  assert.deepEqual(validateMediaStates(undefined), []);
  assert.deepEqual(validateMediaStates([]), []);
  const declaration = { key: 'print-contrast', media: 'print', forcedColors: 'active', colorScheme: 'light' };
  assert.deepEqual(validateMediaStates([declaration]), [declaration]);
  assert.notEqual(validateMediaStates([declaration])[0], declaration);

  for (const value of [null, {}, 'dark', [null], [[]], [{}], [{ key: 'dark' }], new Array(1)]) {
    assert.throws(() => validateMediaStates(value), /mediaStates/);
  }
});

test('mediaStates rejects unsafe keys, unsupported values, and reducedMotion', () => {
  for (const key of ['', '../dark', 'dark/light', ' dark', 'C:dark']) {
    assert.throws(() => validateMediaStates([{ ...dark, key }]));
  }

  for (const feature of [
    { colorScheme: 'no-preference' },
    { media: 'speech' },
    { forcedColors: true },
    { colorScheme: undefined },
    { reducedMotion: 'reduce' },
    { contrast: 'more' },
    { constructor: 'dark' },
  ]) {
    assert.throws(() => validateMediaStates([{ ...dark, ...feature }]), /mediaStates/);
  }
});

test('mediaStates adds base and explicit variant copies with provenance, excluding recipes and live states', async () => {
  const calls = [];

  const captures = expandSurfaceVariants({
    ...surface,
    mediaStates: [dark, { key: 'print', media: 'print' }],
    widths: [800],
    ignore: ['.clock'],
    popups: true,
    go: async () => calls.push('navigate'),
    variants: [{ key: 'open', setup: async () => calls.push('setup'), go: async () => calls.push('open') }],
    stateRecipes: [{ action: 'focus', selector: 'button', stateKey: 'focused' }],
  });

  assert.deepEqual(
    captures.map((capture) => capture.key),
    ['home', 'home-open', 'home-focused', 'home-dark', 'home-print', 'home-open-dark', 'home-open-print'],
  );
  const mediaCapture = captures.find((capture) => capture.key === 'home-open-dark');
  assert.deepEqual(mediaCapture.metadata, {
    surfaceKey: 'home',
    variantKey: 'open-dark',
    variantKind: 'variant',
    mediaState: dark,
  });
  assert.deepEqual(mediaCapture.widths, [800]);
  assert.deepEqual(mediaCapture.ignore, ['.clock']);
  assert.equal(mediaCapture.popups, false);
  await mediaCapture.go({ emulateMedia: async (features) => calls.push(features) });
  assert.deepEqual(calls, [
    { colorScheme: 'dark', media: null, forcedColors: null, reducedMotion: 'reduce' },
    'setup',
    'navigate',
    'open',
  ]);
  assert.deepEqual(
    expandSurfaceVariants({ ...surface, mediaStates: [dark], liveStates: [{ key: 'loaded' }] }).map(
      (capture) => capture.key,
    ),
    ['home-loaded'],
  );
});

test('surface media declarations override global options, including an empty opt-out', () => {
  const settings = resolveSettings({ dir: 'media', freezeClock: false, mediaStates: [dark] });
  assert.deepEqual(settings.mediaStates, [dark]);
  assert.equal(captureOptionsFor(surface, settings, () => 0).mediaStatesDeclared, true);
  assert.equal(captureOptionsFor({ ...surface, mediaStates: [] }, settings, () => 0).mediaStatesDeclared, false);
  assert.deepEqual(
    expandSurfaceVariants({ ...surface, mediaStates: [] }).map((capture) => capture.key),
    ['home'],
  );
});

test('media expansion detects duplicate, ambiguous and case-folded capture keys', () => {
  for (const mediaStates of [
    [dark, dark],
    [dark, { ...dark, key: 'DARK' }],
  ]) {
    assert.throws(() => assertUniqueExpandedKeys(expandSurfaceVariants({ ...surface, mediaStates })), /capture key/);
  }

  assert.throws(
    () =>
      assertUniqueExpandedKeys(
        expandSurfaceVariants({
          ...surface,
          mediaStates: [dark],
          variants: [{ key: 'dark' }],
        }),
      ),
    /capture key/,
  );
});

test('resetting a shared page clears declared features while ordinary captures preserve consumer media', async () => {
  const calls = [];
  const page = { emulateMedia: async (features) => calls.push(features) };
  await applyMediaState(page);
  await applyMediaState(page, dark);
  await applyMediaState(page);
  assert.deepEqual(calls, [
    { reducedMotion: 'reduce' },
    { colorScheme: 'dark', media: null, forcedColors: null, reducedMotion: 'reduce' },
    { colorScheme: null, media: null, forcedColors: null, reducedMotion: 'reduce' },
  ]);
});

test('media discovery names only the supported condition vocabulary', () => {
  assert.deepEqual(
    mediaStateFeatures([
      '(prefers-color-scheme: dark)',
      'not print and (min-width: 800px)',
      '(forced-colors: active)',
      '(prefers-contrast: more)',
    ]),
    ['prefers-color-scheme', 'print', 'forced-colors', 'prefers-contrast'],
  );
  assert.deepEqual(
    mediaStateFeatures(['(min-width: 800px)', '(prefers-reduced-motion: reduce)', '(pointer: fine)']),
    [],
  );
});

test('runner global media declarations expand keys and surface overrides replace them', () => {
  const captureDeclarations = listCaptureDeclarations(`
    defineStyleMapCapture({ dir: 'media', freezeClock: false, mediaStates: [{ key: 'dark', colorScheme: 'dark' }], surfaces: [
      { key: 'home', widths: [800], go: async () => {}, variants: [{ key: 'open' }] },
      { key: 'settings', widths: [800], mediaStates: [{ key: 'print', media: 'print' }], go: async () => {} },
      { key: 'account', widths: [800], mediaStates: [], go: async () => {} },
    ] });
  `);

  assert.deepEqual(captureDeclarations, [
    'home',
    'home-open',
    'home-dark',
    'home-open-dark',
    'settings',
    'settings-print',
    'account',
  ]);
});

function listCaptureDeclarations(declarations) {
  const directory = makeTemporaryDirectory('styleproof-media-list-');

  try {
    const specification = path.join(directory, 'capture.spec.mjs');
    const configuration = path.join(directory, 'playwright.config.mjs');
    fileSystem.writeFileSync(
      specification,
      `import { defineStyleMapCapture } from ${JSON.stringify(pathToFileURL(path.resolve('dist/index.js')).href)};\n${declarations}`,
    );
    fileSystem.writeFileSync(configuration, `export default { testDir: ${JSON.stringify(directory)} };`);

    const result = spawnSynchronouslyToCompletion(
      process.execPath,
      [path.resolve('node_modules/@playwright/test/cli.js'), 'test', '--list', '--config', configuration],
      {
        encoding: 'utf8',
        env: { ...process.env, STYLEPROOF_BASE_MAPS: '', STYLEPROOF_ONLY_SURFACES: undefined },
      },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);

    return [...result.stdout.matchAll(/› ([\w-]+) @ 800/g)].map((match) => match[1]);
  } finally {
    removeTemporaryDirectory(directory);
  }
}

test('media advice is emitted once across worker processes sharing a capture run', () => {
  const directory = makeTemporaryDirectory('styleproof-media-warning-');

  try {
    const moduleLocation = pathToFileURL(path.resolve('dist/media-states.js')).href;

    const source = `import { warnUndeclaredMediaStates } from ${JSON.stringify(moduleLocation)};
      await warnUndeclaredMediaStates({ evaluate: async () => ({ mediaTexts: ['print', '(prefers-color-scheme: dark)'] }) }, { mediaWarningScope: ${JSON.stringify(directory)} });`;

    const warnings = [0, 1].map(() => {
      const result = spawnSynchronouslyToCompletion(process.execPath, ['--input-type=module', '--eval', source], {
        encoding: 'utf8',
      });

      assert.equal(result.status, 0, result.stderr || result.stdout);

      return result.stderr;
    });

    assert.match(warnings[0], /prefers-color-scheme, print.*mediaStates/);
    assert.equal(warnings[1], '');
  } finally {
    removeTemporaryDirectory(directory);
  }
});
