import { test, expect } from '@playwright/test';
import { captureStyleMap } from '../dist/capture.js';
import { classifyClassReach, combineClassReach } from '../dist/class-join.js';
import { changedScriptRanges } from '../dist/script-join-git.js';

for (const scenario of ['control', 'ticker', 'ignore', 'shadow', 'frame'])
  test(`real capture class-preserving refactor stays unknown with ${scenario}`, async ({ page }) => {
    const before = "document.querySelector('time').className = 'clock';";
    const after = "const CLS = 'clock'; document.querySelector('time').className = CLS;";
    const maps = [];
    for (const source of [before, after]) {
      await page.goto('about:blank');
      await page.setContent(`<style>.clock{color:red}</style><body><section class="ad"><time>0</time></section>
        <script>${source}
        ${scenario === 'ticker' ? "let n=0; setInterval(() => { document.querySelector('time').textContent = ++n; }, 80);" : ''}
        ${scenario === 'shadow' ? "document.querySelector('section').attachShadow({mode:'open'}).innerHTML='<time class=clock>0</time>';" : ''}
        </script>${scenario === 'frame' ? '<iframe srcdoc="<time class=clock>0</time>"></iframe>' : ''}</body>`);
      const map = await captureStyleMap(page, {
        captureReach: true,
        captureStates: false,
        ...(scenario === 'ignore' ? { ignore: ['.ad'] } : {}),
        stabilize: scenario === 'ticker' ? { interval: 25, quietFor: 200, timeout: 650 } : false,
      });
      if (scenario === 'control')
        expect(map.classPresence).toEqual({ version: 1, ignored: false, shadowHosts: 0, frames: 0 });
      if (scenario === 'ticker') {
        expect(map.volatile?.length).toBeGreaterThan(0);
        expect(Object.values(map.elements).some((entry) => entry.tag === 'time')).toBe(false);
      }
      if (scenario === 'ignore') {
        expect(map.classPresence?.ignored).toBe(true);
        expect(Object.values(map.elements).some((entry) => entry.tag === 'time')).toBe(false);
      }
      if (scenario === 'shadow') expect(map.classPresence?.shadowHosts).toBe(1);
      if (scenario === 'frame') expect(map.classPresence?.frames).toBe(1);
      maps.push(map);
    }
    const changes = changedScriptRanges(
      `@@ -1 +1 @@\n-${before}\n+${after}\n`,
      { base: before, head: after },
      'app.js',
    );
    const result = classifyClassReach([maps[0]], [maps[1]], changes, [{ base: maps[0], head: maps[1] }]);
    expect(result.units).toHaveLength(2);
    expect(result.units.every((unit) => unit.status === 'unknown')).toBe(true);
    const scripts = changes.map(({ sourceKey, side, range }) => ({
      sourceKey,
      side,
      range,
      execution: 'ran' as const,
      status: 'unknown' as const,
      why: 'ran; rendering unproved',
      level: 'warn' as const,
    }));
    expect(combineClassReach(scripts, result.units).every((unit) => unit.status === 'unknown')).toBe(true);
  });
