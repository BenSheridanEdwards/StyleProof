import assert from 'node:assert/strict';
import { test } from 'node:test';
import { trackServedRules } from '../dist/capture/reach.js';
import { classifyRuleReach } from '../dist/rule-reach.js';

const cases = [
  ['checked', '.choice:checked + .label', '.choice + .label'],
  ['disabled', '.save:disabled', '.save'],
  ['placeholder-shown', '.field:placeholder-shown', '.field'],
];

// CDP saw the rule while forced; the final selector probe runs after reset.
async function capture(selector, probe, color, metadata, { comparedMatch = true, resting = false } = {}) {
  const text = `${selector} { color: ${color}; }`;
  let added;

  const client = {
    on: (event, listener) => {
      if (event === 'CSS.styleSheetAdded') added = listener;
    },
    send: async (command) => {
      if (command === 'CSS.enable')
        added({ header: { styleSheetId: 'sheet', origin: 'regular', isInline: true, frameId: 'main' } });

      if (command === 'CSS.getStyleSheetText') return { text };

      if (command === 'DOM.getDocument') return { root: {} };

      if (command === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };

      if (command === 'CSS.stopRuleUsageTracking')
        return { ruleUsage: [{ styleSheetId: 'sheet', used: true, startOffset: 0, endOffset: text.length }] };

      return {};
    },
    detach: async () => {},
  };

  const compared = ['control', 'label'];

  const tracker = await trackServedRules({
    context: () => ({ newCDPSession: async () => client }),
    evaluate: async (_fn, input) => {
      if (input) assert.deepEqual(input.compared, compared);

      return {
        fingerprint: 'unchanged resting DOM',
        matched:
          input?.probes.map((candidate, index) => {
            if (candidate === probe) {
              assert.equal(input.exclusive[index], true, 'relaxed probes require every candidate to be compared');

              return comparedMatch;
            }

            return resting && candidate === selector;
          }) ?? [],
      };
    },
  });

  try {
    await tracker.start();

    return { ...metadata, reach: await tracker.stop([], compared, metadata) };
  } finally {
    await tracker.dispose();
  }
}

for (const [state, selector, probe] of cases) {
  const metadata = { stateLayers: [state], stateTargets: { [state]: ['control'] } };
  test(`a changed ${state} rule matched only in a captured forced layer is reached`, async () => {
    const base = await capture(selector, probe, 'red', metadata);
    const head = await capture(selector, probe, 'blue', metadata);
    assert.equal(head.reach.version, 2);
    assert.equal(head.reach.scope, 'compared');
    assert.equal(classifyRuleReach([base], [head]).rules[0].status, 'reached');
    assert.equal(head.reach.rules[0].used, true);
    assert.equal(head.reach.rules[0].outside, undefined);
  });

  test(`${state} stays outside without a captured layer or compared owner`, async () => {
    for (const missing of [
      undefined,
      { ...metadata, stateLayers: [] },
      { ...metadata, stateTargets: {} },
      { ...metadata, stateTargets: { [state]: ['excluded'] } },
    ]) {
      const base = await capture(selector, probe, 'red', missing);
      const head = await capture(selector, probe, 'blue', missing);
      assert.equal(head.reach.rules[0].outside, true);
      assert.equal(classifyRuleReach([base], [head]).rules[0].status, 'unmeasured');
    }
  });

  test(`${state} cannot attribute a relaxed match with outside candidates`, async () => {
    const base = await capture(selector, probe, 'red', metadata, { comparedMatch: false });
    const head = await capture(selector, probe, 'blue', metadata, { comparedMatch: false });
    assert.equal(head.reach.rules[0].outside, true);
    assert.equal(classifyRuleReach([base], [head]).rules[0].status, 'unmeasured');
  });

  test(`${state} resting matches still count without forced-layer metadata`, async () => {
    const base = await capture(selector, probe, 'red', undefined, { resting: true });
    const head = await capture(selector, probe, 'blue', undefined, { resting: true });
    assert.equal(classifyRuleReach([base], [head]).rules[0].status, 'reached');
  });
}

for (const state of ['invalid', 'indeterminate', 'open']) {
  test(`unlisted :${state} stays outside even if layer metadata names it`, async () => {
    const metadata = { stateLayers: [state], stateTargets: { [state]: ['control'] } };
    const base = await capture(`.field:${state}`, '.field', 'red', metadata, { resting: true });
    const head = await capture(`.field:${state}`, '.field', 'blue', metadata, { resting: true });
    assert.equal(head.reach.rules[0].used, undefined);
    assert.equal(head.reach.rules[0].outside, true);
    assert.equal(classifyRuleReach([base], [head]).rules[0].status, 'unmeasured');
  });
}
