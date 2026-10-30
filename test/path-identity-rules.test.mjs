import { GENERATED_ID_SOURCES } from '../dist/generated-id.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { injectPathOf } from '../dist/capture/browser.js';
import { isStableId } from '../dist/inventory.js';

// #1154: authored ids that the stable-id rules wrongly reject, and generated ids they wrongly accept.
const AUTHORED_REJECTED = [
  'reach-out',
  'mui-theme',
  'radix-colors',
  'section:intro',
  'form:email',
  'cell_r_1_c_2',
  'facade01',
];

const GENERATED_ACCEPTED = ['mat-input-0', 'cdk-overlay-0', 'v-0', 'v-1-2'];

function element(tag, attributes = {}, children = []) {
  const node = { tagName: tag.toUpperCase(), getAttribute: (name) => attributes[name] ?? null, children };

  for (const child of children) child.parentElement = node;

  return node;
}

function pathOfDiv(attributes) {
  const div = element('div', attributes);
  const body = element('body', {}, [div]);
  const html = element('html', {}, [body]);
  globalThis.window = {};
  globalThis.document = { documentElement: html, body };

  try {
    injectPathOf(GENERATED_ID_SOURCES);

    return globalThis.window.__spPathOf(div);
  } finally {
    delete globalThis.window;
    delete globalThis.document;
  }
}

test('#1154 authored ids key the element path on both sides', () => {
  const wrong = AUTHORED_REJECTED.filter((id) => !isStableId(id) || !/sp-key\(/.test(pathOfDiv({ id })));
  assert.deepEqual(wrong, []);
});

test('#1154 Angular/CDK and Vue generated ids never key the element path', () => {
  const positional = pathOfDiv({});
  const wrong = GENERATED_ACCEPTED.filter((id) => isStableId(id) || pathOfDiv({ id }) !== positional);
  assert.deepEqual(wrong, []);
});
