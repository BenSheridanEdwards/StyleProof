import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyRuleReach } from '../dist/rule-reach.js';
import { servedRulesOf } from '../dist/capture/reach.js';

// Change Reach J1 (#995): every served rule that differs between base and head gets one
// status, judged on the side where it can render.

const rule = (key, hash, extra = {}) => ({ key, hash, sheet: 0, ...extra });
const map = (...rules) => ({ defaults: {}, elements: {}, states: {}, reach: { sheets: ['/app.css'], rules } });
const statusOf = (result, key) => result.rules.find((r) => r.key === key);

const sheet = (label, text, ...needles) => ({ label, text, needles });
const cssMap = (...sheets) => {
  const order = (s) => JSON.stringify([s.label, s.text]);
  const sorted = [...sheets].sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0));
  const seen = new Map();
  const rules = sorted.flatMap(({ text, needles }, index) => {
    const ranges = needles.map((needle) => {
      const startOffset = text.indexOf(needle);
      assert.notEqual(startOffset, -1, `fixture lacks ${needle}`);
      return { startOffset, endOffset: startOffset + needle.length };
    });
    return servedRulesOf(text, ranges).map((rule) => {
      const n = (seen.get(rule.key) ?? 0) + 1;
      seen.set(rule.key, n);
      return { ...rule, key: n > 1 ? `${rule.key} #${n}` : rule.key, sheet: index };
    });
  });
  return { ...map(), reach: { sheets: sorted.map((s) => s.label), rules } };
};

test('an unchanged ledger has nothing to classify', () => {
  const side = map(rule('.a', 'h1', { used: true }), rule('.b', 'h2'));
  assert.deepEqual(classifyRuleReach([side], [side]), { ledger: 'complete', rules: [], unreadableSheets: 0 });
});

test('a changed rule is reached when a head state matched it, and never-rendered otherwise', () => {
  const base = map(rule('.link:hover', 'h1', { used: true }), rule('.panel--fault .indicator', 'h2'));
  const head = map(rule('.link:hover', 'h1b', { used: true }), rule('.panel--fault .indicator', 'h2b'));
  const result = classifyRuleReach([base], [head]);
  assert.equal(statusOf(result, '.link:hover').status, 'reached');
  assert.deepEqual(statusOf(result, '.panel--fault .indicator'), {
    key: '.panel--fault .indicator',
    change: 'changed',
    status: 'never-rendered',
    why: 'its selector never matched',
    sheet: '/app.css',
  });
});

test('reach unions every surface and width of a side', () => {
  const base = [map(rule('.badge--bad', 'h1')), map(rule('.badge--bad', 'h1', { used: true }))];
  const head = [map(rule('.badge--bad', 'h2')), map(rule('.badge--bad', 'h2', { used: true }))];
  assert.equal(classifyRuleReach(base, head).rules[0].status, 'reached');
});

test('an added rule is judged on head, a removed rule on base', () => {
  const base = map(rule('.panel--fault', 'h1'), rule('.gone', 'h2', { used: true }));
  const head = map(rule('.new', 'h3', { used: true }), rule('.unseen', 'h4'));
  const result = classifyRuleReach([base], [head]);
  assert.deepEqual(
    result.rules.map((r) => [r.key, r.change, r.status]),
    [
      ['.gone', 'removed', 'reached'],
      ['.new', 'added', 'reached'],
      ['.panel--fault', 'removed', 'never-rendered'],
      ['.unseen', 'added', 'never-rendered'],
    ],
  );
});

test('a never-rendered rule inside at-rules names its condition', () => {
  const key = '@media (prefers-color-scheme: dark) > .panel > .cell';
  const result = classifyRuleReach([map(rule(key, 'h1'))], [map(rule(key, 'h2'))]);
  assert.equal(statusOf(result, key).condition, '@media (prefers-color-scheme: dark)');
  assert.equal(statusOf(result, key).why, 'never matched while @media (prefers-color-scheme: dark) applied');
  const nested = '@media (min-width: 1440px) > @supports (display: grid) > .panel';
  assert.equal(
    classifyRuleReach([map(rule(nested, 'h1'))], [map(rule(nested, 'h2'))]).rules[0].condition,
    '@media (min-width: 1440px) > @supports (display: grid)',
  );
});

