import assert from 'node:assert/strict';
import test from 'node:test';
import { renderCropChanges } from '../dist/report/markdown.js';

const context = { tokensBefore: new Map(), tokensAfter: new Map() };

test('folded element labels preserve currentColor evidence and fall back to the full path for an unlabelled element', () => {
  const first = 'body > article:nth-child(1) > h2';
  const second = 'body > article:nth-child(2) > h2';
  const finding = (path, props) => ({ kind: 'style', path, cls: 'card-title', pseudo: null, props });
  const shown = [
    finding(first, [
      { prop: 'color', before: 'rgb(0, 0, 255)', after: 'rgb(255, 0, 0)' },
      { prop: 'outline-color', before: 'rgb(0, 0, 255)', after: 'rgb(255, 0, 0)' },
    ]),
  ];
  const folded = [first, second].map((path, index) =>
    finding(path, [{ prop: 'height', before: '20px', after: `${21 + index * 2}px` }]),
  );
  const markdown = renderCropChanges(
    shown,
    Infinity,
    context,
    folded,
    new Map([[first, 'article:nth-child(1) > h2']]),
  ).join('\n');
  assert.match(markdown, /↳ `outline-color` _\(currentColor\)_/);
  assert.ok(markdown.includes('**`article:nth-child(1) > h2`**'));
  assert.ok(markdown.includes(`**\`${second}\`**`));
  for (const height of ['21px', '23px']) assert.equal(markdown.split(`\`${height}\``).length - 1, 1);
  assert.match(markdown, /2 size\/position rows folded/);
});

test('property and folded-geometry caps count omitted entries after forty distinct elements', () => {
  for (const folded of [false, true]) {
    const findings = Array.from({ length: 42 }, (_, index) => ({
      kind: 'style',
      path: `body > div:nth-child(${index + 1})`,
      cls: `item-${index + 1}`,
      pseudo: null,
      props: [
        { prop: folded ? 'height' : 'opacity', before: folded ? '20px' : '0', after: folded ? `${21 + index}px` : '1' },
      ],
    }));
    const markdown = renderCropChanges(folded ? [] : findings, Infinity, context, folded ? findings : []).join('\n');
    assert.equal((markdown.match(folded ? /\| `height` \|/g : /\| `opacity` \|/g) ?? []).length, 40);
    assert.match(markdown, folded ? /…and 2 more size\/position rows folded/ : /…and 2 more element\(s\)/);
    assert.doesNotMatch(markdown, /item-41|item-42/);
    if (folded) assert.match(markdown, /42 size\/position rows folded/);
  }
});
