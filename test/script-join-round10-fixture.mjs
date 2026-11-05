const jsxRuntime =
  'const h = (tag, props, ...children) => typeof tag === "function" ? tag({...props, children}) : ({tag, props, children});\n';

export const lexicalCases = [
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
      'function List({render}) { return render({label:"ok"}); }\nwindow.result = <List render={(i)=>i.label || __DEV__ && "red"}>x</List>;',
  },
  {
    name: 'an escaped slash after a condition cannot start a fake comment',
    ambiguous: true,
    before:
      'const live = window.live ?? true, s = "/"; function dbg(x) { window.debug = x; }\nif (live) /\\//.test(s) && __DEV__ && dbg("red");',
  },
].map((entry) => ({ ...entry, after: entry.before.replace('"red"', '"orange"') }));