test('a changed custom property is reached only when every rule that reads it matched', () => {
  const base = map(
    rule(':root', 'h1', { used: true, vars: { '--warn': 'green', '--ok': 'green' } }),
    rule('.fault-badge', 'h2', { uses: ['--warn'] }),
    rule('.badge--ok', 'h3', { used: true, uses: ['--ok'] }),
  );
  const head = map(
    rule(':root', 'h1b', { used: true, vars: { '--warn': 'amber', '--ok': 'green' } }),
    rule('.fault-badge', 'h2', { uses: ['--warn'] }),
    rule('.badge--ok', 'h3', { used: true, uses: ['--ok'] }),
  );
  const root = statusOf(classifyRuleReach([base], [head]), ':root');
  assert.equal(root.status, 'never-rendered');
  assert.equal(root.why, '--warn changed, and its consumer .fault-badge never matched');

  // The same change is reached once the consumer renders; an unchanged token's consumers don't matter.
  const rendered = map(
    rule(':root', 'h1b', { used: true, vars: { '--warn': 'amber', '--ok': 'green' } }),
    rule('.fault-badge', 'h2', { used: true, uses: ['--warn'] }),
    rule('.badge--ok', 'h3', { uses: ['--ok'] }),
  );
  assert.equal(statusOf(classifyRuleReach([base], [rendered]), ':root').status, 'reached');
});

test('a token changed on one route is not hidden by another route already serving its new value', () => {
  const route = (hash, warn, x, used = false) =>
    map(
      rule(':root', hash, { used: true, vars: { '--warn': warn, '--x': x } }),
      rule('.fault', 'f', { ...(used ? { used: true } : {}), uses: ['--warn'] }),
      rule('.spacing', 's', { used: true, uses: ['--x'] }),
    );
  const unchanged = route('a2', 'a', '2');
  const base = [route('g1', 'g', '1'), unchanged];
  const head = [route('a1', 'a', '1'), unchanged];
  const result = classifyRuleReach(base, head);
  assert.deepEqual(statusOf(result, ':root'), {
    key: ':root',
    change: 'changed',
    status: 'never-rendered',
    why: '--warn changed, and its consumer .fault never matched',
    sheet: '/app.css',
  });
  for (const before of [base, [...base].reverse()]) {
    for (const after of [head, [...head].reverse()]) {
      assert.deepEqual(classifyRuleReach(before, after), result);
    }
  }
  assert.equal(statusOf(classifyRuleReach(base, [route('a1', 'a', '1', true), unchanged]), ':root').status, 'reached');
});

test('a token with no counterpart body still requires its consumers to render', () => {
  const consumer = (used) => rule('.fault', 'f', { ...(used ? { used: true } : {}), uses: ['--warn'] });
  const withoutToken = map(consumer(false));
  const withToken = (used) => map(rule(':root', 'h1', { used: true, vars: { '--warn': 'g' } }), consumer(used));
  for (const used of [false, true]) {
    for (const [before, after, change] of [
      [withoutToken, withToken(used), 'added'],
      [withToken(used), withoutToken, 'removed'],
    ]) {
      const root = statusOf(classifyRuleReach([before], [after]), ':root');
      assert.equal(root.change, change);
      assert.equal(root.status, used ? 'reached' : 'never-rendered');
      if (!used) assert.equal(root.why, '--warn changed, and its consumer .fault never matched');
    }
  }
});

test('a custom property head deletes is a change its consumers must render', () => {
  const base = map(
    rule(':root', 'h1', { used: true, vars: { '--warn': 'g' } }),
    rule('.fault', 'f', { uses: ['--warn'] }),
  );
  const head = map(rule(':root', 'h2', { used: true }), rule('.fault', 'f', { uses: ['--warn'] }));
  assert.deepEqual(statusOf(classifyRuleReach([base], [head]), ':root'), {
    key: ':root',
    change: 'changed',
    status: 'never-rendered',
    why: '--warn changed, and its consumer .fault never matched',
    sheet: '/app.css',
  });
  const rendered = map(rule(':root', 'h2', { used: true }), rule('.fault', 'f', { used: true, uses: ['--warn'] }));
  assert.equal(statusOf(classifyRuleReach([base], [rendered]), ':root').status, 'reached');
});

