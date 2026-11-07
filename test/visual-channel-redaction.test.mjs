import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeImageSource } from '../dist/capture/visual-channel-values.js';

// Fixture blocks isolate helper state; the test bodies and matrices are unchanged.
{
  for (const [label, a, b, equal] of [
    ['R1 Bunny', 'token=first&expires=1&exp=1', 'token=second&expires=2&exp=2', true],
    ['R2 Akamai', 'hdnts=exp%3D1~hmac%3Dfirst', 'hdnts=exp%3D2~hmac%3Dsecond', true],
    ['R3 Akamai token', '__token__=exp=1~hmac=first', '__token__=exp=2~hmac=second', true],
    [
      'R4 GCS V2',
      'GoogleAccessId=public&Expires=1&Signature=first',
      'GoogleAccessId=public&Expires=2&Signature=second',
      true,
    ],
    ['R5 S3 identity', 'w=100&X-Amz-Signature=first', 'w=200&X-Amz-Signature=second', false],
    ['R6 SAS identity', 'v=1&sig=first&se=1', 'v=2&sig=second&se=2', false],
    [
      'R7 encoded signature',
      'X-Amz-Credential=x&x%2Damz%2Dsignature=first',
      'X-Amz-Credential=x&x%2Damz%2Dsignature=second',
      true,
    ],
    ['R8 unsigned expiry', 'expires=1', 'expires=2', false],
    ['R9 maps identity', 'key=public-one', 'key=public-two', false],
    ['R10 CloudFront', 'Policy=p1&Signature=first&Key-Pair-Id=K', 'Policy=p2&Signature=second&Key-Pair-Id=K', true],
    ['R11 encoding', 'b=%2B&a=1%20&token=first', 'b=%2B&a=1%20&token=second', true],
  ]) {
    test(label, () => {
      const before = normalizeImageSource(
        `http://fixture.test/a.png?${a}`,
        'http://fixture.test',
        'http://fixture.test/',
        true,
      );
      const after = normalizeImageSource(
        `http://fixture.test/a.png?${b}`,
        'http://fixture.test',
        'http://fixture.test/',
        true,
      );
      assert.equal(before === after, equal);
      assert.doesNotMatch(before + after, /first|second|hmac/);
    });
  }

  test('non-rotating Google identifiers remain source identity', () => {
    const source = normalizeImageSource(
      'http://fixture.test/a.png?GoogleAccessId=public&key=public',
      'http://fixture.test',
      'http://fixture.test/',
      true,
    );
    assert.equal(source, '/a.png?GoogleAccessId=public&key=public');
  });
}

{
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
}
