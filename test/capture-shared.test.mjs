import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext, runInContext } from 'node:vm';
import { captureStyleMap } from '../dist/capture.js';
import {
  capturePage,
  capturePageChanges,
  freezeMotion,
  injectPathOf,
  snapSessionBaseline,
  snapSubtree,
} from '../dist/capture/browser.js';
import { PSEUDO_REFERENCES } from '../dist/pseudo-references.js';
import { skipSelector } from '../dist/capture/shared.js';
import { captureForcedStates, resolveForcedStateLimits } from '../dist/capture/forced-states.js';

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
      if (typeof fn === 'string') return runInContext(fn, context);
      let result;
      switch (fn.name) {
        case 'freezeMotion':
        case 'unfreezeMotion':
        case 'capturePage':
        case 'capturePageChanges':
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
          break;
        case '': // focus blur or settle-store cleanup
          if (typeof arg === 'string') result = run(fn, arg);
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

// The same isolated page realm also executes the real CDP snapshot expressions.
function forcedStateHarness({
  scope = 'document',
  legacy,
  drift,
  settled,
  unsupported,
  resetFailures = 0,
  replaceDocument = false,
  removeAfterReset,
} = {}) {
  const { context, document, run } = capturePageHarness();
  const nodes = [];
  const make = (path, parentElement, button = false) => {
    const element = {
      path,
      parentElement,
      button,
      children: [],
      attrs: {},
      matches: (selector) => selector.includes('.skip') && path.includes(' > output'),
      setAttribute(name, value) {
        this.attrs[name] = value;
      },
      removeAttribute(name) {
        delete this.attrs[name];
      },
      querySelectorAll() {
        return this.children.flatMap((child) => [child, ...child.querySelectorAll()]);
      },
      computedStyleMap: () => ({ get: () => (drift === 'typed' && revision ? '1px' : 'auto') }),
    };
    parentElement?.children.push(element);
    nodes.push(element);
    return element;
  };
  document.documentElement = make('html');
  document.body = make('body', document.documentElement);
  for (let i = 0; i < 20; i++) {
    const parent = scope === 'parent' ? document.body : make(`body > section:nth-child(${i + 1})`, document.body);
    const button = make(`${parent.path} > button:nth-child(${i + 1})`, parent, true);
    make(`${button.path} > span`, button);
    make(`${parent.path} > output:nth-child(${i + 1})`, parent);
  }
  if (unsupported) nodes.at(-1).computedStyleMap = undefined;
  const targets = nodes.filter((node) => node.button);
  document.querySelectorAll = (selector) => {
    if (selector === 'body *') return document.body.querySelectorAll();
    if (selector.includes('data-styleproof-state-id'))
      return nodes.filter(
        (node) =>
          node.attrs['data-styleproof-state-id'] &&
          (selector === '[data-styleproof-state-id]' ||
            selector.includes(`"${node.attrs['data-styleproof-state-id']}"`)),
      );
    return targets;
  };
  document.querySelector = (selector) => document.querySelectorAll(selector)[0] ?? null;
  context.HTMLInputElement = class {};
  context.HTMLTextAreaElement = class {};
  context.CSSImportRule = class {};
  context.CSSStyleRule = class {};
  const rule = Object.assign(new context.CSSStyleRule(), {
    selectorText: scope === 'parent' ? 'button:hover + output' : 'section:has(button:hover)',
  });
  document.styleSheets = scope === 'parent' || scope === 'fallback' ? [{ cssRules: [rule] }] : [];
  let pathReads = 0;
  context.window.__spPathOf = (element) => {
    pathReads++;
    return element.path;
  };
  let forced,
    state,
    revision = settled && drift !== 'removal' ? 1 : 0,
    mutated = settled,
    baselines = 0,
    counts = 0,
    reads = 0,
    resetBarriers = 0;
  if (settled && drift === 'removal') nodes.pop().parentElement.children.pop();
  const visits = [];
  const forces = [];
  context.getComputedStyle = (element, pseudo) => {
    reads++;
    const changed =
      forced &&
      (element === forced ||
        element.parentElement === forced ||
        (scope !== 'subtree' && element.parentElement === forced.parentElement));
    return computedStyle(
      pseudo
        ? { content: pseudo === '::before' && changed ? '"state"' : 'none' }
        : { display: 'block', color: `${changed ? state : 'rest'}-${drift === 'typed' ? 0 : revision}` },
    );
  };
  const client = {
    detach: async () => {},
    send: async (method, params) => {
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (method === 'DOM.querySelectorAll')
        return { nodeIds: document.querySelectorAll(params.selector).map((n) => nodes.indexOf(n) + 1) };
      if (method === 'CSS.forcePseudoState') {
        forces.push({ nodeId: params.nodeId, classes: [...params.forcedPseudoClasses] });
        const resetting = !params.forcedPseudoClasses.length;

        if (resetting && nodes[params.nodeId - 1] === targets[removeAfterReset])
          delete targets[removeAfterReset].attrs['data-styleproof-state-id'];

        if (resetting && state === 'active' && forced === targets.at(-1) && resetFailures-- > 0)
          throw new Error('CSS.forcePseudoState: Could not find node with given id');
        forced = resetting ? undefined : nodes[params.nodeId - 1];
        if (forced) {
          state = params.forcedPseudoClasses[0];
          visits.push([forced.path, state]);
        } else if (state === 'active' && drift && !mutated) {
          mutated = true;
          if (drift !== 'removal') revision++;
          else {
            const removed = nodes.pop();
            removed.parentElement.children.pop();
          }
        }
      }
      if (method !== 'Runtime.evaluate') return {};
      const expression = params.expression;

      if (expression.endsWith('getComputedStyle(element).display; return true; })()')) resetBarriers++;

      const sessionBaseline = expression.startsWith(`(function ${snapSessionBaseline.name}(`);
      // Force the production legacy path; all per-target reads still run unmodified.
      if (legacy && sessionBaseline) return { result: { value: false } };

      if (replaceDocument && expression.includes('"saveBaseline":true')) {
        document.querySelector = () => null;

        for (const key of Object.keys(context.window)) {
          if (key.startsWith('__spForcedStateBaseline')) delete context.window[key];
        }
      }
      const value = runInContext(expression, context);
      if (expression.includes('"countOnly":true')) counts++;
      else if (expression.includes('"saveBaseline":true') && (!sessionBaseline || value)) baselines++;
      return { result: { value } };
    },
  };
  const page = { context: () => ({ newCDPSession: async () => client }), evaluate: async (fn, args) => run(fn, args) };
  const capture = async (options = {}, ignore = [], skipPaths = []) => {
    const warnings = [],
      original = console.warn;
    console.warn = (message) => warnings.push(message);
    try {
      const result = await captureForcedStates(
        page,
        ignore,
        options.maxInteractive ?? 800,
        resolveForcedStateLimits({ forcedStateScope: scope === 'document' ? 'document' : 'stylesheet', ...options }),
        skipPaths,
      );
      assert.deepEqual(
        Object.keys(context.window).filter((key) => key.startsWith('__spForcedStateBaseline')),
        [],
      );
      assert.ok(nodes.every((node) => !node.attrs['data-styleproof-state-id']));
      assert.equal(forced, undefined);
      if (legacy) assert.equal(counts, 0);

      return { result, warnings, visits, baselines, counts, reads, pathReads, forces, resetBarriers };
    } finally {
      console.warn = original;
    }
  };
  return {
    capture,
    run,
    context,
    targets,
    get reads() {
      return reads;
    },
  };
}

for (const scope of ['subtree', 'parent', 'document', 'fallback']) {
  test(`post-reset barriers fold into the next read: ${scope}`, async () => {
    const folded = await forcedStateHarness({ scope }).capture();
    const legacy = await forcedStateHarness({ scope, legacy: true }).capture();
    assert.equal(JSON.stringify(folded.result), JSON.stringify(legacy.result));
    assert.deepEqual(folded.warnings, legacy.warnings);
    assert.equal(folded.resetBarriers, 1, 'only the final target needs an explicit reset barrier');
    assert.equal(legacy.resetBarriers, 1, 'per-target baselines also carry the preceding reset barrier');
  });
}

test('reset detachment preserves serialized deltas and warning order before a budget stop', async () => {
  const { result, warnings } = await forcedStateHarness({ scope: 'subtree', removeAfterReset: 0 }).capture({
    maxInteractive: 2,
    maxForcedStateScanWork: 9,
  });

  assert.deepEqual(warnings, [
    'styleproof: 20 interactive elements exceeds maxInteractive=2; forced-state capture truncated to the first 2. Raise maxInteractive to cover them all.',
    'styleproof: interactive element sp-0 detached while resetting forced state; skipping it.',
    'styleproof: forced-state document scan reached maxForcedStateElements=2000 or the remaining maxForcedStateScanWork=9 budget; capture is target-first and truncated, so the forced-state layer is not certified.',
    'styleproof: forced-state aggregate scan exhausted its 9-element work budget; capture stopped and the forced-state layer is not certified.',
  ]);
  assert.equal(
    JSON.stringify(result),
    '{"states":{"body > section:nth-child(1) > button:nth-child(1)":{"hover":{"body > section:nth-child(1) > button:nth-child(1)":{"color":"hover-0"},"body > section:nth-child(1) > button:nth-child(1)::before":{"content":"\\"state\\""},"body > section:nth-child(1) > button:nth-child(1) > span":{"color":"hover-0"},"body > section:nth-child(1) > button:nth-child(1) > span::before":{"content":"\\"state\\""}},"focus":{"body > section:nth-child(1) > button:nth-child(1)":{"color":"focus-0"},"body > section:nth-child(1) > button:nth-child(1)::before":{"content":"\\"state\\""},"body > section:nth-child(1) > button:nth-child(1) > span":{"color":"focus-0"},"body > section:nth-child(1) > button:nth-child(1) > span::before":{"content":"\\"state\\""}}}},"skipped":true}',
  );
});

for (const scope of ['document', 'fallback', 'subtree', 'parent']) {
  test(`forced-state capture replaces each target's state before one final reset: ${scope}`, async () => {
    const { result, forces } = await forcedStateHarness({ scope }).capture();
    const targets = Object.keys(result.states);
    const nodeIds = [...new Set(forces.map(({ nodeId }) => nodeId))];

    assert.equal(result.skipped, false);
    assert.equal(targets.length, 20);
    assert.equal(nodeIds.length, targets.length);

    for (const nodeId of nodeIds) {
      const classes = forces.flatMap((force) => (force.nodeId === nodeId ? [force.classes] : []));
      assert.equal(classes.length, 4, 'three forces and one reset per target');
      assert.deepEqual(classes, [['hover'], ['focus', 'focus-visible'], ['active'], []]);
    }

    assert.deepEqual(
      forces.map(({ nodeId }) => nodeId),
      nodeIds.flatMap((nodeId) => Array(4).fill(nodeId)),
    );
  });
}

for (const scope of ['document', 'fallback', 'subtree', 'parent']) {
  test(`shared baseline preserves serialized states, proof, warnings and budget boundaries: ${scope}`, async (t) => {
    const size = { document: 82, fallback: 82, subtree: 2, parent: 61 }[scope];
    for (const options of [
      {},
      { maxForcedStateScanWork: size * 80 },
      { maxForcedStateScanWork: size * 8 },
      { maxForcedStateScanWork: size * 8 + 1 },
      { maxForcedStateScanWork: size * 8 - 1 },
      { maxForcedStateElements: 1 },
      { maxForcedStateElements: size },
      { maxInteractive: 2 },
      { maxInteractive: 3 },
    ]) {
      const shared = await forcedStateHarness({ scope }).capture(options);
      const legacy = await forcedStateHarness({ scope, legacy: true }).capture(options);
      assert.equal(JSON.stringify(shared.result), JSON.stringify(legacy.result));
      assert.deepEqual(shared.warnings, legacy.warnings);
      assert.deepEqual(shared.visits, legacy.visits, 'truncation lands on the same target and state');
      if (shared.counts) assert.equal(shared.baselines, 2, 'one shared baseline plus its final check');
      assert.ok(shared.reads <= legacy.reads, 'avoid extra style reads for disjoint or budget-limited scopes');
      if (!Object.keys(options).length) {
        t.diagnostic(`style reads: ${legacy.reads} legacy, ${shared.reads} shared`);
        if (scope === 'fallback')
          assert.match(shared.warnings[0], /'stylesheet' fell back to whole-document forced-state reads:.*:has\(\)/);
        const documentScope = scope === 'document' || scope === 'fallback';
        assert.equal(shared.counts > 0, documentScope);
        if (documentScope) {
          assert.ok(shared.reads < legacy.reads, 'sharing must save style reads');
          assert.equal(shared.pathReads - legacy.pathReads, size * 3, 'one count, shared save and end check');
        } else {
          assert.equal(shared.reads, legacy.reads);
          assert.equal(shared.pathReads, legacy.pathReads, 'narrow scopes bypass the planner');
        }
        assert.ok(Object.keys(shared.result.stateComputedValueStyle).length > 0);
        assert.equal(shared.result.skipped, false);
      }
    }
    const args = [{}, ['.skip'], ['body > section:nth-child(2)']];
    assert.equal(
      JSON.stringify((await forcedStateHarness({ scope }).capture(...args)).result),
      JSON.stringify((await forcedStateHarness({ scope, legacy: true }).capture(...args)).result),
    );
  });
}

test('baseline planning stops visiting targets once the scan budget is exhausted', async (t) => {
  for (const maxForcedStateScanWork of [82 * 4, 82 * 4 - 1]) {
    const shared = await forcedStateHarness().capture({ maxForcedStateScanWork });
    const legacy = await forcedStateHarness({ legacy: true }).capture({ maxForcedStateScanWork });
    assert.equal(JSON.stringify(shared.result), JSON.stringify(legacy.result));
    assert.deepEqual(shared.warnings, legacy.warnings);
    assert.deepEqual(shared.visits, legacy.visits);
    t.diagnostic(`budget ${maxForcedStateScanWork}: ${shared.pathReads - legacy.pathReads} planner path reads`);
    assert.equal(shared.pathReads - legacy.pathReads, 82, 'one document count regardless of target count');
  }
});

for (const drift of ['style', 'removal', 'typed']) {
  test(`end-check ${drift} drift discards the entire shared pass and retries per target`, async () => {
    const options = { maxInteractive: 6, maxForcedStateScanWork: 82 * 16 + 20 };
    const shared = await forcedStateHarness({ drift }).capture(options);
    const legacy = await forcedStateHarness({ legacy: true, drift, settled: true }).capture(options);
    assert.equal(shared.visits.filter(([path, state]) => path === shared.visits[0][0] && state === 'hover').length, 2);
    assert.deepEqual(shared.warnings, legacy.warnings, 'tentative warnings are discarded');
    assert.equal(JSON.stringify(shared.result), JSON.stringify(legacy.result));
    assert.equal(shared.baselines, 6, 'shared save plus five retry baselines; failed end check excluded');
  });
}

test('a failed reset before retry keeps the forced-state layer uncertified', async () => {
  const { result } = await forcedStateHarness({ resetFailures: 4 }).capture();
  assert.equal(result.skipped, true);
  assert.equal(result.stateComputedValueStyle, undefined);
});

test('unavailable Typed OM falls back to per-target baselines', async () => {
  const shared = await forcedStateHarness({ unsupported: true }).capture();
  const legacy = await forcedStateHarness({ unsupported: true, legacy: true }).capture();
  assert.equal(JSON.stringify(shared.result), JSON.stringify(legacy.result));
  assert.equal(shared.counts, 0);
});

test('count-only preserves skips and truncation without reading styles or replacing the baseline', () => {
  const harness = forcedStateHarness();
  const args = {
    selector: '[data-styleproof-state-id="sp-0"]',
    skipSel: '',
    skipPaths: [],
    maxElements: 3,
    baselineKey: 'baseline',
    saveBaseline: true,
  };
  harness.targets[0].attrs['data-styleproof-state-id'] = 'sp-0';
  const baseline = harness.run(snapSubtree, args);
  const saved = JSON.stringify(harness.context.window.baseline),
    reads = harness.reads;
  assert.equal(JSON.stringify(harness.run(snapSubtree, { ...args, countOnly: true })), JSON.stringify(baseline));
  assert.equal(harness.reads, reads);
  assert.equal(JSON.stringify(harness.context.window.baseline), saved);
  let assertions = 0;
  harness.context.window.__spAssertFrozen = () => {
    if (++assertions === 2) throw new Error('freeze lost');
  };
  assert.throws(() => harness.run(snapSubtree, { ...args, countOnly: true }), /freeze lost/);
});

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

const settleEntry = (overrides = {}) => ({
  tag: 'div',
  cls: '',
  style: { color: 'red' },
  rect: [0, 0, 10, 10],
  ...overrides,
});
const resizedEntry = () => settleEntry({ style: { color: 'red', width: '20px' }, rect: [0, 0, 20, 10] });

for (const [name, before, after, expected] of [
  ['added element', {}, { body: settleEntry() }, ['body']],
  ['removed element', { body: settleEntry() }, {}, ['body']],
  ['style change', { body: settleEntry() }, { body: settleEntry({ style: { color: 'blue' } }) }, ['body']],
  ['text change', { body: settleEntry({ text: 'one' }) }, { body: settleEntry({ text: 'two' }) }, ['body']],
  ['geometry alone', { body: settleEntry() }, { body: resizedEntry() }, ['body']],
  ['html geometry alone', { html: settleEntry() }, { html: resizedEntry() }, ['html']],
  ['added descendant', { body: settleEntry() }, { body: resizedEntry(), 'body > div': settleEntry() }, ['body > div']],
  ['unchanged', { body: settleEntry() }, { body: settleEntry() }, []],
  ['undefined field', { body: settleEntry() }, { body: settleEntry({ text: undefined }) }, []],
  [
    'numeric serialization',
    { body: settleEntry({ rect: [-0, NaN, Infinity, -Infinity] }) },
    { body: settleEntry({ rect: [0, null, null, null] }) },
    [],
  ],
  [
    'property order',
    { body: settleEntry({ style: { color: 'red', display: 'block' } }) },
    { body: settleEntry({ style: { display: 'block', color: 'red' } }) },
    ['body'],
  ],
  ...['width', 'height', 'inline-size', 'block-size', 'perspective-origin', 'transform-origin'].map((prop) => [
    `followed ${prop} and html`,
    { html: settleEntry(), body: settleEntry(), 'body > div': settleEntry() },
    {
      html: resizedEntry(),
      body: settleEntry({ style: { color: 'red', [prop]: '20px' } }),
      'body > div': resizedEntry(),
    },
    ['body > div'],
  ]),
  [
    'geometry with removed descendant',
    { body: settleEntry(), 'body > div': settleEntry() },
    { body: resizedEntry() },
    ['body > div'],
  ],
  [
    'geometry with unrelated change',
    { body: settleEntry() },
    { body: resizedEntry(), 'bodyguard > div': settleEntry() },
    ['body', 'bodyguard > div'],
  ],
]) {
  test(`settle diff preserves the previous rule: ${name}`, () => {
    const { context, run } = capturePageHarness();
    context.snapshot = before;
    runInContext(
      `Object.defineProperty(window, 'settle', {
      configurable: true, value: { capture: (args) => { captureArgs = args; return { elements: snapshot }; } }
    })`,
      context,
    );
    const poll = () => Array.from(run(capturePageChanges, { key: 'settle', args: pageCaptureArgs }));
    assert.deepEqual(poll(), [], 'the first poll only records a baseline');
    assert.deepEqual(JSON.parse(JSON.stringify(context.captureArgs)), pageCaptureArgs);
    context.snapshot = after;
    assert.deepEqual(poll(), expected);
    assert.deepEqual(poll(), [], 'the previous snapshot advances after every poll');
  });
}

test('settle diff returns null when its window store is missing', () => {
  const { run } = capturePageHarness();
  assert.equal(run(capturePageChanges, { key: 'missing', args: pageCaptureArgs }), null);
});

for (const outcome of ['quiet', 'timeout', 'churn']) {
  test(`settle recovers a lost store between polls before ${outcome}`, async (t) => {
    const host = { color: 'red' };
    const { page, context, hooks } = pseudoPageHarness({ host });
    let now = 0;
    t.mock.method(Date, 'now', () => now);
    let key;
    hooks.onWait = () => {
      now++;
      const keys = Object.getOwnPropertyNames(context.window).filter((name) => name.startsWith('__spSettle_'));
      assert.equal(keys.length, 1, 'the store is installed before each wait');
      [key] = keys;
      if (now === 2) {
        delete context.window[key];
        host.color = 'blue';
      } else if (outcome === 'churn' && now > 2) {
        host.color = now % 2 ? 'red' : 'blue';
      }
    };
    const map = await captureStyleMap(page, {
      captureStates: false,
      pendingRequests: () => 0,
      stabilize: { interval: 1, quietFor: 2, timeout: outcome === 'quiet' ? 10 : outcome === 'timeout' ? 2 : 4 },
    });
    // Only waits advance the mocked clock: recovery at 2 must restart the two-tick quiet window.
    assert.equal(now, outcome === 'timeout' ? 2 : 4);
    assert.deepEqual(map.volatile ?? [], outcome === 'churn' ? ['target'] : []);
    if (outcome === 'churn') assert.equal(Object.hasOwn(map.elements, 'target'), false);
    else assert.equal(map.elements.target.style.color, 'blue', 'the new document remains captured');
    assert.equal(Object.hasOwn(context.window, key), false, 'the reinstalled store is cleaned up');
  });
}

for (const outcome of ['quiet', 'timeout', 'wait error']) {
  test(`settle clears its non-enumerable store after ${outcome}`, async (t) => {
    const { page, context, hooks } = capturePageHarness();
    let now = 0;
    t.mock.method(Date, 'now', () => now);
    let polls = 0;
    hooks.afterRead = (name) => {
      if (name === 'capturePageChanges') polls++;
    };
    let key;
    hooks.onWait = () => {
      now++;
      const keys = Object.getOwnPropertyNames(context.window).filter((name) => name.startsWith('__spSettle_'));
      assert.equal(keys.length, 1);
      [key] = keys;
      assert.equal(Object.getOwnPropertyDescriptor(context.window, key).enumerable, false);
      if (outcome === 'wait error') throw new Error('wait between polls failed');
    };
    const capture = captureStyleMap(page, {
      captureStates: false,
      pendingRequests: () => (outcome === 'timeout' ? 1 : 0),
      stabilize: { interval: 1, quietFor: 1, timeout: 25 },
    });
    if (outcome === 'wait error') await assert.rejects(capture, /wait between polls failed/);
    else assert.deepEqual((await capture).volatile ?? [], []);
    assert.ok(key, 'at least one poll ran');
    // Only waits advance the mocked clock: one baseline, then one poll per elapsed tick.
    assert.equal(polls, outcome === 'quiet' ? 2 : outcome === 'timeout' ? 26 : 1);
    assert.equal(Object.hasOwn(context.window, key), false);
  });
}

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
  const host = {
    color: 'rgb(200, 0, 0)',
    'font-family': 'serif',
    'border-top-color': 'rgb(200, 200, 200)',
    'row-rule-color': 'rgb(200, 200, 200)',
  };
  const pseudo = {
    content: 'none',
    color: host.color,
    'font-family': host['font-family'],
    'border-top-color': host.color,
    'row-rule-color': host.color,
  };
  const ua = { content: 'none', 'row-rule-color': 'rgb(0, 0, 0)' };
  const { run } = pseudoPageHarness({
    host,
    pseudos: { '::first-letter': pseudo, '::first-line': pseudo },
    defaults: { '::first-letter': ua, '::first-line': ua },
  });
  const map = run(capturePage, pageCaptureArgs);
  assert.equal(map.elements.target.pseudo, undefined);
  assert.equal(map.defaults['p::first-letter'], undefined);
  assert.equal(map.defaults['p::first-line'], undefined);
});

