import { test } from 'node:test';
import assert from 'node:assert/strict';
import { affectedSurfaces, classifyStyleChange, explainAffectedSurfaces } from '../dist/affected-surfaces.js';

// ---------------------------------------------------------------------------
// classifyStyleChange: sound global-vs-local verdict across styling systems.
// 'scope' is only ever returned for provably-scoped changes; everything else,
// and anything unrecognized, is 'all' (fail closed).
// ---------------------------------------------------------------------------
const read = (content) => () => content;

test('classify: vanilla stylesheet with a reset is global', () => {
  assert.equal(classifyStyleChange('reset.css', read(':root{--brand:#00f}\n*{box-sizing:border-box}')), 'all');
});
test('classify: vanilla stylesheet that only LOOKS local is still global (unscoped namespace)', () => {
  // A `.btn` rule in a plain .css applies document-wide — the import graph can't bound it.
  assert.equal(classifyStyleChange('legacy.css', read('.btn{padding:8px}\n.card{border:1px}')), 'all');
});
test('classify: CSS Module with only class selectors is scoped', () => {
  assert.equal(classifyStyleChange('Button.module.css', read('.btn{padding:8px}')), 'scope');
});
test('classify: CSS Module with :global escapes its scope', () => {
  assert.equal(classifyStyleChange('Themed.module.css', read(':global(.brand){color:red}\n.btn{padding:8px}')), 'all');
});
test('classify: CSS Module containing :root is global despite the .module extension', () => {
  assert.equal(classifyStyleChange('Tokens.module.css', read(':root{--brand:#00f}\n.btn{padding:8px}')), 'all');
});
test('classify: CSS Module using `composes … from` pulls in outside scope', () => {
  assert.equal(classifyStyleChange('Btn.module.css', read('.btn{composes: base from "./shared.css"}')), 'all');
});
test('classify: colocated CSS-in-JS component is scoped', () => {
  assert.equal(
    classifyStyleChange('Button.tsx', read("import styled from 'styled-components';\nexport const B=styled.button``;")),
    'scope',
  );
});
test('classify: createGlobalStyle in a .tsx is global (the blunt fallback misses this)', () => {
  assert.equal(
    classifyStyleChange(
      'GlobalStyle.tsx',
      read("import {createGlobalStyle} from 'styled-components';\nexport const G=createGlobalStyle`:root{}`;"),
    ),
    'all',
  );
});
test('classify: an UNLISTED CSS-in-JS global API in a .tsx reads as scope — documented residual', () => {
  // BOUNDARY PIN (the one known-unsound path, accepted permanently). CSSJS_GLOBAL
  // (src/affected-surfaces.ts) is an allowlist of global CSS-in-JS APIs. An
  // allowlist is structurally incapable of failing closed on unknown members: a
  // made-up `createGlobalStyles` from a fictional library isn't in the list, so a
  // genuinely-global change in a .tsx is (mis)read as 'scope' and follows the
  // import graph. The only sound alternative is treating EVERY code file as 'all',
  // which deletes the feature. So this is caller-gated: an unsupported styling
  // system is a reason to SKIP selective remap (README "Optional: selective remap
  // (advisory)" states this). This test exists to make the boundary explicit, not
  // accidental — if you add a library, extend CSSJS_GLOBAL and move it above.
  assert.equal(
    classifyStyleChange(
      'Theme.tsx',
      read(
        "import {createGlobalStyles} from 'fictional-css-lib';\nexport const T=createGlobalStyles({body:{margin:0}});",
      ),
    ),
    'scope',
  );
});
test('classify: vanilla-extract globalStyle() is global', () => {
  assert.equal(
    classifyStyleChange(
      'theme.css.ts',
      read("import {globalStyle} from '@vanilla-extract/css';\nglobalStyle('body',{margin:0});"),
    ),
    'all',
  );
});
test('classify: a design-system config cascades everywhere', () => {
  assert.equal(classifyStyleChange('tailwind.config.js', read('module.exports={}')), 'all');
});
test('classify: a Sass partial (non-module) is global', () => {
  assert.equal(classifyStyleChange('_tokens.scss', read('$brand:#00f;')), 'all');
});
test('classify: a scoped Sass module is local', () => {
  assert.equal(classifyStyleChange('Button.module.scss', read('.btn{padding:8px}')), 'scope');
});
test('classify: a Sass module with @use pulls in a partial → global (fail closed)', () => {
  // @use/@forward loads another partial (and any global rules it carries) that
  // dependency-cruiser's JS import graph can't bound. Sound over-approximation → all.
  assert.equal(classifyStyleChange('Button.module.scss', read("@use './globals';\n.btn{padding:8px}")), 'all');
});
test('classify: a Sass module with @forward re-exports another partial → global', () => {
  assert.equal(classifyStyleChange('Button.module.sass', read("@forward 'tokens'\n.btn\n  padding: 8px")), 'all');
});
test('classify: a Sass module with @import "partial" pulls in a partial → global (fail closed)', () => {
  // Legacy Sass `@import "vars"` merges the partial's members (possibly global
  // rules) into this module exactly like `@use` — the JS import graph can't bound
  // it. The old classifier omitted `@import` and wrongly returned 'scope'.
  assert.equal(classifyStyleChange('Card.module.scss', read('@import "vars";\n.card{border:1px}')), 'all');
});
test('classify: a Sass module with a plain-CSS @import url(...) also escapes → global', () => {
  // A CSS `@import url(x.css)` composes an external sheet whose selectors are NOT
  // hashed into this module's per-file scope, so it escapes the module too → 'all'.
  // Uniform rule: ANY @import in a CSS-module Sass file fails closed.
  assert.equal(classifyStyleChange('Card.module.scss', read('@import url("theme.css");\n.card{border:1px}')), 'all');
});
test('classify: a plain .module.css with a CSS @import escapes its module scope → global', () => {
  // Same reasoning applies to a non-Sass CSS module: an @import-ed sheet is not
  // hashed, so it escapes. Only ever widens toward 'all'.
  assert.equal(classifyStyleChange('Card.module.css', read('@import "reset.css";\n.card{border:1px}')), 'all');
});
test('classify: a plain .module.scss WITHOUT any load stays scoped', () => {
  // Guard against over-widening: a module with only class selectors and no load
  // directive is still provably scoped.
  assert.equal(classifyStyleChange('Card.module.scss', read('.card{border:1px}\n.title{font-weight:600}')), 'scope');
});
test('classify: an unreadable file fails closed to global', () => {
  assert.equal(
    classifyStyleChange('missing.css', () => {
      throw new Error('nope');
    }),
    'all',
  );
});