test('a changed token reaches through aliases to every consumer', () => {
  const sameRule = (warn) =>
    map(
      rule(':root', warn, {
        used: true,
        vars: { '--warn': warn, '--badge': 'w' },
        uses: ['--warn'],
        aliases: { '--badge': ['--warn'] },
      }),
      rule('.fault', 'f', { uses: ['--badge'] }),
    );
  const aliased = statusOf(classifyRuleReach([sameRule('g')], [sameRule('a')]), ':root');
  assert.equal(aliased.status, 'never-rendered');
  assert.equal(aliased.why, '--warn changed through --badge, and its consumer .fault never matched');

  const theme = (warn, used) =>
    map(
      rule(':root', warn, { used: true, vars: { '--warn': warn } }),
      rule('.theme', 't', {
        used: true,
        vars: { '--badge': 'w' },
        uses: ['--warn'],
        aliases: { '--badge': ['--warn'] },
      }),
      rule('.fault', 'f', { ...(used ? { used: true } : {}), uses: ['--badge'] }),
    );
  const crossRule = statusOf(classifyRuleReach([theme('g', false)], [theme('a', false)]), ':root');
  assert.equal(crossRule.status, 'never-rendered');
  assert.equal(crossRule.why, '--warn changed through --badge, and its consumer .fault never matched');
  assert.equal(statusOf(classifyRuleReach([theme('g', true)], [theme('a', true)]), ':root').status, 'reached');

  // A matched body without the read cannot vouch for another route's unmatched consumer.
  const routes = (warn) => [
    map(rule(':root', warn, { used: true, vars: { '--warn': warn } }), rule('.fault', 'f1', { used: true })),
    map(rule(':root', warn, { used: true, vars: { '--warn': warn } }), rule('.fault', 'f2', { uses: ['--warn'] })),
  ];
  const split = statusOf(classifyRuleReach(routes('g'), routes('a')), ':root');
  assert.equal(split.status, 'never-rendered');
  assert.equal(split.why, '--warn changed, and its consumer .fault never matched');
});

test('a changed @keyframes is a blind channel when a rendered rule references it', () => {
  const base = map(rule('@keyframes pulse', 'k1'), rule('.badge', 'b', { used: true, refs: ['pulse'] }));
  const head = map(rule('@keyframes pulse', 'k2'), rule('.badge', 'b', { used: true, refs: ['pulse'] }));
  assert.deepEqual(statusOf(classifyRuleReach([base], [head]), '@keyframes pulse'), {
    key: '@keyframes pulse',
    change: 'changed',
    status: 'blind-channel',
    why: 'referenced by .badge, which rendered',
    sheet: '/app.css',
  });
  const unreferenced = map(rule('@keyframes pulse', 'k2'), rule('.badge', 'b', { refs: ['pulse'] }));
  assert.equal(statusOf(classifyRuleReach([base], [unreferenced]), '@keyframes pulse').status, 'never-rendered');

  // Only the unmatched body references pulse; the matched route's body cannot vouch for it.
  const routes = (hash, used) => [
    map(rule('@keyframes pulse', hash), rule('.badge', 'b1', { used: true })),
    map(rule('@keyframes pulse', hash), rule('.badge', 'b2', { ...(used ? { used: true } : {}), refs: ['pulse'] })),
  ];
  const split = statusOf(classifyRuleReach(routes('k1', false), routes('k2', false)), '@keyframes pulse');
  assert.deepEqual([split.status, split.why], ['never-rendered', 'no rendered rule references it']);
  assert.equal(
    statusOf(classifyRuleReach(routes('k1', false), routes('k2', true)), '@keyframes pulse').status,
    'blind-channel',
  );
});

