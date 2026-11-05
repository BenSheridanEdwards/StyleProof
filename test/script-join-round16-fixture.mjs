const setup = 'globalThis.hits=0;function sink(x){globalThis.hits++;return x;}\n';
export const boundResidual =
  'a generator with no `yield` whose computed key or type-parameter list exceeds 512 characters is not detected';

const escaped = [
  ['braced Unicode name', String.raw`*\u{006d}()`, 'new C().m()'],
  ['braced Unicode inside a name', String.raw`*a\u{62}c()`, 'new C().abc()'],
  ['braced private name', String.raw`*#\u{6d}()`, 'new C().go()', 'go(){return this.#m();}'],
  ['braced astral name', String.raw`*\u{1d453}()`, 'new C()["𝑓"]()'],
];
const continued = ['\n', '\r\n', '\u2028'].flatMap((ending) =>
  ["'", '"'].map((quote) => [
    `${quote} quoted continuation ${JSON.stringify(ending)}`,
    '*' + quote + 'a\\' + ending + 'b' + quote + '()',
    'new C().ab()',
  ]),
);
export const escapedGeneratorCases = [...escaped, ...continued].map(([name, header, call, tail = '']) => {
  const before = setup + `class C {${header}{return sink(731);}${tail}}\nglobalThis.iterator=${call};`;
  return { name, before, after: before.replace('sink(731)', 'sink(947)'), hits: 0 };
});

export const overBoundCases = [
  [
    'QA computed key above bound',
    "*['" + 'x'.repeat(511) + "']()",
    'new C()[' + JSON.stringify('x'.repeat(511)) + ']()',
  ],
  ['QA generic list above bound', '*m<' + 'T'.repeat(513) + '>()', 'new C().m()'],
].map(([name, header, call]) => {
  const before = setup + `class C {${header}{return sink(731);}}\nglobalThis.iterator=${call};`;
  return { name, before, after: before.replace('sink(731)', 'sink(947)'), hits: 0 };
});
