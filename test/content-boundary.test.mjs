import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { diffContentMaps, diffStyleMapDirs, diffStyleMaps } from '../dist/diff.js';
import { generateStyleMapReport } from '../dist/report.js';
import { makeMap, rmTmp, solidPng, tmpDirs, writeCapture } from './helpers.mjs';

test('content-disabled certification ignores element additions, removals, and retags', () => {
  const before = makeMap({
    elements: {
      body: { tag: 'body' },
      'body > p:nth-child(1)': { tag: 'p', cls: 'message', style: { color: 'rgb(0, 0, 0)' } },
      'body > em:nth-child(2)': { tag: 'em', cls: 'old' },
    },
  });
  const after = makeMap({
    elements: {
      body: { tag: 'body' },
      'body > p:nth-child(1)': { tag: 'section', cls: 'message', style: { color: 'rgb(0, 0, 0)' } },
      'body > strong:nth-child(2)': { tag: 'strong', cls: 'new' },
    },
  });

  assert.deepEqual(diffStyleMaps(before, after, { includeStructure: false }), []);
});

test('content comparison reports structural changes as advisory evidence', () => {
  const before = makeMap({
    elements: {
      body: { tag: 'body' },
      'body > p:nth-child(1)': { tag: 'p', cls: 'message' },
      'body > em:nth-child(2)': { tag: 'em', cls: 'old' },
    },
  });
  const after = makeMap({
    elements: {
      body: { tag: 'body' },
      'body > p:nth-child(1)': { tag: 'section', cls: 'message' },
      'body > strong:nth-child(2)': { tag: 'strong', cls: 'new' },
    },
  });

  assert.deepEqual(diffContentMaps(before, after), [
    {
      kind: 'structure',
      path: 'body > em:nth-child(2)',
      cls: 'old',
      change: 'removed',
    },
    {
      kind: 'structure',
      path: 'body > p:nth-child(1)',
      cls: 'message',
      change: 'retagged',
      detail: '<p> → <section>',
    },
    {
      kind: 'structure',
      path: 'body > strong:nth-child(2)',
      cls: 'new',
      change: 'added',
    },
  ]);
});

test('unchanged computed values suppress layout-used reflow while genuine style changes still gate', () => {
  const path = 'body > header:nth-child(1) > span:nth-child(1)';
  const before = makeMap({
    elements: {
      [path]: {
        tag: 'span',
        cls: 'trailing-label',
        rect: [420, 20, 120, 20],
        style: { color: 'rgb(0, 0, 0)', 'margin-left': '240px', width: '120px' },
        computedValueStyle: { 'margin-left': 'auto', width: '20%' },
      },
    },
  });
  const contentReflow = makeMap({
    elements: {
      [path]: {
        tag: 'span',
        cls: 'trailing-label',
        rect: [390, 20, 150, 20],
        style: { color: 'rgb(0, 0, 0)', 'margin-left': '210px', width: '150px' },
        computedValueStyle: { 'margin-left': 'auto', width: '20%' },
      },
    },
  });
  const genuineRestyle = makeMap({
    elements: {
      [path]: {
        tag: 'span',
        cls: 'trailing-label',
        rect: [390, 20, 150, 20],
        style: { color: 'rgb(255, 0, 0)', 'margin-left': '24px', width: '150px' },
        computedValueStyle: { width: '20%' },
      },
    },
  });

  assert.deepEqual(diffStyleMaps(before, contentReflow), []);
  const findings = diffStyleMaps(before, genuineRestyle);
  const propertyNames = findings
    .flatMap((finding) => (finding.kind === 'style' ? finding.props : []))
    .map((p) => p.prop);
  assert.deepEqual(propertyNames.sort(), ['color', 'margin-left']);
});

test('legacy maps without computed-value evidence remain fail-closed for geometry changes', () => {
  const path = 'body > span:nth-child(1)';
  const before = makeMap({ elements: { [path]: { tag: 'span', style: { width: '120px' } } } });
  const after = makeMap({ elements: { [path]: { tag: 'span', style: { width: '150px' } } } });

  const finding = diffStyleMaps(before, after).find((item) => item.kind === 'style');
  assert.ok(finding);
  assert.deepEqual(finding.props, [{ prop: 'width', before: '120px', after: '150px' }]);
});