test('a changed @property is a blind channel only when a rendered rule reads or declares it', () => {
  for (const reference of [{ uses: ['--brand'] }, { vars: { '--brand': 'x' } }]) {
    const side = (hash, used) =>
      map(rule('@property --brand', hash), rule('.btn', 'b', { ...reference, ...(used ? { used: true } : {}) }));
    assert.deepEqual(statusOf(classifyRuleReach([side('p1', true)], [side('p2', true)]), '@property --brand'), {
      key: '@property --brand',
      change: 'changed',
      status: 'blind-channel',
      why: 'referenced by .btn, which rendered',
      sheet: '/app.css',
    });
    const idle = statusOf(classifyRuleReach([side('p1', true)], [side('p2', false)]), '@property --brand');
    assert.deepEqual([idle.status, idle.why], ['never-rendered', 'no rendered rule references it']);
  }
  const missing = classifyRuleReach([map(rule('@property --brand', 'p1'))], [map(rule('@property --brand', 'p2'))]);
  assert.deepEqual(
    [missing.rules[0].status, missing.rules[0].why],
    ['never-rendered', 'no rendered rule references it'],
  );
});

test('an unparsable @property name cannot claim reach', () => {
  const side = (hash) =>
    map(rule('@property --brand unexpected', hash), rule('.btn', 'b', { used: true, uses: ['--brand'] }));
  const result = classifyRuleReach([side('p1')], [side('p2')]).rules[0];
  assert.deepEqual([result.status, result.why], ['never-rendered', 'no rendered rule references it']);
});

test('removed and renamed custom properties require rendered consumers', () => {
  const base = cssMap(sheet('/app.css', ':root { --warn: red; } .fault { color: var(--warn); }', ':root'));
  for (const [declaration, why] of [
    ['color: black;', '--warn changed, and its consumer .fault never matched'],
    ['--renamed: red;', '--renamed changed, and no served rule reads it outside a custom property'],
  ]) {
    const head = cssMap(sheet('/app.css', `:root { ${declaration} } .fault { color: var(--warn); }`, ':root'));
    assert.deepEqual(statusOf(classifyRuleReach([base], [head]), ':root'), {
      key: ':root',
      change: 'changed',
      status: 'never-rendered',
      why,
      sheet: '/app.css',
    });
  }
});

test('served CSS aliases across sheets and within the changed rule reach every consumer', () => {
  for (const aliases of [
    ['--middle: var( --warn ); --tone: var(--middle);', ''],
    ['', ':root { --middle: var( --warn ); --tone: var(--middle); }'],
  ]) {
    const captured = (value, rendered) =>
      cssMap(
        sheet('/tokens.css', `:root { --warn: ${value}; ${aliases[0]} }`, ':root'),
        sheet(
          '/app.css',
          `${aliases[1]} .fault { color: var(--tone); } .healthy { color: var(--tone-extra); }`,
          ...(aliases[1] ? [':root', ...rendered] : rendered),
        ),
      );
    const base = captured('red', []);
    for (const rendered of [[], ['.fault']]) {
      const result = classifyRuleReach([base], [captured('blue', rendered)]).rules;
      assert.equal(result.length, 1);
      assert.equal(result[0].key, aliases[1] ? ':root #2' : ':root');
      assert.equal(result[0].status, rendered.length ? 'reached' : 'never-rendered');
    }
  }
});

test('unread tokens and alias cycles are never rendered', () => {
  for (const [aliases, prop] of [
    ['', '--warn'],
    ['--tone: var(--warn);', '--tone'],
    ['--tone: var(--warn); --warn: var(--tone);', '--tone'],
  ]) {
    const base = cssMap(sheet('/app.css', ':root { --warn: red; }', ':root'));
    const head = cssMap(sheet('/app.css', `:root { --warn: blue; ${aliases} }`, ':root'));
    assert.deepEqual(statusOf(classifyRuleReach([base], [head]), ':root'), {
      key: ':root',
      change: 'changed',
      status: 'never-rendered',
      why: `${prop} changed, and no served rule reads it outside a custom property`,
      sheet: '/app.css',
    });
  }
});

