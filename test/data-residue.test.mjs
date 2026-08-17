import { test } from 'node:test';
import assert from 'node:assert/strict';
import { endpointOf, residueKey, unionResidue, auditResidue, auditRunResidue } from '../dist/data-residue.js';
import { urlMatcher } from '../dist/capture.js';

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
