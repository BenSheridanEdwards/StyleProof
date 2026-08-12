import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateStateRecipe,
  parseStateRecipes,
  stateRecipeKey,
  classifyStateRecipe,
  isUnsafeStateLabel,
  StateRecipeError,
} from '../dist/state-recipes.js';

// ---------------------------------------------------------------------------
// Pure schema validation
// ---------------------------------------------------------------------------

test('validateStateRecipe: accepts hover/focus/press shapes', () => {
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

test('validateStateRecipe: hover/focus require selector; press requires key', () => {
  assert.throws(() => validateStateRecipe({ action: 'hover' }), StateRecipeError);
  assert.throws(() => validateStateRecipe({ action: 'focus' }), StateRecipeError);
  assert.throws(() => validateStateRecipe({ action: 'press', selector: '#x' }), StateRecipeError);
  assert.throws(() => validateStateRecipe({ action: 'hover', selector: '' }), StateRecipeError);
});

test('validateStateRecipe: rejects unknown actions and forbidden fields loudly', () => {
  assert.throws(() => validateStateRecipe({ action: 'click', selector: '#x' }), /one of hover, focus, press/);
  assert.throws(() => validateStateRecipe({ action: 'route' }), /one of hover, focus, press/);
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

test('parseStateRecipes: validates arrays and indexes errors', () => {
  const recipes = parseStateRecipes([
    { action: 'hover', selector: '#a' },
    { action: 'press', key: 'Enter' },
  ]);
  assert.equal(recipes.length, 2);
  assert.throws(() => parseStateRecipes({ action: 'hover' }), /JSON array/);
  assert.throws(() => parseStateRecipes([{ action: 'hover' }]), /state recipe\[0\]/);
});

// ---------------------------------------------------------------------------
// Stable keys
// ---------------------------------------------------------------------------

test('stateRecipeKey: deterministic keys from action + label/selector/key', () => {
  assert.equal(stateRecipeKey({ action: 'hover', selector: '#menu', label: 'Open menu' }), 'hover-open-menu');
  assert.equal(stateRecipeKey({ action: 'focus', selector: '#email' }), 'focus-email');
  assert.equal(stateRecipeKey({ action: 'press', key: 'Escape' }), 'press-escape');
  assert.equal(
    stateRecipeKey({ action: 'press', key: 'ArrowDown', selector: '#plan', label: 'Plan' }),
    'press-plan-arrowdown',
  );
  assert.equal(stateRecipeKey({ action: 'hover', selector: '#x', stateKey: 'nav-tooltip' }), 'nav-tooltip');
  // Same inputs → same key across calls
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

  // Shape still fails before safety
  assert.throws(() => classifyStateRecipe({ action: 'hover' }), StateRecipeError);
});
