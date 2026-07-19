// Source of truth — the spec-process half of freezeClock. The browser clock has
// always been pinned, but a fixture computed at the SPEC module's top level
// (`const GENERATED_AT = new Date().toISOString()`) runs in Node before any test
// executes: each capture run stamps its own wall clock, the base and head runs
// disagree, and any surface rendering the stamp as text drifts in width — a
// phantom diff the in-run self-check can never see (both of its captures share
// one process and therefore one stamp). Importing styleproof under
// STYLEPROOF_FREEZE_SPEC_CLOCK=1 must pin Node's Date before the consumer spec's
// own constants evaluate, and two separate processes must agree on the instant.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_CLOCK_TIME,
  frozenSpecClockInstant,
  installFrozenSpecClock,
  realNow,
  resolveSpecClockFreeze,
  restoreRealSpecClock,
} from '../dist/spec-clock.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const RealDate = Date;
const FIXED = RealDate.parse('2030-06-15T12:00:00Z');

afterEach(() => restoreRealSpecClock());

test('resolveSpecClockFreeze is off unless STYLEPROOF_FREEZE_SPEC_CLOCK=1', () => {
  assert.equal(resolveSpecClockFreeze({}), undefined);
  assert.equal(resolveSpecClockFreeze({ STYLEPROOF_FREEZE_SPEC_CLOCK: '0' }), undefined);
  assert.equal(resolveSpecClockFreeze({ STYLEPROOF_FREEZE_SPEC_CLOCK: '1' }), RealDate.parse(DEFAULT_CLOCK_TIME));
});

test('resolveSpecClockFreeze honours STYLEPROOF_CLOCK_TIME as ISO or epoch milliseconds', () => {
  assert.equal(
    resolveSpecClockFreeze({ STYLEPROOF_FREEZE_SPEC_CLOCK: '1', STYLEPROOF_CLOCK_TIME: '2030-06-15T12:00:00Z' }),
    FIXED,
  );
  assert.equal(
    resolveSpecClockFreeze({ STYLEPROOF_FREEZE_SPEC_CLOCK: '1', STYLEPROOF_CLOCK_TIME: String(FIXED) }),
    FIXED,
  );
});

test('resolveSpecClockFreeze fails loudly on an unparseable instant', () => {
  assert.throws(
    () => resolveSpecClockFreeze({ STYLEPROOF_FREEZE_SPEC_CLOCK: '1', STYLEPROOF_CLOCK_TIME: 'not-a-date' }),
    /STYLEPROOF_CLOCK_TIME is not a date/,
  );
});

test('the frozen twin pins zero-argument reads and leaves everything else real', () => {
  installFrozenSpecClock(FIXED);
  assert.equal(frozenSpecClockInstant(), FIXED);
  assert.equal(new Date().getTime(), FIXED);
  assert.equal(new Date().toISOString(), '2030-06-15T12:00:00.000Z');
  assert.equal(Date.now(), FIXED);
  assert.equal(Date(), new RealDate(FIXED).toString());
  // Explicit-argument construction, parsing, and identity stay real.
  assert.equal(new Date('2026-01-05T00:00:00Z').toISOString(), '2026-01-05T00:00:00.000Z');
  assert.equal(new Date(0).getTime(), 0);
  assert.equal(Date.parse('2026-01-05T00:00:00Z'), RealDate.parse('2026-01-05T00:00:00Z'));
  assert.equal(Date.UTC(2026, 0, 5), RealDate.UTC(2026, 0, 5));
  assert.ok(new Date() instanceof Date);
});

test('realNow keeps reading the real clock while the freeze is installed', () => {
  const before = RealDate.now();
  installFrozenSpecClock(FIXED);
  const observed = realNow();
  restoreRealSpecClock();
  assert.notEqual(observed, FIXED);
  assert.ok(observed >= before && observed <= RealDate.now());
});

test('restoreRealSpecClock puts the real Date back', () => {
  installFrozenSpecClock(FIXED);
  restoreRealSpecClock();
  assert.equal(frozenSpecClockInstant(), undefined);
  assert.equal(globalThis.Date, RealDate);
  assert.notEqual(Date.now(), FIXED);
});

// The consumer-facing guarantee, exercised through the real package entry: two
// SEPARATE processes that import styleproof under the freeze env and then read a
// module-level `new Date()` stamp — exactly the shape of a spec fixture — agree
// byte-for-byte, where unfrozen processes each report their own wall clock.
const STAMP_SCRIPT = 'await import("./dist/index.js"); console.log(new Date().toISOString(), Date.now());';

function stampFromFreshProcess(extraEnv) {
  return execFileSync(process.execPath, ['--input-type=module', '-e', STAMP_SCRIPT], {
    cwd: ROOT,
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
  }).trim();
}

test('two separate frozen processes stamp the identical instant via the package import', () => {
  const environment = { STYLEPROOF_FREEZE_SPEC_CLOCK: '1', STYLEPROOF_CLOCK_TIME: '2030-06-15T12:00:00Z' };
  const first = stampFromFreshProcess(environment);
  const second = stampFromFreshProcess(environment);
  assert.equal(first, second);
  assert.equal(first, `2030-06-15T12:00:00.000Z ${FIXED}`);
});

test('without the env the package import leaves the process clock live', () => {
  const stamp = stampFromFreshProcess({ STYLEPROOF_FREEZE_SPEC_CLOCK: undefined });
  assert.doesNotMatch(stamp, /^2025-01-01T00:00:00\.000Z/);
});

test('styleproof-map enables the spec-process freeze for the capture run it spawns', async () => {
  const { readFileSync } = await import('node:fs');
  const mapCli = readFileSync(path.join(ROOT, 'bin', 'styleproof-map.mjs'), 'utf8');
  assert.match(mapCli, /STYLEPROOF_FREEZE_SPEC_CLOCK: process\.env\.STYLEPROOF_FREEZE_SPEC_CLOCK \?\? '1'/);
});
