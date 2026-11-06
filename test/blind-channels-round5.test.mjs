import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contextDependentKeyframes, contextRelativeValue } from '../dist/capture/visual-channel-values.js';
const frames = (value) =>
  ['0%', '100%'].map((keyText) => ({ keyText, cssText: `margin-left:${value}`, properties: [['margin-left', value]] }));
for (const value of [
  '2em',
  '2rem',
  '20%',
  '3ch',
  '1lh',
  '1rlh',
  '3ex',
  '2cap',
  '4cqw',
  '20dvh',
  'currentColor',
  'inherit',
  'unset',
  'var(--x)',
  'calc(2em + 1px)',
  'color-mix(in srgb,currentColor 50%,red)',
  'auto',
])
  test(`context-dependent value ${value}`, () => {
    assert.equal(contextRelativeValue(value), true);
    assert.equal(contextDependentKeyframes(frames(value)), true);
  });
for (const value of [
  '20px',
  '0.5',
  'rgb(20, 30, 40)',
  'rotate(360deg)',
  '"currentColor 2em"',
  'url("/asset%20em.svg")',
])
  test(`fixed value ${value}`, () => assert.equal(contextRelativeValue(value), false));
test('explicit absolute endpoints remain independent of other inputs', () =>
  assert.equal(contextDependentKeyframes(frames('20px')), false));
test('implicit endpoints are contextual even with an absolute explicit endpoint', () =>
  assert.equal(contextDependentKeyframes(frames('20px').slice(1)), true));
test('endpoint coverage is per property', () =>
  assert.equal(
    contextDependentKeyframes([
      { keyText: '0%', cssText: 'opacity:0', properties: [['opacity', '0']] },
      { keyText: '100%', cssText: 'transform:none', properties: [['transform', 'none']] },
    ]),
    true,
  ));
test('selector percentages alone are not context-relative values', () =>
  assert.equal(contextDependentKeyframes(frames('20px')), false));
test('CSSOM-expanded currentColor defaults stay contextual with explicit endpoints', () =>
  assert.equal(
    contextDependentKeyframes(
      ['0%', '100%'].map((keyText) => ({
        keyText,
        cssText: 'border:2px solid',
        properties: [['border-top-color', 'currentcolor']],
      })),
    ),
    true,
  ));
