import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffStyleMaps } from '../dist/diff.js';
import { canonicalEngineKeyframes, resolveEngineBody } from '../dist/capture/visual-channel-values.js';

// Fixture blocks isolate helper state; the test bodies and matrices are unchanged.
{
  const channels = { version: 1, keyframes: {} };

  const map = (source, enabled = true) => ({
    defaults: {},
    states: {},
    elements: { image: { tag: 'img', cls: 'asset', style: source === undefined ? {} : { 'img currentSrc': source } } },
    ...(enabled ? { visualChannels: channels } : {}),
  });

  test('proved keyframes absence is a normal compared change; unreadable stays unknown', () => {
    const before = map(undefined);
    before.elements.image.style = { 'animation keyframes (pulse)': 'pulse' };
    before.visualChannels = {
      version: 1,
      keyframes: { pulse: { name: 'pulse', status: 'known', body: '100% { opacity: 1; }' } },
    };
    const after = structuredClone(before);
    after.visualChannels.keyframes.pulse = { name: 'pulse', status: 'none' };
    assert.deepEqual(diffStyleMaps(before, after)[0]?.props, [
      { prop: 'animation keyframes (pulse)', before: '100% { opacity: 1; }', after: '(no @keyframes)' },
    ]);
    after.visualChannels.keyframes.pulse = { name: 'pulse', status: 'unknown' };
    assert.deepEqual(diffStyleMaps(before, after), []);
  });
}

{
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
}

{
  const frame = (props, easing) => ({ offset: 0.5, computedOffset: 0.5, easing, composite: 'auto', ...props });

  test('disjoint timing groups commute while shared-property groups retain order', () => {
    const a = frame({ opacity: '1' }, 'steps(1)');
    const b = frame({ transform: 'translateX(30px)' }, 'ease-in');
    assert.equal(canonicalEngineKeyframes([a, b]), canonicalEngineKeyframes([b, a]));
    const c = frame({ opacity: '.7' }, 'linear');
    assert.notEqual(canonicalEngineKeyframes([a, c]), canonicalEngineKeyframes([c, a]));
    assert.equal(canonicalEngineKeyframes([a, b, c]), canonicalEngineKeyframes([b, a, c]));
  });
}
