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
];

export const tokenDefines = { 'process.env.NODE_ENV': '"production"', isProd: 'true' };

export const residualCases = [
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