test('a token closure follows only declared aliases', () => {
  const captured = (value) =>
    cssMap(
      sheet(
        '/app.css',
        `:root { --warn: ${value}; } .shown { color: var(--warn); --unrelated: blue; }
         .hidden { color: var(--unrelated); }`,
        ':root',
        '.shown',
      ),
    );
  assert.equal(statusOf(classifyRuleReach([captured('red')], [captured('blue')]), ':root').status, 'reached');
});

test('an ambiguous alias and regular read in one rule stays never rendered', () => {
  const captured = (value) =>
    cssMap(sheet('/app.css', `:root { --warn: ${value}; --tone: var(--warn); color: var(--warn); }`, ':root'));
  const result = statusOf(classifyRuleReach([captured('red')], [captured('blue')]), ':root');
  assert.deepEqual(
    [result.status, result.why],
    ['never-rendered', '--warn changed, and no served rule reads it outside a custom property'],
  );
});

test('later-sheet changes keep their own usage in either discovery order', () => {
  const first = sheet('/first.css', '.a { color: red; }', '.a');
  const second = sheet('/second.css', '.a { color: blue; } .a { padding: 1px; }');
  const changed = sheet('/second.css', '.a { color: green; } .a { padding: 2px; }');
  const base = cssMap(first, second);
  const head = cssMap(first, changed);
  assert.deepEqual(base, cssMap(second, first));
  assert.deepEqual(head, cssMap(changed, first));
  const result = classifyRuleReach([base], [head]);
  assert.deepEqual(classifyRuleReach([cssMap(second, first)], [cssMap(changed, first)]), result);
  assert.deepEqual(
    result.rules.map((r) => [r.key, r.sheet, r.status]),
    [
      ['.a #2', '/second.css', 'never-rendered'],
      ['.a #3', '/second.css', 'never-rendered'],
    ],
  );
});

test('repeated captures do not borrow usage from another sheet or ordinal', () => {
  const text = '.a { color: red; } .a { color: blue; }';
  const captured = (...needles) => cssMap(sheet('/first.css', text, ...needles), sheet('/second.css', text));
  const base = [captured(), captured('.a { color: blue; }')];
  assert.deepEqual(classifyRuleReach(base, [...base].reverse()).rules, []);
  const added = cssMap(
    sheet('/first.css', `${text} .new { margin: 0; }`, '.a { color: blue; }'),
    sheet('/second.css', '.a { color: green; } .a { color: pink; }'),
  );
  assert.deepEqual(
    classifyRuleReach(base, [added]).rules.map((r) => [r.key, r.status]),
    [
      ['.a #3', 'never-rendered'],
      ['.a #4', 'never-rendered'],
      ['.new', 'never-rendered'],
    ],
  );
  for (const rendered of [[], ['.other']]) {
    const before = cssMap(sheet('/first.css', `.other { margin: 0; } ${text}`, ...rendered));
    const after = cssMap(sheet('/first.css', text));
    const result = classifyRuleReach([before], [after]).rules;
    assert.equal(result.length, 1);
    assert.deepEqual(
      [result[0].key, result[0].change, result[0].status],
      ['.other', 'removed', rendered.length ? 'reached' : 'never-rendered'],
    );
  }
});

test('a side with any map lacking a ledger classifies nothing', () => {
  const ledgered = map(rule('.a', 'h1', { used: true }));
  const legacy = { defaults: {}, elements: {}, states: {} };
  assert.deepEqual(classifyRuleReach([ledgered, legacy], [ledgered]), {
    ledger: 'missing',
    rules: [],
    unreadableSheets: 0,
  });
  assert.equal(classifyRuleReach([ledgered], []).ledger, 'missing');
});

test('unreadable stylesheets on either side are counted', () => {
  const base = { ...map(rule('.a', 'h1', { used: true })), reach: { sheets: [], rules: [], unreadable: 2 } };
  const head = { ...map(), reach: { sheets: [], rules: [], unreadable: 1 } };
  const result = classifyRuleReach([base], [head]);
  assert.equal(result.unreadableSheets, 3);
  assert.equal(result.ledger, 'partial');
  const legacy = { defaults: {}, elements: {}, states: {} };
  const missing = classifyRuleReach([base, legacy], [head]);
  assert.deepEqual(missing, { ledger: 'missing', rules: [], unreadableSheets: 3 });
  assert.deepEqual(classifyRuleReach([legacy, base], [head]), missing);
  assert.deepEqual(classifyRuleReach([base], [legacy, head]), missing);
  assert.deepEqual(classifyRuleReach([base], [head, legacy]), missing);
});