// ---------------------------------------------------------------------------
// affectedSurfaces: reverse reachability + context-module recovery + fail-closed.
// One in-memory fixture (a dependency-cruiser-shaped graph) mirrors the spike.
// ---------------------------------------------------------------------------
function fixture() {
  const sources = {
    // three surfaces; Dashboard uses a COMPUTED dynamic import over ../components/*
    'src/pages/Home.tsx':
      "import {Header} from '../components/Header';\nconst P=lazy(()=>import('../components/Promo'));",
    'src/pages/Pricing.tsx':
      "import {Header} from '../components/Header';\nimport {PriceTable} from '../components/PriceTable';\nimport {Isolated} from '../widgets/Isolated';",
    'src/pages/Dashboard.tsx':
      "import {Header} from '../components/Header';\nconst name='Widget';\nconst D=lazy(()=>import(`../components/${name}`));",
    'src/pages/Settings.tsx': "import {G} from '../components/GlobalStyle';",
    'src/components/Header.tsx': "import './Header.css';\nexport function Header(){return null}",
    'src/components/PriceTable.tsx':
      "import s from './PriceTable.module.css';\nexport function PriceTable(){return null}",
    'src/components/Promo.tsx': "import './Promo.css';\nexport default function Promo(){return null}",
    'src/components/Widget.tsx': "import './Widget.css';\nexport default function Widget(){return null}",
    'src/components/GlobalStyle.tsx':
      "import {createGlobalStyle} from 'styled-components';\nexport const G=createGlobalStyle`:root{--brand:#00f}`;",
    'src/widgets/Isolated.tsx': 'export function Isolated(){return null}',
    'src/components/Header.css': '.site-header{background:blue}',
    'src/components/PriceTable.module.css': '.tbl{border:1px}',
    'src/components/Promo.css': '.promo{color:red}',
    'src/components/Widget.css': '.widget{color:red}',
    'src/tokens.css': ':root{--brand:#00f}',
  };
  // Resolved import edges as a dependency-cruiser run would report them (the
  // computed Dashboard→Widget edge is intentionally absent — it is recovered).
  const graph = [
    { from: 'src/pages/Home.tsx', to: 'src/components/Header.tsx' },
    { from: 'src/pages/Home.tsx', to: 'src/components/Promo.tsx', dynamic: true },
    { from: 'src/pages/Pricing.tsx', to: 'src/components/Header.tsx' },
    { from: 'src/pages/Pricing.tsx', to: 'src/components/PriceTable.tsx' },
    { from: 'src/pages/Pricing.tsx', to: 'src/widgets/Isolated.tsx' },
    { from: 'src/pages/Dashboard.tsx', to: 'src/components/Header.tsx' },
    { from: 'src/pages/Settings.tsx', to: 'src/components/GlobalStyle.tsx' },
    { from: 'src/components/Header.tsx', to: 'src/components/Header.css' },
    { from: 'src/components/PriceTable.tsx', to: 'src/components/PriceTable.module.css' },
    { from: 'src/components/Promo.tsx', to: 'src/components/Promo.css' },
    { from: 'src/components/Widget.tsx', to: 'src/components/Widget.css' },
  ];
  return {
    surfaces: {
      home: 'src/pages/Home.tsx',
      pricing: 'src/pages/Pricing.tsx',
      dashboard: 'src/pages/Dashboard.tsx',
      settings: 'src/pages/Settings.tsx',
    },
    graph,
    files: Object.keys(sources),
    readFile: (p) => sources[p],
  };
}
const run = (changedFiles) => affectedSurfaces({ ...fixture(), changedFiles });
const sorted = (v) => (v === 'all' ? 'all' : [...v].sort());

