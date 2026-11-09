import { test } from 'node:test';
import assert from 'node:assert/strict';
import { colorNameIfClose } from '../dist/describe.js';
import { changeLine } from '../dist/report/change-line.js';

// QA1-03: a colour word is the main claim of a change line, so it must be genuinely close.
test('a colour is named only when its nearest named colour is genuinely close', () => {
  for (const [value, name] of [
    ['rgb(30, 60, 120)', 'dark indigo'],
    ['rgb(150, 30, 60)', 'dark red'],
    ['rgb(200, 40, 40)', 'red'],
    ['rgb(250, 160, 0)', 'amber'],
    ['rgb(20, 184, 166)', 'teal'],
    ['rgb(255, 255, 255)', 'white'],
    ['rgb(0, 0, 0)', 'black'],
    ['rgb(156, 163, 175)', 'gray'],
  ]) {
    assert.equal(colorNameIfClose(value), name, value);
  }
  for (const value of [
    'rgb(165, 243, 252)', // light cyan: the nearest palette word is "white"
    'rgb(0, 160, 80)', // green: the nearest palette word is "teal"
  ]) {
    assert.equal(colorNameIfClose(value), null, value);
  }
});

test('the change line keeps values, not a wrong word, when either side has no close name', () => {
  const subject = { tag: 'a', cls: 'link', path: 'body > a', texts: ['Docs'], count: 1, sameSelectorCount: 1 };
  const line = changeLine({
    subject,
    rest: [],
    states: [{ state: 'hover', props: [{ prop: 'color', before: 'rgb(165, 243, 252)', after: 'rgb(252, 165, 165)' }] }],
  });
  assert.match(line, /text colour changes from `#a5f3fc` to `#fca5a5` when hovered/);
  assert.doesNotMatch(line, /white/);
});
