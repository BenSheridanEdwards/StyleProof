import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { generateStructuralStyleMapReportForTesting as generateReport } from '../dist/report.js';
import { makeMap, mkTmp, rmTmp, solidPng, writeCapture } from './helpers.mjs';

// Regression for the state-attribution bug (#1299's reproduction): three form controls in one
// area, each changed in its own forced state, and one state that restyles another element.
const checkbox = 'body > input:nth-child(1)';
const label = 'body > label:nth-child(2)';
const nickname = 'body > input:nth-child(3)';
const save = 'body > button:nth-child(4)';

/**
 * "Show the CSS" renders each owner's state changes as main does: a block headed by the owner's
 * selector, then its `| :state | prop |` rows. The rows under the block for `selector`, as "state prop".
 */
function ownerRows(section, selector) {
  const out = [];
  let inBlock = false;
  for (const line of section.split('\n')) {
    const head = /^\*\*(?:[^*]+\*\* )?`([^`]+)`(?:\*\*)?(?: ×\d+)?$/.exec(line);
    if (head) inBlock = head[1] === selector;
    const row = /^\| `:([\w-]+)` \| `([\w-]+)` \|/.exec(line);
    if (row && inBlock) out.push(`${row[1]} ${row[2]}`);
  }
  return out;
}

function fixture(t, screenshots = true, hidden = false) {
  const root = mkTmp('styleproof-state-sections-');
  t.after(() => rmTmp(root));
  const beforeDir = path.join(root, 'before');
  const afterDir = path.join(root, 'after');
  for (const dir of [beforeDir, afterDir]) {
    const color = dir === beforeDir ? 'rgb(20, 120, 60)' : 'rgb(160, 40, 40)';
    const map = makeMap({
      elements: {
        [checkbox]: { tag: 'input', cls: 'offers-check', rect: [20, 20, 20, 20] },
        [label]: { tag: 'label', cls: 'offers-label', rect: [40, 20, 100, 20] },
        [nickname]: { tag: 'input', cls: 'nickname', rect: [20, 45, 120, 25] },
        [save]: { tag: 'button', cls: 'save', rect: [20, 75, 100, 25] },
      },
      states: {
        [checkbox]: { checked: { [label]: { color } } },
        [nickname]: { 'placeholder-shown': { [nickname]: { 'border-color': color } } },
        [save]: { disabled: { [save]: { 'background-color': color } } },
      },
    });
    if (hidden) for (const entry of Object.values(map.elements)) entry.rect = [0, 0, 0, 0];
    writeCapture(dir, 'form@390', map, screenshots ? solidPng(390, 180) : undefined);
    if (screenshots) {
      for (const state of ['checked', 'disabled', 'placeholder-shown']) {
        fs.writeFileSync(
          path.join(dir, `form@390.${state}.png`),
          solidPng(390, 180, dir === beforeDir ? [20, 120, 60] : [160, 40, 40]),
        );
      }
    }
  }
  const result = generateReport({ beforeDir, afterDir, outDir: path.join(root, 'report') });
  return {
    md: fs.readFileSync(result.reportMdPath, 'utf8'),
    json: JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8')),
  };
}

const sectionsOf = (md) =>
  Object.fromEntries(
    md
      .split(/^### /m)
      .slice(1)
      .map((section) => [section.split('\n')[0], section]),
  );

for (const [screenshots, hidden] of [
  [true, false],
  [false, false],
  [false, true],
]) {
  test(`each control gets its own change section named after the element that changed, screenshots=${screenshots}, hidden=${hidden}`, (t) => {
    const { md } = fixture(t, screenshots, hidden);
    const sections = sectionsOf(md);
    assert.deepEqual(
      Object.keys(sections),
      ['Offers label', 'Nickname', 'Save'],
      'page order, one per changed element',
    );
    // The CSS names the control under its own block, as the capture records (#1299).
    assert.match(sections['Offers label'], /^`label\.offers-label` · 1 element restyled$/m);
    assert.deepEqual(ownerRows(sections['Offers label'], 'input.offers-check'), ['checked color']);
    assert.match(sections.Nickname, /`input\.nickname` · 1 element restyled/);
    assert.match(sections.Save, /`button\.save` · 1 element restyled/);
    assert.doesNotMatch(sections.Nickname, /:checked|:disabled/, 'no other state leaks into the field');
    assert.doesNotMatch(sections.Save, /:checked|placeholder/, 'no other state leaks into the button');
  });
}

test('a state that restyles another element names that element and the control driving it', (t) => {
  const { md, json } = fixture(t);
  const sections = sectionsOf(md);
  const offers = sections['Offers label'];
  assert.match(offers, /^On the offers label, the text colour changes from .+ when the offers check is checked\./m);
  assert.match(offers, /\*\*While checked\*\*/);
  assert.doesNotMatch(offers, /While disabled|While showing its placeholder/);
  // The row sits under the control that produced it, as the capture records (main's per-owner block).
  assert.deepEqual(
    ownerRows(offers, 'input.offers-check'),
    ['checked color'],
    "the CSS row is the label colour under the checkbox's :checked",
  );
  assert.match(sections.Save, /\*\*While disabled\*\*/);
  assert.match(sections.Nickname, /\*\*While showing its placeholder\*\*/);
  // The Where map boxes the label that changed, never the checkbox that drives it.
  const region = json.surfaces[0].regions.find((r) => r.paths.includes(label));
  assert.deepEqual(region.paths, [label]);
  assert.deepEqual(
    region.where.flatMap((map) => map.boxes),
    [[40, 20, 100, 20]],
  );
});

test('a list of checkboxes restyling their labels still names the driving control (RV2-01)', (t) => {
  const root = mkTmp('styleproof-state-drivers-');
  t.after(() => rmTmp(root));
  const [c1, l1, c2, l2] = [1, 2, 3, 4].map((n) => `body > ${n % 2 ? 'input' : 'label'}:nth-child(${n})`);
  const dirs = ['before', 'after'].map((side) => path.join(root, side));
  for (const dir of dirs) {
    const color = dir === dirs[0] ? 'rgb(20, 120, 60)' : 'rgb(160, 40, 40)';
    const map = makeMap({
      elements: {
        [c1]: { tag: 'input', cls: 'opt', rect: [20, 20, 20, 20] },
        [l1]: { tag: 'label', cls: 'opt-label', rect: [40, 20, 100, 20] },
        [c2]: { tag: 'input', cls: 'opt', rect: [20, 60, 20, 20] },
        [l2]: { tag: 'label', cls: 'opt-label', rect: [40, 60, 100, 20] },
      },
      states: { [c1]: { checked: { [l1]: { color } } }, [c2]: { checked: { [l2]: { color } } } },
    });
    writeCapture(dir, 'form@390', map, solidPng(390, 180));
    fs.writeFileSync(path.join(dir, 'form@390.checked.png'), solidPng(390, 180));
  }
  const result = generateReport({ beforeDir: dirs[0], afterDir: dirs[1], outDir: path.join(root, 'report') });
  const labels = sectionsOf(fs.readFileSync(result.reportMdPath, 'utf8'))['Opt labels'];
  assert.match(labels, /^On both opt labels, the text colour changes from .+ when the matching opt is checked\./m);
  assert.deepEqual(ownerRows(labels, 'input.opt'), ['checked color']);
});

test("an element's own hover and another control's checked each name their own driver (RV11-01)", (t) => {
  const root = mkTmp('styleproof-state-own-driven-');
  t.after(() => rmTmp(root));
  const [box, label] = ['body > input:nth-child(1)', 'body > label:nth-child(2)'];
  const dirs = ['before', 'after'].map((side) => path.join(root, side));
  for (const dir of dirs) {
    const before = dir === dirs[0];
    const map = makeMap({
      elements: {
        [box]: { tag: 'input', cls: 'opt', rect: [20, 20, 20, 20] },
        [label]: { tag: 'label', cls: 'opt-label', text: 'Send offers', rect: [40, 20, 100, 20] },
      },
      states: {
        // The label's own hover, and the checkbox's checked state restyling the label.
        [label]: { hover: { [label]: { 'background-color': before ? 'rgb(255, 255, 255)' : 'rgb(40, 40, 120)' } } },
        [box]: { checked: { [label]: { color: before ? 'rgb(20, 120, 60)' : 'rgb(160, 40, 40)' } } },
      },
    });
    writeCapture(dir, 'form@390', map, solidPng(390, 180));
    for (const state of ['hover', 'checked'])
      fs.writeFileSync(
        path.join(dir, `form@390.${state}.png`),
        solidPng(390, 180, before ? [20, 120, 60] : [160, 40, 40]),
      );
  }
  const result = generateReport({ beforeDir: dirs[0], afterDir: dirs[1], outDir: path.join(root, 'report') });
  const section = sectionsOf(fs.readFileSync(result.reportMdPath, 'utf8'))['Opt label'];
  assert.ok(section, 'one section for the label');
  // The hover is the label's own; only the checked state is the checkbox's.
  assert.match(section, /background changes from white to dark indigo when hovered/);
  assert.match(section, /text colour changes from green to red when the opt is checked/);
  assert.doesNotMatch(section, /when the opt is hovered/);
  // Each owner's block holds only its own change: the label's hover, the checkbox's checked.
  assert.deepEqual(ownerRows(section, 'input.opt'), ['checked color']);
  assert.deepEqual(ownerRows(section, 'label.opt-label'), ['hover background-color']);
  assert.match(section, /\*\*While hovered\*\*/);
  assert.match(section, /\*\*While checked\*\*/);
});

test('a state layer captured on one side only gets a plain line, not an unnamed element (RV2-05)', (t) => {
  const root = mkTmp('styleproof-state-layer-');
  t.after(() => rmTmp(root));
  const dirs = ['before', 'after'].map((side) => path.join(root, side));
  for (const dir of dirs) {
    const map = makeMap({ elements: { 'body > h1': { tag: 'h1', cls: 'title', rect: [20, 20, 300, 60] } } });
    map.stateLayers = dir === dirs[0] ? ['hover', 'focus', 'active'] : ['hover', 'focus', 'active', 'checked'];
    writeCapture(dir, 'home@1280', map, solidPng(1280, 400));
  }
  const result = generateReport({ beforeDir: dirs[0], afterDir: dirs[1], outDir: path.join(root, 'report') });
  const md = fs.readFileSync(result.reportMdPath, 'utf8');
  const sections = sectionsOf(md);
  assert.equal(sections.Element, undefined, 'no unnamed "Element" section');
  const layer = sections['Interaction states not compared'];
  assert.ok(layer, Object.keys(sections).join(', '));
  assert.match(layer, /^The forced `:checked` state was captured on head only, so it was not compared\./m);
  assert.match(md, /\*\*1 change to review\*\* on `home` at 1280px wide\./, 'no element is counted for it');
  // QA3-04: the fold uses the same words and counts no element either.
  const shown = layer.replace(/<!-- styleproof-[^\n]*-->/g, '');
  assert.doesNotMatch(shown, /\(surface\)|element restyled|Interactive-state changes|forced-state capture/);
  const html = fs.readFileSync(path.join(root, 'report', 'report.html'), 'utf8');
  assert.doesNotMatch(html, /\(surface\)|Element paths/, 'report.html lists no pseudo element path');
  assert.match(layer, /^Forced-state layers captured on one side only$/m);
  assert.match(layer, /^\| `:checked` \| not captured \| captured \|$/m);
});

for (const [added, expected] of [
  [true, /^On the Docs link, the text colour changes from `#a5f3fc` to `#fca5a5` when hovered\./m],
  [false, /^On the Docs link, the text colour changes from `#fca5a5` to `#a5f3fc` when hovered\./m],
]) {
  test(`a hover style ${added ? 'added' : 'removed'} states the resting value, never "none" (RV2-06)`, (t) => {
    const root = mkTmp('styleproof-state-none-');
    t.after(() => rmTmp(root));
    const link = 'body > a';
    const dirs = ['before', 'after'].map((side) => path.join(root, side));
    for (const dir of dirs) {
      const hovered = (dir === dirs[1]) === added;
      const map = makeMap({
        elements: {
          [link]: {
            tag: 'a',
            cls: 'docs-link',
            text: 'Docs',
            rect: [20, 20, 80, 20],
            style: { color: 'rgb(165, 243, 252)' },
          },
        },
        states: hovered ? { [link]: { hover: { [link]: { color: 'rgb(252, 165, 165)' } } } } : {},
      });
      writeCapture(dir, 'docs@1280', map, solidPng(1280, 300));
      fs.writeFileSync(path.join(dir, 'docs@1280.hover.png'), solidPng(1280, 300));
    }
    const result = generateReport({ beforeDir: dirs[0], afterDir: dirs[1], outDir: path.join(root, 'report') });
    const md = fs.readFileSync(result.reportMdPath, 'utf8');
    assert.match(md, expected);
    assert.doesNotMatch(md, /from none|to none/);
  });
}

