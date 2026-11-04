import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { trackScriptReach } from '../dist/capture/script-reach.js';
import { captureExpression, STYLEPROOF_SCRIPT_URL } from '../dist/capture/script-evaluation.js';
import { NAV_OBSERVER_SNIPPET } from '../dist/runner/browser.js';
import { scriptReachFixture } from './script-reach-fixture.mjs';

const wrap = (source) => `(() => {\n      ${source}\n    })();`;
const stackTrace = { callFrames: [{ scriptId: 'capture', functionName: 'capturePage' }] };

async function collect(source, metadata = {}, count = 1) {
  const fixture = scriptReachFixture({
    source,
    entries: Array.from({ length: count }, (_, index) => ({
      scriptId: String(index),
      url: '',
      ...metadata,
      functions: [{ ranges: [{ startOffset: 0, endOffset: source.length, count: 1 }] }],
    })),
  });

  const tracker = await trackScriptReach(fixture.page);
  fixture.navigate();

  return tracker.stop();
}

const clockSource = `(() => {\n      const module = {};\n      \nvar __commonJS = obj => {};\nvar ClockController = class {};\n      if (!globalThis.__pwClock)\n        globalThis.__pwClock = (module.exports.inject())(globalThis, "chromium");\n    })();`;

const injected = {
  binding: wrap(`globalThis['__playwright__binding__controller__'].addBinding("__styleproofObservedNav")`),
  fractionalClockLog: wrap("globalThis.__pwClock.controller.log('runFor', 1735689600696, 1.5)"),
  clockLog: wrap("globalThis.__pwClock.controller.log('setFixedTime', 1735689600696, 1735689600000)"),
  clock: wrap(clockSource),
  rawClock: clockSource,
  bindingsController: wrap(
    `\n      (() => {\n        const module = {};\n        \nvar __commonJS = obj => {};\nvar BindingsController = class {};\n        const property = '__playwright__binding__controller__';\n        if (!globalThis[property])\n          globalThis[property] = new (module.exports.BindingsController())(globalThis, '__playwright__binding__');\n      })();\n    `,
  ),
  utility: 'var UtilityScript = class { }; return new (module.exports.UtilityScript())(globalThis, false);',
  injectedUtility: 'var InjectedScript = class { }; return new (module.exports.InjectedScript())(globalThis, false);',
  directEvaluation: '((utilityScript, ...args) => utilityScript.evaluate(...args))',
};

const marked = {
  observer: wrap(NAV_OBSERVER_SNIPPET),
  documentSheet: captureExpression('function () { return this.getRootNode() === document; }'),
  inlineStyles: captureExpression('function parsedInlineStyles() { return { names: [], reader: false, count: 0 }; }'),
};

for (const [name, source] of Object.entries({ ...injected, ...marked })) {
  for (const trace of [undefined, stackTrace]) {
    test(`${name} is excluded with stackTrace=${!!trace}`, async () => {
      const result = await collect(source, {
        url: Object.hasOwn(marked, name) ? STYLEPROOF_SCRIPT_URL : '',
        stackTrace: trace,
      });
      assert.equal(result.status, 'measured');
      assert.deepEqual(result.scripts, []);
    });
  }
}

test('a sourceURL marker inside app string data stays named', async () => {
  const source = `const s = \`\n//# sourceURL=${STYLEPROOF_SCRIPT_URL}\n\`; app();`;
  const result = await collect(source, { stackTrace });
  assert.deepEqual(result.scripts, [{ url: '<anonymous>', status: 'unmeasured', reason: 'unsupported script URL' }]);
});

for (const source of [
  'document.body.dataset.app = "yes";',
  wrap('document.body.dataset.app = "yes";'),
  'function parsedInlineStyles() { return "app code"; }',
  'globalThis.__pwClock = { app: true };',
  injected.binding + '\napp();',
  injected.clockLog + '\napp();',
  wrap('var ClockController = class {}; app();'),
  wrap('var BindingsController = class {}; app();'),
]) {
  test(`page anonymous/eval source stays named: ${source.slice(0, 50)}`, async () => {
    const result = await collect(source, { stackTrace });
    assert.deepEqual(result.scripts, [{ url: '<anonymous>', status: 'unmeasured', reason: 'unsupported script URL' }]);
  });
}

test('only immediate utility evaluations are excluded; an app eval called inside one stays named', async () => {
  const sources = [injected.utility, '(function settle() { eval("app()"); })', 'app()'];

  const fixture = scriptReachFixture({
    entries: sources.map((source, i) => ({
      scriptId: String(i),
      url: '',
      stackTrace: i ? { callFrames: [{ scriptId: String(i - 1) }] } : stackTrace,
      functions: [{ ranges: [{ startOffset: 0, endOffset: source.length, count: 1 }] }],
    })),
  });

  const send = fixture.client.send;
  fixture.client.send = (method, params) =>
    method === 'Debugger.getScriptSource'
      ? Promise.resolve({ scriptSource: sources[Number(params.scriptId)] })
      : send(method, params);
  const tracker = await trackScriptReach(fixture.page);
  fixture.navigate();
  assert.deepEqual((await tracker.stop()).scripts, [
    { url: '<anonymous>', status: 'unmeasured', reason: 'unsupported script URL' },
  ]);
});

test('different injected-script counts cannot downgrade self-check evidence', async () => {
  const { assertDeterministicScriptReach } = await import('../dist/runner/self-check.js');
  const first = { scriptReach: await collect(injected.clockLog, { stackTrace }) };
  const again = { scriptReach: await collect(injected.bindingsController, { stackTrace }, 3) };
  assertDeterministicScriptReach(first, again, 'home');
  assert.equal(first.scriptReach.status, 'measured');
  assert.deepEqual(first.scriptReach.scripts, []);
});

for (const [kind, discardedSource] of Object.entries({ wrapped: injected.clock, direct: injected.rawClock })) {
  test(`a discarded ${kind} clock is identified by a live copy; unavailable app sources stay named`, async () => {
    const fixture = scriptReachFixture({
      entries: [discardedSource, injected.clock, 'app()'].map((source, index) => ({
        scriptId: String(index),
        url: '',
        hash: createHash('sha256').update(source).digest('hex'),
        stackTrace: index === 2 ? { callFrames: [{ scriptId: '0' }] } : undefined,
        functions: [{ isBlockCoverage: false, ranges: [{ startOffset: 0, endOffset: source.length, count: 1 }] }],
      })),
    });

    const send = fixture.client.send;
    fixture.client.send = (method, params) => {
      if (method !== 'Debugger.getScriptSource') return send(method, params);

      if (params.scriptId === '1') return Promise.resolve({ scriptSource: injected.clock });

      return Promise.reject(new Error('No script for id: ' + params.scriptId));
    };

    const tracker = await trackScriptReach(fixture.page);
    fixture.navigate();
    assert.deepEqual((await tracker.stop()).scripts, [
      { url: '<anonymous>', status: 'unmeasured', reason: 'unsupported script URL' },
    ]);
  });
}
