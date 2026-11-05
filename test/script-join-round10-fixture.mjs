const jsxRuntime =
  'const h = (tag, props, ...children) => typeof tag === "function" ? tag({...props, children}) : ({tag, props, children});\n';

export const lexicalCases = [
  {
    name: 'slashes in a regex character class cannot start a fake comment',
    ambiguous: true,
    before:
      'const live = window.live ?? true, s = "/"; function dbg(x) { window.debug = x; }\nif (live) /[//]/.test(s) && __DEV__ && dbg("red");',
  },
  {
    name: 'paired single quotes across JSX siblings cannot invent a string',
    ambiguous: true,
    before:
      jsxRuntime +
      'window.result=<section><p>{1}\'first</p>{__DEV__ && <Debug tone="red" />}<p>\'second</p></section>;',
  },
  {
    name: 'paired double quotes across JSX siblings cannot invent a string',
    ambiguous: true,
    from: "'red'",
    to: "'orange'",
    before:
      jsxRuntime +
      'window.result=<section><p>{1}"first</p>{__DEV__ && <Debug tone=\'red\' />}<p>"second</p></section>;',
  },
  {
    name: 'regex-looking JSX text after an expression cannot hide code',
    ambiguous: true,
    before: jsxRuntime + 'window.result=<section>{1}/prefix{__DEV__ && <Debug tone="red" />}suffix</section>;',
  },
  {
    name: 'regex-looking JSX text after a closing tag cannot hide code',
    ambiguous: true,
    before:
      jsxRuntime + 'window.result=<section><p>healthy</p>/prefix{__DEV__ && <Debug tone="red" />}suffix</section>;',
  },
  {
    name: 'paired backticks across JSX siblings cannot invent a template',
    ambiguous: true,
    before:
      jsxRuntime + 'window.result=<section><p>{1}`first</p>{__DEV__ && <Debug tone="red" />}<p>`second</p></section>;',
  },
  ...['// TODO', '/* note', '`npm i'].flatMap((label) => [
    {
      name: `JSX text ${label} after a child expression cannot hide code`,
      ambiguous: true,
      before: jsxRuntime + `window.result=<section><p>{1}${label}</p>{__DEV__ && <Debug tone="red" />}</section>;`,
    },
    {
      name: `JSX text ${label} after a closing tag cannot hide code`,
      ambiguous: true,
      before: jsxRuntime + `window.result=<section><p>healthy</p>${label}{__DEV__ && <Debug tone="red" />}</section>;`,
    },
  ]),
  ...['// TODO', '/* note', '`npm i'].map((label) => ({
    name: `JSX text ${label} cannot hide a removed sibling`,
    before:
      jsxRuntime +
      `function App() {\n  return (\n    <section>\n      <p>${label}</p>{__DEV__ && <Debug tone="red" />}\n    </section>\n  );\n}\nwindow.result = App();`,
  })),
  {
    name: 'an arrow in a JSX attribute cannot create a text token for removed code',
    before:
      jsxRuntime +
      'function List({render}) { return render({label:""}); }\nwindow.result = <List render={(i)=>i.label || __DEV__ && "red"}>x</List>;',
  },
  {
    name: 'a JSX attribute keeps negative evidence for its unopened OR arm',
    browserExpected: 'never-rendered',
    before:
      jsxRuntime +
      'function List({render}) { return render({label:"ok"}); }\nwindow.result = <List render={(i)=>i.label || __DEV__ && "red"}>x</List>;',
  },
  {
    name: 'an escaped slash after a condition cannot start a fake comment',
    ambiguous: true,
    before:
      'const live = window.live ?? true, s = "/"; function dbg(x) { window.debug = x; }\nif (live) /\\//.test(s) && __DEV__ && dbg("red");',
  },
].map((entry) => ({ ...entry, after: entry.before.replace(entry.from ?? '"red"', entry.to ?? '"orange"') }));
