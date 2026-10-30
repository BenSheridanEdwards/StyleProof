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
  'menu::appr1::trigger',
  'menu:«appr1»:trigger',
  'menu:_appr_1_:trigger',
  'menu::r1::trigger',
  'dialog:v-0:content',
  'dialog:v-1-2:content',
  'menu:cl-0:trigger',
  ':my.appr0:',
  'radix-12-custom',
  'mui-42-custom',
  'radix-12-trigger-account',
  'radix-12-content-account',
  'mui-42-listbox',
  'mui-42-option-0',
  'mui-42-label',
  'react-aria123-4-tab-account',
  'react-aria8345678901-4-tab-account',
  'radix-:appr0:',
  'radix-:appr1:',
  'headlessui-menu-button-:appr2:',
  'headlessui-menu-button-«appr2»',
  'menu-:appr1:-trigger',
  'downshift-:appr1:-menu',
  'radix-«appr1»',
  '_appr_0_',
  '_appR_0H1_',
  'radix-_appr_0_',
  'radix-_appR_0H1_-trigger',
  'section:main-ref:x',
  ':appr0:',
  '«appr1»',
  'prefix:r1:suffix',
  'prefix«r2»suffix',
  'prefix_r_3_suffix',
  ':app-r0:',
  '«app-r0»',
  '_app-r_0_',
  'radix-:app-r1:',
  'menu-button-:app-r3:',
  'headlessui-menu-button-«app-r2»',
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
  'radix-:r1:-trigger-account',
  'radix-:r1:-content-account',
  'downshift-:r1:-menu',
  'downshift-:r1:-item-0',
  ':r1:-listbox',
  ':r1:-option-0',
  'field-:r1:-label',
  'tabs-:r1:--tab-0',
  '«r1»-listbox',
  'radix-_r_6_-trigger-x',
  'tabs::r1::trigger:a',
  'chakra-modal-3',
  'chakra-modal--header-3',
  'mat-mdc-form-field-label-0',
  'mat-mdc-checkbox-1-input',
  'mat-select-value-1',
  'mat-tab-label-0-1',
  'cdk-describedby-message-0',
  'cdk-accordion-child-3',
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
  'section:hero1:x',
  'a:bar2:b',
  'nav:primary:item',
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

for (const [name, ids] of [
  ['React suffixed tokens', GENERATED.filter((id) => id.includes('r1') || id.includes('_r_6_'))],
  ['Chakra v1 counters', GENERATED.filter((id) => id.startsWith('chakra-'))],
  ['Angular multi-segment counters', GENERATED.filter((id) => /^(?:mat|cdk)-/.test(id))],
]) {
  test(`${name} never key inventory or serialized capture paths`, () => {
    const positional = pathOfDiv({});

    for (const id of ids) {
      assert.equal(isStableId(id), false, id);
      assert.equal(pathOfDiv({ id }), positional, id);
    }
  });
}
