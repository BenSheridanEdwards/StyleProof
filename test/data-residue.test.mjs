import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { endpointOf, residueKey, unionResidue, auditResidue, auditRunResidue } from '../dist/data-residue.js';
import { trackDataResidue, urlMatcher } from '../dist/capture.js';

test('urlMatcher reproduces Playwright URL-glob semantics for the data boundary', () => {
  const m = urlMatcher('**/api/**');
  // `**` spans path separators — the default `**/api/**` matches nested API paths.
  assert.equal(m('http://app.test/api/probe'), true);
  assert.equal(m('http://app.test/v1/api/users?id=1'), true);
  assert.equal(m('http://api.test/api/x'), true);
  // Non-API assets (JS/CSS/fonts) load live and must NOT match.
  assert.equal(m('http://app.test/static/app.js'), false);
  assert.equal(m('http://app.test/assets/logo.png'), false);
  // A single `*` stays within a segment.
  const seg = urlMatcher('http://app.test/api/*');
  assert.equal(seg('http://app.test/api/users'), true);
  assert.equal(seg('http://app.test/api/users/1'), false); // `/` not crossed by single `*`
  // A glob-char-free string is a substring match (Playwright's non-glob fallback).
  const sub = urlMatcher('/graphql');
  assert.equal(sub('http://app.test/graphql?q=1'), true);
  assert.equal(sub('http://app.test/api/x'), false);
});

test('urlMatcher keeps Playwright glob punctuation literal and validates brace groups', () => {
  const brackets = urlMatcher('**/api/[id]');
  assert.equal(brackets('https://app.test/api/[id]'), true);
  assert.equal(brackets('https://app.test/api/i'), false);

  const group = urlMatcher('**/api/{users,teams}');
  assert.equal(group('https://app.test/api/users'), true);
  assert.equal(group('https://app.test/api/teams'), true);
  assert.equal(group('https://app.test/api/users,teams'), false);

  const comma = urlMatcher('**/api/users,teams');
  assert.equal(comma('https://app.test/api/users,teams'), true);
  assert.equal(comma('https://app.test/api/users'), false);

  const escapedStar = urlMatcher('**/api/\\*');
  assert.equal(escapedStar('https://app.test/api/*'), true);
  assert.equal(escapedStar('https://app.test/api/users'), false);

  assert.throws(() => urlMatcher('**/api/{users,{teams,orgs}}'), /nested '\{' is not supported/);
  assert.throws(() => urlMatcher('**/api/{users,teams'), /unmatched '\{'/);
  assert.throws(() => urlMatcher('**/api/users}'), /unmatched '\}'/);
});

// The residue guard's pure core: query-stripped endpoints, escaped surface·endpoint keys,
// dedupe across widths / a self-check re-run, and ledger reconciliation (unacknowledged +
// stale). Mirrors the inventory guard's unit tests — same list-vs-ledger discipline, but a
// failing endpoint is present-on-HEAD, not a base-vs-head removal.

const entry = (surface, endpoint, reason = 'net::ERR_CONNECTION_REFUSED') => ({
  key: residueKey(surface, endpoint),
  surface,
  endpoint,
  reason,
});
const mapWith = (...entries) => ({ dataResidue: entries });

test('endpointOf strips the query so ?all=1 vs ?all=2 do not fork the key', () => {
  assert.equal(endpointOf('https://app.test/api/probe?all=1'), '/api/probe');
  assert.equal(endpointOf('https://app.test/api/probe?all=2'), '/api/probe');
  // A non-URL string falls back to itself, never throws.
  assert.equal(endpointOf('not a url'), 'not a url');
});

test('residueKey escapes Markdown-significant chars so a key cannot inject into the report', () => {
  const k = residueKey('dashboard', '/api/x[]`');
  assert.equal(k.includes('['), false);
  assert.equal(k.includes('`'), false);
  assert.match(k, /^dashboard·/);
});

test('unionResidue dedupes the same failure across widths / a self-check re-run to ONE entry', () => {
  // The same surface·endpoint seen on 3 widths → one entry, not a spray.
  const union = unionResidue([
    mapWith(entry('dashboard', '/api/probe')),
    mapWith(entry('dashboard', '/api/probe')),
    mapWith(entry('dashboard', '/api/probe')),
  ]);
  assert.equal(union.length, 1);
  assert.equal(union[0].key, 'dashboard·/api/probe');
});

test('auditResidue: an unacknowledged failing endpoint is unacknowledged; acknowledging clears it', () => {
  const head = [mapWith(entry('dashboard', '/api/probe'))];
  const bare = auditResidue(head, {});
  assert.deepEqual(
    bare.unacknowledged.map((r) => r.key),
    ['dashboard·/api/probe'],
  );
  const acked = auditResidue(head, { 'dashboard·/api/probe': 'known-down staging probe' });
  assert.deepEqual(acked.unacknowledged, []);
  assert.deepEqual(acked.staleAcknowledgements, []);
});

