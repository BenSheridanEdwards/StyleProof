import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalEngineKeyframes,
  normalizeImageSource,
  resolveEngineBody,
} from '../dist/capture/visual-channel-values.js';

const frame = (props, easing = 'ease', offset = 1, composite = 'auto') => ({
  offset,
  computedOffset: offset,
  easing,
  composite,
  ...props,
});
for (const [name, before, after] of [
  [
    'V1 margin shorthand with physical override',
    { marginTop: '7px', marginLeft: '3px' },
    { marginTop: '15px', marginLeft: '3px' },
  ],
  [
    'V2 split margin shorthand with physical override',
    { marginRight: '7px', marginLeft: '3px' },
    { marginRight: '15px', marginLeft: '3px' },
  ],
  [
    'V3 border shorthand with color override',
    { borderTopWidth: '2px', borderLeftColor: 'rgb(255, 0, 0)' },
    { borderTopWidth: '9px', borderLeftColor: 'rgb(255, 0, 0)' },
  ],
  ['LP1 physical then logical', { marginLeft: '25px' }, { marginLeft: '3px' }],
  ['LP2 split physical then logical', { marginLeft: '25px' }, { marginLeft: '3px' }],
  ['LP3 inset physical then logical', { left: '2px' }, { left: '20px' }],
]) {
  test(`engine values retain ${name}`, () =>
    assert.notEqual(canonicalEngineKeyframes([frame(before)]), canonicalEngineKeyframes([frame(after)])));
}
for (const name of [
  'S1 closed slotted doc change',
  'S2 closed slotted body change',
  'S3 closed host doc change',
  'S4 closed host body change',
  'S5 closed host no doc rule',
  'S6 mixed doc change',
  'S7 mixed body change',
  'S8 closed outer',
]) {
  test(`${name} cannot publish an outer body`, () => {
    const body = canonicalEngineKeyframes([frame({ opacity: '0.5' })]);
    assert.equal(
      resolveEngineBody({
        body,
        hasLive: true,
        expected: 'document',
        matched: 'shadow',
        ambiguous: true,
        verified: true,
      }),
      undefined,
    );
  });
}
test('non-adjacent matching timing groups retain engine sequence order', () => {
  const a = [
    frame({ opacity: '.5' }, 'steps(1)', 0.5),
    frame({ opacity: '.7' }, 'linear', 0.5),
    frame({ opacity: '.8' }, 'steps(1)', 0.5),
  ];
  assert.notEqual(canonicalEngineKeyframes(a), canonicalEngineKeyframes(a.slice(1)));
  assert.notEqual(canonicalEngineKeyframes(a), canonicalEngineKeyframes([...a].reverse()));
});
test('engine-normalised adjacent groups and declaration key order stay equivalent', () => {
  assert.equal(
    canonicalEngineKeyframes([frame({ opacity: '.5', transform: 'none' })]),
    canonicalEngineKeyframes([frame({ transform: 'none', opacity: '.5' })]),
  );
});
test('equivalent easing aliases canonicalise identically', () =>
  assert.equal(
    canonicalEngineKeyframes([frame({ opacity: '1' }, 'ease')]),
    canonicalEngineKeyframes([frame({ opacity: '1' }, 'cubic-bezier(0.25, 0.1, 0.25, 1)')]),
  ));
test('missing, unusable or mismatched engine evidence never invents a body', () => {
  for (const frames of [[], [{ offset: NaN }], [{ offset: 0, easing: 'linear', composite: 'auto', opacity: {} }]])
    assert.equal(canonicalEngineKeyframes(frames), undefined);
  assert.equal(
    resolveEngineBody({
      hasLive: true,
      expected: 'doc',
      matched: 'other',
      body: 'frames',
      verified: true,
      ambiguous: false,
    }),
    undefined,
  );
  assert.equal(
    resolveEngineBody({ hasLive: true, matched: 'other', body: 'frames', verified: true, ambiguous: false }),
    undefined,
  );
  assert.equal(resolveEngineBody({ hasLive: false, expected: 'doc', verified: true, ambiguous: false }), undefined);
  assert.equal(resolveEngineBody({ hasLive: false, verified: true, ambiguous: false }), null);
  assert.equal(resolveEngineBody({ hasLive: false, verified: false, ambiguous: false }), undefined);
});
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

test('an incomplete animated-custom-property model is unknown, not a guessed computed body', () => {
  assert.equal(
    resolveEngineBody({
      body: 'frames',
      hasLive: true,
      expected: 'source',
      matched: 'source',
      verified: true,
      ambiguous: false,
      complete: false,
    }),
    undefined,
  );
});

test('T1 swapped timing and C1 composition remain observable engine differences', () => {
  const opacity = frame({ opacity: '1' }, 'steps(1)', 0.5);
  const transform = frame({ transform: 'translateX(30px)' }, 'ease-in', 0.5);
  assert.notEqual(
    canonicalEngineKeyframes([opacity, transform]),
    canonicalEngineKeyframes([
      { ...opacity, easing: 'ease-in' },
      { ...transform, easing: 'steps(1)' },
    ]),
  );
  assert.notEqual(
    canonicalEngineKeyframes([frame({ transform: 'translateX(5px)' }, 'linear', 1, 'add')]),
    canonicalEngineKeyframes([frame({ transform: 'translateX(5px)' }, 'linear', 1, 'replace')]),
  );
});
test('Q1 string contents remain intact while computed property keys sort', () => {
  const a = canonicalEngineKeyframes([frame({ fontFamily: '"a;b}c", serif', opacity: '.5' })]);
  const b = canonicalEngineKeyframes([frame({ opacity: '.5', fontFamily: '"a;b}c", serif' })]);
  assert.equal(a, b);
  assert.equal(JSON.parse(a)[0].fontFamily, '"a;b}c", serif');
});
test('a verified document winner remains known outside shadow scope chains', () => {
  const body = canonicalEngineKeyframes([frame({ opacity: '.1' })]);
  assert.equal(
    resolveEngineBody({
      body,
      hasLive: true,
      expected: 'document',
      matched: 'document',
      verified: true,
      ambiguous: false,
    }),
    body,
  );
});
for (const scope of ['S9 adopted doc change', 'S10 adopted body change', 'three-level mixed chain'])
  test(scope, () => {
    assert.equal(
      resolveEngineBody({
        body: 'engine',
        hasLive: true,
        expected: 'document',
        matched: 'shadow',
        verified: true,
        ambiguous: true,
      }),
      undefined,
    );
  });
test('non-rotating Google identifiers remain source identity', () => {
  const source = normalizeImageSource(
    'http://fixture.test/a.png?GoogleAccessId=public&key=public',
    'http://fixture.test',
    'http://fixture.test/',
    true,
  );
  assert.equal(source, '/a.png?GoogleAccessId=public&key=public');
});
