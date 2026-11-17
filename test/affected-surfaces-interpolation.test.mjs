import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyStyleChange, affectedSurfaces } from '../dist/affected-surfaces.js';

// Sass removes the quotes in selector interpolation, producing .foo, h1, .bar.
// https://sass-lang.com/documentation/interpolation/#quoted-strings
const css = '.foo#{", h1,"}.bar { color: red }';

test('Sass selector interpolation cannot prove a CSS Module is scoped', () => {
  assert.equal(
    classifyStyleChange('Card.module.scss', () => css),
    'all',
  );
});

test('Sass selector interpolation re-captures non-importing surfaces', () => {
  assert.equal(
    affectedSurfaces({
      changedFiles: ['Card.module.scss'],
      surfaces: { Home: 'Home.tsx', About: 'About.tsx' },
      graph: [{ from: 'Home.tsx', to: 'Card.module.scss' }],
      files: ['Home.tsx', 'About.tsx', 'Card.module.scss'],
      readFile: (file) => (file === 'Card.module.scss' ? css : ''),
    }),
    'all',
  );
});
