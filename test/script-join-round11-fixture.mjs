export const assertionCases = [
  'window.res = <any>[__DEV__ && "red", 1];',
  '(<any>window).res = __DEV__ ? "red" : "k";',
  'function sink(...args) { return args; } const n = 1; window.res = sink(<any>n, __DEV__ && "red");',
].map((before, index) => ({
  name: `TypeScript assertion ${index + 1} cannot hide removed code`,
  before,
  after: before.replace('"red"', '"orange"'),
}));

export const parameterCases = [
  {
    name: 'a default initializer with two nested calls',
    before: 'function sink(x) { return x; } function App(a = sink(sink("red"))) { return a; } window.result = App();',
    residual: 'default parameter values',
  },
  {
    name: 'a multiline destructured props default',
    before: 'function Card({\n  tone = "red",\n} = {}) {\n  return tone;\n}\nwindow.result = Card();',
    residual: 'destructuring defaults',
  },
  {
    name: 'a multiline ordinary parameter default',
    before: 'function App(\n  tone = "red",\n) {\n  return tone;\n}\nwindow.result = App();',
    residual: 'default parameter values',
  },
];

export const genericControl = {
  name: 'a live generic arrow value retains positive execution',
  before: 'const on = window.input ?? true; const f = <T>(a: T) => on ? "red" : "k"; window.res = f(1);',
  after: 'const on = window.input ?? true; const f = <T>(a: T) => on ? "orange" : "k"; window.res = f(1);',
};
