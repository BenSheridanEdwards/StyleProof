import { test } from 'node:test';
import assert from 'node:assert/strict';
import { colorNameIfClose } from '../dist/describe.js';

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
    'rgb(200, 200, 200)', // light gray (#c8c8c8): the nearest neutral is "white" (RV11-14)
    'rgb(230, 230, 230)', // very light gray (#e6e6e6): not white
    'rgb(28, 28, 28)', // near black, but not black
  ]) {
    assert.equal(colorNameIfClose(value), null, value);
  }
});
