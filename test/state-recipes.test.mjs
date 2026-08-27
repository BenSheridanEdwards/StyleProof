import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALLOWED_PRESS_KEYS,
  MAX_RECIPE_SELECTOR_LENGTH,
  MAX_RECIPE_LABEL_LENGTH,
  MAX_RECIPE_STATE_KEY_LENGTH,
  validateStateRecipe,
  parseStateRecipes,
  stateRecipeKey,
  classifyStateRecipe,
  isAllowedPressKey,
  isUnsafeStateLabel,
  assertSafeRecipeSelector,
  assertSafeRecipeLabel,
  assertSafeRecipeStateKey,
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
  // Value-free structural CSS selectors
  assert.equal(validateStateRecipe({ action: 'focus', selector: 'input[name]' }).selector, 'input[name]');
  assert.equal(validateStateRecipe({ action: 'click', selector: '[aria-expanded]' }).selector, '[aria-expanded]');
  assert.equal(validateStateRecipe({ action: 'hover', selector: '  #card  ' }).selector, '#card');
  assert.equal(validateStateRecipe({ action: 'click', selector: 'li:first-child' }).selector, 'li:first-child');
  assert.equal(validateStateRecipe({ action: 'click', selector: 'li:nth-child(2)' }).selector, 'li:nth-child(2)');
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

test('validateStateRecipe: transient observation is bounded, structural, and explicitly keyed', () => {
  assert.deepEqual(
    validateStateRecipe({
      action: 'click',
      selector: '#notify',
      stateKey: 'toast-visible',
      observeSelector: '[role]',
      observeMs: 250,
    }),
    {
      action: 'click',
      selector: '#notify',
      stateKey: 'toast-visible',
      observeSelector: '[role]',
      observeMs: 250,
    },
  );

  assert.throws(
    () => validateStateRecipe({ action: 'click', selector: '#notify', observeSelector: '[role]', observeMs: 250 }),
    /observation requires an explicit stateKey/,
  );
  assert.throws(
    () => validateStateRecipe({ action: 'click', selector: '#notify', stateKey: 'toast', observeSelector: '[role]' }),
    /observeSelector and observeMs must be provided together/,
  );
  assert.throws(
    () => validateStateRecipe({ action: 'click', selector: '#notify', stateKey: 'toast', observeMs: 250 }),
    /observeSelector and observeMs must be provided together/,
  );
  for (const observeMs of [49, 5001, 100.5, Number.NaN, Number.POSITIVE_INFINITY, '250']) {
    assert.throws(
      () =>
        validateStateRecipe({
          action: 'click',
          selector: '#notify',
          stateKey: 'toast',
          observeSelector: '[role]',
          observeMs,
        }),
      /observeMs must be an integer from 50 to 5000 milliseconds/,
    );
  }

  const secret = 'transient-secret-value';
  try {
    validateStateRecipe({
      action: 'click',
      selector: '#notify',
      stateKey: 'toast',
      observeSelector: `[data-token=${secret}]`,
      observeMs: 250,
    });
    assert.fail('expected observation selector policy rejection');
  } catch (e) {
    assert.match(String(e.message), /privacy policy/);
    assert.equal(`${e.message}\n${e.stack ?? ''}`.includes(secret), false);
  }
});

