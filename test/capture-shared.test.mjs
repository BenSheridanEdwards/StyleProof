import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext, runInContext } from 'node:vm';
import { captureStyleMap } from '../dist/capture.js';
import { freezeMotion, injectPathOf, snapSubtree } from '../dist/capture/browser.js';
import { skipSelector } from '../dist/capture/shared.js';

test('skipSelector: a selector-list entry skips the descendants of every selector in it (#981)', () => {
  // `.ticker, .clock *` would only reach children of .clock; the descendant
  // clause must group the whole list so children of .ticker are skipped too.
  assert.equal(skipSelector(['.ticker, .clock']), '.ticker, .clock, :is(.ticker, .clock) *');
});

test('skipSelector: nothing ignored is the empty selector', () => {
  assert.equal(skipSelector([]), '');
});

// Execute the serialized callbacks in an isolated page realm; no browser or timing races.
function capturePageHarness() {
  const appSheet = {};
  const document = {
    adoptedStyleSheets: [appSheet],
    documentElement: { scrollHeight: 600, matches: () => true },
    body: { matches: () => true, appendChild() {} },
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ style: {}, contentDocument: {}, remove() {} }),
  };
  const context = createContext({
    window: { scrollX: 0, scrollY: 0 },
    document,
    CSSStyleSheet: class {
      disabled = false;
      replaceSync() {}
    },
  });
  const run = (fn, arg) => runInContext(`(${fn.toString()})(${JSON.stringify(arg)})`, context);
  const harness = {
    document,
    appSheet,
    run,
    afterRead() {},
    onWait() {},
  };
  const page = {
    mouse: { move: async () => {} },
    emulateMedia: async () => {},
    viewportSize: () => ({ width: 800, height: 600 }),
    waitForTimeout: async () => harness.onWait(),
    evaluate: async (fn, arg) => {
      let result;
      switch (fn.name) {
        case 'freezeMotion':
        case 'unfreezeMotion':
        case 'capturePage':
          result = run(fn, arg);
          break;
        case 'detectLiveCandidates':
        case 'detectOverlayCandidates':
          result = [];
          break;
        case 'capturePageTokens':
          result = {};
          break;
        case 'expandInnerScrollContainers':
          result = 0;
          break;
        case 'measureExpandedRects':
          result = { rects: {}, screenshotHeight: 600 };
          break;
        case 'installHoverSink':
        case 'injectPathOf':
        case 'restoreInnerScrollContainers':
        case '': // focus blur
          break;
        default:
          throw new Error(`Unexpected page callback: ${fn.name}`);
      }
      harness.afterRead(fn.name, arg);
      return result;
    },
  };
  return { ...harness, page, hooks: harness };
}

const captureOptions = { captureStates: false, stabilize: false };
const freezeError = /styleproof: motion freeze was removed or disabled during capture/;

for (const phase of ['settle', 'capture']) {
  test(`captureStyleMap rejects adopted-sheet replacement during ${phase}`, async () => {
    const { page, document } = capturePageHarness();
    await assert.rejects(
      captureStyleMap(page, {
        ...captureOptions,
        onPhase: (current) => {
          if (current === phase) document.adoptedStyleSheets = [{}];
        },
      }),
      freezeError,
    );
  });
}

test('captureStyleMap rejects adopted-sheet replacement between stabilization polls', async () => {
  const { page, document, hooks } = capturePageHarness();
  hooks.onWait = () => {
    document.adoptedStyleSheets = [];
  };
  await assert.rejects(
    captureStyleMap(page, {
      ...captureOptions,
      stabilize: { interval: 1, quietFor: 1, timeout: 100, waitForRequests: false },
    }),
    freezeError,
  );
});

test('captureStyleMap rejects adopted-sheet replacement inside a frozen snapshot', async () => {
  const { page, document } = capturePageHarness();
  document.body.appendChild = () => {
    // The motion-only read deliberately has no freeze; replace sheets only during the frozen read.
    if (document.adoptedStyleSheets.length > 1) document.adoptedStyleSheets = [];
  };
  await assert.rejects(captureStyleMap(page, captureOptions), freezeError);
});

for (const read of ['capturePage', 'detectOverlayCandidates', 'capturePageTokens']) {
  test(`captureStyleMap rejects adopted-sheet replacement after ${read}`, async () => {
    const { page, document, hooks } = capturePageHarness();
    hooks.afterRead = (name, args) => {
      if (name === read && !args?.motionOnly) document.adoptedStyleSheets = [{}];
    };
    await assert.rejects(captureStyleMap(page, captureOptions), freezeError);
    assert.equal(document.adoptedStyleSheets.length, 1, 'cleanup preserves the replacement app sheet');
  });
}

test('captureStyleMap rejects adopted-sheet replacement during reach stop, outside cleanup', async () => {
  const { page, document } = capturePageHarness();
  const servedRules = {
    start: async () => {},
    stop: async () => {
      document.adoptedStyleSheets = [];
      return {};
    },
  };
  await assert.rejects(captureStyleMap(page, { ...captureOptions, captureReach: true, servedRules }), freezeError);
});

test('captureStyleMap preserves app sheets and cleans up its freeze across repeated captures', async () => {
  const { page, document, appSheet } = capturePageHarness();
  for (let attempt = 0; attempt < 2; attempt++) {
    const map = await captureStyleMap(page, {
      ...captureOptions,
      onPhase: () => {
        // Replacing the list is safe when it retains the actual freeze sheet.
        document.adoptedStyleSheets = [...document.adoptedStyleSheets];
      },
    });
    assert.equal(Object.keys(map.elements).length, 0);
    assert.deepEqual(Array.from(document.adoptedStyleSheets), [appSheet]);
  }
});

test('captureStyleMap rejects a disabled freeze sheet', async () => {
  const { page, document, appSheet } = capturePageHarness();
  await assert.rejects(
    captureStyleMap(page, {
      ...captureOptions,
      onPhase: () => {
        document.adoptedStyleSheets.find((sheet) => sheet !== appSheet).disabled = true;
      },
    }),
    freezeError,
  );
});

test('forced-state snapshots reject adopted-sheet replacement while frozen', () => {
  const { document, run } = capturePageHarness();
  run(freezeMotion, '*,*::before,*::after{animation:none!important;transition:none!important}');
  document.adoptedStyleSheets = [];
  assert.throws(() => run(snapSubtree, {}), freezeError);
});

test('forced-state snapshots reject adopted-sheet replacement during a read', () => {
  const { document, run } = capturePageHarness();
  run(injectPathOf);
  run(freezeMotion, '*,*::before,*::after{animation:none!important;transition:none!important}');
  document.body.querySelectorAll = () => [];
  document.querySelector = () => {
    document.adoptedStyleSheets = [];
    return document.body;
  };
  assert.throws(
    () => run(snapSubtree, { selector: 'body', skipSel: '*', skipPaths: [], maxElements: 10, saveBaseline: true }),
    freezeError,
  );
});