test('auditResidue: an acknowledgement for an endpoint no longer failing is STALE (ledger cannot rot)', () => {
  // Endpoint got fixtured → no residue on head, but the ack lingers → stale.
  const clean = auditResidue([mapWith()], { 'dashboard·/api/probe': 'was down' });
  assert.deepEqual(clean.residue, []);
  assert.deepEqual(clean.staleAcknowledgements, ['dashboard·/api/probe']);
});

test('auditRunResidue carries the armed bit through unchanged', () => {
  const head = [mapWith(entry('dashboard', '/api/probe'))];
  assert.equal(auditRunResidue(head, {}, true).armed, true);
  assert.equal(auditRunResidue(head, {}, false).armed, false);
});

test('a 4xx/5xx completion is residue just like a network failure (reason carries the status)', () => {
  const head = [mapWith(entry('dashboard', '/api/probe', 'HTTP 503'))];
  const audit = auditResidue(head, {});
  assert.equal(audit.unacknowledged[0].reason, 'HTTP 503');
});

// Fakes for the harvest-layer (page-event) tests. A request the CURRENT surface owns
// fires its `request` event while the watcher is armed — every fake surface-owned
// request below is emitted as `request` first, exactly as Playwright orders events.
const fakeMainFrame = { parentFrame: () => null };
const fakeRequest = (url, resourceType = 'fetch', errorText = 'net::ERR_ABORTED') => ({
  url: () => url,
  resourceType: () => resourceType,
  isNavigationRequest: () => false,
  failure: () => ({ errorText }),
});
const fakeNavigationRequest = (url) => ({
  url: () => url,
  resourceType: () => 'document',
  isNavigationRequest: () => true,
  frame: () => fakeMainFrame,
  failure: () => null,
});

test('a failed request under a literal-bracket data boundary is recorded as residue', () => {
  const page = new EventEmitter();
  const request = fakeRequest('https://app.test/api/[id]');
  const residue = trackDataResidue(page, '**/api/[id]', 'dashboard');

  page.emit('request', request);
  page.emit('requestfailed', request);

  assert.deepEqual(residue.residue(), [
    {
      key: 'dashboard·/api/-id-',
      surface: 'dashboard',
      endpoint: '/api/[id]',
      reason: 'net::ERR_ABORTED',
    },
  ]);
  residue.dispose();
});

test('an EventSource HTTP 204 terminal response is clean when Chromium later reports ERR_ABORTED', () => {
  const page = new EventEmitter();
  const request = fakeRequest('https://app.test/api/stream', 'eventsource');
  const response = { request: () => request, status: () => 204 };
  const residue = trackDataResidue(page, '**/api/**', 'dashboard');

  // Chromium can report the protocol-level EventSource shutdown as a successful
  // 204 response followed by requestfailed(ERR_ABORTED). The 204 is terminal by
  // design; it does not render a data-fallback branch and must not gate capture.
  page.emit('request', request);
  page.emit('response', response);
  page.emit('requestfailed', request);

  assert.deepEqual(residue.residue(), []);
  residue.dispose();
});

test('an EventSource HTTP 204 terminal response clears an earlier ERR_ABORTED observation', () => {
  const page = new EventEmitter();
  const request = fakeRequest('https://app.test/api/stream', 'eventsource');
  const residue = trackDataResidue(page, '**/api/**', 'dashboard');

  page.emit('request', request);
  page.emit('requestfailed', request);
  page.emit('response', { request: () => request, status: () => 204 });

  assert.deepEqual(residue.residue(), []);
  residue.dispose();
});

test('a stream abort without a terminal HTTP 204 response remains fail-closed residue', () => {
  const page = new EventEmitter();
  const request = fakeRequest('https://app.test/api/stream', 'eventsource');
  const residue = trackDataResidue(page, '**/api/**', 'dashboard');

  page.emit('request', request);
  page.emit('requestfailed', request);

  assert.deepEqual(residue.residue(), [
    {
      endpoint: '/api/stream',
      key: 'dashboard·/api/stream',
      reason: 'net::ERR_ABORTED',
      surface: 'dashboard',
    },
  ]);
  residue.dispose();
});

test('an EventSource HTTP 200 followed by an abort remains fail-closed residue', () => {
  const page = new EventEmitter();
  const request = fakeRequest('https://app.test/api/stream', 'eventsource');
  const residue = trackDataResidue(page, '**/api/**', 'dashboard');

  page.emit('request', request);
  page.emit('response', { request: () => request, status: () => 200 });
  page.emit('requestfailed', request);

  assert.equal(residue.residue()[0]?.reason, 'net::ERR_ABORTED');
  residue.dispose();
});

