import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAuthBoundary } from '../dist/auth-boundary.js';

const candidate = (overrides = {}) => ({ selector: 'form > input:nth-child(1)', ...overrides });

test('classifies password and credential autocomplete metadata without retaining field values', () => {
  const diagnostics = classifyAuthBoundary([
    candidate({ inputType: 'password', value: 'do-not-record-this' }),
    candidate({ autocomplete: 'username', value: 'alice@example.test' }),
    candidate({ autocomplete: 'current-password', text: 'secret' }),
  ]);
  assert.equal(diagnostics.length, 3);
  assert.deepEqual(
    diagnostics.map(({ reason }) => reason),
    ['password-input', 'credential-autocomplete', 'credential-autocomplete'],
  );
  assert.ok(diagnostics.every((diagnostic) => !JSON.stringify(diagnostic).includes('do-not-record-this')));
  assert.ok(diagnostics.every((diagnostic) => !JSON.stringify(diagnostic).includes('alice@example.test')));
  assert.ok(diagnostics.every((diagnostic) => !('value' in diagnostic)));
});

test('recognizes authentication form actions and retains only a redacted path', () => {
  const [diagnostic] = classifyAuthBoundary([
    candidate({ formAction: 'https://app.test/auth/login?returnTo=%2Fbilling#secret' }),
  ]);
  assert.deepEqual(diagnostic, {
    kind: 'auth-form',
    reason: 'auth-form-action',
    selector: 'form > input:nth-child(1)',
    formAction: '/auth/login',
  });
});

test('recognizes redirects to authentication routes without recording query data', () => {
  const [diagnostic] = classifyAuthBoundary([
    { route: '/reports', redirectTo: 'https://app.test/sign-in?next=%2Freports&token=secret', redirectStatus: 302 },
  ]);
  assert.deepEqual(diagnostic, {
    kind: 'auth-redirect',
    reason: 'auth-route-redirect',
    route: '/reports',
    redirectTo: '/sign-in',
    redirectStatus: 302,
  });
});

test('ignores ordinary fields, ordinary routes, and non-auth redirects', () => {
  assert.deepEqual(
    classifyAuthBoundary([
      candidate({ inputType: 'email', autocomplete: 'email', formAction: '/subscribe' }),
      { route: '/reports', redirectTo: '/reports?tab=all', redirectStatus: 200 },
      { route: '/reports', redirectTo: '/maintenance', redirectStatus: 302 },
    ]),
    [],
  );
});

test('returns stable sorted diagnostics and redacts URLs with credentials or malformed input', () => {
  const diagnostics = classifyAuthBoundary([
    { route: 'https://app.test/private?user=alice', redirectTo: 'https://app.test/login', redirectStatus: 302 },
    candidate({ formAction: 'not a url' }),
    candidate({ inputType: 'PASSWORD' }),
  ]);
  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.reason),
    ['password-input', 'auth-route-redirect'],
  );
  assert.equal(JSON.stringify(diagnostics).includes('alice'), false);
  assert.equal(JSON.stringify(diagnostics).includes('not a url'), false);
});

test('redactedSelector rejects attribute equality selectors whether quoted or unquoted', () => {
  const leaky = [
    'input[value=plaintext-secret]',
    'input[value="quoted-secret"]',
    "input[value='single-quoted']",
    'input[value=`backtick`]',
    'input[type=password][name=user]',
    'form input[autocomplete^=current]',
  ];
  for (const selector of leaky) {
    const diagnostics = classifyAuthBoundary([{ selector, inputType: 'password' }]);
    assert.equal(diagnostics.length, 1, `expected diagnostic for ${selector}`);
    assert.equal(diagnostics[0].kind, 'credential-input');
    assert.equal(
      'selector' in diagnostics[0] && diagnostics[0].selector,
      false,
      `selector must be dropped: ${selector}`,
    );
    assert.equal(JSON.stringify(diagnostics).includes('secret'), false);
    assert.equal(JSON.stringify(diagnostics).includes('plaintext'), false);
    assert.equal(JSON.stringify(diagnostics).includes('quoted'), false);
  }
  const [kept] = classifyAuthBoundary([candidate({ inputType: 'password' })]);
  assert.equal(kept.selector, 'form > input:nth-child(1)');
});

test('does not treat generic account routes/forms as auth without a strong auth segment', () => {
  assert.deepEqual(
    classifyAuthBoundary([
      candidate({ formAction: '/account' }),
      candidate({ formAction: '/account/settings' }),
      candidate({ formAction: 'https://app.test/accounts/profile' }),
      { route: '/dashboard', redirectTo: '/account', redirectStatus: 302 },
      { route: '/dashboard', redirectTo: '/account/billing', redirectStatus: 301 },
    ]),
    [],
  );
  // Strong auth segments still classify even when `account` appears nearby.
  const [form] = classifyAuthBoundary([candidate({ formAction: '/account/login' })]);
  assert.deepEqual(form, {
    kind: 'auth-form',
    reason: 'auth-form-action',
    selector: 'form > input:nth-child(1)',
    formAction: '/account/login',
  });
  const [redirect] = classifyAuthBoundary([{ route: '/reports', redirectTo: '/auth/account', redirectStatus: 302 }]);
  assert.equal(redirect.reason, 'auth-route-redirect');
  assert.equal(redirect.redirectTo, '/auth/account');
});
