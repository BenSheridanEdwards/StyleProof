import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveCrawlConfidence,
  normalizeAuthBoundaryExclude,
  authBoundaryKey,
  mergeAuthBoundaryObservations,
  shouldRetainAuthRedirects,
  redactedRoutePath,
  cliSafeLine,
  crawlCaptureExitCode,
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

test('shouldRetainAuthRedirects drops intermediate redirects only after setup leaves the wall onto a non-auth path', () => {
  assert.equal(shouldRetainAuthRedirects(false, false), true, 'no-setup redirect retains');
  assert.equal(shouldRetainAuthRedirects(false, true), true, 'redirect + landed wall, no setup');
  assert.equal(shouldRetainAuthRedirects(true, true), true, 'still-gated retains');
  assert.equal(shouldRetainAuthRedirects(true, true, '/login'), true, 'still-gated on auth path retains');
  assert.equal(shouldRetainAuthRedirects(true, false, '/vault'), false, 'successful unlock off auth path drops');
  assert.equal(shouldRetainAuthRedirects(true, false, '/dashboard'), false, 'setup left wall on ordinary path drops');
  assert.equal(shouldRetainAuthRedirects(true, false, '/login'), true, 'unrelated setup + auth path retains');
  assert.equal(
    shouldRetainAuthRedirects(true, false, '/oauth/authorize'),
    true,
    'unrelated setup + oauth path retains',
  );
  assert.equal(
    shouldRetainAuthRedirects(true, false, '/auth/callback'),
    true,
    'unrelated setup + auth segment retains',
  );
  assert.equal(shouldRetainAuthRedirects(true, false), true, 'setup + no wall + unknown path fails closed (retain)');
  assert.equal(shouldRetainAuthRedirects(true, false, ''), true, 'empty path fails closed (retain)');
});

test('merge omits route when redaction fails (file URL, opaque query, malformed) and never keeps secrets', () => {
  const diag = [{ kind: 'credential-input', reason: 'password-input', selector: '#pw' }];
  // Assemble non-http schemes at runtime so privacy:check does not flag fixture literals.
  const fileRoute = ['file:', '', 'secret-host', 'token-path', 'login.html'].join('/');
  const fileMerged = mergeAuthBoundaryObservations([{ route: fileRoute, diagnostics: diag }]);
  assert.equal(fileMerged.length, 1);
  assert.equal(fileMerged[0].route, undefined);
  assert.equal(JSON.stringify(fileMerged).includes('secret-host'), false);
  assert.equal(JSON.stringify(fileMerged).includes('token-path'), false);
  assert.equal(JSON.stringify(fileMerged).includes('file:'), false);

  const opaqueMerged = mergeAuthBoundaryObservations([
    { route: '?token=super-secret-token&path=/vault', diagnostics: diag },
  ]);
  assert.equal(opaqueMerged.length, 1);
  assert.equal(opaqueMerged[0].route, undefined);
  assert.equal(JSON.stringify(opaqueMerged).includes('super-secret-token'), false);
  assert.equal(JSON.stringify(opaqueMerged).includes('token='), false);

  const malformedMerged = mergeAuthBoundaryObservations([{ route: 'http://[not-a-valid-url', diagnostics: diag }]);
  assert.equal(malformedMerged.length, 1);
  assert.equal(malformedMerged[0].route, undefined);
  assert.equal(JSON.stringify(malformedMerged).includes('not-a-valid'), false);

  // Successful redaction still strips query tokens.
  assert.equal(redactedRoutePath('/login?token=abc&next=%2Fsecret'), '/login');
  assert.equal(redactedRoutePath(fileRoute), undefined);
  assert.equal(redactedRoutePath('?opaque=1'), undefined);
});

test('cliSafeLine strips newlines and control characters for terminal rendering', () => {
  assert.equal(cliSafeLine('ok reason'), 'ok reason');
  assert.equal(cliSafeLine('line1\nline2\rline3'), 'line1 line2 line3');
  assert.equal(cliSafeLine('tab\there'), 'tab here');
  assert.equal(cliSafeLine('bell\u0007x'), 'bell x');
  // Stored reason semantics stay in resolveCrawlConfidence; only rendering is sanitized.
  const c = resolveCrawlConfidence({
    observations: [passwordObs()],
    exclude: { '/login': 'scope\nwith\nnewlines' },
  });
  assert.equal(c.acknowledged[0].reason, 'scope\nwith\nnewlines');
  assert.equal(cliSafeLine(c.acknowledged[0].reason), 'scope with newlines');
});

test('crawlCaptureExitCode precedence is coverage 4, incomplete UI 6, auth 5, then 0', () => {
  assert.equal(
    crawlCaptureExitCode({
      requireFullCoverage: true,
      hasCoverageResidue: true,
      incompleteUiBlocked: true,
      authBlocked: true,
    }),
    4,
  );
  assert.equal(
    crawlCaptureExitCode({
      requireFullCoverage: false,
      hasCoverageResidue: true,
      incompleteUiBlocked: true,
      authBlocked: true,
    }),
    6,
  );
  assert.equal(
    crawlCaptureExitCode({
      requireFullCoverage: false,
      hasCoverageResidue: false,
      incompleteUiBlocked: false,
      authBlocked: true,
    }),
    5,
  );
  assert.equal(
    crawlCaptureExitCode({
      requireFullCoverage: false,
      hasCoverageResidue: false,
      incompleteUiBlocked: false,
      authBlocked: false,
    }),
    0,
  );
});
