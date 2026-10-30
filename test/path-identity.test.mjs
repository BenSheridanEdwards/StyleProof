import { GENERATED_ID_SOURCES } from '../dist/generated-id.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { injectPathOf } from '../dist/capture/browser.js';
import { isStableId } from '../dist/inventory.js';

// Ids a framework generates renumber when an unrelated component starts or stops calling the
// generator, so they must never name an element: React useId (18/19.0 `:r0:`, 19.1 `«r0»`,
// 19.2 `_r_0_`, server `_R_0H1_`), Radix and Headless UI scoped ids, MUI fallbacks, hashes.
const GENERATED = [
  ':r0:',
  ':R1:',
  '«r2»',
  '_r_3_',
  '_R_0H1_',
  'app_r_4_',
  'radix-:r5:',
  'radix-_r_6_',
  'headlessui-tabs-tab-3',
  'mui-42',
  'a1b2c3d4e5',
  'ABCDEF0123',
  'app-:r7:',
  'app-«R8»',
  'radix-12',
  'react-aria123-4',
  'react-aria-4',
  'react-aria123-_r_4_',
  'floating-ui-abcd12',
  'downshift-1',
  'downshift-1-toggle-button',
  'downshift-1-item-2',
  'reach-menu-button-3',
  'mat-input-0',
  'cdk-overlay-0',
  'v-0',
  'v-1-2',
];

const AUTHORED = [
  'command',
  'nav-faults',
  'panel_1',
  'main-nav',
  'checkout',
  'reach-out',
  'mui-theme',
  'radix-colors',
  'section:intro',
  'form:email',
  'cell_r_1_c_2',
  'facade01',
  'tooltip-12',
  'step-2',
  'headlessui-tabs',
  'chakra-theme',
  'react-aria-label',
  'floating-ui-panel',
  'downshift-menu',
  'mat-input-label',
  'cdk-overlay-pane',
  'v-next',
  'prefix:r1:suffix',
  'prefix«r2»suffix',
  'prefix_r_3_suffix',
  'mui-42-custom',
  'radix-12-custom',
  'v-1-2-custom',
];

/** The smallest DOM `__spPathOf` walks: tag, attributes, parent, children. */
function element(tag, attributes = {}, children = []) {
  const node = { tagName: tag.toUpperCase(), getAttribute: (name) => attributes[name] ?? null, children };
  for (const child of children) child.parentElement = node;
  return node;
}

/** The capture path of a lone `<div>` carrying `attributes`, from the real in-page function. */
function pathOfDiv(attributes) {
  const div = element('div', attributes);
  const body = element('body', {}, [div]);
  const html = element('html', {}, [body]);
  globalThis.window = {};
  globalThis.document = { documentElement: html, body };
  try {
    runInNewContext(`(${injectPathOf.toString()})(${JSON.stringify(GENERATED_ID_SOURCES)})`, {
      window: globalThis.window,
      document: globalThis.document,
    });
    return globalThis.window.__spPathOf(div);
  } finally {
    delete globalThis.window;
    delete globalThis.document;
  }
}

test('a framework-generated id never becomes part of an element path', () => {
  const positional = pathOfDiv({});
  for (const id of GENERATED) assert.equal(pathOfDiv({ id }), positional, `${id} must not key the path`);
});

test('an authored id still keys the element path', () => {
  for (const id of AUTHORED) assert.match(pathOfDiv({ id }), /^body > div:sp-key\([0-9a-z]+\)$/, id);
});

test('inventory keying and capture paths agree on which ids are stable', () => {
  for (const id of GENERATED) assert.ok(!isStableId(id), `${id} should be rejected as generated`);
  for (const id of AUTHORED) assert.ok(isStableId(id), `${id} should be a stable id`);
});
