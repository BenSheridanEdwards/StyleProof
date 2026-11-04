import assert from 'node:assert/strict';
import test from 'node:test';
import { markInteractiveElements, analyzeForcedStateScope } from '../dist/capture/browser.js';
import { diffStyleMaps, diffStyleMapDirs } from '../dist/index.js';
import { STATE_LAYER_NAMES } from '../dist/capture/forced-states.js';
import {
  makeMap as createStyleMap,
  mkTmp as createTemporaryDirectory,
  writeCapture,
  rmTmp as removeTemporaryDirectory,
} from './helpers.mjs';

for (const state of ['checked', 'disabled', 'placeholder-shown']) {
  test(`${state} is compared only when both maps captured the layer`, () => {
    const before = createStyleMap({ elements: { control: { tag: 'input' } } });

    const after = {
      ...before,
      stateLayers: [...STATE_LAYER_NAMES],
      states: { control: { [state]: { control: { color: 'red' } } } },
    };

    for (const [base, head] of [
      [before, after],
      [after, before],
    ]) {
      const findings = diffStyleMaps(base, head);
      assert.equal(findings.filter((finding) => finding.path !== '(surface)').length, 0);
      assert.ok(findings.some((finding) => finding.path === '(surface)'));
    }

    const findings = diffStyleMaps({ ...before, stateLayers: [...STATE_LAYER_NAMES] }, after);
    assert.ok(findings.some((finding) => finding.path === 'control' && finding.state === state));
  });
}

test('layer availability mismatches count as uncertified surfaces, including empty deltas', () => {
  const directory = createTemporaryDirectory();

  try {
    const before = `${directory}/before`;
    const after = `${directory}/after`;
    const legacy = createStyleMap({});
    const current = { ...legacy, stateLayers: [...STATE_LAYER_NAMES] };
    writeCapture(before, 'form@1280', legacy, null);
    writeCapture(after, 'form@1280', current, null);
    assert.equal(diffStyleMapDirs(before, after).statesUncertified, 1);
    writeCapture(before, 'form@1280', current, null);
    assert.equal(diffStyleMapDirs(before, after).statesUncertified, 0);
    const partial = { ...current, stateLayers: ['hover', 'focus', 'active'] };
    writeCapture(before, 'form@1280', partial, null);
    writeCapture(after, 'form@1280', partial, null);
    assert.equal(diffStyleMapDirs(before, after).statesUncertified, 1);
  } finally {
    removeTemporaryDirectory(directory);
  }
});

test('interactive discovery records only meaningful form states that are false at rest', (context) => {
  const controls = [
    { selectors: ['input', 'input[type="checkbox"]'], expected: ['checked', 'disabled'] },
    { selectors: ['input', 'input[type="radio"]', ':checked'], expected: ['disabled'] },
    { selectors: ['button', ':disabled'], expected: [] },
    { selectors: ['select'], expected: ['disabled'] },
    { selectors: ['textarea'], placeholder: 'Hint', value: 'Filled', expected: ['disabled', 'placeholder-shown'] },
    { selectors: ['input', ':placeholder-shown'], placeholder: 'Hint', value: '', expected: ['disabled'] },
    { selectors: ['input'], placeholder: '', value: 'Filled', expected: ['disabled'] },
    { selectors: ['a'], expected: [] },
  ].map((control) => ({
    ...control,
    matches(selector) {
      return selector.split(',').some((part) => control.selectors.includes(part.trim()));
    },
    getAttribute: () => control.placeholder ?? null,
    setAttribute() {},
  }));

  Object.assign(globalThis, { window: {}, document: { querySelectorAll: () => controls } });
  context.after(() => {
    delete globalThis.window;
    delete globalThis.document;
  });
  const marked = markInteractiveElements({ selector: '*', skipSel: '', attr: 'data-state' });
  assert.deepEqual(
    marked.map((control) => control.formStateLayers),
    controls.map((control) => control.expected),
  );
});

for (const state of ['checked', 'disabled', 'placeholder-shown']) {
  for (const [selector, expected] of [
    [`input:${state}`, 'subtree'],
    [`input:${state} + label`, 'parent'],
    [`main:has(input:${state}) h2`, 'document'],
    [`input:not(:${state}) ~ label`, 'parent'],
  ]) {
    test(`scope analysis bounds ${selector}`, (context) => {
      class StyleRule {
        selectorText = selector;
      }

      class ImportRule {}

      Object.assign(globalThis, {
        CSSStyleRule: StyleRule,
        CSSImportRule: ImportRule,
        document: { styleSheets: [{ cssRules: [new StyleRule()] }] },
      });
      context.after(() => {
        delete globalThis.CSSStyleRule;
        delete globalThis.CSSImportRule;
        delete globalThis.document;
      });
      assert.equal(analyzeForcedStateScope().scope, expected);
      assert.equal(analyzeForcedStateScope(false).scope, 'subtree', 'form selectors do not expand the legacy sweep');
    });
  }
}
