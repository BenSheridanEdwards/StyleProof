import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALLOWED_PRESS_KEYS,
  validateStateRecipe,
  parseStateRecipes,
  stateRecipeKey,
  classifyStateRecipe,
  isAllowedPressKey,
  isUnsafeStateLabel,
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
  assert.deepEqual(validateStateRecipe({ action: 'focus', selector: 'input[name=email]' }), {
    action: 'focus',
    selector: 'input[name=email]',
  });
  assert.deepEqual(validateStateRecipe({ action: 'press', key: 'Escape' }), {
    action: 'press',
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
      selector: '[role=combobox]',
      label: 'Plan',
      stateKey: 'plan-listbox-open',
    }),
    {
      action: 'press',
      key: 'ArrowDown',
      selector: '[role=combobox]',
      label: 'Plan',
      stateKey: 'plan-listbox-open',
    },
  );
});

test('validateStateRecipe: hover/focus/click require selector; press requires key', () => {
  assert.throws(() => validateStateRecipe({ action: 'hover' }), StateRecipeError);
  assert.throws(() => validateStateRecipe({ action: 'focus' }), StateRecipeError);
  assert.throws(() => validateStateRecipe({ action: 'click' }), StateRecipeError);
  assert.throws(() => validateStateRecipe({ action: 'press', selector: '#x' }), StateRecipeError);
  assert.throws(() => validateStateRecipe({ action: 'hover', selector: '' }), StateRecipeError);
});

test('validateStateRecipe: rejects unknown actions and forbidden fields loudly', () => {
  assert.throws(() => validateStateRecipe({ action: 'route' }), /one of hover, focus, press, click/);
  assert.throws(() => validateStateRecipe({ action: 'dblclick', selector: '#x' }), /one of hover, focus, press, click/);
  assert.throws(() => validateStateRecipe({ action: 'hover', selector: '#x', url: '/api' }), /must not include "url"/);
  assert.throws(
    () => validateStateRecipe({ action: 'hover', selector: '#x', script: 'evil()' }),
    /must not include "script"/,
  );
  assert.throws(() => validateStateRecipe({ action: 'hover', selector: '#x', eval: '1' }), /must not include "eval"/);
  assert.throws(
    () => validateStateRecipe({ action: 'hover', selector: '#x', network: {} }),
    /must not include "network"/,
  );
  assert.throws(
    () => validateStateRecipe({ action: 'hover', selector: '#x', dispatchEvent: 'mouseover' }),
    /must not include "dispatchEvent"/,
  );
  assert.throws(() => validateStateRecipe(null), /plain object/);
  assert.throws(() => validateStateRecipe('hover'), /plain object/);
});

test('validateStateRecipe: press keys limited to disclosure/navigation vocabulary', () => {
  // Exact allowed set — no silent expansion
  assert.deepEqual(
    [...ALLOWED_PRESS_KEYS],
    ['Enter', 'Escape', 'Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'],
  );

  for (const key of ALLOWED_PRESS_KEYS) {
    assert.equal(isAllowedPressKey(key), true, key);
    assert.equal(validateStateRecipe({ action: 'press', key }).key, key);
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
      () => validateStateRecipe({ action: 'press', key }),
      /press key must be one of|modifiers, chords, and free-text/,
    );
  }
});

