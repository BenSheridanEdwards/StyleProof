import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALLOWED_PRESS_KEYS,
  MAX_RECIPE_SELECTOR_LENGTH,
  validateStateRecipe,
  parseStateRecipes,
  stateRecipeKey,
  classifyStateRecipe,
  isAllowedPressKey,
  isUnsafeStateLabel,
  assertSafeRecipeSelector,
  stateRecipeGo,
  StateRecipeError,
} from '../dist/state-recipes.js';

// ---------------------------------------------------------------------------
// Pure schema validation
// ---------------------------------------------------------------------------

test('validateStateRecipe: accepts hover/focus/press/click shapes', () => {
  assert.deepEqual(validateStateRecipe({ action: 'hover', selector: '#menu', label: 'Open menu' }), {
    action: 'hover',
    selector: '#menu',
    label: 'Open menu',
  });
  assert.deepEqual(validateStateRecipe({ action: 'focus', selector: '#email' }), {
    action: 'focus',
    selector: '#email',
  });
  assert.deepEqual(validateStateRecipe({ action: 'press', selector: '#dialog', key: 'Escape' }), {
    action: 'press',
    selector: '#dialog',
    key: 'Escape',
  });
  assert.deepEqual(validateStateRecipe({ action: 'click', selector: '#menu', label: 'Open menu' }), {
    action: 'click',
    selector: '#menu',
    label: 'Open menu',
  });
  assert.deepEqual(
    validateStateRecipe({
      action: 'press',
      key: 'ArrowDown',
      selector: '#plan',
      label: 'Plan',
      stateKey: 'plan-listbox-open',
    }),
    {
      action: 'press',
      key: 'ArrowDown',
      selector: '#plan',
      label: 'Plan',
      stateKey: 'plan-listbox-open',
    },
  );
  // Value-free structural selectors
  assert.equal(validateStateRecipe({ action: 'focus', selector: 'input[name]' }).selector, 'input[name]');
  assert.equal(validateStateRecipe({ action: 'click', selector: '[aria-expanded]' }).selector, '[aria-expanded]');
  assert.equal(validateStateRecipe({ action: 'hover', selector: '  #card  ' }).selector, '#card');
});

test('validateStateRecipe: every action requires selector; press requires key', () => {
  assert.throws(() => validateStateRecipe({ action: 'hover' }), /privacy policy|selector/);
  assert.throws(() => validateStateRecipe({ action: 'focus' }), /privacy policy|selector/);
  assert.throws(() => validateStateRecipe({ action: 'click' }), /privacy policy|selector/);
  assert.throws(() => validateStateRecipe({ action: 'press', key: 'Escape' }), /privacy policy|selector/);
  assert.throws(() => validateStateRecipe({ action: 'press', selector: '#x' }), /requires a key/);
  assert.throws(() => validateStateRecipe({ action: 'hover', selector: '' }), /privacy policy/);
  assert.throws(() => validateStateRecipe({ action: 'hover', selector: '   ' }), /privacy policy/);
});

test('validateStateRecipe: closed-world — rejects unknown keys including typos and deferred fields', () => {
  const unknown = [
    'seletor',
    'timeout',
    'force',
    'button',
    'modifiers',
    'fill',
    'value',
    'href',
    'script',
    'eval',
    'route',
    'url',
    'network',
    'dispatchEvent',
    'code',
    'futureField',
  ];
  for (const field of unknown) {
    assert.throws(
      () => validateStateRecipe({ action: 'hover', selector: '#x', [field]: 'x' }),
      new RegExp(`must not include "${field}"`),
      field,
    );
  }
  assert.throws(() => validateStateRecipe({ action: 'route' }), /one of hover, focus, press, click/);
  assert.throws(() => validateStateRecipe({ action: 'dblclick', selector: '#x' }), /one of hover, focus, press, click/);
  assert.throws(() => validateStateRecipe(null), /plain object/);
  assert.throws(() => validateStateRecipe('hover'), /plain object/);
  // key only allowed on press
  assert.throws(() => validateStateRecipe({ action: 'hover', selector: '#x', key: 'Enter' }), /must not include "key"/);
});

