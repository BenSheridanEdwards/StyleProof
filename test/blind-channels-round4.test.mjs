import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalEngineKeyframes, normalizeImageSource } from '../dist/capture/visual-channel-values.js';
const frame = (props, easing) => ({ offset: 0.5, computedOffset: 0.5, easing, composite: 'auto', ...props });
test('disjoint timing groups commute while shared-property groups retain order', () => {
  const a = frame({ opacity: '1' }, 'steps(1)');
  const b = frame({ transform: 'translateX(30px)' }, 'ease-in');
  assert.equal(canonicalEngineKeyframes([a, b]), canonicalEngineKeyframes([b, a]));
  const c = frame({ opacity: '.7' }, 'linear');
  assert.notEqual(canonicalEngineKeyframes([a, c]), canonicalEngineKeyframes([c, a]));
  assert.equal(canonicalEngineKeyframes([a, b, c]), canonicalEngineKeyframes([b, a, c]));
});
for (const marker of [
  'sig',
  'Signature',
  'token',
  'hdnts',
  '__token__',
  'x-other-signature',
  'X-Amz-Signature',
  'X-Goog-Signature',
])
  test(`signing marker ${marker} removes rotation fields but retains content identity`, () => {
    const normalize = (q) =>
      normalizeImageSource('https://asset.test/a.png?' + q, 'https://fixture.test', 'https://fixture.test/', true);
    const a = normalize(`${marker}=first&exp=1&expires=1&expiry=1&se=1&st=1&w=100`);
    const b = normalize(`${marker}=second&exp=2&expires=2&expiry=2&se=2&st=2&w=100`);
    assert.equal(a, b);
    assert.doesNotMatch(a, /first|second/);
    assert.match(a, /w=100/);
    assert.notEqual(a, normalize(`${marker}=third&exp=3&w=200`));
  });
test('unsigned rotation-like parameters retain identity', () => {
  const f = (v) =>
    normalizeImageSource(
      `https://asset.test/a.png?exp=${v}&st=${v}&oe=${v}`,
      'https://fixture.test',
      'https://fixture.test/',
      true,
    );
  assert.notEqual(f(1), f(2));
});

test('Meta CDN oh/oe rotation remains source identity', () => {
  const f = (n) =>
    normalizeImageSource(
      `https://asset.test/a.png?oh=signature${n}&oe=${n}`,
      'https://fixture.test',
      'https://fixture.test/',
      true,
    );
  assert.notEqual(f(1), f(2));
  assert.match(f(1), /oh=signature1&oe=1/);
});
