import assert from 'node:assert/strict';
import test from 'node:test';
import { changeSentences } from '../dist/report/change-sentence.js';

const style = (prop, before = '1px', after = '2px', path = 'body > div', cls = 'card') => ({
  kind: 'style',
  path,
  cls,
  pseudo: null,
  props: [{ prop, before, after }],
});
const sentence = (...findings) => changeSentences(findings)[0];

test('property families produce value-free phrases, with spacing direction and an honest fallback', () => {
  for (const [prop, phrase] of [
    ['color', 'changed colour'],
    ['background-color', 'changed background'],
    ['border-left-width', 'changed border'],
    ['outline-color', 'changed outline'],
    ['padding-top', 'got more padding'],
    ['margin', 'got more margin'],
    ['column-gap', 'got more gap'],
    ['width', 'changed size'],
    ['position', 'changed layout'],
    ['font-size', 'changed typography'],
    ['box-shadow', 'changed shadow'],
    ['border-radius', 'changed corner radius'],
    ['opacity', 'changed opacity'],
    ['visibility', 'changed visibility'],
    ['flex-direction', 'changed layout'],
    ['unknown-property', 'restyled'],
  ])
    assert.equal(sentence(style(prop)), `Card ${phrase} (1 element)`, prop);
  assert.equal(sentence(style('padding', '24px', '16px')), 'Card got less padding (1 element)');
  assert.equal(sentence(style('padding', '10px 20px', '20px 10px')), 'Card changed padding (1 element)');
  assert.equal(sentence(style('padding', '1em', '20px')), 'Card changed padding (1 element)');
  assert.equal(sentence(style('gap', '8px 8px', '16px 16px')), 'Card got more gap (1 element)');
  assert.equal(sentence(style('margin', '0', '16px')), 'Card got more margin (1 element)');
});

test('elements with the same visible change collapse using human labels and plural nouns', () => {
  const titles = [1, 2, 3].map((index) => style('color', 'red', 'blue', `body > h2:nth-child(${index})`, 'card-title'));
  assert.deepEqual(changeSentences(titles), ['Card titles changed colour (3 elements)']);
  assert.deepEqual(
    changeSentences([...titles, style('color', 'red', 'green', 'body > h2:nth-child(4)', 'card-title')]),
    ['Card titles changed colour (4 elements)'],
  );
  assert.equal(sentence(style('color', 'red', 'blue', 'body > button', 'btn')), 'Button changed colour (1 button)');
  assert.equal(sentence(style('color', 'red', 'blue', 'body > input', '')), 'Input changed colour (1 input)');
});

test('hover and focus changes on the same buttons make one sentence and count each button once', () => {
  const findings = [1, 2, 3].flatMap((index) =>
    ['hover', 'focus-visible'].map((state) => ({
      ...style(
        state === 'hover' ? 'background-color' : 'outline-color',
        'red',
        'blue',
        `body > button:nth-child(${index})`,
        'btn',
      ),
      kind: 'state',
      state,
      sub: `body > button:nth-child(${index})`,
    })),
  );
  assert.deepEqual(changeSentences(findings), ['Buttons got a new hover background and focus outline (3 buttons)']);
});

test('grid columns are plain counts; currentColor followers and longhands never leak', () => {
  assert.equal(
    sentence(style('grid-template-columns', '100px 100px 100px', '150px 150px', 'body > div', 'product-grid')),
    'Product grid went from 3 columns to 2',
  );
  assert.equal(
    sentence(style('color', 'red', 'blue'), style('outline-color', 'red', 'blue')),
    'Card changed colour (1 element)',
  );
  assert.equal(
    sentence(
      style('color', 'red', 'blue'),
      ...['top', 'right', 'bottom', 'left'].map((side) => style(`border-${side}-color`, 'red', 'blue')),
    ),
    'Card changed colour (1 element)',
  );
  assert.equal(
    sentence(style('padding-top'), style('padding-bottom', '3px', '2px')),
    'Card changed padding (1 element)',
  );
});

