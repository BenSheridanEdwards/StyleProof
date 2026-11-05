export const generatorResidual = 'bodies of generator / async-generator functions that were called but never iterated';

const generatorSetup =
  'globalThis.hits = 0; function __h(x) { globalThis.hits += x; } function sink(x) { return x; }\n';

export const generatorCases = [
  ['a never-iterated generator', 'function* gen() { __h(1); yield sink(1); }\nglobalThis.keep = gen();', 0],
  ['an iterated generator', 'function* gen() { __h(1); yield sink(1); }\nglobalThis.keep = gen().next();', 1],
  ['a never-iterated async generator', 'async function* gen() { __h(1); yield sink(1); }\nglobalThis.keep = gen();', 0],
  ['a generator method', 'const obj = { *gen() { __h(1); yield sink(1); } };\nglobalThis.keep = obj.gen();', 0],
  [
    'an async generator method',
    'class D { async *gen() { __h(1); yield sink(1); } }\nglobalThis.keep = new D().gen();',
    0,
  ],
  ['a multiline generator body', 'function* gen() {\n  __h(1);\n  yield sink(1);\n}\nglobalThis.keep = gen();', 0],
].map(([name, text, hits]) => ({
  name,
  before: generatorSetup + text,
  after: (generatorSetup + text).replace('sink(1)', 'sink(2)'),
  hits,
}));

export const methodDefaults = [
  ['a class method default', 'class D { m(a = "red") { return a; } } window.result = new D().m();'],
  ['an object method default', 'const obj = { m(a = "red") { return a; } }; window.result = obj.m();'],
  [
    'a parameter-property constructor default',
    'class D { constructor(private a: any = "red") {} } window.result = new D();',
  ],
  ['a whole-line template default', 'function App(a = `red`) { return a; } window.result = App();'],
].map(([name, before]) => ({
  name,
  before,
  after: before.replace('red', 'orange'),
  residual: 'default parameter values',
}));

export const tsxGenerics = ['T extends unknown', 'T,', 'T, U'].flatMap((parameters) =>
  [false, true].map((idle) => {
    const before = `const on=window.on ?? true; const f = <${parameters}>(a: T) => on ? "red" : "k"; window.res=f(1);`;
    return {
      name: `${idle ? 'idle' : 'live'} TSX generic <${parameters}> arm`,
      before,
      after: idle ? before.replace('"k"', '"idle"') : before.replace('"red"', '"orange"'),
      idle,
    };
  }),
);
