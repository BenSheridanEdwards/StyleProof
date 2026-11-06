// TS-AST oracle fuzz for StyleProof #1001 round 7 type-mode walker. Usage: R=<clone> node fuzz.mjs <seed> <programs> [kind...]
import { createRequire } from 'node:module';
const R = process.env.R;
const require = createRequire(R + '/package.json');
const ts = require('typescript');
const { classLiterals } = await import(R + '/dist/class-join-literals.js');
const seed = Number(process.argv[2] ?? 1),
  N = Number(process.argv[3] ?? 4000),
  kinds = process.argv.slice(4).length ? process.argv.slice(4) : ['ts', 'tsx', 'vue', 'svelte'];
let s = seed >>> 0 || 1;
const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 2 ** 32);
const pick = (a) => a[Math.floor(rnd() * a.length)];
let id = 0;
const ty = () => `'ty${id++}'`;
let frag = [];
const label = new Map();
const rt = () => {
  const n = id++;
  label.set('rt' + n, frag.join('/'));
  return `'rt${n}'`;
};
let kind = 'ts';
// ---------- types ----------
const leaves = [
  () => `{ class: ${ty()} }`,
  () => `{ className: ${ty()} }`,
  () => `{ readonly class?: ${ty()} }`,
  () => `{ 'class': ${ty()}; className: ${ty()} }`,
  () => ty(),
  () => `\`${ty().slice(1, -1)} \${string}\``,
  () => `Foo[${ty()}]`,
  () => `typeof import(${ty()})`,
  () => `{ [K in ${ty()}]: ${ty()} }`,
  () => `{ (x: ${ty()}): void }`,
  () => `{ new (): { class: ${ty()} } }`,
  () => `{ m(): { class: ${ty()} } }`,
  () => `{ get v(): { className: ${ty()} } }`,
  () => `keyof { class: ${ty()} }`,
  () => `unique symbol`,
  () => `string`,
];
const comps = [
  (T) => `(${T()})`,
  (T) => `(${T()})[]`,
  (T) => `readonly (${T()})[]`,
  (T) => `[${T()}, ${T()}?]`,
  (T) => `readonly [${T()}]`,
  (T) => `[a: ${T()}, ...rest: (${T()})[]]`,
  (T) => `Record<K, ${T()}>`,
  (T) => `Map<${T()}, ${T()}>`,
  (T) => `A<B<${T()}>>`,
  (T) => `A<B<C<${T()}>>>`,
  (T) => `${T()} | ${T()}`,
  (T) => `${T()} & ${T()}`,
  (T) => `A extends ${T()} ? ${T()} : ${T()}`,
  (T) => `A extends (infer U extends ${T()}) ? U : ${T()}`,
  (T) => `A extends [infer H, ...infer Rest] ? ${T()} : never`,
  (T) => `((a: ${T()}, b?: ${T()}) => ${T()})`,
  (T) => `(new (a: ${T()}) => ${T()})`,
  (T) => `(<G extends ${T()} = ${T()}>(g: G) => ${T()})`,
  (T) => `keyof (${T()})`,
  () => `typeof x`,
  (T) => `{ nested: ${T()}; other?: ${T()} }`,
  (T) => `{ [k: string]: ${T()} }`,
  (T) => `{ [K in keyof X]: ${T()} }`,
  (T) => `{ [K in keyof X as \`p-\${K & string}\`]: ${T()} }`,
  (T) => `(${T()})['k']`,
  (T) => `(abstract new () => ${T()})`,
  (T) => `Promise<${T()}>`,
  (T) => `\`a\${${T()} & string}b\``,
];
function T(d = 0) {
  if (d > 3 || rnd() < 0.3) return pick(leaves)();
  return pick(comps)(() => T(d + 1));
}
const g = () => (kind === 'tsx' ? 'G,' : 'G');
// ---------- type-position statements ----------
const typeStmts = [
  () => `let p: ${T()} = value;`,
  () => `let p: ${T()};`,
  () => `let p!: ${T()};`,
  () => `const p: ${T()} = value, q: ${T()} = v2;`,
  () => `const { a }: ${T()} = value;`,
  () => `const [a]: ${T()} = value;`,
  () => `function f(e: ${T()}, g?: ${T()}): ${T()} { return value; }`,
  () => `function f(e: ${T()}): ${T()};\nfunction f(e: ${T()}): ${T()};\nfunction f(e) { return e; }`,
  () => `declare function f(e: ${T()}): ${T()};`,
  () => `function assert(x: unknown): asserts x is ${T()} {}`,
  () => `function isX(x: unknown): x is ${T()} { return true; }`,
  () => `function f(this: ${T()}) {}`,
  () => `const f = (e: ${T()}): ${T()} => e;`,
  () => `const f = async (e: ${T()}): Promise<${T()}> => e;`,
  () => `const f = function (e: ${T()}): ${T()} { return e; };`,
  () => `const f = <${g()}>(e: ${T()}): ${T()} => e;`,
  () => `const f = <G extends ${T()}>(e: G) => e;`,
  () => `const p = value as ${T()};`,
  () => `const p = value satisfies ${T()};`,
  () => (kind === 'tsx' ? `const p = value as ${T()};` : `const p = <${T()}>value;`),
  () => `const p = (value as ${T()}).x;`,
  () => `const p = value as unknown as ${T()};`,
  () => `const p = f(value as ${T()}, other);`,
  () => `const p = { a: value as ${T()}, b: 1 };`,
  () => `type X<G = ${T()}> = ${T()};`,
  () => `type X = ${T()};`,
  () => `export type X = ${T()}`,
  () =>
    `interface X<G extends ${T()}> extends Y<${T()}> { p: ${T()}; m(a: ${T()}): ${T()}; (a: ${T()}): ${T()}; new (a: ${T()}): ${T()}; [k: string]: ${T()}; get gg(): ${T()}; set gg(v: ${T()}); readonly r?: ${T()} }`,
  () =>
    `class C<G = ${T()}> extends Base<${T()}> implements I<${T()}>, J { p: ${T()} = init; declare d: ${T()}; static s?: ${T()}; #q!: ${T()}; accessor a: ${T()} = v; constructor(private readonly x: ${T()}, public y?: ${T()}) { super(); } m(a: ${T()}): ${T()}; m(a) { return a; } get gg(): ${T()} { return v; } set gg(v: ${T()}) {} }`,
  () => `abstract class C { abstract m(): ${T()}; abstract p: ${T()}; }`,
  () => `declare global { interface Window { p: ${T()} } var gv: ${T()}; }`,
  () => `declare module 'mod' { export const p: ${T()}; export function f(a: ${T()}): ${T()}; }`,
  () => `namespace N { export type X = ${T()}; export let v: ${T()}; }`,
  () => `import type { X } from 'mod';`,
  () => `export const p: ${T()} = value;`,
  () => `new Map<string, ${T()}>();`,
  () => `foo<A, ${T()}>(x);`,
  () => `const gi = foo<${T()}>;`,
  () => `a?.b<${T()}>(x);`,
  () => `for (const x of xs as (${T()})[]) {}`,
  () =>
    `const o = { m(a: ${T()}): ${T()} { return a; }, n: (b: ${T()}): ${T()} => b, get gg(): ${T()} { return v; } };`,
  () => `useState<${T()}>(() => init);`,
  () => `let p: ${T()} = cond ? a : b;`,
  () => `export default function f(a: ${T()}): ${T()} { return a; }`,
  () => `type M = { [K in keyof X]: X[K] extends ${T()} ? ${T()} : never };`,
  () => `let p: ${T()}\nlet q: ${T()}`,
  () => (kind === 'vue' ? `const props = defineProps<${T()}>();` : `let p: ${T()};`),
  () => (kind === 'vue' ? `const emit = defineEmits<{ (e: ${ty()}, v: ${T()}): void }>();` : `let p: ${T()};`),
  () => (kind === 'vue' ? `const props = withDefaults(defineProps<${T()}>(), {});` : `let p: ${T()};`),
  () => (kind === 'svelte' ? `let { a }: ${T()} = $props();` : `let p: ${T()};`),
  () => (kind === 'svelte' ? `export let p: ${T()};` : `let p: ${T()};`),
];
// ---------- runtime positive fragments (each rt literal must be explicit) ----------
const R0 = [
  () => `el.className = ${rt()};`,
  () => `el.classList.add(${rt()});`,
  () => `cn(${rt()});`,
  () => `clsx(${rt()}, cond && ${rt()});`,
  () => `h('div', { class: ${rt()} });`,
  () => `el.className = cond ? ${rt()} : ${rt()};`,
];
const tsxR = [
  () => `const v = <div className=${rt().replaceAll("'", '"')} />;`,
  () => `const v = <div className={cond ? ${rt()} : ${rt()}} />;`,
  () => `const v = <div className={cn(${rt()})} />;`,
];
const wrapF = (arr, tag) => () => {
  const i = Math.floor(rnd() * arr.length);
  frag.push(tag + i);
  try {
    return arr[i]();
  } finally {
    frag.pop();
  }
};
const r0 = () => (kind === 'tsx' && rnd() < 0.4 ? wrapF(tsxR, 'x')() : wrapF(R0, 'r')());
const ctxStmts = [
  () => `function f(e: ${T()}): ${T()} { ${r0()} return value; }`,
  () => `const f = (e: ${T()}): ${T()} => { ${r0()} return e; };`,
  () => `const f = (e: ${T()}): string => cn(${rt()});`,
  () => `const o = { k: (e: ${T()}) => cn(${rt()}), j: 1 };`,
  () => `const o = { k: (e: ${T()}): ${T()} => cn(${rt()}), j: 1 };`,
  () => `let p: ${T()} = { class: ${rt()} };`,
  () => `let p: ${T()} = cond ? { class: ${rt()} } : { class: ${rt()} };`,
  () => `let p: ${T()} = cn(${rt()});`,
  () => `foo(value as ${T()}, cn(${rt()}));`,
  () => `const p = { a: value as ${T()}, class: ${rt()} };`,
  () => `const ok = a < b; ${r0()} const ok2 = c > d;`,
  () => `if (a < b && c > d) { ${r0()} }`,
  () => `el.className = a < b ? ${rt()} : ${rt()};`,
  () => `x<y>(z); ${r0()}`,
  () => `const v = f<${T()}>(z); ${r0()}`,
  () => `class C { p: ${T()} = { class: ${rt()} }; m(): ${T()} { el.className = ${rt()}; return v; } }`,
  () => `switch (k) { case A: { ${r0()} } default: { ${r0()} } }`,
  () => `outer: { ${r0()} }`,
  () => `const f = <${g()}>(e: ${T()}) => { ${r0()} return e; };`,
  () => `export default { name: 'x', data: () => ({ class: ${rt()} }) } satisfies ${T()};`,
  () => `type X = ${T()}\n${r0()}`,
  () => `let p: ${T()}\n${r0()}`,
  () => `const p = value as ${T()}\n${r0()}`,
  () => `function assert(x: unknown): asserts x is ${T()} { ${r0()} }`,
  () => `const total = count < max; const big = total > min; ${r0()}`,
  () => `if (n < 3) { ${r0()} } else if (n > 9) { ${r0()} }`,
  () => `const p = cond ? (value as ${T()}) : other ; cn(${rt()});`,
  () => `const f = (e: X): (${T()}) => { ${r0()} return e; };`,
  () => `const f = (): (A | B) => cn(${rt()});`,
  () =>
    kind === 'tsx'
      ? `const v = <ul className={a < b ? ${rt()} : ${rt()}}>{c > d && <li className=${rt().replaceAll("'", '"')} />}</ul>;`
      : `el.className = c > d ? ${rt()} : ${rt()};`,
];
function program() {
  const n = 3 + Math.floor(rnd() * 6),
    parts = [];
  for (let i = 0; i < n; i++) {
    const r = rnd();
    parts.push(r < 0.45 ? pick(typeStmts)() : r < 0.75 ? wrapF(ctxStmts, 'c')() : r0());
  }
  return parts.join(pick(['\n', ' ', '\n\n']));
}
function wrap(code) {
  if (kind === 'vue') {
    const pre = `<template>\n  <div class="layout">x</div>\n</template>\n<script setup lang="ts">\n`;
    return { file: 'App.vue', text: pre + code + '\n</script>\n', offset: pre.length };
  }
  if (kind === 'svelte') {
    const pre = `<script lang="ts">\n`;
    return { file: 'App.svelte', text: pre + code + '\n</script>\n<div class="layout">x</div>\n', offset: pre.length };
  }
  return { file: `app.${kind}`, text: code, offset: 0 };
}
function oracle(code) {
  const sk = kind === 'tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const tree = ts.createSourceFile(kind === 'tsx' ? 'a.tsx' : 'a.ts', code, ts.ScriptTarget.Latest, true, sk);
  if (tree.parseDiagnostics.length) return;
  const typed = new Map(),
    positions = new Map();
  const pending = [{ node: tree, type: false }];
  while (pending.length) {
    const { node, type } = pending.pop();
    const inType = type || ts.isTypeNode(node);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node)) {
      const m = /^(ty|rt)\d+/.exec(node.text);
      if (m) {
        typed.set(m[0], inType);
        positions.set(m[0], node.getStart(tree));
      }
    }
    ts.forEachChild(node, (child) => {
      pending.push({ node: child, type: inType });
    });
  }
  return { typed, positions };
}
// Match the extractor's named failures and unresolved explicit contexts against
// the complete generated-token vocabulary; capture/ledger gaps are not invented.
function extractionRanges(literals, text, vocabulary) {
  const lines = [0];
  for (const match of text.matchAll(/\r\n|[\r\n\u2028\u2029]/g)) lines.push(match.index + match[0].length);
  const at = (p) => lines[p.line - 1] + p.column;
  const ranges = literals.map((literal) => ({ literal, start: at(literal.range.start), end: at(literal.range.end) }));
  return ranges.filter(({ literal, start, end }) => {
    if (literal.extractionGap) return true;
    if (!literal.explicit) return false;
    if (literal.residual) return true;
    if (!literal.context) return false;
    return !ranges.some(
      (entry) =>
        entry.start < end &&
        start < entry.end &&
        entry.literal.explicit &&
        entry.literal.words.some((word) => vocabulary.has(word.token)),
    );
  });
}
const stats = {};
for (const k of kinds) {
  kind = k;
  const st = (stats[k] = {
    programs: 0,
    rejected: 0,
    typeLits: 0,
    fp: 0,
    rtLits: 0,
    fn: 0,
    hiddenWithGap: 0,
    hiddenNoGap: 0,
    nonExplicit: 0,
    missEx: { hiddenWithGap: [], hiddenNoGap: [], nonExplicit: [] },
    rtInType: 0,
    fpEx: [],
    fnEx: [],
    errors: 0,
  });
  while (st.programs < N) {
    const code = program();
    const observed = oracle(code);
    if (!observed) {
      st.rejected++;
      if (st.rejected > N * 20) throw new Error('too many rejects');
      continue;
    }
    const { typed, positions } = observed;
    st.programs++;
    const { file, text, offset } = wrap(code);
    let lits;
    try {
      lits = classLiterals(text, file);
    } catch (e) {
      st.errors++;
      if (st.fpEx.length < 3) st.fpEx.push('THROW ' + e.message + ' :: ' + code);
      continue;
    }
    const gaps = extractionRanges(lits, text, typed);
    const explicit = new Map();
    for (const l of lits)
      for (const w of l.words) {
        const m = /^(ty|rt)\d+/.exec(w.token);
        if (m) explicit.set(m[0], (explicit.get(m[0]) ?? false) || l.explicit);
      }
    for (const [tok, inType] of typed) {
      if (inType) {
        st.typeLits++;
        if (tok.startsWith('rt')) st.rtInType++;
        if (explicit.get(tok)) {
          st.fp++;
          if (st.fpEx.length < 8) st.fpEx.push(`${tok} :: ${code}`);
        }
      } else if (tok.startsWith('rt')) {
        st.rtLits++;
        {
          const lb = label.get(tok);
          (st.totFrag ??= {})[lb] = (st.totFrag[lb] ?? 0) + 1;
        }
        if (!explicit.get(tok)) {
          st.fn++;
          const position = offset + positions.get(tok) + 1;
          const miss = explicit.has(tok)
            ? 'nonExplicit'
            : gaps.some((gap) => gap.start <= position && position < gap.end)
              ? 'hiddenWithGap'
              : 'hiddenNoGap';
          st[miss]++;
          if (st.missEx[miss].length < 3) st.missEx[miss].push(`${tok} :: ${code}`);
          const lb = label.get(tok);
          (st.byFrag ??= {})[lb] = (st.byFrag[lb] ?? 0) + 1;
          if (st.fnEx.length < 12 && (!process.env.FNLABEL || new RegExp(process.env.FNLABEL).test(label.get(tok))))
            st.fnEx.push(`${tok} [${label.get(tok)}] :: ${code}`);
        }
      }
    }
  }
}
const summary = Object.fromEntries(
  Object.entries(stats).map(([k, v]) => [
    k,
    { ...v, fpEx: v.fpEx, fnEx: process.env.FNEX ? v.fnEx : v.fnEx.slice(0, 3) },
  ]),
);
console.log(JSON.stringify({ seed, N, summary }, null, 1));
