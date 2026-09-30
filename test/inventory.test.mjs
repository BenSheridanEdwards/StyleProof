import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  unionInventory,
  diffInventory,
  auditRemovals,
  auditRunInventory,
  classifyInventory,
} from '../dist/inventory.js';

// The exact scenario StyleProof is blind to today, modelled from a dashboard HUD:
// the live nav offers agents / model-config / faults / fault-map / skills
// / groups; the "agents v5" redesign offers agents / teams / faults / skills / groups
// — silently dropping MODEL CONFIG and FAULT MAP (features stop being reachable),
// while the certification diff reports the *existing* surfaces unchanged → clean.
const navButtons = (labels) =>
  labels.map((l) => ({ key: `nav-button:${l}`, kind: 'nav-button', label: l.toUpperCase() }));

const BASE = navButtons(['agents', 'model-config', 'faults', 'fault-map', 'skills', 'groups']);
const HEAD = navButtons(['agents', 'teams', 'faults', 'skills', 'groups']);

test('inventory diff: a dropped nav item surfaces as removed, a new one as added', () => {
  const delta = diffInventory(BASE, HEAD);
  assert.deepEqual(
    delta.removed.map((i) => i.key),
    ['nav-button:model-config', 'nav-button:fault-map'],
  );
  assert.deepEqual(
    delta.added.map((i) => i.key),
    ['nav-button:teams'],
  );
});

test('the guard FAILS on an unacknowledged feature removal (green would have shipped it)', () => {
  const delta = diffInventory(BASE, HEAD);
  const { unexplained } = auditRemovals(delta, {});
  assert.equal(unexplained.length, 2, 'model-config + fault-map are unexplained removals');
  assert.ok(unexplained.some((i) => i.key === 'nav-button:model-config'));
});

test('an explicit, reasoned acknowledgement clears the removal (a decision on the record)', () => {
  const delta = diffInventory(BASE, HEAD);
  const { unexplained, staleAllowances } = auditRemovals(delta, {
    'nav-button:model-config': 'moved into the per-agent dossier — intentional',
    'nav-button:fault-map': 'folded into faults — intentional',
  });
  assert.equal(unexplained.length, 0);
  assert.equal(staleAllowances.length, 0);
});

test('a stale acknowledgement (for a key that is no longer removed) is flagged — the ledger cannot rot', () => {
  const delta = diffInventory(BASE, HEAD);
  const { staleAllowances } = auditRemovals(delta, {
    'nav-button:model-config': 'ok',
    'nav-button:skills': 'skills was never removed — this entry is stale',
  });
  assert.deepEqual(staleAllowances, ['nav-button:skills']);
});

test('parallel-route staging: capturing the new route ALSO makes it visible before cutover', () => {
  // agents-v5 lives at /agents-v5. If it is captured (a surface exists for it), its
  // route link enters the head inventory — so even before the cutover, the new
  // destination is on the record, and a reviewer sees the redesign exists.
  const base = [...BASE];
  const head = [...HEAD, { key: 'route:/agents-v5', kind: 'link', label: 'Agents v5', href: '/agents-v5' }];
  const delta = diffInventory(base, head);
  assert.ok(delta.added.some((i) => i.key === 'route:/agents-v5'));
  // model-config is still a removal — the guard still gates it.
  assert.ok(auditRemovals(delta, {}).unexplained.some((i) => i.key === 'nav-button:model-config'));
});

test('unionInventory reduces a run of per-surface maps to one reachable set (deduped)', () => {
  const maps = [
    { inventory: navButtons(['agents', 'faults']) },
    { inventory: navButtons(['faults', 'skills']) }, // faults repeats across surfaces
    undefined, // a map with no inventory harvested
  ];
  assert.deepEqual(
    unionInventory(maps).map((i) => i.key),
    ['nav-button:agents', 'nav-button:faults', 'nav-button:skills'],
  );
});

// #754: an affordance without a stable id is keyed by its label, so it shares that key
// with every same-labelled affordance in the run. A new id-less tab whose label another
// surface (or another strip on the same surface) already offered vanished into the
// run-wide union, and the audit claimed "navigable set unchanged".
const raw = (name, role = 'tab') => ({
  tag: 'button',
  role,
  name,
  internalPath: null,
  testId: null,
  domId: null,
  controls: null,
});
const surfaceInventory = (surface, names, role) => ({
  surface,
  inventory: classifyInventory(names.map((n) => raw(n, role))),
});

test('#754: an id-less tab added to one surface is added even when another surface offers the label', () => {
  const settings = surfaceInventory('settings@1280', ['Overview', 'Activity']);
  const base = [settings, surfaceInventory('account@1280', ['Overview'])];
  const head = [settings, surfaceInventory('account@1280', ['Overview', 'Activity'])];
  const { delta } = auditRunInventory(base, head);
  assert.deepEqual(
    delta.added.map((i) => i.key),
    ['tab:activity'],
  );
  assert.deepEqual(delta.removed, []);
});

test('#754: a second same-labelled id-less nav button on the same surface is added', () => {
  const base = [surfaceInventory('account@1280', ['Activity'], '')];
  const head = [surfaceInventory('account@1280', ['Activity', 'Activity'], '')];
  assert.deepEqual(
    auditRunInventory(base, head).delta.added.map((i) => i.key),
    ['nav-button:activity'],
  );
});

test('#754: a pure reorder of id-less tabs is neither an addition nor a removal', () => {
  const base = [surfaceInventory('account@1280', ['Alpha', 'Beta', 'Beta', 'Gamma'])];
  const head = [surfaceInventory('account@1280', ['Gamma', 'Beta', 'Alpha', 'Beta'])];
  assert.deepEqual(auditRunInventory(base, head).delta, { added: [], removed: [] });
});

test('#754: maps without a surface identity keep the run-wide union comparison', () => {
  const tabs = (names) => ({ inventory: classifyInventory(names.map((n) => raw(n))) });
  const base = [tabs(['Activity']), tabs([])];
  const head = [tabs(['Activity']), tabs(['Activity'])];
  assert.deepEqual(auditRunInventory(base, head).delta, { added: [], removed: [] });
});