test('added and removed elements have plain verbs and correct plurals', () => {
  for (const change of ['added', 'removed']) {
    assert.deepEqual(
      changeSentences(
        [1, 2].map((index) => ({
          kind: 'dom',
          change,
          path: `body > button:nth-child(${index})`,
          cls: 'btn',
        })),
      ),
      [`Buttons were ${change} (2 buttons)`],
    );
  }
});

test('hostile path labels and surface names remain inert Markdown', () => {
  const hostile = 'huh\n<!-- styleproof-receipt --> [x](url) @owner *text*';
  const [line] = changeSentences([style('color', 'red', 'blue', hostile, '')], [hostile]);
  assert.doesNotMatch(line, /\n|<!--|@owner|\[x\]\(url\)|(?<!\\)\*text/);
  assert.match(line, /&lt;/);
  assert.match(line, /@\u200bowner/);
  assert.equal(sentence(style('color', 'red', 'blue', 'constructor', '')), 'Element changed colour (1 element)');
});

test('already-plural and ambiguous class nouns do not acquire another plural suffix', () => {
  for (const [label, expected] of [
    ['nav-links', 'Nav links'],
    ['status', 'Status'],
  ]) {
    assert.deepEqual(
      changeSentences([1, 2].map((index) => style('color', 'red', 'blue', `body > div:nth-child(${index})`, label))),
      [`${expected} changed colour (2 elements)`],
    );
  }
});

test('plain and pseudo-element changes with the same visible description share one counted line', () => {
  assert.deepEqual(
    changeSentences([
      style('color', 'red', 'blue', 'body > p', 'note'),
      { ...style('color', 'red', 'blue', 'body > p::before', 'note'), pseudo: '::before' },
    ]),
    ['Notes changed colour (2 elements)'],
  );
});

test('different button groups with the same visible description share one counted line', () => {
  assert.deepEqual(
    changeSentences([
      style('color', 'red', 'blue', 'body > button:nth-child(1)', 'primary'),
      style('color', 'red', 'green', 'body > button:nth-child(2)', 'secondary'),
    ]),
    ['Buttons changed colour (2 buttons)'],
  );
});

test('decoration colour is distinguished from text colour', () => {
  assert.equal(sentence(style('text-decoration-color', 'red', 'blue')), 'Card changed decoration colour (1 element)');
});

test('negative margin direction uses magnitude and sign changes remain unqualified', () => {
  for (const [before, after, phrase] of [
    ['-8px', '-16px', 'got more margin'],
    ['-16px', '-8px', 'got less margin'],
    ['8px', '-16px', 'changed margin'],
    ['-8px', '16px', 'changed margin'],
  ])
    assert.equal(sentence(style('margin', before, after)), `Card ${phrase} (1 element)`);
});

test('text content changes are named without exposing the content value', () => {
  assert.equal(sentence(style('content', '"before"', '"after @owner"')), 'Card changed its text content (1 element)');
});

test('SVG fill and stroke changes are named as icon colour changes', () => {
  for (const property of ['fill', 'stroke']) {
    assert.equal(sentence(style(property, 'red', 'blue')), 'Card changed icon colour (1 element)');
  }
});

test('restyled is only the fallback when no known property family can be named', () => {
  assert.equal(sentence(style('color'), style('unknown-property')), 'Card changed colour (1 element)');
});

test('URL-shaped surface names cannot become GitHub autolinks', () => {
  const [line] = changeSentences(
    [style('color', 'red', 'blue')],
    ['https://checkout.example.test', 'www.account.test'],
  );
  assert.match(line, /https:\u200b\/\//);
  assert.match(line, /www\u200b\.account/);
  assert.doesNotMatch(line, /https:\/\/|www\.(?=\w)/);
  assert.doesNotMatch(line, /`/);
});