test('a range media query stays one condition; a quoted combinator stays in its selector', () => {
  const ranged = '@media (width > 600px) > @container card (inline-size > 30rem) > .panel';
  const result = classifyRuleReach([map(rule(ranged, 'h1'))], [map(rule(ranged, 'h2'))]);
  assert.equal(result.rules[0].condition, '@media (width > 600px) > @container card (inline-size > 30rem)');
  const quoted = '.tip[data-arrow=" > "] > .label';
  const plain = classifyRuleReach([map(rule(quoted, 'h1'))], [map(rule(quoted, 'h2'))]).rules[0];
  assert.equal(plain.condition, undefined);
  assert.equal(plain.why, 'its selector never matched');
});

test('a body only one route serves is compared on its own, not hidden by another route', () => {
  // Route-split stylesheets: route 2 serves a different body for the same key.
  const route1 = map(rule('.x', 'A', { used: true }));
  const baseRoute2 = map(rule('.x', 'A', { used: true }));
  const headRoute2 = map(rule('.x', 'B'));
  assert.deepEqual(
    classifyRuleReach([route1, baseRoute2], [route1, headRoute2]).rules.map((r) => [r.key, r.change, r.status]),
    [['.x', 'changed', 'never-rendered']],
  );
  // Head drops route 2's body: the removed body is judged where base rendered it.
  const oldRoute2 = (used) => map(rule('.x', 'C', used ? { used: true } : {}));
  const seen = classifyRuleReach([route1, oldRoute2(true)], [route1, route1]).rules[0];
  assert.deepEqual([seen.change, seen.status], ['changed', 'reached']);
  const unseen = classifyRuleReach([route1, oldRoute2(false)], [route1, route1]).rules[0];
  assert.deepEqual([unseen.change, unseen.status], ['changed', 'never-rendered']);

  // Head replaces route 1's body and drops route 2's: the dropped body is still judged on base.
  const replacedHead = [map(rule('.x', 'B', { used: true })), map()];
  const dropped = classifyRuleReach([route1, oldRoute2(false)], replacedHead).rules[0];
  assert.deepEqual([dropped.change, dropped.status], ['changed', 'never-rendered']);
  const droppedSeen = classifyRuleReach([route1, oldRoute2(true)], replacedHead).rules[0];
  assert.deepEqual([droppedSeen.change, droppedSeen.status], ['changed', 'reached']);
  // A one-for-one edit is judged where head renders it.
  assert.equal(
    classifyRuleReach([map(rule('.x', 'A'))], [map(rule('.x', 'B', { used: true }))]).rules[0].status,
    'reached',
  );
});

test('a one-for-one swap across routes still judges the removed body on base', () => {
  const added = map(rule('.x', 'B', { used: true }));
  for (const used of [false, true]) {
    const removed = map(rule('.x', 'C', used ? { used: true } : {}));
    for (const [base, head] of [
      [
        [removed, map()],
        [map(), added],
      ],
      [
        [removed, removed],
        [map(), added],
      ],
      [
        [removed, map()],
        [added, added],
      ],
      [[removed, removed], [added]],
      [[removed], [added, added]],
    ]) {
      const result = classifyRuleReach(base, head);
      assert.deepEqual(statusOf(result, '.x'), {
        key: '.x',
        change: 'changed',
        status: used ? 'reached' : 'never-rendered',
        why: used ? 'matched in a captured state' : 'its selector never matched',
        sheet: '/app.css',
      });
      for (const before of [base, [...base].reverse()]) {
        for (const after of [head, [...head].reverse()]) {
          assert.deepEqual(classifyRuleReach(before, after), result);
        }
      }
    }
  }
});

