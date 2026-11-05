const setup = 'globalThis.hits = 0; function __h(x) { globalThis.hits++; } function sink(x) { return x; }\n';

export const generatorFileCases = [
  [
    'a generator divisor after a keyword-named property call',
    'const obj = { if() { return 1; } }; window.result = obj.if() / (function* gen(){ __h("d1"); yield sink(1); })() / 2;',
  ],
  [
    'a generator call inside division',
    'const factor = 1; window.result = factor / (function* gen(){ __h("d1"); yield sink(1); })() / 2;',
  ],
  [
    'a generator call after an object operand',
    'window.result = {} / (function* gen(){ __h("d1"); yield sink(1); })() / 2;',
  ],
  ['QA static method', 'class D { static *method(){yield sink(1);} }\nglobalThis.keep = D.method();'],
  [
    'QA async method without whitespace',
    'class D { async*method(){yield sink(1);} }\nglobalThis.keep = new D().method();',
  ],
  [
    'QA ordinary function in a generator file',
    'function* gen(){yield 1;} function plain(){return sink(1);} globalThis.keep=plain();',
  ],
  ['a static generator', 'class D { static *s() { __h("d1"); yield sink(1); } }\nglobalThis.keep = D.s();'],
  ['a static async generator', 'class D { static async *s() { __h("d1"); yield sink(1); } }\nglobalThis.keep = D.s();'],
  [
    'a computed generator',
    'class D { *[Symbol.iterator]() { __h("d1"); yield sink(1); } }\nglobalThis.keep = new D()[Symbol.iterator]();',
  ],
  [
    'a computed async generator',
    'class D { async *[Symbol.asyncIterator]() { __h("d1"); yield sink(1); } }\nglobalThis.keep = new D()[Symbol.asyncIterator]();',
  ],
  [
    'a private-name generator',
    'class D { *#p() { __h("d1"); yield sink(1); } call() { return this.#p(); } }\nglobalThis.keep = new D().call();',
  ],
  [
    'a quoted-name generator',
    'class D { *"quoted"() { __h("d1"); yield sink(1); } }\nglobalThis.keep = new D().quoted();',
  ],
  ['a numeric-name generator', 'class D { *1() { __h("d1"); yield sink(1); } }\nglobalThis.keep = new D()[1]();'],
  ['a public generator', 'class D { public *m() { __h("d1"); yield sink(1); } }\nglobalThis.keep = new D().m();'],
  [
    'a private async generator',
    'class D { private async *n() { __h("d1"); yield sink(1); } call() { return this.n(); } }\nglobalThis.keep = new D().call();',
  ],
  [
    'adjacent generator methods on one line',
    'class D { static *s() { __h("d1"); yield sink(1); } *[Symbol.iterator]() { __h("d2"); } }\nglobalThis.keep = D.s();',
  ],
  [
    'a long saga body',
    'function* saga() {\n  const a = 1;\n  const b = 2;\n  const c = 3;\n  const d = 4;\n  const e = 5;\n  const f = 6;\n  __h("d1");\n  yield sink(1);\n}\nglobalThis.keep = saga();',
  ],
  ['a generator expression', 'const gen = function * () { __h("d1"); yield sink(1); };\nglobalThis.keep = gen();'],
  [
    'an async generator expression',
    'const gen = async function* () { __h("d1"); yield sink(1); };\nglobalThis.keep = gen();',
  ],
  [
    'an ordinary value elsewhere in a generator file',
    'function* unused() { yield 1; }\n\n\n\n\n\nwindow.value = sink(1);',
  ],
].map(([name, body]) => ({ name, before: setup + body, after: (setup + body).replace('sink(1)', 'sink(2)'), hits: 0 }));

const jsxBody =
  'const h = (tag, props, ...children) => ({tag, props, children}); globalThis.keep = <section><p>// NOTE</p>{(function* gen(){ __h("d1"); yield sink(1); })()}</section>;';
generatorFileCases.push({
  name: 'a generator expression after JSX comment-like text',
  before: setup + jsxBody,
  after: (setup + jsxBody).replace('sink(1)', 'sink(2)'),
  hits: 0,
  sourceKey: 'app.tsx',
});

export const generatorLexicalControls = [
  'if (window.input) /function*foo/.test("x"); window.result = sink(1);',
  'if (window.input) {} /function*foo/.test("x"); window.result = sink(1);',
  'const a = 2, b = (c) => c; window.value = a *b(1);',
  'window.value = "function* fake() {}"; window.result = sink(1);',
  'window.value = `class D { static *s() {} }`; window.result = sink(1);',
  'window.value = /function*foo/.source; window.result = sink(1);',
  '/* function* fake() {} */ window.result = sink(1);',
  '// class D { static *s() {} }\nwindow.result = sink(1);',
];
