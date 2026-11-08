const setup = 'const h=(...xs)=>xs;const f=(x)=>true;globalThis.hits=0;function sink(x){globalThis.hits++;return x;}\n';
const long = String.raw`\.`.repeat(2100);
export const cappedRegexCases = [
  ['long slash-class regex in a conditional', `f(/${long}[//]/) && 0 && sink(1);`],
  ['long star-class regex in a conditional', `f(/${long}[/*]/) && 0 && sink(1);`],
  ['long brace regex in a substitution', '`' + '${f(/}' + long + '/) && 0 && sink(1)}`;'],
  ['long slash-class regex before a comma', `f(/${long}[//]/), 0 && sink(1);`],
  ['long regex inside a JSX attribute', `<div value={f(/${long}[//]/) && 0 && sink(1)}>healthy</div>;`],
  [
    'long regex inside a JSX template attribute',
    '<div value={`' + '${f(/}' + long + '/) && 0 && sink(1)}`}>healthy</div>;',
  ],
  ['short regex control', 'f(/[//]/) && 0 && sink(1);'],
].map(([name, expression]) => {
  const before = setup + 'window.result=' + expression;
  return { name, before, after: before.replace('sink(1)', 'sink(2)'), hits: 0, sourceKey: 'app.tsx' };
});

export const paddedEscapeCases = [
  ['eight-digit braced generator name', String.raw`*\u{0000006d}()`],
  ['eight-digit braced private generator name', String.raw`*#\u{0000006d}()`],
].map(([name, header]) => {
  const privateName = header.startsWith('*#');
  const before =
    setup +
    `class C {${header}{return sink(731);}${privateName ? 'go(){return this.#m();}' : ''}}\nglobalThis.iterator=new C().${privateName ? 'go' : 'm'}();`;
  return { name, before, after: before.replace('sink(731)', 'sink(947)'), hits: 0, sourceKey: 'app.ts' };
});
