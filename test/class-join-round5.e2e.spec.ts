import { test, expect } from '@playwright/test';
import { transform } from 'esbuild';
import { captureStyleMap } from '../dist/capture.js';
import { classifyClassReach, combineClassReach } from '../dist/class-join.js';
import { changedScriptRanges } from '../dist/script-join-git.js';

for (const [name, before, after, positive] of [
  ['tag to call', "cn('card', t`open`)", "cn('card', t('open'))", false],
  ['in to hasOwn', "cn('card', 'open' in flags && 'tab')", "cn('card', Object.hasOwn(flags,'open') && 'tab')", false],
  ['tagged CSS', "cn('card', css`old`)", "cn('card', css`new`)", false],
  ['optional call', "cn('card', fn?.('old'))", "cn('card', fn?.('new'))", false],
  ['non-null call', "cn('card', fn!('old'))", "cn('card', fn!('new'))", false],
  ['generic call', "cn('card', fn<string>('old'))", "cn('card', fn<string>('new'))", false],
  [
    'comments',
    "cn('card', state === /* enum */ 'active' && 'tab')",
    "cn('card', state === /* enum */ 'selected' && 'tab')",
    false,
  ],
  ['optional lookup', "cn('card', styles?.['active'])", "cn('card', styles?.['selected'])", false],
  [
    'cast lookup',
    "cn('card', ({old:'tab'} as Record<string,string>)[key])",
    "cn('card', ({new:'tab'} as Record<string,string>)[key])",
    false,
  ],
  [
    'satisfies lookup',
    "cn('card', ({old:'tab'} satisfies Record<string,string>)[key])",
    "cn('card', ({new:'tab'} satisfies Record<string,string>)[key])",
    false,
  ],
  ['relational', "cn('card', state >= 'old' && 'tab')", "cn('card', state >= 'new' && 'tab')", false],
  ['arrow body', "cn('card', s => 'old')", "cn('card', s => 'new')", false],
  ['false and control', "cn('card', false && 'old')", "cn('card', false && 'new')", true],
  ['ternary control', "cn('card', on ? 'old' : 'tab')", "cn('card', on ? 'new' : 'tab')", true],
  ['helper key control', "cn('card', {old:on})", "cn('card', {new:on})", true],
])
  test(`real Chromium allow-list ${name}`, async ({ page }) => {
    const setup =
      "const cn=(...xs)=>xs.flatMap(x=>typeof x==='string'?[x]:x&&typeof x==='object'?Object.keys(x).filter(k=>x[k]):[]).join(' '); const t=()=>''; const css=()=>'tab'; const fn=(...args)=>'tab'; const styles={active:'tab',selected:'tab'}; const flags={open:true}; const on=false;";
    const base =
      setup + `const state='${name === 'comments' ? 'active' : 'zzzz'}',key='old'; document.body.className=${before};`;
    const head =
      setup + `const state='${name === 'comments' ? 'selected' : 'zzzz'}',key='new'; document.body.className=${after};`;
    const maps = [];
    for (const source of [base, head]) {
      const bundle = await transform(source, { loader: 'tsx' });
      await page.goto('about:blank');
      await page.setContent(
        `<style>.old,.new,.open,.active,.selected{color:red}.card,.tab{color:black}</style><body><script>${bundle.code}</script></body>`,
      );
      maps.push(await captureStyleMap(page, { captureReach: true, captureStates: false, stabilize: false }));
    }
    expect(maps[0].elements.body.cls).toEqual(maps[1].elements.body.cls);
    const changes = changedScriptRanges(`@@ -1 +1 @@\n-${base}\n+${head}\n`, { base, head }, 'app.tsx');
    const result = classifyClassReach([maps[0]], [maps[1]], changes, [{ base: maps[0], head: maps[1] }]);
    const j2 = changes.map(({ sourceKey, side, range }) => ({
      sourceKey,
      side,
      range,
      execution: 'ran' as const,
      status: 'reached' as const,
      why: 'executed',
      level: 'warn' as const,
    }));
    if (positive) expect(result.units.some((u) => u.explicit && u.status === 'never-rendered')).toBe(true);
    else expect(result.units.every((u) => !u.explicit || u.status !== 'never-rendered')).toBe(true);
    expect(
      combineClassReach(j2, result.units).every((u) => u.status === (positive ? 'never-rendered' : 'reached')),
    ).toBe(true);
  });
