import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { detectOverlayCandidates } from '../dist/capture/browser.js';
import { DANGER_SOURCE, SUBMITS_FORM_SOURCE } from '../dist/danger.js';
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
  const input = JSON.stringify({ submitsFormSource: SUBMITS_FORM_SOURCE, ...args });

  return JSON.parse(JSON.stringify(runInNewContext(`(${fn.toString()})(${input})`, fixture(copy, forbidText))));
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

const privacyArgs = {
  popupSelector: '.overlay',
  triggerSelector: '.trigger',
  attr: 'data-trigger',
  max: 1,
  captureText: false,
};

test('popup privacy identities hash copy and change when copy changes', () => {
  const first = snapshot(popupDomSnapshot, privacyArgs, 'First copy');
  const second = snapshot(popupDomSnapshot, privacyArgs, 'Replacement copy');
  assert.notDeepEqual(first.keys, second.keys);
  assert.notEqual(first.candidates[0].label, second.candidates[0].label);
  assert.match(first.candidates[0].label, /^[0-9a-f]{8}$/);
  assert.match(first.keys[0], /\|[0-9a-f]{8}$/);
  assert.ok(!JSON.stringify(first).includes('First copy'));
});

// Exercise the runner's actual guards without a browser or capture side effects.
const popupSource = readFileSync(new URL('../dist/runner/popups.js', import.meta.url), 'utf8');

const openSource = popupSource.slice(
  popupSource.indexOf('async function openPopupCandidate('),
  popupSource.indexOf('const leakedOverlaysDesc'),
);

async function openWithCopy(resetCopy, openedCopy) {
  const first = snapshot(popupDomSnapshot, privacyArgs, 'First copy');
  let copy = resetCopy;

  const page = {
    setViewportSize: async () => {},
    keyboard: { press: async () => {} },
    evaluate: async (fn, args) => snapshot(fn, args, copy),
    locator: () => ({
      first: () => ({
        click: async () => {
          copy = openedCopy;
        },
      }),
    }),
    waitForTimeout: async () => {},
  };

  const open = runInNewContext(`(${openSource.trim()})`, {
    snapshot: (target, args) => target.evaluate(popupDomSnapshot, args),
    POPUP_TRIGGER_ATTR: 'data-trigger',
    realNow: () => 0,
  });

  return open(
    page,
    { go: async () => {} },
    {},
    { timeoutMs: 0, overlays: '.overlay', triggers: '.trigger' },
    first.candidates[0],
    new Set(first.keys),
    false,
  );
}

test('privacy mode skips a shifted same-tag sibling with different text as missing', async () => {
  // No baseline overlay: isolate the trigger identity guard from the leak guard.
  const first = snapshot(popupDomSnapshot, { ...privacyArgs, popupSelector: '.absent' }, 'First copy');
  const rebound = snapshot(
    popupDomSnapshot,
    {
      ...privacyArgs,
      popupSelector: '.absent',
      relocatePath: first.candidates[0].path,
      relocateLabel: first.candidates[0].label,
    },
    'Replacement copy',
  );

  assert.equal(rebound.found, false, 'the runner must take its missing branch');
});

test('privacy mode counts an overlay text-only change as opened', async () => {
  assert.equal((await openWithCopy('First copy', 'Replacement copy')).status, 'opened');
});

test('privacy mode reports text-only leftovers as leaked without logging raw copy', async () => {
  const result = await openWithCopy('Replacement copy', 'Replacement copy');
  assert.equal(result.status, 'leaked');

  const descSource = popupSource.slice(
    popupSource.indexOf('const leakedOverlaysDesc'),
    popupSource.indexOf('function popupMetadata'),
  );

  const reason = runInNewContext(`${descSource}; SKIP_REASONS.leaked`, {})(result.leaked);
  assert.match(reason, /could not clear/);
  assert.ok(!reason.includes('Replacement copy'));
  assert.match(reason, /\|[0-9a-f]{8}/);
});

test('popup default and explicit text mode preserve copy-based keys and labels', () => {
  const args = { popupSelector: '.overlay', triggerSelector: '.trigger', attr: 'data-trigger', max: 1 };
  const first = snapshot(popupDomSnapshot, args);
  assert.deepEqual(first, snapshot(popupDomSnapshot, { ...args, captureText: true }));
  assert.equal(first.keys[0], 'dialog[role="dialog"]|dialog|||||||Private dialog copy');
  assert.equal(first.candidates[0].label, 'Private dialog copy');
  assert.notDeepEqual(first.keys, snapshot(popupDomSnapshot, args, 'Replacement copy').keys);
});

for (const label of ['Send', 'Delete', 'Pay']) {
  test(`popup enumeration rejects ${label} even with private identities`, () => {
    const result = snapshot(popupDomSnapshot, { ...privacyArgs, dangerSource: DANGER_SOURCE }, label);

    assert.equal(result.candidates.length, 0);
  });
}
