import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyInventory, isStableId, diffInventory } from '../dist/inventory.js';

// Target-based keying: a tab/menuitem/nav-button keys by a stable, developer-authored
// identity (data-testid, else a non-generated id / aria-controls) when it exposes one,
// so a wobble in the LABEL (a live count badge, a re-label) doesn't move the key and
// fake a removed+added. A raw affordance as the in-page harvest produces it; only the
// fields a case exercises need meaningful values.
const aff = (o) => ({
  tag: 'button',
  role: '',
  name: '',
  internalPath: null,
  testId: null,
  domId: null,
  controls: null,
  ...o,
});

test('a nav button keys by its data-testid, so a count-badge label change does NOT churn', () => {
  // The #414 command-rail case: "COMMAND 5" → "COMMAND 3" as the live count ticks.
  const base = classifyInventory([aff({ name: 'COMMAND 5', testId: 'command' })]);
  const head = classifyInventory([aff({ name: 'COMMAND 3', testId: 'command' })]);
  assert.deepEqual(
    base.map((i) => i.key),
    ['nav-button:#command'],
  );
  const delta = diffInventory(base, head);
  assert.equal(delta.removed.length, 0, 'the badge count changed, not the item — no removal');
  assert.equal(delta.added.length, 0);
  assert.equal(head[0].label, 'COMMAND 3', 'the human label still tracks the live text');
});

test('without a stable id, a label wobble DOES churn — the fallback surfaces it, never hides it', () => {
  const base = classifyInventory([aff({ name: 'COMMAND 5' })]);
  const head = classifyInventory([aff({ name: 'COMMAND 3' })]);
  assert.deepEqual(
    base.map((i) => i.key),
    ['nav-button:command-5'],
  );
  const delta = diffInventory(base, head);
  assert.equal(delta.removed.length, 1, 'safe direction: a false removal is SURFACED (a red), not hidden');
  assert.equal(delta.added.length, 1);
});

test('a non-generated id / aria-controls is used; a framework-generated one is ignored', () => {
  // Authored id on a button → keyed by it.
  assert.deepEqual(
    classifyInventory([aff({ name: 'Faults', domId: 'nav-faults' })]).map((i) => i.key),
    ['nav-button:#nav-faults'],
  );
  // A tab keyed by the panel it controls.
  assert.deepEqual(
    classifyInventory([aff({ tag: 'div', role: 'tab', name: 'Faults', controls: 'panel-faults' })]).map((i) => i.key),
    ['tab:#panel-faults'],
  );
  // React useId / Headless UI generated ids wobble across renders → ignored, so the key
  // falls back to the label slug (no WORSE than before; never keyed on churn).
  assert.deepEqual(
    classifyInventory([aff({ name: 'Faults', domId: ':r7:' })]).map((i) => i.key),
    ['nav-button:faults'],
  );
  assert.deepEqual(
    classifyInventory([aff({ name: 'Faults', domId: 'headlessui-tabs-tab-3' })]).map((i) => i.key),
    ['nav-button:faults'],
  );
});

test('distinct identities stay distinct — a real removal is still caught when ids are used', () => {
  const base = classifyInventory([
    aff({ name: 'Faults', testId: 'faults' }),
    aff({ name: 'Model Config', testId: 'model-config' }),
  ]);
  const head = classifyInventory([aff({ name: 'Faults', testId: 'faults' })]);
  const delta = diffInventory(base, head);
  assert.deepEqual(
    delta.removed.map((i) => i.key),
    ['nav-button:#model-config'],
    'dropping Model Config is still a gated removal',
  );
});

test('data-testid is trusted verbatim even when it would look generated as an id', () => {
  // data-testid is developer-authored by definition, so it bypasses the generated-id
  // filter that would (safely) reject the same string as an `id`.
  assert.deepEqual(
    classifyInventory([aff({ name: 'X', testId: 'abcdef12' })]).map((i) => i.key),
    ['nav-button:#abcdef12'],
  );
});

test('isStableId: authored ids pass, framework-generated ids fail', () => {
  for (const ok of ['command', 'nav-faults', 'panel_1', 'main-nav'])
    assert.ok(isStableId(ok), `${ok} should be a stable id`);
  for (const bad of [null, undefined, '', ':r0:', 'radix-:r1:', 'headlessui-tabs-tab-3', 'a1b2c3d4e5', 'mui-42'])
    assert.ok(!isStableId(bad), `${bad} should be rejected as generated/empty`);
});