test('validateStateRecipe: press keys limited to disclosure/navigation vocabulary', () => {
  assert.deepEqual(
    [...ALLOWED_PRESS_KEYS],
    ['Enter', 'Escape', 'Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'],
  );

  for (const key of ALLOWED_PRESS_KEYS) {
    assert.equal(isAllowedPressKey(key), true, key);
    assert.equal(validateStateRecipe({ action: 'press', selector: '#t', key }).key, key);
  }

  const rejected = [
    'a',
    'A',
    'enter',
    'ENTER',
    ' ',
    'PageDown',
    'PageUp',
    'F1',
    'Backspace',
    'Delete',
    'Meta+k',
    'Control+Enter',
    'Shift+Tab',
    'Alt+ArrowDown',
    'cmd+s',
    'Control+Shift+p',
    'hello',
    'ArrowDown ArrowUp',
  ];
  for (const key of rejected) {
    assert.equal(isAllowedPressKey(key), false, key);
    assert.throws(
      () => validateStateRecipe({ action: 'press', selector: '#t', key }),
      /press key must be one of|modifiers, chords, and free-text/,
    );
  }
});

test('validateStateRecipe: blank/whitespace label rejected', () => {
  assert.throws(() => validateStateRecipe({ action: 'hover', selector: '#x', label: '' }), /label/);
  assert.throws(() => validateStateRecipe({ action: 'hover', selector: '#x', label: '   ' }), /label/);
  assert.equal(validateStateRecipe({ action: 'hover', selector: '#x', label: '  Open  ' }).label, 'Open');
});

// ---------------------------------------------------------------------------
// Selector privacy
// ---------------------------------------------------------------------------

test('assertSafeRecipeSelector / validateStateRecipe: rejects secret-bearing and unsafe selectors without echoing secrets', () => {
  const secret = 'super-secret-token-xyz';
  const leaky = [
    `input[value=${secret}]`,
    `input[value="${secret}"]`,
    `input[value='${secret}']`,
    `[data-token=${secret}]`,
    `[data-token="${secret}"]`,
    `a[href="/path?token=${secret}"]`,
    `a[href*="${secret}"]`,
    `input[name=user]`,
    `[role=button]`,
    'form input[autocomplete^=current]',
    `#x\n.y`,
    `#x\u0000y`,
    `#x\u200by`,
    'a'.repeat(MAX_RECIPE_SELECTOR_LENGTH + 1),
    `a[href="https://user:${secret}@evil.test/"]`,
  ];

  for (const selector of leaky) {
    let err;
    try {
      validateStateRecipe({ action: 'focus', selector });
      assert.fail(`expected reject for selector policy case`);
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof StateRecipeError, 'StateRecipeError');
    assert.match(String(err.message), /privacy policy/);
    const serialized = JSON.stringify({ message: err.message, name: err.name, stack: err.stack });
    assert.equal(serialized.includes(secret), false, 'error must not contain secret');
    assert.equal(String(err.message).includes(secret), false);
    // Oversized case has no secret; still no raw dump of selector body beyond policy name
    if (selector.includes(secret)) {
      assert.equal(serialized.includes(secret.slice(0, 8)), false);
    }
  }

  // Accepted value-free structural selectors
  for (const selector of ['#id', '.class', 'button.primary', '[aria-expanded]', 'input[name]', 'nav > a']) {
    assert.equal(assertSafeRecipeSelector(selector), selector);
    assert.equal(validateStateRecipe({ action: 'click', selector }).selector, selector);
  }
});

// ---------------------------------------------------------------------------
// Collections + keys
// ---------------------------------------------------------------------------