test('a new hover border colour names the resting border colour it changes from (QA3-05)', (t) => {
  const root = mkTmp('styleproof-state-border-');
  t.after(() => rmTmp(root));
  const link = 'body > a';
  const sides = ['top', 'right', 'bottom', 'left'];
  const border = (value) => Object.fromEntries(sides.map((side) => [`border-${side}-color`, value]));
  const dirs = ['before', 'after'].map((side) => path.join(root, side));
  for (const dir of dirs) {
    const map = makeMap({
      elements: {
        [link]: {
          tag: 'a',
          cls: 'docs-link',
          text: 'Docs',
          rect: [20, 20, 80, 20],
          style: { color: 'rgb(165, 243, 252)', ...border('rgb(165, 243, 252)') },
        },
      },
      states: dir === dirs[1] ? { [link]: { hover: { [link]: border('rgb(252, 165, 165)') } } } : {},
    });
    writeCapture(dir, 'docs@1280', map, solidPng(1280, 300));
    fs.writeFileSync(path.join(dir, 'docs@1280.hover.png'), solidPng(1280, 300));
  }
  const result = generateReport({ beforeDir: dirs[0], afterDir: dirs[1], outDir: path.join(root, 'report') });
  const md = fs.readFileSync(result.reportMdPath, 'utf8');
  assert.match(md, /the border colour changes from `#a5f3fc` to `#fca5a5` when hovered/);
  assert.doesNotMatch(md, /now changes to/);
});

test('machine findings keep the state owners', (t) => {
  const { json } = fixture(t);
  const owners = json.surfaces[0].findings.map((f) => [f.path, f.state, f.sub]).sort();
  assert.deepEqual(
    owners,
    [
      [checkbox, 'checked', label],
      [nickname, 'placeholder-shown', nickname],
      [save, 'disabled', save],
    ].sort(),
  );
});