test('a statically-imported component outside any context-glob dir → just its surface (the win)', () => {
  assert.deepEqual(sorted(run(['src/widgets/Isolated.tsx'])), ['pricing']);
});
test("a component sharing a dir with a context import → that dir's consumer too (sound coarsening)", () => {
  // Dashboard's import(`../components/${x}`) could load PriceTable at runtime.
  assert.deepEqual(sorted(run(['src/components/PriceTable.tsx'])), ['dashboard', 'pricing']);
});
test('a string-literal lazy component → its lazy importer (edge kept by the graph)', () => {
  assert.deepEqual(sorted(run(['src/components/Promo.tsx'])), ['dashboard', 'home']);
});
test('a component reachable ONLY via a computed import → recovered as a context module', () => {
  assert.deepEqual(sorted(run(['src/components/Widget.tsx'])), ['dashboard']);
});
test('a scoped CSS-module change follows its component, staying selective', () => {
  assert.deepEqual(sorted(run(['src/components/PriceTable.module.css'])), ['dashboard', 'pricing']);
});
test('a vanilla component stylesheet forces a full re-capture', () => {
  assert.equal(run(['src/components/Header.css']), 'all');
});
test('a global token stylesheet forces a full re-capture', () => {
  assert.equal(run(['src/tokens.css']), 'all');
});
test('a createGlobalStyle change forces a full re-capture (not a local .tsx edit)', () => {
  assert.equal(run(['src/components/GlobalStyle.tsx']), 'all');
});
test('a shared static component → every surface that imports it', () => {
  assert.deepEqual(sorted(run(['src/components/Header.tsx'])), ['dashboard', 'home', 'pricing']);
});
test('a changed file the graph cannot place → full re-capture (fail closed)', () => {
  assert.equal(run(['src/lib/orphan.ts']), 'all');
});
test('an unbounded dynamic import anywhere makes reachability untrustworthy → all', () => {
  const f = fixture();
  f.readFile = (p) =>
    p === 'src/pages/Dashboard.tsx' ? 'const which=pick;\nconst D=lazy(()=>import(which));' : fixture().readFile(p);
  assert.equal(affectedSurfaces({ ...f, changedFiles: ['src/widgets/Isolated.tsx'] }), 'all');
});
test('an empty changeset affects nothing', () => {
  assert.deepEqual(sorted(run([])), []);
});