test('parseStateRecipes: validates arrays and indexes errors', () => {
  const recipes = parseStateRecipes([
    { action: 'hover', selector: '#a' },
    { action: 'press', selector: '#b', key: 'Enter' },
    { action: 'click', selector: '#c' },
  ]);
  assert.equal(recipes.length, 3);
  assert.throws(() => parseStateRecipes({ action: 'hover' }), /JSON array/);
  assert.throws(() => parseStateRecipes([{ action: 'hover' }]), /state recipe\[0\]/);
});

test('parseStateRecipes: rejects duplicate derived stable keys', () => {
  assert.throws(
    () =>
      parseStateRecipes([
        { action: 'hover', selector: '#menu', label: 'Open menu' },
        { action: 'hover', selector: '#other', label: 'Open menu' },
      ]),
    /duplicate state recipe key "hover-open-menu".*recipes\[0\].*recipes\[1\].*independent variants/,
  );

  assert.throws(
    () =>
      parseStateRecipes([
        { action: 'press', selector: '#a', key: 'Escape', stateKey: 'dismiss' },
        { action: 'focus', selector: '#x', stateKey: 'dismiss' },
      ]),
    /duplicate state recipe key "dismiss"/,
  );

  assert.throws(
    () =>
      parseStateRecipes([
        { action: 'focus', selector: '#other', stateKey: 'hover-open-menu' },
        { action: 'hover', selector: '#menu', label: 'Open menu' },
      ]),
    /duplicate state recipe key "hover-open-menu"/,
  );

  assert.throws(
    () =>
      parseStateRecipes([
        { action: 'press', selector: '#a', key: 'Tab', stateKey: 'Next Step!' },
        { action: 'focus', selector: '#y', stateKey: 'next-step' },
      ]),
    /duplicate state recipe key "next-step"/,
  );

  assert.throws(
    () =>
      parseStateRecipes([
        { action: 'press', selector: '#a', key: 'Enter', label: 'Submit' },
        { action: 'press', selector: '#b', key: 'Enter', label: 'Submit' },
      ]),
    /duplicate state recipe key "press-submit-enter"/,
  );

  const mixed = parseStateRecipes([
    { action: 'hover', selector: '#a', label: 'Open menu' },
    { action: 'click', selector: '#a', label: 'Open menu' },
  ]);
  assert.deepEqual(mixed.map(stateRecipeKey), ['click-open-menu', 'hover-open-menu']);
});

test('parseStateRecipes: returns deterministic key ordering (independent variants, not a sequence)', () => {
  const input = [
    { action: 'press', selector: '#dlg', key: 'Escape' },
    { action: 'hover', selector: '#menu', label: 'Open menu' },
    { action: 'focus', selector: '#email' },
    { action: 'click', selector: '#cta', label: 'Start' },
    { action: 'press', selector: '#nav', key: 'Tab', label: 'Next' },
  ];
  const a = parseStateRecipes(input);
  const b = parseStateRecipes([...input].reverse());
  const keysA = a.map(stateRecipeKey);
  const keysB = b.map(stateRecipeKey);
  assert.deepEqual(keysA, keysB);
  assert.deepEqual(keysA, [...keysA].sort());
  assert.deepEqual(keysA, ['click-start', 'focus-email', 'hover-open-menu', 'press-dlg-escape', 'press-next-tab']);
});

test('stateRecipeKey: deterministic keys from action + declared label/selector/key', () => {
  assert.equal(stateRecipeKey({ action: 'hover', selector: '#menu', label: 'Open menu' }), 'hover-open-menu');
  assert.equal(stateRecipeKey({ action: 'focus', selector: '#email' }), 'focus-email');
  assert.equal(stateRecipeKey({ action: 'press', selector: '#dlg', key: 'Escape' }), 'press-dlg-escape');
  assert.equal(stateRecipeKey({ action: 'click', selector: '#cta', label: 'Start' }), 'click-start');
  assert.equal(
    stateRecipeKey({ action: 'press', key: 'ArrowDown', selector: '#plan', label: 'Plan' }),
    'press-plan-arrowdown',
  );
  assert.equal(stateRecipeKey({ action: 'hover', selector: '#x', stateKey: 'nav-tooltip' }), 'nav-tooltip');
  const recipe = { action: 'hover', selector: 'button.menu', label: 'Show help' };
  assert.equal(stateRecipeKey(recipe), stateRecipeKey({ ...recipe }));
});

