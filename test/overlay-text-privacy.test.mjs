import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { detectOverlayCandidates } from '../dist/capture/browser.js';
import { popupDomSnapshot } from '../dist/runner/browser.js';

function fixture(copy, forbidText = false) {
  const root = { hidden: true };
  const attributes = { role: 'dialog', 'aria-label': copy };

  const overlay = {
    tagName: 'DIALOG',
    id: '',
    parentElement: root,
    get textContent() {
      assert.equal(forbidText, false, 'privacy mode must not read textContent');

      return copy;
    },
    getAttribute: (name) => attributes[name] ?? null,
    hasAttribute: (name) => name in attributes,
    setAttribute: (name, value) => {
      attributes[name] = value;
    },
    removeAttribute: (name) => {
      delete attributes[name];
    },
    getBoundingClientRect: () => ({ width: 100, height: 100 }),
    matches: () => false,
    contains: () => false,
  };

  const body = { hidden: true };
  root.children = [overlay];

  return {
    document: {
      documentElement: root,
      body,
      querySelectorAll: (selector) =>
        selector === 'body *' || selector === '.overlay' || selector === '.trigger' ? [overlay] : [],
    },
    window: { __spPathOf: () => 'body > dialog' },
    HTMLDialogElement: class {},
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
  };
}

function snapshot(fn, args, copy = 'Private dialog copy', forbidText = false) {
  return JSON.parse(
    JSON.stringify(runInNewContext(`(${fn.toString()})(${JSON.stringify(args)})`, fixture(copy, forbidText))),
  );
}

test('overlay capture omits the text property without reading copy when disabled', () => {
  const overlays = snapshot(detectOverlayCandidates, { skipSel: '', captureText: false }, undefined, true);
  assert.ok(overlays.length > 0);
  assert.ok(overlays.every((overlay) => !Object.hasOwn(overlay, 'text')));
  assert.ok(!JSON.stringify(overlays).includes('Private dialog copy'));
});

test('overlay capture keeps text by default and when explicitly enabled', () => {
  for (const options of [{}, { captureText: true }]) {
    const overlays = snapshot(detectOverlayCandidates, { skipSel: '', ...options });
    assert.equal(overlays[0].text, 'Private dialog copy');
  }
});

test('popup privacy identities and labels use structure and remain stable when copy changes', () => {
  const args = {
    popupSelector: '.overlay',
    triggerSelector: '.trigger',
    attr: 'data-trigger',
    max: 1,
    captureText: false,
  };

  const first = snapshot(popupDomSnapshot, args, 'First copy', true);
  const second = snapshot(popupDomSnapshot, args, 'Replacement copy', true);
  assert.deepEqual(first, second);
  assert.equal(first.candidates[0].label, 'dialog[role="dialog"]');
  assert.ok(!JSON.stringify(first).includes('First copy'));

  const rebound = snapshot(
    popupDomSnapshot,
    { ...args, relocatePath: first.candidates[0].path, relocateLabel: first.candidates[0].label },
    'Replacement copy',
    true,
  );

  assert.equal(rebound.found, true);
});

test('popup default and explicit text mode preserve copy-based keys and labels', () => {
  const args = { popupSelector: '.overlay', triggerSelector: '.trigger', attr: 'data-trigger', max: 1 };
  const first = snapshot(popupDomSnapshot, args);
  assert.deepEqual(first, snapshot(popupDomSnapshot, { ...args, captureText: true }));
  assert.equal(first.keys[0], 'dialog[role="dialog"]|dialog|||||||Private dialog copy');
  assert.equal(first.candidates[0].label, 'Private dialog copy');
  assert.notDeepEqual(first.keys, snapshot(popupDomSnapshot, args, 'Replacement copy').keys);
});