test('content-disabled directory certification corresponds uniquely shifted elements before comparing styles', () => {
  const directories = tmpDirs();
  const before = makeMap({
    elements: {
      body: { tag: 'body' },
      'body > div:nth-child(1)': {
        tag: 'div',
        cls: 'toolbar',
        style: { 'background-color': 'rgb(20, 30, 40)' },
      },
      'body > div:nth-child(2)': {
        tag: 'div',
        cls: 'results-grid',
        style: { 'background-color': 'rgb(240, 240, 240)' },
      },
    },
  });
  const afterWith = (toolbarColor) =>
    makeMap({
      elements: {
        body: { tag: 'body' },
        'body > div:nth-child(1)': {
          tag: 'div',
          cls: 'new-control',
          style: { 'background-color': 'rgb(80, 20, 100)' },
        },
        'body > div:nth-child(2)': {
          tag: 'div',
          cls: 'toolbar',
          style: { 'background-color': toolbarColor },
        },
        'body > div:nth-child(3)': {
          tag: 'div',
          cls: 'results-grid',
          style: { 'background-color': 'rgb(240, 240, 240)' },
        },
      },
    });

  writeCapture(directories.beforeDir, 'example@800', before, null);
  const structurallyChanged = afterWith('rgb(20, 30, 40)');
  writeCapture(directories.afterDir, 'example@800', structurallyChanged, null);
  assert.deepEqual(diffStyleMapDirs(directories.beforeDir, directories.afterDir).counts, {
    dom: 0,
    style: 0,
    state: 0,
  });
  assert.deepEqual(diffContentMaps(before, structurallyChanged), [
    {
      kind: 'structure',
      path: 'body > div:nth-child(1)',
      cls: 'new-control',
      change: 'added',
    },
  ]);

  writeCapture(directories.afterDir, 'example@800', afterWith('rgb(200, 30, 40)'), null);
  const restyled = diffStyleMapDirs(directories.beforeDir, directories.afterDir);
  assert.equal(restyled.counts.style, 1);
  assert.deepEqual(restyled.surfaces[0].findings[0], {
    kind: 'style',
    path: 'body > div:nth-child(2)',
    cls: 'toolbar',
    pseudo: null,
    props: [
      {
        prop: 'background-color',
        before: 'rgb(20, 30, 40)',
        after: 'rgb(200, 30, 40)',
      },
    ],
    contentLengthSignal: 'unknown',
  });

  rmTmp(directories.root);
});

test('shift correspondence cannot be overwritten by an ambiguous displaced sibling', () => {
  const directories = tmpDirs();
  const before = makeMap({
    elements: {
      body: { tag: 'body' },
      'body > div:nth-child(1)': {
        tag: 'div',
        cls: 'toolbar',
        style: { 'background-color': 'rgb(20, 30, 40)' },
      },
      'body > div:nth-child(2)': {
        tag: 'div',
        cls: 'repeated',
        style: { 'background-color': 'rgb(240, 240, 240)' },
      },
      'body > div:nth-child(3)': {
        tag: 'div',
        cls: 'repeated',
        style: { 'background-color': 'rgb(240, 240, 240)' },
      },
    },
  });
  const after = makeMap({
    elements: {
      body: { tag: 'body' },
      'body > div:nth-child(1)': {
        tag: 'div',
        cls: 'new-control',
        style: { 'background-color': 'rgb(80, 20, 100)' },
      },
      'body > div:nth-child(2)': {
        tag: 'div',
        cls: 'toolbar',
        style: { 'background-color': 'rgb(200, 30, 40)' },
      },
      'body > div:nth-child(3)': {
        tag: 'div',
        cls: 'repeated',
        style: { 'background-color': 'rgb(240, 240, 240)' },
      },
      'body > div:nth-child(4)': {
        tag: 'div',
        cls: 'repeated',
        style: { 'background-color': 'rgb(240, 240, 240)' },
      },
    },
  });

  writeCapture(directories.beforeDir, 'collision@800', before, null);
  writeCapture(directories.afterDir, 'collision@800', after, null);

  const result = diffStyleMapDirs(directories.beforeDir, directories.afterDir);
  assert.equal(result.counts.style, 1);
  assert.deepEqual(result.surfaces[0].findings[0], {
    kind: 'style',
    path: 'body > div:nth-child(2)',
    cls: 'toolbar',
    pseudo: null,
    props: [
      {
        prop: 'background-color',
        before: 'rgb(20, 30, 40)',
        after: 'rgb(200, 30, 40)',
      },
    ],
    contentLengthSignal: 'unknown',
  });

  rmTmp(directories.root);
});

test('structural changes render only in the opt-in advisory content section and never gate', () => {
  const directories = tmpDirs();
  const image = solidPng(400, 200);
  const before = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 400, 200] },
      'body > p:nth-child(1)': { tag: 'p', cls: 'message', rect: [20, 20, 100, 20] },
    },
  });
  const after = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 400, 200] },
      'body > p:nth-child(1)': { tag: 'p', cls: 'message', rect: [20, 20, 100, 20] },
      'body > button:nth-child(2)': { tag: 'button', cls: 'action', rect: [20, 60, 100, 30] },
    },
  });
  writeCapture(directories.beforeDir, 'example@400', before, image);
  writeCapture(directories.afterDir, 'example@400', after, image);

  const contentOff = generateStyleMapReport({
    beforeDir: directories.beforeDir,
    afterDir: directories.afterDir,
    outDir: path.join(directories.root, 'content-off'),
  });
  const contentOn = generateStyleMapReport({
    beforeDir: directories.beforeDir,
    afterDir: directories.afterDir,
    outDir: path.join(directories.root, 'content-on'),
    includeContent: true,
  });
  const contentOffMarkdown = fs.readFileSync(contentOff.reportMdPath, 'utf8');
  const contentOnMarkdown = fs.readFileSync(contentOn.reportMdPath, 'utf8');

  assert.equal(contentOff.changedSurfaces, 0);
  assert.equal(contentOff.totalFindings, 0);
  assert.equal(contentOff.contentChanges, 0);
  assert.ok(!contentOffMarkdown.includes('Content and structure changes'));
  assert.equal(contentOn.changedSurfaces, 0);
  assert.equal(contentOn.totalFindings, 0);
  assert.equal(contentOn.contentChanges, 1);
  assert.ok(contentOnMarkdown.includes('Content and structure changes (advisory)'));
  assert.ok(contentOnMarkdown.includes('element added'));

  rmTmp(directories.root);
});