test('validateStateRecipe: route recipes install bounded value-free network errors only', () => {
  assert.deepEqual(
    validateStateRecipe({ action: 'route', stateKey: 'plans-network-error', urlPattern: '**/api/plans', status: 503 }),
    { action: 'route', stateKey: 'plans-network-error', urlPattern: '**/api/plans', status: 503 },
  );
  assert.equal(
    stateRecipeKey({ action: 'route', stateKey: 'plans-network-error', urlPattern: '**/api/plans', status: 503 }),
    'plans-network-error',
  );
  assert.throws(
    () => validateStateRecipe({ action: 'route', urlPattern: '**/api/plans', status: 503 }),
    /route requires an explicit stateKey/,
  );
  for (const status of [399, 600, 503.5, Number.NaN, '503']) {
    assert.throws(
      () => validateStateRecipe({ action: 'route', stateKey: 'network-error', urlPattern: '**/api/plans', status }),
      /status must be an integer from 400 to 599/,
    );
  }
  for (const extra of [{ selector: '#button' }, { key: 'Enter' }, { observeSelector: '#toast', observeMs: 100 }]) {
    assert.throws(
      () =>
        validateStateRecipe({
          action: 'route',
          stateKey: 'network-error',
          urlPattern: '**/api/plans',
          status: 503,
          ...extra,
        }),
      /route must not include interaction fields/,
    );
  }

  const secret = 'network-secret-value';
  for (const urlPattern of [`**/api/plans?token=${secret}`, `**/api/${secret}=x`, `**/api/${secret}\n`]) {
    try {
      validateStateRecipe({ action: 'route', stateKey: 'network-error', urlPattern, status: 503 });
      assert.fail('expected URL-pattern policy rejection');
    } catch (e) {
      assert.match(String(e.message), /privacy policy/);
      assert.equal(`${e.message}\n${e.stack ?? ''}`.includes(secret), false);
    }
  }
  assert.throws(
    () => validateStateRecipe({ action: 'click', selector: '#button', urlPattern: '**/api/plans', status: 503 }),
    /interaction recipe must not include route fields/,
  );

  const destructive = classifyStateRecipe({
    action: 'route',
    stateKey: 'delete-account-network-error',
    urlPattern: '**/api/account',
    status: 503,
  });
  assert.equal(destructive.ok, false);
  assert.equal(destructive.skip.reason, 'unsafe-label');
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
  // Hostile / secret-bearing field names are not echoed
  const secretField = 'password=super-secret-field-xyz';
  let fieldErr;
  try {
    validateStateRecipe({ action: 'hover', selector: '#x', [secretField]: 'x' });
    assert.fail('expected reject');
  } catch (e) {
    fieldErr = e;
  }
  assert.ok(fieldErr instanceof StateRecipeError);
  assert.match(String(fieldErr.message), /\(invalid field name\)/);
  const fieldSer = JSON.stringify({ m: fieldErr.message, s: fieldErr.stack });
  assert.equal(fieldSer.includes(secretField), false);
  assert.equal(fieldSer.includes('super-secret-field-xyz'), false);
  // Newline / control in field name
  const nlField = 'evil\nkey';
  try {
    validateStateRecipe({ action: 'hover', selector: '#x', [nlField]: 1 });
    assert.fail('expected reject');
  } catch (e) {
    assert.match(String(e.message), /\(invalid field name\)/);
    assert.equal(String(e.message).includes('\n'), false);
    assert.equal(String(e.stack ?? '').includes(nlField), false);
  }
  assert.throws(
    () => validateStateRecipe({ action: 'navigate', selector: '#x' }),
    /one of hover, focus, press, click, route/,
  );
  assert.throws(
    () => validateStateRecipe({ action: 'dblclick', selector: '#x' }),
    /one of hover, focus, press, click, route/,
  );
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

test('assertSafeRecipeSelector / validateStateRecipe: CSS-only policy rejects secret-bearing and engine forms without echoing secrets', () => {
  const secret = 'super-secret-token-xyz';
  const leaky = [
    `input[value=${secret}]`,
    `input[value="${secret}"]`,
    `input[value='${secret}']`,
    'input[value=`' + secret + '`]',
    `[data-token=${secret}]`,
    `[data-token="${secret}"]`,
    `a[href="/path?token=${secret}"]`,
    `a[href*="${secret}"]`,
    `input[name=user]`,
    `[role=button]`,
    'form input[autocomplete^=current]',
    '#x' + String.fromCharCode(10) + '.y',
    '#x' + String.fromCharCode(0) + 'y',
    '#x' + String.fromCharCode(0x200b) + 'y',
    '#x' + String.fromCharCode(92) + 'escape',

    'a'.repeat(MAX_RECIPE_SELECTOR_LENGTH + 1),
    `a[href="https://user:${secret}@evil.test/"]`,
    // Playwright engines + value-carrying functions (CSS-only contract)
    `:text("${secret}")`,
    `:text(${secret})`,
    `:has-text("${secret}")`,
    `text=${secret}`,
    `text="${secret}"`,
    `xpath=//div[@data="${secret}"]`,
    `css=button.${secret}`,
    `id=${secret}`,
    `data-testid=${secret}`,
    `role=button`,
    `nth=0`,
    `url(http://evil.test/${secret})`,
    `button:text(${secret})`,
    `:is(:text(${secret}))`,
    `:not(:text(${secret}))`,
    // Escapes / nested smuggling
    '#x' + String.fromCharCode(92) + ':text(' + secret + ')',

    `internal:testid=${secret}`,
    // Playwright locator chaining (not CSS; single `>` remains OK)
    `>> ${secret}`,
    `button >> ${secret}`,
    `#menu >> text=${secret}`,
    `div >> css=button`,
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
    if (selector.includes(secret)) {
      assert.equal(serialized.includes(secret.slice(0, 8)), false);
    }
  }

  // Accepted value-free structural CSS selectors
  for (const selector of [
    '#id',
    '.class',
    'button.primary',
    '[aria-expanded]',
    'input[name]',
    'nav > a',
    'li:first-child',
    'li:nth-child(2)',
    'button:hover',
    ':not(.disabled)',
  ]) {
    assert.equal(assertSafeRecipeSelector(selector), selector);
    assert.equal(validateStateRecipe({ action: 'click', selector }).selector, selector);
  }
});

test('stateRecipeKey: re-validates at entry — secret selectors never produce keys or leak in errors', () => {
  const secret = 'super-secret-password';
  const hostile = [
    `input[value="${secret}"]`,
    `input[value=${secret}]`,
    `:text(${secret})`,
    `text=${secret}`,
    `xpath=//input[@value="${secret}"]`,
  ];
  for (const selector of hostile) {
    let err;
    try {
      // Direct cast/JS call bypassing validateStateRecipe
      stateRecipeKey(/** @type {any} */ ({ action: 'focus', selector }));
      assert.fail('expected stateRecipeKey to reject');
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof StateRecipeError);
    assert.match(String(err.message), /privacy policy/);
    const serialized = JSON.stringify({ message: err.message, name: err.name, stack: err.stack });
    assert.equal(serialized.includes(secret), false, 'key error must not contain secret');
    assert.equal(serialized.includes('super-secret'), false);
  }
  // Safe path still works
  assert.equal(stateRecipeKey({ action: 'focus', selector: '#email' }), 'focus-email');
});

test('label / stateKey bounds, controls, and non-collapsing slugs', () => {
  assert.equal(assertSafeRecipeLabel('Open menu'), 'Open menu');
  assert.equal(assertSafeRecipeStateKey('nav-tooltip'), 'nav-tooltip');
  assert.equal(MAX_RECIPE_LABEL_LENGTH, 160);
  assert.equal(MAX_RECIPE_STATE_KEY_LENGTH, 80);

  const secret = 'super-secret-label-token';
  const badLabels = [
    '',
    '   ',
    'x'.repeat(MAX_RECIPE_LABEL_LENGTH + 1),
    'line1' + String.fromCharCode(10) + 'line2',
    `password=${secret}`,
    `token=${secret}`,
  ];
  for (const label of badLabels) {
    let err;
    try {
      validateStateRecipe({ action: 'hover', selector: '#x', label });
      assert.fail('expected label reject');
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof StateRecipeError);
    const ser = JSON.stringify({ m: err.message, s: err.stack });
    assert.equal(ser.includes(secret), false);
    assert.equal(String(err.message).includes('\n'), false);
    assert.equal(String(err.message).includes(String.fromCharCode(10)), false);
  }

  // Labels that cannot slug rejected at pure validation (not only at key time)
  for (const label of ['!!!', '🎉', '你好']) {
    assert.throws(
      () => validateStateRecipe({ action: 'hover', selector: '#x', label }),
      /label rejected by privacy policy/,
    );
  }

  // stateKey must slug; all-punctuation collapses rejected (no generic "state")
  for (const stateKey of ['!!!', '---', '…', '@@@', '']) {
    assert.throws(
      () => validateStateRecipe({ action: 'hover', selector: '#x', stateKey }),
      /stateKey rejected by privacy policy/,
    );
    assert.throws(
      () => stateRecipeKey(/** @type {any} */ ({ action: 'hover', selector: '#x', stateKey })),
      /stateKey rejected by privacy policy|must be a non-empty/,
    );
  }
  assert.throws(
    () =>
      validateStateRecipe({ action: 'hover', selector: '#x', stateKey: 'k'.repeat(MAX_RECIPE_STATE_KEY_LENGTH + 1) }),
    /stateKey rejected by privacy policy/,
  );
  assert.throws(
    () => validateStateRecipe({ action: 'hover', selector: '#x', stateKey: 'a' + String.fromCharCode(0) + 'b' }),
    /stateKey rejected by privacy policy/,
  );
  // Selector that cannot slug
  assert.throws(() => stateRecipeKey(/** @type {any} */ ({ action: 'hover', selector: '###' })), /privacy policy/);
});

// Playwright >> chaining rejected before key derivation (no secret echo)
test('selector policy: Playwright >> chaining rejected without echoing secrets', () => {
  const secret = 'chain-secret-token-xyz';
  const chained = [`>> ${secret}`, `button >> ${secret}`, `#x >> .y`, `main >> ${secret}`];
  for (const selector of chained) {
    for (const fn of [
      () => assertSafeRecipeSelector(selector),
      () => validateStateRecipe({ action: 'focus', selector }),
      () => stateRecipeKey(/** @type {any} */ ({ action: 'focus', selector })),
      () => classifyStateRecipe({ action: 'click', selector }),
      () => stateRecipeGo({ action: 'hover', selector }),
    ]) {
      let err;
      try {
        fn();
        assert.fail(`expected reject for ${JSON.stringify(selector)}`);
      } catch (e) {
        err = e;
      }
      assert.ok(err instanceof StateRecipeError);
      assert.match(String(err.message), /privacy policy/);
      const ser = JSON.stringify({ m: err.message, s: err.stack, n: err.name });
      assert.equal(ser.includes(secret), false, 'must not echo secret');
      assert.equal(ser.includes('chain-secret'), false);
    }
  }
  // Single CSS child combinator remains allowed
  assert.equal(assertSafeRecipeSelector('nav > a'), 'nav > a');
  assert.equal(validateStateRecipe({ action: 'click', selector: 'nav > a' }).selector, 'nav > a');
});

// Labels must slug; emoji/CJK/punctuation-only fail pure validation (preflight)
test('label policy: requires non-empty slug fragment (emoji/CJK/punct-only rejected)', () => {
  const bad = ['🎉', '🔥🔥', '你好', '日本語', '!!!', '…', '@@@', '—', '   !!!   '];
  for (const label of bad) {
    for (const fn of [
      () => assertSafeRecipeLabel(label),
      () => validateStateRecipe({ action: 'hover', selector: '#x', label }),
      () => classifyStateRecipe({ action: 'hover', selector: '#x', label }),
      () => stateRecipeKey(/** @type {any} */ ({ action: 'hover', selector: '#x', label })),
      () => stateRecipeGo({ action: 'focus', selector: '#x', label }),
    ]) {
      let err;
      try {
        fn();
        assert.fail(`expected label reject for ${JSON.stringify(label)}`);
      } catch (e) {
        err = e;
      }
      assert.ok(err instanceof StateRecipeError);
      assert.match(String(err.message), /label rejected by privacy policy|slug-able/);
      // Never echo the raw label body in errors
      const msg = String(err.message);
      if (label.trim()) {
        assert.equal(msg.includes(label.trim()), false);
      }
    }
  }
  // Mixed labels that retain an alphanumeric fragment still work
  assert.equal(assertSafeRecipeLabel('Open 🎉 menu'), 'Open 🎉 menu');
  assert.equal(stateRecipeKey({ action: 'hover', selector: '#x', label: 'Open 🎉 menu' }), 'hover-open-menu');
});

// Canonical stateRecipeKey = full validate + internal derive
test('stateRecipeKey: full canonical validation (unknown fields, non-press key, invalid press key)', () => {
  // Unknown fields
  assert.throws(
    () => stateRecipeKey(/** @type {any} */ ({ action: 'hover', selector: '#x', timeout: 1 })),
    /must not include "timeout"/,
  );
  assert.throws(
    () => stateRecipeKey(/** @type {any} */ ({ action: 'focus', selector: '#x', force: true })),
    /must not include "force"/,
  );
  // key only on press
  assert.throws(
    () => stateRecipeKey(/** @type {any} */ ({ action: 'hover', selector: '#x', key: 'Enter' })),
    /must not include "key"/,
  );
  assert.throws(
    () => stateRecipeKey(/** @type {any} */ ({ action: 'click', selector: '#x', key: 'Escape' })),
    /must not include "key"/,
  );
  // invalid press key
  assert.throws(
    () => stateRecipeKey(/** @type {any} */ ({ action: 'press', selector: '#x', key: 'Control+c' })),
    /press key must be one of/,
  );
  assert.throws(
    () => stateRecipeKey(/** @type {any} */ ({ action: 'press', selector: '#x', key: 'a' })),
    /press key must be one of/,
  );
  // missing press key
  assert.throws(() => stateRecipeKey(/** @type {any} */ ({ action: 'press', selector: '#x' })), /requires a key/);
  // matches validate → derive for safe recipes
  const r = { action: 'press', selector: '#dlg', key: 'Escape', label: 'Dialog' };
  assert.equal(stateRecipeKey(r), 'press-dialog-escape');
  assert.equal(stateRecipeKey(validateStateRecipe(r)), 'press-dialog-escape');
  // >> + secret never in key path
  const secret = 'key-path-secret-zzz';
  try {
    stateRecipeKey(/** @type {any} */ ({ action: 'focus', selector: `button >> ${secret}` }));
    assert.fail('expected reject');
  } catch (e) {
    const ser = JSON.stringify({ m: e.message, s: e.stack });
    assert.equal(ser.includes(secret), false);
    assert.match(String(e.message), /privacy policy/);
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
  // Type fixture module is built (go only — not setup)
  const fixture = await import('../dist/state-recipe-go-assignability.js');
  assert.equal(fixture.stateRecipeSurfaceVariantFixture.key, 'plan-card-hover');
  assert.equal(typeof fixture.stateRecipeSurfaceVariantFixture.go, 'function');
  assert.equal(fixture.stateRecipeSurfaceVariantFixture.setup, undefined);
});

// ---------------------------------------------------------------------------
// Linear scanners — CodeQL js/polynomial-redos regression shapes
// Semantic accept/reject + bounded completion (not timing-theater alone).
// ---------------------------------------------------------------------------

test('linear scanners: CodeQL-named adversarial shapes reject without secret echo', () => {
  const secret = 'poly-redos-secret-token-xyz';

  /** @type {Array<{ name: string, run: () => unknown, expectReject?: boolean, expectAccept?: string }>} */
  const cases = [
    // many hyphens (slugFragment path via label/stateKey)
    {
      name: 'many-hyphens-label-slug',
      run: () => stateRecipeKey({ action: 'hover', selector: '#x', label: `${'-'.repeat(40)}ok${'-'.repeat(40)}` }),
      expectAccept: 'hover-ok',
    },
    {
      name: 'many-hyphens-only-label',
      run: () => validateStateRecipe({ action: 'hover', selector: '#x', label: '-'.repeat(80) }),
      expectReject: true,
    },
    // SIMPLE_SELECTOR_LIST_ARG shapes: '!' + spaces / spaces inside :not()
    {
      name: 'not-bang-spaces',
      run: () => assertSafeRecipeSelector(`:not(${'!'.repeat(80)}${' '.repeat(80)})`),
      expectReject: true,
    },
    {
      name: 'not-spaces-only',
      run: () => assertSafeRecipeSelector(`:not(${' '.repeat(120)})`),
      expectReject: true,
    },
    {
      name: 'not-simple-class',
      run: () => assertSafeRecipeSelector(':not(.disabled)'),
      expectAccept: ':not(.disabled)',
    },
    // >> with spaces (includes path)
    {
      name: 'spaced-double-gt',
      run: () => assertSafeRecipeSelector(`button ${' '.repeat(40)}>>${' '.repeat(40)} .x`),
      expectReject: true,
    },
    // repeated [ / [=
    {
      name: 'many-open-brackets',
      run: () => assertSafeRecipeSelector(`${'['.repeat(120)}name]`),
      expectReject: true,
    },
    {
      name: 'bracket-eq-repeats',
      run: () => assertSafeRecipeSelector(`[${'='.repeat(80)}]`),
      expectReject: true,
    },
    {
      name: 'nested-brackets',
      run: () => assertSafeRecipeSelector('[[aria-expanded]]'),
      expectReject: true,
    },
    {
      name: 'presence-attr-ok',
      run: () => assertSafeRecipeSelector('[aria-expanded]'),
      expectAccept: '[aria-expanded]',
    },
    {
      name: 'presence-name-ok',
      run: () => assertSafeRecipeSelector('input[name]'),
      expectAccept: 'input[name]',
    },
    // many + / : (credential + combinator stress)
    {
      name: 'many-plus-colon',
      run: () => assertSafeRecipeSelector(`${'+'.repeat(80)}:${':'.repeat(40)}@${secret}`),
      expectReject: true,
    },
    {
      name: 'userinfo-at',
      run: () => assertSafeRecipeSelector(`//user:${secret}@host`),
      expectReject: true,
    },
    // repeated :A(( pseudo nesting / unbalance
    {
      name: 'nested-pseudo-parens',
      run: () => assertSafeRecipeSelector(`:A${'(('.repeat(40)}x${'))'.repeat(40)}`),
      expectReject: true,
    },
    {
      name: 'unbalanced-pseudo-parens',
      run: () => assertSafeRecipeSelector(`:not(${'('.repeat(60)}x`),
      expectReject: true,
    },
    {
      name: 'nth-child-ok',
      run: () => assertSafeRecipeSelector('li:nth-child(2)'),
      expectAccept: 'li:nth-child(2)',
    },
    // max-length selectors / labels / stateKeys
    {
      name: 'max-selector',
      run: () => assertSafeRecipeSelector('a'.repeat(MAX_RECIPE_SELECTOR_LENGTH)),
      expectAccept: 'a'.repeat(MAX_RECIPE_SELECTOR_LENGTH),
    },
    {
      name: 'over-max-selector',
      run: () => assertSafeRecipeSelector('a'.repeat(MAX_RECIPE_SELECTOR_LENGTH + 1)),
      expectReject: true,
    },
    {
      name: 'max-label',
      run: () => assertSafeRecipeLabel(`L${'a'.repeat(MAX_RECIPE_LABEL_LENGTH - 1)}`),
      expectAccept: `L${'a'.repeat(MAX_RECIPE_LABEL_LENGTH - 1)}`,
    },
    {
      name: 'max-stateKey',
      run: () => assertSafeRecipeStateKey(`k${'a'.repeat(MAX_RECIPE_STATE_KEY_LENGTH - 1)}`),
      expectAccept: `k${'a'.repeat(MAX_RECIPE_STATE_KEY_LENGTH - 1)}`,
    },
    {
      name: 'credential-label',
      run: () => assertSafeRecipeLabel(`password=${secret}`),
      expectReject: true,
    },
  ];

  for (const c of cases) {
    let result;
    let err;
    try {
      result = c.run();
    } catch (e) {
      err = e;
    }
    if (c.expectReject) {
      assert.ok(err instanceof StateRecipeError, `${c.name}: expected StateRecipeError`);
      assert.match(String(err.message), /privacy policy/);
      const ser = JSON.stringify({ m: err.message, s: err.stack, n: err.name });
      assert.equal(ser.includes(secret), false, `${c.name}: must not echo secret`);
      assert.equal(ser.includes('poly-redos-secret'), false, `${c.name}: must not echo secret prefix`);
    } else {
      assert.equal(err, undefined, `${c.name}: unexpected reject ${err && err.message}`);
      if (c.expectAccept !== undefined) {
        if (typeof result === 'object' && result && 'label' in result) {
          assert.equal(result.label, c.expectAccept, c.name);
        } else {
          assert.equal(result, c.expectAccept, c.name);
        }
      }
    }
  }
});

test('linear scanners: stress shapes complete boundedly (semantic loop + generous probe)', () => {
  const shapes = [
    () => {
      try {
        assertSafeRecipeLabel(`${'-'.repeat(10_000)}ok`);
      } catch {
        /* reject is fine */
      }
    },
    () => {
      try {
        assertSafeRecipeSelector(`${'['.repeat(2_000)}${'='.repeat(2_000)}`);
      } catch {
        /* reject is fine */
      }
    },
    () => {
      try {
        assertSafeRecipeSelector(`:not(${'!'.repeat(1_000)}${' '.repeat(1_000)})`);
      } catch {
        /* reject is fine */
      }
    },
    () => {
      try {
        assertSafeRecipeSelector(`x ${' '.repeat(500)}>>${' '.repeat(500)} y`);
      } catch {
        /* reject is fine */
      }
    },
    () => {
      try {
        assertSafeRecipeSelector(`${'+'.repeat(1_000)}:${':'.repeat(500)}@x`);
      } catch {
        /* reject is fine */
      }
    },
    () => {
      try {
        assertSafeRecipeSelector(`:A${'(('.repeat(200)}x`);
      } catch {
        /* reject is fine */
      }
    },
    () => {
      try {
        assertSafeRecipeLabel(`password=${'x'.repeat(500)}`);
      } catch {
        /* reject is fine */
      }
    },
    () => {
      // accept path still linear at max bounds
      assertSafeRecipeSelector('a'.repeat(MAX_RECIPE_SELECTOR_LENGTH));
      assertSafeRecipeLabel('Open menu');
      stateRecipeKey({ action: 'hover', selector: '#menu', label: 'Open menu' });
    },
  ];

  // Semantic loop: each shape runs many times and always finishes.
  const iterations = 200;
  for (const shape of shapes) {
    for (let i = 0; i < iterations; i++) shape();
  }

  // Generous performance sanity probe (not a flake-prone tight threshold).
  const started = Date.now();
  for (let i = 0; i < 2_000; i++) {
    for (const shape of shapes) shape();
  }
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 15_000, `stress probe exceeded generous budget: ${elapsed}ms`);
});