test('a changed @font-face is a blind channel only when a rendered rule uses its family', () => {
  const faces = (brandHash) => [
    rule('@font-face', brandHash, { refs: ['Brand Sans'] }),
    rule('@font-face #2', 'other', { refs: ['Other Serif'] }),
  ];
  const base = map(...faces('b1'), rule('.title', 't', { used: true, refs: ['Other Serif'] }));
  const head = map(...faces('b2'), rule('.title', 't', { used: true, refs: ['Other Serif'] }));
  const unused = statusOf(classifyRuleReach([base], [head]), '@font-face');
  assert.deepEqual([unused.status, unused.why], ['never-rendered', 'no rendered rule references it']);

  const brandBase = map(...faces('b1'), rule('.brand', 'r', { used: true, refs: ['Brand Sans'] }));
  const brandHead = map(...faces('b2'), rule('.brand', 'r', { used: true, refs: ['Brand Sans'] }));
  assert.equal(statusOf(classifyRuleReach([brandBase], [brandHead]), '@font-face').status, 'blind-channel');

  const second = (hash) =>
    map(
      rule('@font-face', 'b', { refs: ['Brand Sans'] }),
      rule('@font-face #2', hash, { refs: ['Other Serif'] }),
      rule('.title', 't', { used: true, refs: ['Other Serif'] }),
    );
  assert.deepEqual(statusOf(classifyRuleReach([second('o1')], [second('o2')]), '@font-face #2'), {
    key: '@font-face #2',
    change: 'changed',
    status: 'blind-channel',
    why: 'referenced by .title, which rendered',
    sheet: '/app.css',
  });
  const pulses = (hash) =>
    map(
      rule('@keyframes pulse', 'k'),
      rule('@keyframes pulse #2', hash),
      rule('.badge', 'b', { used: true, refs: ['pulse'] }),
    );
  assert.equal(
    statusOf(classifyRuleReach([pulses('p1')], [pulses('p2')]), '@keyframes pulse #2').status,
    'blind-channel',
  );
});

test('the same maps in any order give the same result', () => {
  const side = (sheet, referrer, consumer, k, r, warn) => ({
    ...map(),
    reach: {
      sheets: [sheet],
      rules: [
        rule('@keyframes pulse', k),
        rule(referrer, 'ref', { used: true, refs: ['pulse'] }),
        rule(':root', r, { used: true, vars: { '--warn': warn } }),
        rule(consumer, 'c', { uses: ['--warn'] }),
      ],
    },
  });
  const base = [side('/b.css', '.b', '.y', 'k1', 'r1', 'g'), side('/a.css', '.a', '.x', 'k1', 'r1', 'g')];
  const head = [side('/b.css', '.b', '.y', 'k2', 'r2', 'a'), side('/a.css', '.a', '.x', 'k2', 'r2', 'a')];
  const forward = classifyRuleReach(base, head);
  assert.deepEqual(classifyRuleReach([...base].reverse(), [...head].reverse()), forward);
  assert.deepEqual(statusOf(forward, '@keyframes pulse'), {
    key: '@keyframes pulse',
    change: 'changed',
    status: 'blind-channel',
    why: 'referenced by .a, which rendered',
    sheet: '/a.css',
  });
  assert.equal(statusOf(forward, ':root').why, '--warn changed, and its consumer .x never matched');
  assert.equal(statusOf(forward, ':root').sheet, '/a.css');

  // Multiple bodies for one key choose the same result and sheet regardless of route order.
  const split = (hash, sheet, used) => ({
    ...map(),
    reach: { sheets: [sheet], rules: [rule('.split', hash, used ? { used: true } : {})] },
  });
  for (const used of [true, false]) {
    const variants = [split('B', '/b.css', used), split('A', '/a.css', used)];
    const result = classifyRuleReach([map()], variants);
    assert.deepEqual(classifyRuleReach([map()], [...variants].reverse()), result);
    assert.equal(statusOf(result, '.split').sheet, '/a.css');
    assert.deepEqual(classifyRuleReach(variants, [map()]), classifyRuleReach([...variants].reverse(), [map()]));
  }
});
