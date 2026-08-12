import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveCrawlConfidence,
  normalizeAuthBoundaryExclude,
  authBoundaryKey,
  mergeAuthBoundaryObservations,
  shouldRetainAuthRedirects,
} from '../dist/crawl-confidence.js';

const passwordObs = (route = '/login') => ({
  route,
  diagnostics: [{ kind: 'credential-input', reason: 'password-input', selector: '#pw' }],
});

test('no observations → complete and certifies fully', () => {
  const c = resolveCrawlConfidence({ observations: [] });
  assert.equal(c.status, 'complete');
  assert.equal(c.certifiesFully, true);
  assert.equal(c.blocked, false);
  assert.deepEqual(c.authBoundaries, []);
  assert.deepEqual(c.unacknowledged, []);
});

test('password boundary → incomplete-auth and blocked when unacknowledged', () => {
  const c = resolveCrawlConfidence({ observations: [passwordObs()] });
  assert.equal(c.status, 'incomplete-auth');
  assert.equal(c.certifiesFully, false);
  assert.equal(c.blocked, true);
  assert.equal(c.unacknowledged.length, 1);
  assert.equal(c.unacknowledged[0].key, '/login·password-input');
  assert.ok(!JSON.stringify(c).includes('secret'));
});

test('reasoned exclusion clears blocked but never claims full certification', () => {
  const c = resolveCrawlConfidence({
    observations: [passwordObs()],
    exclude: { '/login': 'SSO login page outside certification scope' },
  });
  assert.equal(c.status, 'incomplete-auth');
  assert.equal(c.certifiesFully, false);
  assert.equal(c.blocked, false);
  assert.equal(c.acknowledged.length, 1);
  assert.equal(c.acknowledged[0].reason, 'SSO login page outside certification scope');
  assert.deepEqual(c.unacknowledged, []);
});

test('full observation key and formAction/redirectTo also match exclusions', () => {
  const formObs = {
    route: '/app',
    diagnostics: [{ kind: 'auth-form', reason: 'auth-form-action', formAction: '/auth/login' }],
  };
  const byForm = resolveCrawlConfidence({
    observations: [formObs],
    exclude: { '/auth/login': 'legacy form host' },
  });
  assert.equal(byForm.blocked, false);
  assert.equal(byForm.acknowledged[0].key, authBoundaryKey(formObs));

  const byFull = resolveCrawlConfidence({
    observations: [passwordObs('/gate')],
    exclude: { '/gate·password-input': 'fixture gate' },
  });
  assert.equal(byFull.blocked, false);
});

test('empty exclusion reasons are rejected', () => {
  assert.throws(() => normalizeAuthBoundaryExclude({ '/login': '' }), /non-empty reason/);
  assert.throws(() => normalizeAuthBoundaryExclude({ '/login': '   ' }), /non-empty reason/);
  assert.throws(() => resolveCrawlConfidence({ observations: [], exclude: { '/x': '' } }), /non-empty reason/);
  assert.throws(() => normalizeAuthBoundaryExclude({ '': 'reason' }), /key must be a non-empty/);
});

test('unknownIncompleteness without auth → incomplete-unknown', () => {
  const c = resolveCrawlConfidence({ observations: [], unknownIncompleteness: true });
  assert.equal(c.status, 'incomplete-unknown');
  assert.equal(c.certifiesFully, false);
  assert.equal(c.blocked, false);
});

test('merge dedupes diagnostics and strips query from routes', () => {
  const merged = mergeAuthBoundaryObservations([
    {
      route: '/login?next=%2Fsecret&token=abc',
      diagnostics: [{ kind: 'credential-input', reason: 'password-input', selector: '#a' }],
    },
    {
      route: '/login',
      diagnostics: [
        { kind: 'credential-input', reason: 'password-input', selector: '#a' },
        { kind: 'credential-input', reason: 'credential-autocomplete', selector: '#b' },
      ],
    },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].route, '/login');
  assert.equal(merged[0].diagnostics.length, 2);
  assert.equal(JSON.stringify(merged).includes('token'), false);
  assert.equal(JSON.stringify(merged).includes('secret'), false);
});

test('stale exclusions are reported when nothing matched', () => {
  const c = resolveCrawlConfidence({
    observations: [passwordObs('/login')],
    exclude: {
      '/login': 'in scope ack',
      '/gone': 'rotted opt-out',
    },
  });
  assert.deepEqual(c.staleExclusions, ['/gone']);
});

test('shouldRetainAuthRedirects drops intermediate redirects only after setup leaves the wall', () => {
  assert.equal(shouldRetainAuthRedirects(false, false), true, 'redirect-only, no setup');
  assert.equal(shouldRetainAuthRedirects(false, true), true, 'redirect + landed wall, no setup');
  assert.equal(shouldRetainAuthRedirects(true, true), true, 'setup but still gated');
  assert.equal(shouldRetainAuthRedirects(true, false), false, 'setup left auth boundary');
});
