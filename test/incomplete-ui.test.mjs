import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyIncompleteUi } from '../dist/incomplete-ui.js';

const candidate = (overrides = {}) => ({ selector: 'main > form:nth-child(1)', ...overrides });

test('flags a form even when no password field is present', () => {
  const [diagnostic] = classifyIncompleteUi([candidate({ tag: 'form', value: 'do-not-record-this' })]);
  assert.deepEqual(diagnostic, { kind: 'form', reason: 'form-present', selector: 'main > form:nth-child(1)' });
  assert.equal(JSON.stringify(diagnostic).includes('do-not-record-this'), false);
  assert.equal('value' in diagnostic, false);
});

test('flags disabled, aria-disabled, inert, and pointer-blocked controls as blocked continuation', () => {
  const diagnostics = classifyIncompleteUi([
    candidate({ disabled: true }),
    { selector: 'button.primary', ariaDisabled: true },
    { selector: 'section.wizard', inert: true },
    { selector: 'button.css-blocked', tag: 'button', pointerEventsNone: true },
    { selector: 'div.decorative', tag: 'div', pointerEventsNone: true },
  ]);
  assert.deepEqual(
    diagnostics.map(({ reason }) => reason),
    ['disabled-control', 'aria-disabled', 'inert', 'pointer-events-none'],
  );
});

test('flags an empty required input and never copies the value field', () => {
  const [empty] = classifyIncompleteUi([
    candidate({ required: true, valuePresent: false, value: 'secret-should-not-appear' }),
  ]);
  assert.deepEqual(empty, {
    kind: 'required-empty',
    reason: 'required-input-empty',
    selector: 'main > form:nth-child(1)',
  });
  assert.equal(JSON.stringify(empty).includes('secret'), false);
  const filled = classifyIncompleteUi([candidate({ required: true, valuePresent: true })]);
  assert.deepEqual(filled, []);
});

test('flags closed tabs, accordions, and details as unvisited surfaces', () => {
  const diagnostics = classifyIncompleteUi([
    { selector: 'nav > button:nth-child(1)', ariaExpanded: false },
    { tag: 'details', detailsOpen: false, selector: 'details.faq' },
    { selector: 'nav > button:nth-child(2)', ariaExpanded: true },
    { tag: 'details', detailsOpen: true, selector: 'details.open' },
  ]);
  assert.deepEqual(diagnostics, [
    { kind: 'closed-disclosure', reason: 'aria-collapsed', selector: 'nav > button:nth-child(1)' },
    { kind: 'closed-disclosure', reason: 'details-closed', selector: 'details.faq' },
  ]);
});

test('drops attribute-equality selectors so field values cannot leak', () => {
  const leaky = ['input[value=plaintext-secret]', 'input[value="quoted-secret"]', 'button[name=user]'];
  for (const selector of leaky) {
    const [diagnostic] = classifyIncompleteUi([{ selector, disabled: true }]);
    assert.equal(diagnostic.reason, 'disabled-control');
    assert.equal('selector' in diagnostic && diagnostic.selector, false, `selector must be dropped: ${selector}`);
    assert.equal(JSON.stringify(diagnostic).includes('secret'), false);
  }
});

test('ignores ordinary enabled controls with no form or closed disclosure', () => {
  assert.deepEqual(
    classifyIncompleteUi([
      { tag: 'button', disabled: false, required: false, valuePresent: true },
      { tag: 'input', type: 'email', required: false },
    ]),
    [],
  );
});
