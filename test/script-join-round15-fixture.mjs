const setup = 'globalThis.hits=0;function sink(x){globalThis.hits++;return x;}\n';

const shapes = [
  ['nested computed key', '*[k[0]]()', 'new C().m()', 'const k=["m"];'],
  ['static nested computed key', 'static *[k[0]]()', 'C.m()', 'const k=["m"];'],
  ['multiline computed key', "*[\n'm'\n]()", 'new C().m()'],
  ['computed key with a comment bracket', "*[/*]*/'m']()", 'new C().m()'],
  ['computed key with a quoted bracket', "*['a]']()", 'new C()["a]"]()'],
  ['Unicode uber key', '*über()', 'new C().über()'],
  ['Unicode grosse key', '*größe()', 'new C().größe()'],
  ['escaped key', String.raw`*\u006d()`, 'new C().m()'],
  ['fractional numeric key', '*.5()', 'new C()[.5]()'],
  ['hex numeric key', '*0x1f()', 'new C()[0x1f]()'],
  ['escaped single quoted key', String.raw`*'a\'b'()`, 'new C()["a\'b"]()'],
  ['escaped double quoted key', String.raw`*"a\"b"()`, "new C()['a\"b']()"],
  ['async comment after star', 'async */*c*/m()', 'new C().m()'],
  ['private comment after star', '*/*c*/#m()', 'new C().go()', '', 'go(){return this.#m();}'],
  ['line comment after star', '*// c\nm()', 'new C().m()'],
  ['block comment before parenthesis', '*m/*c*/()', 'new C().m()'],
  ['line comment before parenthesis', '*m// c\n()', 'new C().m()'],
  ['function type generic constraint', '*m<T extends () => void>()', 'new C().m()'],
  ['multiline generic list', '*m<\n T,\n>()', 'new C().m()'],
  ['comments around generics', '*m/*a*/<T>/*b*/()', 'new C().m()'],
  ['optional method', '*m?()', 'new C().m()'],
  ['parenthesized generic default', '*m<T = (string)>()', 'new C().m()'],
  ['QA a comment after star', '* /*comment*/m()', 'new C().m()'],
  ['QA b comment before parenthesis', '*m/*comment*/()', 'new C().m()'],
  ['QA c Unicode key', '*méthode()', 'new C().méthode()'],
  ['QA d escaped key', String.raw`*\u006d()`, 'new C().m()'],
  ['QA e multiline Symbol key', '*[\nSymbol.iterator\n]()', 'new C()[Symbol.iterator]()'],
  ['QA f nested computed key', '*[keys[0]]()', 'new C().m()', 'const keys=["m"];'],
  ['QA g parenthesized function constraint', '*m<T extends (()=>void)>()', 'new C().m()'],
  ['QA h escaped quoted key', String.raw`*'m\'key'()`, 'new C()["m\'key"]()'],
];

export const widenedGeneratorCases = shapes.flatMap(([name, header, call, prefix = '', tail = '']) =>
  [false, true].map((noYield) => {
    const before =
      setup +
      `${prefix}class C {${header}{${noYield ? 'return' : 'yield'} sink(731);}${tail}}\nglobalThis.iterator=${call};`;
    return {
      name: `${name} ${noYield ? 'without yield' : 'with yield'}`,
      before,
      after: before.replace('sink(731)', 'sink(947)'),
      hits: 0,
      noYield,
    };
  }),
);
