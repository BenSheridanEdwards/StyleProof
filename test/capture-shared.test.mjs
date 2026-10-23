import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext, runInContext } from 'node:vm';
import { captureStyleMap } from '../dist/capture.js';
import { capturePage, freezeMotion, injectPathOf, snapSubtree } from '../dist/capture/browser.js';
import { PSEUDO_REFERENCES } from '../dist/pseudo-references.js';
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
  const appSheet = { cssRules: [] };
  const document = {
    styleSheets: [],
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
      cssRules = [];
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
  return { ...harness, page, hooks: harness, context };
}

function computedStyle(properties) {
  const names = Object.keys(properties);
  return {
    ...properties,
    length: names.length,
    item: (index) => names[index],
    getPropertyValue: (name) => properties[name] ?? '',
  };
}

function pseudoPageHarness({ tag = 'p', display = 'block', host = {}, pseudos = {}, defaults = {} } = {}) {
  const harness = capturePageHarness();
  const { context, document } = harness;
  const element = {
    tagName: tag.toUpperCase(),
    getAttribute: () => null,
    matches: (selector) => tag === 'dialog' && selector === ':modal',
    childNodes: [],
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 100, height: 20 }),
    querySelectorAll: () => [],
  };
  const reads = [];
  context.HTMLInputElement = class {};
  context.HTMLTextAreaElement = class {};
  context.CSSImportRule = class {};
  context.window.__spPathOf = () => 'target';
  context.window.__spAssertFrozen = () => {};
  context.getComputedStyle = (_element, pseudo) => {
    reads.push(pseudo ?? null);
    return computedStyle(pseudo ? { content: 'none', ...pseudos[pseudo] } : { display, ...host });
  };
  document.styleSheets = [{ cssRules: [{ cssText: 'p::first-letter {}' }] }];
  document.querySelectorAll = () => [element];
  document.querySelector = () => element;
  document.createElement = () => ({
    style: {},
    remove() {},
    contentDocument: {
      createElement: () => ({}),
      body: { appendChild() {} },
      defaultView: {
        getComputedStyle: (_element, pseudo) => computedStyle(defaults[pseudo ?? 'host'] ?? {}),
      },
    },
  });
  return { ...harness, reads };
}

const pageCaptureArgs = {
  skipSel: '.skip',
  motionOnly: false,
  captureText: false,
  pseudoReferences: PSEUDO_REFERENCES,
};

for (const { name, tag, property, hostValue, value, ua } of [
  {
    name: 'first-letter colour equal to the UA default',
    tag: 'p',
    property: 'color',
    hostValue: 'rgb(200, 0, 0)',
    value: 'rgb(0, 0, 0)',
    ua: 'rgb(0, 0, 0)',
  },
  {
    name: 'first-letter padding equal to the host',
    tag: 'p',
    property: 'padding-top',
    hostValue: '10px',
    value: '10px',
    ua: '0px',
  },
  {
    name: 'backdrop background equal to the host',
    tag: 'dialog',
    property: 'background-color',
    hostValue: 'rgb(255, 255, 255)',
    value: 'rgb(255, 255, 255)',
    ua: 'rgba(0, 0, 0, 0.1)',
  },
]) {
  test(`capture retains ${name} (#979)`, () => {
    const pseudo = tag === 'dialog' ? '::backdrop' : '::first-letter';
    const { run } = pseudoPageHarness({
      tag,
      host: { [property]: hostValue },
      pseudos: { [pseudo]: { [property]: value } },
      defaults: { [pseudo]: { [property]: ua } },
    });
    const map = run(capturePage, pageCaptureArgs);
    assert.equal(map.elements.target.pseudo[pseudo][property], value);
    assert.equal(map.defaults[tag + pseudo][property], ua);
  });
}

test('capture prunes inherited and currentcolor values against their single reference (#979)', () => {
  const host = { color: 'rgb(200, 0, 0)', 'font-family': 'serif', 'border-top-color': 'rgb(200, 200, 200)' };
  const pseudo = {
    content: 'none',
    color: host.color,
    'font-family': host['font-family'],
    'border-top-color': host.color,
  };
  const { run } = pseudoPageHarness({
    host,
    pseudos: { '::first-letter': pseudo, '::first-line': pseudo },
    defaults: { '::first-letter': { content: 'none' }, '::first-line': { content: 'none' } },
  });
  const map = run(capturePage, pageCaptureArgs);
  assert.equal(map.elements.target.pseudo, undefined);
  assert.equal(map.defaults['p::first-letter'], undefined);
  assert.equal(map.defaults['p::first-line'], undefined);
});

for (const display of ['flow-root list-item', 'inline list-item', 'block ruby']) {
  test(`capture reads first boxes on ${display} (#979)`, () => {
    const { run } = pseudoPageHarness({
      display,
      pseudos: { '::first-letter': { color: 'rgb(0, 128, 0)' }, '::first-line': { color: 'rgb(0, 0, 255)' } },
    });
    const map = run(capturePage, pageCaptureArgs);
    assert.equal(map.elements.target.pseudo['::first-letter'].color, 'rgb(0, 128, 0)');
    assert.equal(map.elements.target.pseudo['::first-line'].color, 'rgb(0, 0, 255)');
  });
}

for (const display of ['block', 'flow-root list-item', 'inline list-item']) {
  test(`resting and forced-state capture read markers only on list items: ${display} (#979)`, () => {
    const { run, reads, context } = pseudoPageHarness({
      display,
      pseudos: { '::marker': { color: 'rgb(0, 128, 0)' } },
    });
    const listItem = display.includes('list-item');
    const map = run(capturePage, pageCaptureArgs);
    assert.equal(reads.includes('::marker'), listItem);
    assert.equal(map.elements.target.pseudo?.['::marker']?.color, listItem ? 'rgb(0, 128, 0)' : undefined);
    reads.length = 0;
    const args = {
      selector: 'p',
      skipSel: '',
      skipPaths: [],
      maxElements: 10,
      baselineKey: 'baseline',
      scope: 'target',
    };
    run(snapSubtree, { ...args, saveBaseline: true });
    assert.equal(reads.includes('::marker'), listItem);
    assert.equal(reads.filter((pseudo) => pseudo === null).length, 1, 'host style is read once per element');
    if (listItem) {
      context.getComputedStyle = (_element, pseudo) =>
        computedStyle(pseudo ? { content: 'none' } : { display: 'block' });
      const { delta } = run(snapSubtree, { ...args, saveBaseline: false });
      assert.equal(delta['target::marker'].color, '(gone)');
    }
  });
}

test('forced-state placeholders remain captured when computed content is none (#979)', () => {
  const { run, context, document } = pseudoPageHarness({ pseudos: { '::placeholder': { color: 'rgb(0, 128, 0)' } } });
  Object.setPrototypeOf(document.querySelector(), context.HTMLInputElement.prototype);
  run(snapSubtree, {
    selector: 'input',
    skipSel: '',
    skipPaths: [],
    maxElements: 10,
    baselineKey: 'baseline',
    scope: 'target',
    saveBaseline: true,
  });
  assert.equal(context.window.baseline['target::placeholder'].color, 'rgb(0, 128, 0)');
});

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
