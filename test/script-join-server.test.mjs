import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sha256 } from '../dist/node-util.js';
import { classifyScriptReach } from '../dist/script-join.js';

// A server template with a branch that the requested page never renders.
const template = 'export const render = (show) => show ? "<aside>Offer</aside>" : "<main>Home</main>";';
const range = { start: { line: 1, column: 38 }, end: { line: 1, column: 58 } };
const change = {
  sourceKey: 'server/page.ts',
  side: 'head',
  range,
  contentHash: sha256(template),
  text: template,
};
const renderingProof = [{ join: 'J1', status: 'reached', sourceKey: change.sourceKey, side: 'head', range }];

for (const status of ['measured', 'unsupported']) {
  test(`server template without server execution evidence stays unmeasured (${status})`, () => {
    // A non-Node server supplies no V8 evidence, even if browser coverage works.
    const captures = [{ scriptReach: { version: 1, window: 'navigation', status, scripts: [] } }];
    const { units } = classifyScriptReach(captures, captures, [change], renderingProof);
    assert.equal(units.length, 1);
    assert.equal(units[0].status, 'unmeasured');
    assert.notEqual(units[0].execution, 'ran');
  });
}