test('a non-EventSource HTTP 204 followed by an abort remains fail-closed residue', () => {
  const page = new EventEmitter();
  const request = fakeRequest('https://app.test/api/job', 'fetch');
  const residue = trackDataResidue(page, '**/api/**', 'dashboard');

  page.emit('request', request);
  page.emit('response', { request: () => request, status: () => 204 });
  page.emit('requestfailed', request);

  assert.equal(residue.residue()[0]?.reason, 'net::ERR_ABORTED');
  residue.dispose();
});

// ── surface-handoff attribution (issue #364) ────────────────────────────────────
// The walk shares ONE page across surfaces. A request a previous surface started can
// abort during the NEXT surface's window (the handoff navigation kills it), and which
// surface caught the `requestfailed` event was a timing lottery. Only requests
// initiated inside the current surface's window may be charged to it.

test('a leftover request from a previous surface, aborted during the handoff, is NOT the successor surface’s residue', () => {
  const page = new EventEmitter();
  // The previous surface started this stream — its `request` event fired BEFORE this
  // watcher armed, so this watcher never saw it start.
  const leftoverStream = fakeRequest('https://app.test/api/stream', 'eventsource');
  const residue = trackDataResidue(page, '**/api/**', 'next-surface');

  // The handoff navigation aborts the leftover while THIS surface's watcher is armed.
  page.emit('requestfailed', leftoverStream);

  assert.deepEqual(residue.residue(), []);
  residue.dispose();
});

test('a request initiated before a cross-document commit that aborts after it is a handoff artifact, not residue', () => {
  const page = new EventEmitter();
  // Fired by the OUTGOING document after this watcher armed but before go()'s
  // navigation committed — the commit orphans it.
  const outgoingFetch = fakeRequest('https://app.test/api/poll', 'fetch');
  const residue = trackDataResidue(page, '**/api/**', 'next-surface');

  page.emit('request', outgoingFetch);
  page.emit('request', fakeNavigationRequest('https://app.test/next'));
  page.emit('framenavigated', fakeMainFrame); // cross-document commit
  page.emit('requestfailed', outgoingFetch); // the commit aborted the old document's fetch

  assert.deepEqual(residue.residue(), []);
  residue.dispose();
});

test('a genuine failure initiated after the commit is still residue (the gate is not weakened)', () => {
  const page = new EventEmitter();
  const ownFetch = fakeRequest('https://app.test/api/probe', 'fetch', 'net::ERR_CONNECTION_REFUSED');
  const residue = trackDataResidue(page, '**/api/**', 'dashboard');

  page.emit('request', fakeNavigationRequest('https://app.test/dashboard'));
  page.emit('framenavigated', fakeMainFrame); // this surface's own navigation commits
  page.emit('request', ownFetch); // initiated by the NEW document
  page.emit('requestfailed', ownFetch);

  assert.deepEqual(
    residue.residue().map((entry) => [entry.key, entry.reason]),
    [['dashboard·/api/probe', 'net::ERR_CONNECTION_REFUSED']],
  );
  residue.dispose();
});

test('a same-document navigation (pushState) does NOT orphan an SPA surface’s own failing fetch', () => {
  const page = new EventEmitter();
  const spaFetch = fakeRequest('https://app.test/api/probe', 'fetch', 'net::ERR_CONNECTION_REFUSED');
  const residue = trackDataResidue(page, '**/api/**', 'spa-tab');

  page.emit('request', spaFetch);
  // `framenavigated` fires for pushState too, but no document request preceded it —
  // the document survives, so its in-flight requests stay owned.
  page.emit('framenavigated', fakeMainFrame);
  page.emit('requestfailed', spaFetch);

  assert.equal(residue.residue()[0]?.key, 'spa-tab·/api/probe');
  residue.dispose();
});

test('a failure recorded before a later commit stays recorded (self-check runs still fold)', () => {
  const page = new EventEmitter();
  const failingFetch = fakeRequest('https://app.test/api/probe', 'fetch');
  const residue = trackDataResidue(page, '**/api/**', 'dashboard');

  page.emit('request', failingFetch);
  page.emit('response', { request: () => failingFetch, status: () => 503 }); // recorded now
  page.emit('request', fakeNavigationRequest('https://app.test/dashboard'));
  page.emit('framenavigated', fakeMainFrame); // e.g. the self-check re-runs go()

  assert.equal(residue.residue()[0]?.reason, 'HTTP 503');
  residue.dispose();
});
