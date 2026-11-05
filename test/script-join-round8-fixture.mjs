export const tokenCases = [
  {
    name: 'a live closing brace cannot prove the eliminated development arm ran',
    before:
      '\nconst style = process.env.NODE_ENV === "production" ? {\n    color: "green",\n  } : { color: "red", outline: "1px solid" };\nwindow.style = style;',
    after:
      '\nconst style = process.env.NODE_ENV === "production" ? {\n    color: "green",\n  } : { color: "orange", outline: "2px dashed" };\nwindow.style = style;',
    removed: ['"red"', '"orange"', 'outline'],
  },
  {
    name: 'the eliminated development arm stays unmeasured after a line break',
    before:
      '\nconst style = process.env.NODE_ENV === "production" ? {\n    color: "green",\n  } : {\n    color: "red", outline: "1px solid" };\nwindow.style = style;',
    after:
      '\nconst style = process.env.NODE_ENV === "production" ? {\n    color: "green",\n  } : {\n    color: "orange", outline: "2px dashed" };\nwindow.style = style;',
    removed: ['"red"', '"orange"', 'outline'],
  },
  {
    name: 'a two-token ternary edit cannot borrow the surviving arm execution',
    before: 'window.style = isProd ? "calm" : "debug-red";',
    after: 'window.style = isProd ? "calmer" : "debug-orange";',
    removed: ['debug-red', 'debug-orange'],
  },
  ...[
    [
      'a folded template class substitution',
      'const cls = `btn ${process.env.NODE_ENV !== "production" ? "debug-red" : ""}`; window.result = cls;',
      'debug-red',
      'debug-orange',
    ],
    [
      'a folded template call substitution',
      'function sink(x) { window.result = x; } sink(`color: ${__DEV__ ? "red" : "blue"}`);',
      'red',
      'orange',
    ],
    [
      'a folded template side effect',
      'function warn(x) { window.warned = x; } window.result = `v${P === "production" ? "" : warn("red")}`;',
      'red',
      'orange',
    ],
    [
      'a template on its own call line',
      'function sink(x) { window.result = x; }\nsink(\n  `color: ${__DEV__ ? "red" : "blue"}`\n);',
      'red',
      'orange',
    ],
    [
      'the second template on one line',
      'window.result = [`a${window.input}`, `b${__DEV__ ? "red" : ""}`];',
      'red',
      'orange',
    ],
    [
      'a folded logical template substitution',
      'function dbg(x) { window.debug = x; } window.result = `x${P !== "production" && dbg("red")}`;',
      'red',
      'orange',
    ],
    [
      'a multiline template substitution',
      'window.result = `color:\n${__DEV__ ? "red" : "blue"}\ntail`;',
      'red',
      'orange',
    ],
    [
      'a substitution expression on its own line',
      'window.result = `color: ${\n  __DEV__ ? "red" : "blue"\n} tail`;',
      'red',
      'orange',
    ],
  ].map(([name, before, from, to]) => ({
    name,
    before,
    after: before.replace(`"${from}"`, `"${to}"`),
    removed: [`"${from}"`, `"${to}"`],
    template: true,
    foldedAlways: name === 'a folded logical template substitution',
    from,
    to,
  })),
];

export const tokenDefines = {
  'process.env.NODE_ENV': '"production"',
  isProd: 'true',
  __DEV__: 'false',
  P: '"production"',
};

export const residualCases = [
  ...[
    ['a return value after an empty parameter list', 'function Overlay(){return "red";}window.result=Overlay();'],
    ['a return value outside a function default', 'function App(value="ok"){return "red";}window.result=App("ok");'],
    ['an arrow body outside its parameter default', 'const App=(value="ok")=>"red";window.result=App("ok");'],
  ].map(([name, before]) => ({ name, before, residual: 'throwing expression', notResidual: 'default parameter' })),
  {
    name: 'supplied function default',
    before: 'function App(value="red"){return value;} window.result=App("ok");',
    residual: 'default parameter',
  },
  {
    name: 'supplied arrow default',
    before: 'const App = (value = "red") => value; window.result=App("ok");',
    residual: 'default parameter',
  },
  {
    name: 'code after a throwing call',
    before: 'function fail(){throw 1;}\nfunction App(){\n  fail();\n  return "red";\n}\ntry{App();}catch{}',
    residual: 'throwing expression',
  },
];
