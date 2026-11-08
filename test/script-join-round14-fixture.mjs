const setup = 'globalThis.hits=0; function __h(){globalThis.hits++;} function sink(x){return x;}\n';
const jsx = 'const h=(tag,props,...children)=>({tag,props,children}); const n=1;\n';
const saga = "function* saga(){__h();yield sink(1);}\nglobalThis.keep=saga();\nwindow.done='done';";

export const rawGeneratorCases = [
  ['a generic class method', 'class D { *m<T>(x: T){__h();yield sink(1);} } globalThis.keep=new D().m(1);'],
  ['a generic object method', 'const obj={ *m<T>(){__h();yield sink(1);} };globalThis.keep=obj.m();'],
  ['a static async generic method', 'class D{static async *m<T,>(){__h();yield sink(1);}}globalThis.keep=D.m();'],
  [
    'a decorated generator method',
    'function dec(value){return value;}class D{@dec *m(){__h();yield sink(1);}}globalThis.keep=new D().m();',
  ],
  [
    'a factory-decorated generator method',
    'function dec(){return value=>value;}class D{@dec() *m(){__h();yield sink(1);}}globalThis.keep=new D().m();',
  ],
  [
    'a generator after function-expression division',
    'globalThis.iterator = function(){} / (function*(){__h();yield sink(1);})() / 2;',
  ],
  ['a generator after JSX apostrophe text', jsx + "window.result=<p>{n} isn't here</p>;\n" + saga, 'app.tsx'],
  ['a generator after multiline JSX apostrophe text', jsx + "window.result=<p>\nDon't stop\n</p>;\n" + saga, 'app.tsx'],
  [
    'a generator after realistic component apostrophe text',
    jsx + "window.result=<section><span>{n}</span> item wasn't saved</section>;\n" + saga,
    'app.tsx',
  ],
].map(([name, body, sourceKey = 'app.ts']) => ({
  name,
  before: setup + body,
  after: (setup + body).replace('sink(1)', 'sink(2)'),
  sourceKey,
  hits: 0,
  browserExpected: name === 'a generator after function-expression division' ? 'never-rendered' : 'unmeasured',
}));

export const apostropheControls = [
  ['inline JSX', jsx + "window.result=<p>{n} isn't here</p>;\nfunction never(){return \"red\";}\nwindow.done='done';"],
  [
    'multiline JSX',
    jsx + "window.result=<p>\nDon't stop\n</p>;\nfunction never(){return \"red\";}\nwindow.done='done';",
  ],
  [
    'realistic component',
    jsx +
      "window.result=<section><span>{n}</span> item wasn't saved</section>;\nfunction never(){return \"red\";}\nwindow.done='done';",
  ],
].map(([name, before]) => ({ name, before, after: before.replace('"red"', '"orange"') }));
