import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { generateStyleMapReport } from '../dist/report.js';
import { makeMap, mkTmp, rmTmp, solidPng, writeCapture } from './helpers.mjs';
import { htmlText, reportProblems, visibleMd } from './rule5-detector.mjs';

// Part 1: style, structure and surfaces. Layout pins refer to visual-first.
const BLACK = 'rgb(0, 0, 0)';
const RED = 'rgb(200, 30, 30)';
const body = { tag: 'body', rect: [0, 0, 1280, 400], style: { color: BLACK } };
const para = { tag: 'p', rect: [20, 100, 300, 20], style: { color: BLACK } };
const promo = { tag: 'div', cls: 'promo', rect: [20, 20, 200, 40], style: { color: BLACK, display: 'block' } };
const promo2 = { tag: 'div', cls: 'promo2', rect: [20, 200, 200, 40], style: { color: BLACK, display: 'block' } };
const title = (color) => ({ tag: 'h1', cls: 'title', text: 'Welcome', rect: [20, 300, 400, 40], style: { color } });
const page = (elements, extra = {}) => ({
  ...makeMap({ elements: { body, ...elements } }),
  metadata: { productState: { id: 'rule5', revision: 'fixture-v1' } },
  ...extra,
});
const nav = { tag: 'nav', cls: 'shared', rect: [0, 0, 1280, 40], style: { display: 'block' } };
const navLink = {
  tag: 'a',
  cls: 'cta',
  text: 'Help',
  rect: [10, 10, 60, 20],
  style: { color: BLACK, display: 'inline' },
};
const chromeSurfaces = (withLink) =>
  Object.fromEntries(
    ['home@1280', 'settings@1280'].map((key) => [
      key,
      page({ 'body > nav': nav, ...(withLink ? { 'body > nav > a': navLink } : {}), 'body > p': para }),
    ]),
  );
const PLAIN = { 'home@1280': page({ 'body > p': para }) };
const STYLED = (color) => ({ 'home@1280': page({ 'body > h1': title(color), 'body > p': para }) });
const SHAPES = {
  'empty (no changes)': {
    before: PLAIN,
    after: PLAIN,
    expect: /No reviewable computed-style changes/,
  },
  'style changes only': {
    before: STYLED(BLACK),
    after: STYLED(RED),
    expect: /\*\*1 change to review\*\*/,
  },
  'structure only (one element)': {
    before: { 'home@1280': page({ 'body > div.promo': promo, 'body > p': para }) },
    after: PLAIN,
    expect: /1 visible element was added or removed/,
  },
  'structure only (two elements)': {
    before: { 'home@1280': page({ 'body > div.promo': promo, 'body > div.promo2': promo2, 'body > p': para }) },
    after: PLAIN,
    expect: /2 visible elements were added or removed\*\* — they need review\./,
  },
  'style + structure': {
    before: { 'home@1280': page({ 'body > h1': title(BLACK), 'body > div.promo': promo, 'body > p': para }) },
    after: STYLED(RED),
    expect: /1 visible element was added or removed/,
  },
  'new surface': {
    before: PLAIN,
    after: { ...PLAIN, 'pricing@1280': page({ 'body > p': para }) },
    expect: /1 new surface/,
  },
  'removed surface': {
    before: { ...PLAIN, 'pricing@1280': page({ 'body > p': para }) },
    after: PLAIN,
    expect: /1 removed surface/,
  },
  'new + removed surfaces': {
    before: { ...PLAIN, 'old@1280': page({ 'body > p': para }) },
    after: { ...PLAIN, 'pricing@1280': page({ 'body > p': para }) },
    expect: /1 removed surface/,
  },
  'removed surface + style': {
    before: { ...STYLED(BLACK), 'pricing@1280': page({ 'body > p': para }) },
    after: STYLED(RED),
    expect: /1 removed surface/,
  },
  'style + structure + new surface': {
    before: {
      'home@1280': page({
        'body > h1': title(BLACK),
        'body > div.promo': promo,
        'body > div.promo2': promo2,
        'body > p': para,
      }),
    },
    after: { ...STYLED(RED), 'pricing@1280': page({ 'body > p': para }) },
    expect: /1 new surface/,
  },
  'global chrome': {
    before: chromeSurfaces(false),
    after: chromeSurfaces(true),
    expect: /visible element was added or removed/,
  },
  'style + structure + text': {
    before: {
      'home@1280': page({
        'body > h1': title(BLACK),
        'body > div.promo': promo,
        'body > p': { ...para, text: 'Old text' },
      }),
    },
    after: { 'home@1280': page({ 'body > h1': title(RED), 'body > p': { ...para, text: 'New text' } }) },
    expect: /visible element was added or removed/,
  },
  'text + style (no structure)': {
    before: { 'home@1280': page({ 'body > h1': title(BLACK), 'body > p': { ...para, text: 'Old text' } }) },
    after: { 'home@1280': page({ 'body > h1': title(RED), 'body > p': { ...para, text: 'New text' } }) },
    expect: /\*\*1 change to review\*\*/,
  },
  'text only': {
    before: { 'home@1280': page({ 'body > p': { ...para, text: 'Old text' } }) },
    after: { 'home@1280': page({ 'body > p': { ...para, text: 'New text' } }) },
    expect: /No reviewable computed-style changes/,
  },
};

for (const [shape, spec] of Object.entries(SHAPES)) {
  test(`rule 5 holds for: ${shape}`, (t) => {
    const dir = mkTmp('styleproof-rule5-');
    t.after(() => rmTmp(dir));
    for (const [side, captures] of [
      ['before', spec.before],
      ['after', spec.after],
    ]) {
      const sideDir = path.join(dir, side);
      fs.mkdirSync(sideDir, { recursive: true });
      for (const [key, capture] of Object.entries(captures)) writeCapture(sideDir, key, capture, solidPng(1280, 400));
    }
    for (const layout of [undefined, 'visual-first']) {
      const outDir = path.join(dir, layout ?? 'default');
      generateStyleMapReport({
        beforeDir: path.join(dir, 'before'),
        afterDir: path.join(dir, 'after'),
        outDir,
        ...(layout ? { layout } : {}),
      });
      const md = visibleMd(fs.readFileSync(path.join(outDir, 'report.md'), 'utf8'));
      const html = htmlText(fs.readFileSync(path.join(outDir, 'report.html'), 'utf8'));
      if (!layout && shape === 'structure only (one element)') assert.match(md, /Approve all changes signs these off/);
      if (!layout && shape === 'new surface') assert.match(md, /first-adoption surfaces; approve them/);
      if (!layout && shape === 'removed surface') assert.match(md, /approving accepts the disappearance/);
      if (!layout && shape === 'global chrome') assert.match(md, /approve them with the other changes/);
      if (layout) assert.match(md, spec.expect, `${shape}: fixture branch`);
      if (layout) assert.deepEqual(reportProblems('report.md', md), [], `${shape}: ${layout ?? 'default'} markdown`);
      if (layout) assert.deepEqual(reportProblems('report.html', html), [], `${shape}: ${layout ?? 'default'} HTML`);
    }
  });
}