// ---------------------------------------------------------------------------
// Path-convention canonicalization: surfaces, changedFiles, graph edges, and
// files must resolve to one spelling. A `./`-prefixed surface entry (or a
// changed file) that reverse-reachability CAN place must still be attributed to
// its surface, not silently dropped. And a surface whose entry path is
// unplaceable after normalization fails closed to 'all'.
// ---------------------------------------------------------------------------
test('a ./-prefixed surface entry still gets attributed (no silent drop → correct subset)', () => {
  // `surfaces` spells `./src/pages/Home.tsx`; the graph spells `src/pages/Home.tsx`.
  // Before canonicalization, entryToKey missed the reached surface and returned the
  // empty set instead of {home}. Now both normalize to the same key.
  const f = fixture();
  const affected = affectedSurfaces({
    ...f,
    surfaces: { ...f.surfaces, home: './src/pages/Home.tsx' },
    changedFiles: ['src/components/Promo.tsx'],
  });
  assert.deepEqual(sorted(affected), ['dashboard', 'home']);
});
test('a ./-prefixed CHANGED file resolves to the same node as the graph spelling', () => {
  const f = fixture();
  const affected = affectedSurfaces({ ...f, changedFiles: ['./src/widgets/Isolated.tsx'] });
  assert.deepEqual(sorted(affected), ['pricing']);
});
test('a doubled-separator changed path canonicalizes and still resolves', () => {
  const f = fixture();
  const affected = affectedSurfaces({ ...f, changedFiles: ['src//widgets/Isolated.tsx'] });
  assert.deepEqual(sorted(affected), ['pricing']);
});
test('an unplaceable surface entry (in neither files nor any edge) → all (fail closed)', () => {
  // A declared surface whose entry path the graph cannot place can never receive a
  // reachability hit, so a genuine change to it would be dropped. Fail closed.
  const f = fixture();
  const affected = affectedSurfaces({
    ...f,
    surfaces: { ...f.surfaces, ghost: 'src/pages/Ghost.tsx' },
    changedFiles: ['src/widgets/Isolated.tsx'],
  });
  assert.equal(affected, 'all');
});

// ---------------------------------------------------------------------------
// explainAffectedSurfaces: pure formatter a pre-push hook can print. It names
// which surfaces reuse the base map and which re-capture, so a reviewer can
// sanity-check the skip list before trusting it.
// ---------------------------------------------------------------------------
const ALL_KEYS = ['home', 'pricing', 'dashboard', 'settings'];

test('explain: a subset verdict lists re-captured and reused-from-base surfaces', () => {
  const out = explainAffectedSurfaces(new Set(['pricing']), ALL_KEYS);
  assert.match(out, /re-capture 1, reuse 3 from base/);
  assert.match(out, /↻ pricing \(re-capture — a changed file reaches it\)/);
  // The three the verdict skips are named as base-map reuse, not silently dropped.
  assert.match(out, /✓ dashboard \(reuse base map/);
  assert.match(out, /✓ home \(reuse base map/);
  assert.match(out, /✓ settings \(reuse base map/);
});

test('explain: an all verdict re-captures every surface and carries the reason', () => {
  const out = explainAffectedSurfaces('all', ALL_KEYS, 'src/tokens.css is a global stylesheet');
  assert.match(out, /re-capture all 4 surface\(s\) — src\/tokens\.css is a global stylesheet/);
  for (const k of ALL_KEYS) assert.match(out, new RegExp(`↻ ${k} \\(re-capture\\)`));
  // No surface is ever named as reusable under 'all'.
  assert.doesNotMatch(out, /reuse base map/);
});

test('explain: an all verdict without a reason still renders cleanly', () => {
  const out = explainAffectedSurfaces('all', ['home']);
  assert.match(out, /re-capture all 1 surface\(s\)$/m);
});

test('explain: an empty subset means every surface reuses its base map', () => {
  const out = explainAffectedSurfaces(new Set(), ALL_KEYS);
  assert.match(out, /re-capture 0, reuse 4 from base/);
  assert.doesNotMatch(out, /↻/);
});