test('parseStateRecipes: validates arrays and indexes errors', () => {
  const recipes = parseStateRecipes([
    { action: 'hover', selector: '#a' },
    { action: 'press', key: 'Enter' },
    { action: 'click', selector: '#b' },
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

  // Explicit stateKey collision (same slug after normalize)
  assert.throws(
    () =>
      parseStateRecipes([
        { action: 'press', key: 'Escape', stateKey: 'dismiss' },
        { action: 'focus', selector: '#x', stateKey: 'dismiss' },
      ]),
    /duplicate state recipe key "dismiss"/,
  );

  // Explicit stateKey slug collides with another recipe's derived key
  assert.throws(
    () =>
      parseStateRecipes([
        { action: 'focus', selector: '#other', stateKey: 'hover-open-menu' },
        { action: 'hover', selector: '#menu', label: 'Open menu' },
      ]),
    /duplicate state recipe key "hover-open-menu"/,
  );

  // stateKey values that slug-normalize to the same key
  assert.throws(
    () =>
      parseStateRecipes([
        { action: 'press', key: 'Tab', stateKey: 'Next Step!' },
        { action: 'focus', selector: '#y', stateKey: 'next-step' },
      ]),
    /duplicate state recipe key "next-step"/,
  );

  // Same free-form inputs that slug to the same key
  assert.throws(
    () =>
      parseStateRecipes([
        { action: 'press', key: 'Enter', label: 'Submit' },
        { action: 'press', key: 'Enter', label: 'Submit' },
      ]),
    /duplicate state recipe key "press-submit-enter"/,
  );

  // click and hover with same label are distinct actions (different keys)
  const mixed = parseStateRecipes([
    { action: 'hover', selector: '#a', label: 'Open menu' },
    { action: 'click', selector: '#a', label: 'Open menu' },
  ]);
  assert.deepEqual(mixed.map(stateRecipeKey), ['click-open-menu', 'hover-open-menu']);
});

test('parseStateRecipes: returns deterministic key ordering (independent variants, not a sequence)', () => {
  const input = [
    { action: 'press', key: 'Escape' },
    { action: 'hover', selector: '#menu', label: 'Open menu' },
    { action: 'focus', selector: '#email' },
    { action: 'click', selector: '#cta', label: 'Start' },
    { action: 'press', key: 'Tab', label: 'Next' },
  ];
  const a = parseStateRecipes(input);
  const b = parseStateRecipes([...input].reverse());
  const keysA = a.map(stateRecipeKey);
  const keysB = b.map(stateRecipeKey);
  assert.deepEqual(keysA, keysB);
  assert.deepEqual(keysA, [...keysA].sort());
  // Sorted by stable key, not input order
  assert.deepEqual(keysA, ['click-start', 'focus-email', 'hover-open-menu', 'press-escape', 'press-next-tab']);
});

// ---------------------------------------------------------------------------
// Stable keys
// ---------------------------------------------------------------------------

test('stateRecipeKey: deterministic keys from action + declared label/selector/key', () => {
  assert.equal(stateRecipeKey({ action: 'hover', selector: '#menu', label: 'Open menu' }), 'hover-open-menu');
  assert.equal(stateRecipeKey({ action: 'focus', selector: '#email' }), 'focus-email');
  assert.equal(stateRecipeKey({ action: 'press', key: 'Escape' }), 'press-escape');
  assert.equal(stateRecipeKey({ action: 'click', selector: '#cta', label: 'Start' }), 'click-start');
  assert.equal(
    stateRecipeKey({ action: 'press', key: 'ArrowDown', selector: '#plan', label: 'Plan' }),
    'press-plan-arrowdown',
  );
  assert.equal(stateRecipeKey({ action: 'hover', selector: '#x', stateKey: 'nav-tooltip' }), 'nav-tooltip');
  // Same inputs → same key across calls
  const recipe = { action: 'hover', selector: 'button.menu', label: 'Show help' };
  assert.equal(stateRecipeKey(recipe), stateRecipeKey({ ...recipe }));
  // Without declared label, selector (not a hypothetical live label) drives the key
  assert.equal(stateRecipeKey({ action: 'focus', selector: '#email' }), 'focus-email');
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

  // Shape still fails before safety
  assert.throws(() => classifyStateRecipe({ action: 'hover' }), StateRecipeError);
  assert.throws(() => classifyStateRecipe({ action: 'press', key: 'Control+c' }), /press key must be one of/);
});

// ---------------------------------------------------------------------------
// Public package entry re-exports
// ---------------------------------------------------------------------------

test('package index re-exports press-key API used by consumers', async () => {
  const pkg = await import('../dist/index.js');
  assert.equal(typeof pkg.isAllowedPressKey, 'function');
  assert.ok(Array.isArray(pkg.ALLOWED_PRESS_KEYS));
  assert.deepEqual([...pkg.ALLOWED_PRESS_KEYS], [...ALLOWED_PRESS_KEYS]);
  assert.equal(pkg.isAllowedPressKey('Enter'), true);
  assert.equal(pkg.isAllowedPressKey('Control+Enter'), false);
  assert.equal(typeof pkg.parseStateRecipes, 'function');
  assert.equal(typeof pkg.validateStateRecipe, 'function');
  assert.equal(typeof pkg.applyStateRecipe, 'function');
  assert.equal(typeof pkg.stateRecipeDriver, 'function');
  assert.equal(typeof pkg.StateRecipeError, 'function');
});