// ---------------------------------------------------------------------------
// Destructive-action guard (shared DANGER_SOURCE)
// ---------------------------------------------------------------------------

test('isUnsafeStateLabel: matches the shared destructive vocabulary', () => {
  assert.equal(isUnsafeStateLabel('Delete account'), true);
  assert.equal(isUnsafeStateLabel('Revoke access'), true);
  assert.equal(isUnsafeStateLabel('Open menu'), false);
  assert.equal(isUnsafeStateLabel('Save draft'), false);
});

test('classifyStateRecipe: soft-skips unsafe labels; validates shape first', () => {
  const unsafe = classifyStateRecipe({
    action: 'hover',
    selector: 'button.delete',
    label: 'Delete account',
  });
  assert.equal(unsafe.ok, false);
  if (!unsafe.ok) {
    assert.equal(unsafe.skip.reason, 'unsafe-label');
    assert.equal(unsafe.skip.label, 'Delete account');
    assert.match(unsafe.skip.detail, /destructive-action guard/);
  }

  const safe = classifyStateRecipe({ action: 'focus', selector: '#email', label: 'Email' });
  assert.equal(safe.ok, true);
  if (safe.ok) assert.equal(safe.recipe.action, 'focus');

  assert.throws(() => classifyStateRecipe({ action: 'hover' }), StateRecipeError);
  assert.throws(
    () => classifyStateRecipe({ action: 'press', selector: '#x', key: 'Control+c' }),
    /press key must be one of/,
  );
  assert.throws(() => classifyStateRecipe({ action: 'press', key: 'Escape' }), /privacy policy|selector/);
});

// ---------------------------------------------------------------------------
// stateRecipeGo adapter + public package entry
// ---------------------------------------------------------------------------

test('stateRecipeGo: returns Promise<void> driver after validating recipe', async () => {
  const go = stateRecipeGo({ action: 'focus', selector: '#email', label: 'Email' });
  assert.equal(typeof go, 'function');
  // Validate-on-build: bad recipes throw before a page exists
  assert.throws(() => stateRecipeGo({ action: 'press', key: 'Escape' }), /privacy policy|selector/);
  assert.throws(() => stateRecipeGo({ action: 'hover', selector: `input[value=secret-nope]` }), /privacy policy/);
});

test('package index re-exports consumer API (no stateRecipeDriver; has stateRecipeGo)', async () => {
  const pkg = await import('../dist/index.js');
  assert.equal(typeof pkg.isAllowedPressKey, 'function');
  assert.ok(Array.isArray(pkg.ALLOWED_PRESS_KEYS));
  assert.deepEqual([...pkg.ALLOWED_PRESS_KEYS], [...ALLOWED_PRESS_KEYS]);
  assert.equal(pkg.isAllowedPressKey('Enter'), true);
  assert.equal(pkg.isAllowedPressKey('Control+Enter'), false);
  assert.equal(typeof pkg.parseStateRecipes, 'function');
  assert.equal(typeof pkg.validateStateRecipe, 'function');
  assert.equal(typeof pkg.applyStateRecipe, 'function');
  assert.equal(typeof pkg.stateRecipeGo, 'function');
  assert.equal(pkg.stateRecipeDriver, undefined);
  assert.equal(typeof pkg.StateRecipeError, 'function');
  // Type fixture module is built
  const fixture = await import('../dist/state-recipe-go-assignability.js');
  assert.equal(fixture.stateRecipeSurfaceVariantFixture.key, 'plan-card-hover');
  assert.equal(typeof fixture.stateRecipeSurfaceVariantFixture.go, 'function');
});
