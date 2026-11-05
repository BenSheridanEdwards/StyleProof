import assert from 'node:assert/strict';
import { test } from 'node:test';
import { transform } from 'esbuild';
import { classifyScriptReach } from '../dist/script-join.js';
import { changedScriptRanges } from '../dist/script-join-git.js';
import { scriptTokens } from '../dist/script-join-tokens.js';
import { mapScriptCoverage } from '../dist/script-reach.js';
import { compactScriptEvidence } from '../dist/script-reach-storage.js';
import { tokenCases, tokenDefines } from './script-join-round8-fixture.mjs';
import { patches } from './script-join-round6-fixture.mjs';

for (const scenario of tokenCases.filter((entry) => entry.template)) {
  for (const minify of [false, true]) {
    test(`${scenario.name} cannot borrow the template head with minify=${minify}`, async () => {
      const maps = [];
      for (const [text, word] of [
        [scenario.before, scenario.from],
        [scenario.after, scenario.to],
      ]) {
        const bundle = await transform(text, {
          minify,
          define: tokenDefines,
          sourcemap: 'external',
          sourcefile: 'app.tsx',
        });
        const literal = JSON.stringify(word),
          start = bundle.code.indexOf(literal);
        assert.equal(
          start < 0,
          minify || scenario.foldedAlways,
          'the changed literal survives only in the unminified conditional branches',
        );
        const ranges = [{ startOffset: 0, endOffset: bundle.code.length, count: 1 }];
        if (start >= 0) ranges.push({ startOffset: start, endOffset: start + literal.length, count: 0 });
        const files = mapScriptCoverage(
          { functions: [{ ranges }] },
          bundle.code,
          JSON.parse(bundle.map),
          'https://template.test/app.js.map',
        );
        maps.push({
          scriptReach: {
            version: 1,
            window: 'navigation',
            status: 'measured',
            scripts: [compactScriptEvidence({ url: '/app.js', status: 'mapped', files })],
          },
        });
      }
      const changes = changedScriptRanges(
        patches(scenario.before, scenario.after),
        { base: scenario.before, head: scenario.after },
        'app.tsx',
      );
      const result = classifyScriptReach([maps[0]], [maps[1]], changes);
      assert.deepEqual(result.gaps, []);
      assert.equal(result.units.length, 2);
      if (minify || scenario.foldedAlways)
        assert.ok(result.units.every((unit) => unit.execution === 'unmeasured' && unit.status === 'unmeasured'));
      else
        assert.ok(
          result.units.every(
            (unit) => ['never-ran', 'partly-ran'].includes(unit.execution) && unit.status === 'never-rendered',
          ),
        );
    });
  }
}

for (const minify of [false, true]) {
  test(`a live template substitution keeps its own execution start with minify=${minify}`, async () => {
    const before = 'window.result = `btn ${window.input ?? "red"}`;',
      after = before.replace('"red"', '"orange"');
    const maps = [];
    for (const text of [before, after]) {
      const bundle = await transform(text, { minify, sourcemap: 'external', sourcefile: 'app.tsx' });
      const files = mapScriptCoverage(
        { functions: [{ ranges: [{ startOffset: 0, endOffset: bundle.code.length, count: 1 }] }] },
        bundle.code,
        JSON.parse(bundle.map),
        'https://template.test/app.js.map',
      );
      maps.push({
        scriptReach: {
          version: 1,
          window: 'navigation',
          status: 'measured',
          scripts: [compactScriptEvidence({ url: '/app.js', status: 'mapped', files })],
        },
      });
    }
    const result = classifyScriptReach(
      [maps[0]],
      [maps[1]],
      changedScriptRanges(patches(before, after), { base: before, head: after }, 'app.tsx'),
    );
    assert.equal(result.units.length, 2);
    assert.ok(result.units.every((unit) => unit.execution === 'ran' && unit.status === 'unknown'));
  });
}

for (const [source, expected] of [
  ['`btn ${flag ? "red" : "blue"} tail`', ['`btn ${', 'flag', '"red"', '"blue"']],
  ['`a${one} middle ${two} tail`', ['`a${', 'one', 'two']],
  ['`a${{ key: "red" }.key} tail`', ['`a${', 'key', '"red"', 'key']],
  ['`a${`b${flag ? "red" : "blue"}`} tail`', ['`a${', '`b${', 'flag', '"red"', '"blue"']],
  ['`a${/}/.test("}") ? "red" : "blue"} tail`', ['`a${', '/}/', 'test', '"}"', '"red"', '"blue"']],
  ['`a${/* } */ flag ? "red" : "blue"} tail`', ['`a${', 'flag', '"red"', '"blue"']],
  ['`a\n${flag ? "red" : "blue"}\ntail`', ['`a\n${', 'flag', '"red"', '"blue"']],
  ['`plain text`', ['`plain text`']],
  ['`escaped \\${plain}`', ['`escaped \\${plain}`']],
]) {
  test(`template lexical pieces preserve expression starts in ${JSON.stringify(source)}`, () => {
    assert.deepEqual(
      scriptTokens(source).map((token) => source.slice(token.index, token.end)),
      expected,
    );
  });
}
