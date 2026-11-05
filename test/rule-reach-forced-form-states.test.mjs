import assert from 'node:assert/strict';
import { test } from 'node:test';
import { trackServedRules } from '../dist/capture/reach.js';
import { classifyRuleReach } from '../dist/rule-reach.js';

const cases = [
  ['checked', '.choice:checked + .label', '.choice + .label'],
  ['disabled', '.save:disabled', '.save'],
  ['placeholder-shown', '.field:placeholder-shown', '.field'],
  ['checked', '.c:checked:not(:disabled) + .l', '.c:not(:disabled) + .l', ['checked', 'disabled']],
];

// CDP saw the rule while forced; the final selector probe runs after reset.
async function capture(
  selector,
  probe,
  color,
  metadata,
  { comparedMatch = true, resting = false, exactProbe = selector, exactExclusive = false } = {},
) {
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
            if (resting && candidate === exactProbe) {
              assert.equal(input.exclusive[index], exactExclusive, 'exact form tokens retain the original scope check');

              return true;
            }

            if (candidate === probe) {
              assert.equal(input.exclusive[index], true, 'relaxed probes require every candidate to be compared');

              return comparedMatch;
            }

            return false;
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

const recordedFormLayers = {
  stateLayers: ['checked', 'disabled', 'placeholder-shown'],
  stateTargets: { checked: ['control'], disabled: ['control'], 'placeholder-shown': ['control'] },
};

for (const [selector, exactProbe, exactExclusive = false] of [
  ['button:not(:disabled)', 'button:not(:disabled)'],
  ['button:not(:disabled):hover', 'button:not(:disabled)', true],
  ['.f:not(:placeholder-shown) + label', '.f:not(:placeholder-shown) + label'],
  ['.x:not(:checked)', '.x:not(:checked)'],
  ['.form:has(.choice:checked)', '.form:has(.choice:checked)'],
  ['.choice:is(:checked)', '.choice:is(:checked)'],
]) {
  test(`recorded form layers preserve exact matching for ${selector}`, async () => {
    const options = { resting: true, exactProbe, exactExclusive, comparedMatch: false };
    const base = await capture(selector, 'unused relaxed probe', 'red', recordedFormLayers, options);
    const head = await capture(selector, 'unused relaxed probe', 'blue', recordedFormLayers, options);
    assert.equal(classifyRuleReach([base], [head]).rules[0].status, 'reached');
    assert.equal(head.reach.rules[0].used, true);
    assert.equal(head.reach.rules[0].outside, undefined);
  });
}

test('a resting checked match survives an ignored candidate in the relaxed probe with layer metadata', async () => {
  const options = { resting: true, comparedMatch: false };
  const base = await capture('.choice:checked', '.choice', 'red', recordedFormLayers, options);
  const head = await capture('.choice:checked', '.choice', 'blue', recordedFormLayers, options);
  assert.equal(classifyRuleReach([base], [head]).rules[0].status, 'reached');
  assert.equal(head.reach.rules[0].outside, undefined);
});

for (const [state, selector, probe, layers = [state]] of cases) {
  const metadata = {
    stateLayers: layers,
    stateTargets: Object.fromEntries(layers.map((layer) => [layer, ['control']])),
  };

  test(`a changed ${selector} rule matched only in a captured forced layer is reached`, async () => {
    const base = await capture(selector, probe, 'red', metadata);
    const head = await capture(selector, probe, 'blue', metadata);
    assert.equal(head.reach.version, 2);
    assert.equal(head.reach.scope, 'compared');
    assert.equal(classifyRuleReach([base], [head]).rules[0].status, 'reached');
    assert.equal(head.reach.rules[0].used, true);
    assert.equal(head.reach.rules[0].outside, undefined);
  });

  test(`${selector} stays outside without a captured layer or compared owner`, async () => {
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

  test(`${selector} cannot attribute a relaxed match with outside candidates`, async () => {
    const base = await capture(selector, probe, 'red', metadata, { comparedMatch: false });
    const head = await capture(selector, probe, 'blue', metadata, { comparedMatch: false });
    assert.equal(head.reach.rules[0].outside, true);
    assert.equal(classifyRuleReach([base], [head]).rules[0].status, 'unmeasured');
  });

  test(`${selector} resting matches still count without forced-layer metadata`, async () => {
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
