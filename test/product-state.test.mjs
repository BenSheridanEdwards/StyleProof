import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  isWholesaleLabelReplacement,
  productStateMismatchEvidence,
  incomparableProductStates,
} from '../dist/product-state.js';
import { generateStyleMapReport } from '../dist/report.js';
import { makeMap, rmTmp, solidPng, tmpDirs, writeCapture } from './helpers.mjs';

test('isWholesaleLabelReplacement: Guardian mode labels are distinct product states', () => {
  assert.equal(isWholesaleLabelReplacement('WATCHING YOUR DRAFT', 'AUTO IS DRIVING'), true);
});

test('isWholesaleLabelReplacement: a shared-word copy edit is not a state flip', () => {
  assert.equal(isWholesaleLabelReplacement('Original demo copy', 'Updated demo copy'), false);
});

test('isWholesaleLabelReplacement: one-word edits stay copy', () => {
  assert.equal(isWholesaleLabelReplacement('Save', 'Saved'), false);
  assert.equal(isWholesaleLabelReplacement('', 'AUTO IS DRIVING'), false);
});

test('productStateMismatchEvidence: eight structural adds are a tree rewrite', () => {
  const changes = Array.from({ length: 8 }, (_, index) => ({
    kind: 'structure',
    path: `body > div:nth-child(${index + 1})`,
    cls: '',
    change: 'added',
  }));
  const evidence = productStateMismatchEvidence(changes);
  assert.ok(evidence.some((item) => item.includes('8 structural')));
});

test('productStateMismatchEvidence: three adds are not enough', () => {
  const changes = [
    { kind: 'structure', path: 'a', cls: '', change: 'added' },
    { kind: 'structure', path: 'b', cls: '', change: 'added' },
    { kind: 'structure', path: 'c', cls: '', change: 'removed' },
  ];
  assert.deepEqual(productStateMismatchEvidence(changes), []);
});

test('incomparableProductStates collapse widths onto one surface base', () => {
  const states = incomparableProductStates([
    {
      surface: 'chat-guardian-auto-preview@1024',
      changes: [
        {
          kind: 'text',
          path: 'span',
          cls: 'truncate',
          before: 'WATCHING YOUR DRAFT',
          after: 'AUTO IS DRIVING',
        },
      ],
    },
    {
      surface: 'chat-guardian-auto-preview@1440',
      changes: [
        {
          kind: 'text',
          path: 'span',
          cls: 'truncate',
          before: 'WATCHING YOUR DRAFT',
          after: 'AUTO IS DRIVING',
        },
      ],
    },
  ]);
  assert.equal(states.length, 1);
  assert.equal(states[0].surfaceBase, 'chat-guardian-auto-preview');
});

test('generateStyleMapReport marks undeclared legacy state as unproven and strict mode does not certify it', () => {
  const dirs = tmpDirs();
  const before = makeMap({
    elements: {
      'body > span.relative:nth-child(1)': {
        tag: 'span',
        cls: 'relative',
        rect: [8, 8, 24, 24],
        text: 'WATCHING YOUR DRAFT',
        style: { 'background-color': 'rgba(63, 233, 255, 0.08)' },
      },
    },
  });
  const after = makeMap({
    elements: {
      'body > span.relative:nth-child(1)': {
        tag: 'span',
        cls: 'relative',
        rect: [8, 8, 24, 24],
        text: 'AUTO IS DRIVING',
        style: { 'background-color': 'rgba(217, 107, 255, 0.14)' },
      },
    },
  });
  writeCapture(dirs.beforeDir, 'chat-guardian-auto-preview@1440', before, solidPng(400, 200, [20, 80, 90]));
  writeCapture(dirs.afterDir, 'chat-guardian-auto-preview@1440', after, solidPng(400, 200, [80, 20, 90]));

  const result = generateStyleMapReport({
    beforeDir: dirs.beforeDir,
    afterDir: dirs.afterDir,
    outDir: path.join(dirs.root, 'out'),
    includeContent: true,
    requireStateIdentity: true,
  });
  const md = fs.readFileSync(result.reportMdPath, 'utf8');
  assert.equal(result.changedSurfaces, 0);
  assert.equal(result.comparison.status, 'unproven');
  assert.equal(result.comparison.blocksCertification, true);
  assert.ok(md.includes('unproven'));
  assert.ok(!md.includes('## Element-level changes'));
  assert.ok(!md.includes('1 element restyled'));

  rmTmp(dirs.root);
});

test('generateStyleMapReport still certifies a real restyle with a small copy edit', () => {
  const dirs = tmpDirs();
  const before = makeMap({
    elements: {
      'body > button:nth-child(1)': {
        tag: 'button',
        cls: 'save',
        rect: [8, 8, 80, 32],
        text: 'Original demo copy',
        style: { 'background-color': 'rgb(0, 0, 0)' },
      },
    },
  });
  const after = makeMap({
    elements: {
      'body > button:nth-child(1)': {
        tag: 'button',
        cls: 'save',
        rect: [8, 8, 80, 32],
        text: 'Updated demo copy',
        style: { 'background-color': 'rgb(255, 0, 0)' },
      },
    },
  });
  writeCapture(dirs.beforeDir, 'settings@1280', before, solidPng(400, 200));
  writeCapture(dirs.afterDir, 'settings@1280', after, solidPng(400, 200, [180, 40, 40]));

  const result = generateStyleMapReport({
    beforeDir: dirs.beforeDir,
    afterDir: dirs.afterDir,
    outDir: path.join(dirs.root, 'out'),
    includeContent: true,
  });
  const md = fs.readFileSync(result.reportMdPath, 'utf8');
  assert.ok(result.changedSurfaces >= 1);
  assert.ok(md.includes('Element-level changes'));
  assert.ok(!md.includes('not certified'));

  rmTmp(dirs.root);
});