test('capture retains explicit row-rule colours matching the host or UA default (#979)', () => {
  const host = { color: 'rgb(200, 0, 0)', 'row-rule-color': 'rgb(200, 200, 200)' };
  const ua = { content: 'none', 'row-rule-color': 'rgb(0, 0, 0)' };
  for (const value of [host['row-rule-color'], ua['row-rule-color']]) {
    const pseudo = { color: 'rgb(0, 128, 0)', 'row-rule-color': value };
    const { run } = pseudoPageHarness({
      host,
      pseudos: { '::first-letter': pseudo, '::first-line': pseudo },
      defaults: { '::first-letter': ua, '::first-line': ua },
    });
    const map = run(capturePage, pageCaptureArgs);
    for (const ps of ['::first-letter', '::first-line']) {
      assert.equal(map.elements.target.pseudo[ps]['row-rule-color'], value, ps);
    }
  }
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
  const { page, document, hooks, context } = capturePageHarness();
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
  assert.equal(
    Object.getOwnPropertyNames(context.window).some((key) => key.startsWith('__spSettle_')),
    false,
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

test('document replacement before a target baseline skips missing targets without calling the lost snapshot', async () => {
  const { result, warnings, forces } = await forcedStateHarness({ scope: 'subtree', replaceDocument: true }).capture();
  assert.equal(result.skipped, true);
  assert.deepEqual(result.states, {});
  assert.equal(forces.length, 0);
  assert.equal(warnings.length, 20);
  assert.ok(warnings.every((warning) => warning.includes('detached')));
});
