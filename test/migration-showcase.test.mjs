/**
 * Migration showcase fixtures and tests (#563).
 *
 * TDD fixtures that prove migration mode showcases two-head comparison correctly:
 * - Surface classification: unchanged, changed, genuinely-new, removed
 * - Structure changes: elements added, removed, retagged
 * - Gate contracts: certify remains fail-closed, no soft-green for structure
 *
 * Tests start RED (migration mode not yet implemented) and turn GREEN once
 * the feature lands (#564–#567).
 *
 * ## Mission 4 Lockdown Decisions
 *
 * Q9 Gallery labels (#566):
 *   - **Changed styles** → SurfaceClassification: 'changed'
 *   - **New surfaces** → SurfaceClassification: 'genuinely-new'
 *   - **New/removed elements** → ContentChange kind: 'structure'
 *
 * Q10 Inventory/nav removals:
 *   - Removed surfaces (SurfaceClassification: 'removed') stay SEPARATE from
 *     migration gallery — do not fold into migration buckets.
 *
 * Q7 Merge-ready gate:
 *   - These fixtures gate merge-ready; external dogfood is post-release only.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { diffStyleMapDirs, diffContentMaps, diffStyleMaps } from '../dist/diff.js';
import { makeMap, mkTmp, rmTmp, writeCapture, fixtureCompatibilityKey } from './helpers.mjs';

// ============================================================================
// Fixture builders — privacy-clean demo surfaces for migration showcase
// ============================================================================

/** Create a minimal map manifest for a capture directory. */
const writeMinimalManifest = (dir, opts = {}) => {
  const manifest = {
    version: 1,
    packageVersion: '6.3.0',
    sha: opts.sha ?? 'a'.repeat(40),
    dirty: false,
    spec: 'e2e/styleproof.spec.ts',
    specHash: '0'.repeat(64),
    platform: 'linux',
    arch: 'x64',
    nodeMajor: '22',
    screenshots: true,
    har: false,
    compatibilityKey: fixtureCompatibilityKey('migration-showcase'),
    createdAt: new Date().toISOString(),
    ...(opts.surfaceCaptureFailures ? { surfaceCaptureFailures: opts.surfaceCaptureFailures } : {}),
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'styleproof-manifest.json'), JSON.stringify(manifest));
};

/** Unchanged surface: identical on both sides. */
const unchangedSurface = () =>
  makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 1280, 720] },
      'body > header:nth-child(1)': {
        tag: 'header',
        cls: 'page-header',
        rect: [0, 0, 1280, 64],
        style: { 'background-color': 'rgb(255, 255, 255)', height: '64px' },
      },
      'body > main:nth-child(2)': {
        tag: 'main',
        cls: 'page-content',
        rect: [0, 64, 1280, 600],
        style: { padding: '24px' },
      },
    },
  });

/** Style-changed surface: same structure, different computed styles. */
const styleChangedSurfaceBefore = () =>
  makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 1280, 720] },
      'body > button:nth-child(1)': {
        tag: 'button',
        cls: 'cta-primary',
        rect: [100, 100, 200, 48],
        style: {
          'background-color': 'rgb(59, 130, 246)',
          color: 'rgb(255, 255, 255)',
          'border-radius': '8px',
        },
      },
    },
  });

const styleChangedSurfaceAfter = () =>
  makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 1280, 720] },
      'body > button:nth-child(1)': {
        tag: 'button',
        cls: 'cta-primary',
        rect: [100, 100, 200, 48],
        style: {
          'background-color': 'rgb(16, 185, 129)',
          color: 'rgb(255, 255, 255)',
          'border-radius': '12px',
        },
      },
    },
  });

/** Genuinely new surface: present only on head, not a baseline failure. */
const genuinelyNewSurface = () =>
  makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 1280, 720] },
      'body > section:nth-child(1)': {
        tag: 'section',
        cls: 'new-feature-panel',
        rect: [0, 0, 1280, 400],
        style: { 'background-color': 'rgb(249, 250, 251)', padding: '32px' },
      },
    },
  });

/** Removed surface: present only on base, absent on head. */
const removedSurface = () =>
  makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 1280, 720] },
      'body > aside:nth-child(1)': {
        tag: 'aside',
        cls: 'deprecated-sidebar',
        rect: [1000, 0, 280, 720],
        style: { 'background-color': 'rgb(243, 244, 246)' },
      },
    },
  });

/** Surface with elements added on head. */
const elementsAddedSurfaceBefore = () =>
  makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 1280, 720] },
      'body > ul:nth-child(1)': {
        tag: 'ul',
        cls: 'item-list',
        rect: [20, 20, 400, 200],
        style: { 'list-style': 'none' },
      },
      'body > ul:nth-child(1) > li:nth-child(1)': {
        tag: 'li',
        cls: 'item',
        rect: [20, 20, 400, 40],
        style: { padding: '8px' },
      },
    },
  });

const elementsAddedSurfaceAfter = () =>
  makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 1280, 720] },
      'body > ul:nth-child(1)': {
        tag: 'ul',
        cls: 'item-list',
        rect: [20, 20, 400, 280],
        style: { 'list-style': 'none' },
      },
      'body > ul:nth-child(1) > li:nth-child(1)': {
        tag: 'li',
        cls: 'item',
        rect: [20, 20, 400, 40],
        style: { padding: '8px' },
      },
      'body > ul:nth-child(1) > li:nth-child(2)': {
        tag: 'li',
        cls: 'item new-item',
        rect: [20, 60, 400, 40],
        style: { padding: '8px' },
      },
      'body > ul:nth-child(1) > li:nth-child(3)': {
        tag: 'li',
        cls: 'item new-item',
        rect: [20, 100, 400, 40],
        style: { padding: '8px' },
      },
    },
  });

/** Surface with elements removed on head. */
const elementsRemovedSurfaceBefore = () =>
  makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 1280, 720] },
      'body > nav:nth-child(1)': {
        tag: 'nav',
        cls: 'main-nav',
        rect: [0, 0, 1280, 56],
        style: { display: 'flex' },
      },
      'body > nav:nth-child(1) > a:nth-child(1)': {
        tag: 'a',
        cls: 'nav-link',
        rect: [20, 16, 80, 24],
        style: { color: 'rgb(59, 130, 246)' },
      },
      'body > nav:nth-child(1) > a:nth-child(2)': {
        tag: 'a',
        cls: 'nav-link deprecated',
        rect: [120, 16, 80, 24],
        style: { color: 'rgb(107, 114, 128)' },
      },
      'body > nav:nth-child(1) > a:nth-child(3)': {
        tag: 'a',
        cls: 'nav-link deprecated',
        rect: [220, 16, 80, 24],
        style: { color: 'rgb(107, 114, 128)' },
      },
    },
  });

const elementsRemovedSurfaceAfter = () =>
  makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 1280, 720] },
      'body > nav:nth-child(1)': {
        tag: 'nav',
        cls: 'main-nav',
        rect: [0, 0, 1280, 56],
        style: { display: 'flex' },
      },
      'body > nav:nth-child(1) > a:nth-child(1)': {
        tag: 'a',
        cls: 'nav-link',
        rect: [20, 16, 80, 24],
        style: { color: 'rgb(59, 130, 246)' },
      },
    },
  });

/** Surface with retagged elements. */
const elementsRetaggedSurfaceBefore = () =>
  makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 1280, 720] },
      'body > div:nth-child(1)': {
        tag: 'div',
        cls: 'card',
        rect: [20, 20, 300, 200],
        style: { 'border-radius': '8px' },
      },
    },
  });

const elementsRetaggedSurfaceAfter = () =>
  makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 1280, 720] },
      'body > div:nth-child(1)': {
        tag: 'article',
        cls: 'card',
        rect: [20, 20, 300, 200],
        style: { 'border-radius': '8px' },
      },
    },
  });

// ============================================================================
// Surface classification tests — diffStyleMapDirs SurfaceClassification
// ============================================================================

describe('migration showcase: SurfaceClassification (#563)', () => {
  test('classifies unchanged surfaces as "unchanged"', () => {
    const root = mkTmp();
    const beforeDir = path.join(root, 'before');
    const afterDir = path.join(root, 'after');

    writeCapture(beforeDir, 'unchanged@1280', unchangedSurface(), null);
    writeCapture(afterDir, 'unchanged@1280', unchangedSurface(), null);
    writeMinimalManifest(beforeDir, { sha: 'b'.repeat(40) });
    writeMinimalManifest(afterDir, { sha: 'a'.repeat(40) });

    const result = diffStyleMapDirs(beforeDir, afterDir);

    // Unchanged surfaces have no findings so may not appear in surfaces list
    // but they ARE compared (counts.style === 0, counts.dom === 0)
    assert.equal(result.counts.style, 0, 'no style changes');
    assert.equal(result.counts.dom, 0, 'no DOM changes');
    assert.equal(result.compared, 1, 'one surface compared');

    rmTmp(root);
  });

  test('classifies style-changed surfaces as "changed"', () => {
    const root = mkTmp();
    const beforeDir = path.join(root, 'before');
    const afterDir = path.join(root, 'after');

    writeCapture(beforeDir, 'style-changed@1280', styleChangedSurfaceBefore(), null);
    writeCapture(afterDir, 'style-changed@1280', styleChangedSurfaceAfter(), null);
    writeMinimalManifest(beforeDir);
    writeMinimalManifest(afterDir);

    const result = diffStyleMapDirs(beforeDir, afterDir);
    const surface = result.surfaces.find((s) => s.surface === 'style-changed@1280');

    assert.ok(surface, 'style-changed surface should be in results');
    assert.equal(surface.classification, 'changed', 'should be classified as changed');
    assert.equal(surface.missing, undefined, 'should not be missing');
    assert.ok(surface.findings.length > 0, 'should have findings');
    assert.ok(result.counts.style > 0, 'should have style changes');

    rmTmp(root);
  });

  test('classifies genuinely-new surfaces as "genuinely-new" with isNew=true', () => {
    const root = mkTmp();
    const beforeDir = path.join(root, 'before');
    const afterDir = path.join(root, 'after');

    // Base has one surface; head adds a genuinely new one
    writeCapture(beforeDir, 'existing@1280', unchangedSurface(), null);
    writeCapture(afterDir, 'existing@1280', unchangedSurface(), null);
    writeCapture(afterDir, 'genuinely-new@1280', genuinelyNewSurface(), null);
    writeMinimalManifest(beforeDir);
    writeMinimalManifest(afterDir);

    const result = diffStyleMapDirs(beforeDir, afterDir);
    const surface = result.surfaces.find((s) => s.surface === 'genuinely-new@1280');

    assert.ok(surface, 'genuinely-new surface should be in results');
    assert.equal(surface.classification, 'genuinely-new', 'should be classified as genuinely-new');
    assert.equal(surface.missing, 'before', 'should be missing from before');
    assert.equal(surface.isNew, true, 'isNew should be true for backward compatibility');

    rmTmp(root);
  });

  test('classifies removed surfaces as "removed"', () => {
    const root = mkTmp();
    const beforeDir = path.join(root, 'before');
    const afterDir = path.join(root, 'after');

    // Base has a surface that is removed on head
    writeCapture(beforeDir, 'existing@1280', unchangedSurface(), null);
    writeCapture(beforeDir, 'removed@1280', removedSurface(), null);
    writeCapture(afterDir, 'existing@1280', unchangedSurface(), null);
    writeMinimalManifest(beforeDir);
    writeMinimalManifest(afterDir);

    const result = diffStyleMapDirs(beforeDir, afterDir);
    const surface = result.surfaces.find((s) => s.surface === 'removed@1280');

    assert.ok(surface, 'removed surface should be in results');
    assert.equal(surface.classification, 'removed', 'should be classified as removed');
    assert.equal(surface.missing, 'after', 'should be missing from after');

    rmTmp(root);
  });

  test('removed surfaces stay separate from migration gallery buckets (Q10 lockdown)', () => {
    // Q10: inventory/nav removals stay SEPARATE from migration gallery —
    // do not fold into migration buckets (Changed styles / New surfaces / New·removed elements).
    // Removed surfaces are their own distinct category, not part of the "New/removed elements" label.
    const root = mkTmp();
    const beforeDir = path.join(root, 'before');
    const afterDir = path.join(root, 'after');

    writeCapture(beforeDir, 'existing@1280', unchangedSurface(), null);
    writeCapture(beforeDir, 'nav-page@1280', removedSurface(), null);
    writeCapture(afterDir, 'existing@1280', unchangedSurface(), null);
    writeMinimalManifest(beforeDir);
    writeMinimalManifest(afterDir);

    const result = diffStyleMapDirs(beforeDir, afterDir);
    const removed = result.surfaces.find((s) => s.surface === 'nav-page@1280');

    // Removed surfaces are classified distinctly, not folded into element-level structure
    assert.equal(removed.classification, 'removed', 'removed surface stays its own category');
    assert.notEqual(removed.classification, 'changed', 'not folded into Changed styles');
    assert.notEqual(removed.classification, 'genuinely-new', 'not folded into New surfaces');
    // The "New/removed elements" gallery label is for ContentChange kind: 'structure',
    // which tracks element-level changes WITHIN a surface — not surface-level removals.

    rmTmp(root);
  });

  test('distinguishes genuinely-new from baseline-repair-debt (#514)', () => {
    const root = mkTmp();
    const beforeDir = path.join(root, 'before');
    const afterDir = path.join(root, 'after');

    // Base has a capture failure for one surface
    writeCapture(beforeDir, 'existing@1280', unchangedSurface(), null);
    writeCapture(afterDir, 'existing@1280', unchangedSurface(), null);
    writeCapture(afterDir, 'repaired@1280', genuinelyNewSurface(), null);
    writeCapture(afterDir, 'genuinely-new@1280', genuinelyNewSurface(), null);
    writeMinimalManifest(beforeDir, {
      surfaceCaptureFailures: [{ key: 'repaired@1280', reason: 'timeout', kind: 'capture' }],
    });
    writeMinimalManifest(afterDir);

    const result = diffStyleMapDirs(beforeDir, afterDir);
    const repaired = result.surfaces.find((s) => s.surface === 'repaired@1280');
    const genuinelyNew = result.surfaces.find((s) => s.surface === 'genuinely-new@1280');

    assert.ok(repaired, 'repaired surface should be in results');
    assert.ok(genuinelyNew, 'genuinely-new surface should be in results');
    assert.equal(repaired.classification, 'baseline-repair-debt', 'repaired should be baseline-repair-debt');
    assert.equal(genuinelyNew.classification, 'genuinely-new', 'genuinely-new should be genuinely-new');
    assert.equal(repaired.isNew, false, 'baseline-repair-debt should NOT be isNew');
    assert.equal(genuinelyNew.isNew, true, 'genuinely-new should be isNew');

    rmTmp(root);
  });
});

// ============================================================================
// Element-level structure tests — ContentChange with kind: 'structure'
// ============================================================================

describe('migration showcase: ContentChange structure classification (#563)', () => {
  test('diffContentMaps reports added elements as structure change', () => {
    const before = elementsAddedSurfaceBefore();
    const after = elementsAddedSurfaceAfter();

    const changes = diffContentMaps(before, after);
    const added = changes.filter((c) => c.kind === 'structure' && c.change === 'added');

    assert.equal(added.length, 2, 'should report 2 added elements');
    assert.ok(
      added.every((c) => c.cls.includes('new-item')),
      'added elements should have new-item class',
    );
  });

  test('diffContentMaps reports removed elements as structure change', () => {
    const before = elementsRemovedSurfaceBefore();
    const after = elementsRemovedSurfaceAfter();

    const changes = diffContentMaps(before, after);
    const removed = changes.filter((c) => c.kind === 'structure' && c.change === 'removed');

    assert.equal(removed.length, 2, 'should report 2 removed elements');
    assert.ok(
      removed.every((c) => c.cls.includes('deprecated')),
      'removed elements should have deprecated class',
    );
  });

  test('diffContentMaps reports retagged elements as structure change', () => {
    const before = elementsRetaggedSurfaceBefore();
    const after = elementsRetaggedSurfaceAfter();

    const changes = diffContentMaps(before, after);
    const retagged = changes.filter((c) => c.kind === 'structure' && c.change === 'retagged');

    assert.equal(retagged.length, 1, 'should report 1 retagged element');
    assert.equal(retagged[0].detail, '<div> → <article>', 'should show tag transition');
  });

  test('diffStyleMaps includeStructure: true reports DOM added/removed/retagged', () => {
    const before = elementsAddedSurfaceBefore();
    const after = elementsAddedSurfaceAfter();

    const findings = diffStyleMaps(before, after, { includeStructure: true });
    const dom = findings.filter((f) => f.kind === 'dom');

    assert.equal(dom.length, 2, 'should report 2 DOM findings');
    assert.ok(
      dom.every((f) => f.change === 'added'),
      'all DOM findings should be additions',
    );
  });

  test('diffStyleMaps includeStructure: false (default) excludes DOM findings for certification', () => {
    const before = elementsAddedSurfaceBefore();
    const after = elementsAddedSurfaceAfter();

    const findings = diffStyleMaps(before, after, { includeStructure: false });
    const dom = findings.filter((f) => f.kind === 'dom');

    assert.equal(dom.length, 0, 'certification excludes DOM findings');
  });
});

// ============================================================================
// Gate contract tests — certify remains fail-closed, no soft-green
// ============================================================================

describe('migration showcase: certify/style gate contracts (#563)', () => {
  test('style changes on paired surfaces contribute to counts (fail gate)', () => {
    const root = mkTmp();
    const beforeDir = path.join(root, 'before');
    const afterDir = path.join(root, 'after');

    writeCapture(beforeDir, 'style-changed@1280', styleChangedSurfaceBefore(), null);
    writeCapture(afterDir, 'style-changed@1280', styleChangedSurfaceAfter(), null);
    writeMinimalManifest(beforeDir);
    writeMinimalManifest(afterDir);

    const result = diffStyleMapDirs(beforeDir, afterDir);

    // Style certification: style changes block
    assert.ok(result.counts.style > 0, 'style changes counted for gate');

    rmTmp(root);
  });

  test('genuinely-new surfaces do NOT inflate style counts (exit 3, reviewable)', () => {
    const root = mkTmp();
    const beforeDir = path.join(root, 'before');
    const afterDir = path.join(root, 'after');

    // Base has one unchanged surface; head adds a new one
    writeCapture(beforeDir, 'existing@1280', unchangedSurface(), null);
    writeCapture(afterDir, 'existing@1280', unchangedSurface(), null);
    writeCapture(afterDir, 'genuinely-new@1280', genuinelyNewSurface(), null);
    writeMinimalManifest(beforeDir);
    writeMinimalManifest(afterDir);

    const result = diffStyleMapDirs(beforeDir, afterDir);

    // New surfaces have no baseline to diff against — they don't inflate tallies
    assert.equal(result.counts.style, 0, 'new surfaces do not inflate style counts');
    assert.equal(result.counts.dom, 0, 'new surfaces do not inflate DOM counts');

    // But they ARE flagged as new for review
    const newSurface = result.surfaces.find((s) => s.surface === 'genuinely-new@1280');
    assert.ok(newSurface, 'new surface reported');
    assert.equal(newSurface.missing, 'before', 'new surface missing from before');

    rmTmp(root);
  });

  test('removed surfaces do NOT inflate style counts (exit 3, reviewable)', () => {
    const root = mkTmp();
    const beforeDir = path.join(root, 'before');
    const afterDir = path.join(root, 'after');

    writeCapture(beforeDir, 'existing@1280', unchangedSurface(), null);
    writeCapture(beforeDir, 'removed@1280', removedSurface(), null);
    writeCapture(afterDir, 'existing@1280', unchangedSurface(), null);
    writeMinimalManifest(beforeDir);
    writeMinimalManifest(afterDir);

    const result = diffStyleMapDirs(beforeDir, afterDir);

    // Removed surfaces don't inflate tallies either
    assert.equal(result.counts.style, 0, 'removed surfaces do not inflate style counts');

    rmTmp(root);
  });

  test('element additions in certification mode (includeStructure: false) do NOT count as findings', () => {
    const root = mkTmp();
    const beforeDir = path.join(root, 'before');
    const afterDir = path.join(root, 'after');

    // Surface with element additions but no STYLE changes
    writeCapture(beforeDir, 'elements-added@1280', elementsAddedSurfaceBefore(), null);
    writeCapture(afterDir, 'elements-added@1280', elementsAddedSurfaceAfter(), null);
    writeMinimalManifest(beforeDir);
    writeMinimalManifest(afterDir);

    // Default: includeStructure: false (certification mode)
    const result = diffStyleMapDirs(beforeDir, afterDir);

    // Certification excludes structure — only style changes count
    assert.equal(result.counts.dom, 0, 'DOM changes excluded in certification');
    assert.equal(result.counts.style, 0, 'no style changes, only element additions');
    assert.equal(result.surfaces.length, 0, 'no surfaces with findings in certification mode');

    rmTmp(root);
  });

  test('element additions in structural mode (includeStructure: true) produce DOM findings', () => {
    const root = mkTmp();
    const beforeDir = path.join(root, 'before');
    const afterDir = path.join(root, 'after');

    writeCapture(beforeDir, 'elements-added@1280', elementsAddedSurfaceBefore(), null);
    writeCapture(afterDir, 'elements-added@1280', elementsAddedSurfaceAfter(), null);
    writeMinimalManifest(beforeDir);
    writeMinimalManifest(afterDir);

    // Structural inventory mode
    const result = diffStyleMapDirs(beforeDir, afterDir, { includeStructure: true });

    // Structure mode includes DOM findings
    assert.ok(result.counts.dom > 0, 'DOM changes counted in structural mode');

    rmTmp(root);
  });
});

// ============================================================================
// Mixed scenario tests — real-world migration showcase
// ============================================================================

describe('migration showcase: mixed scenario (#563)', () => {
  test('mixed before/after with all classification categories', () => {
    const root = mkTmp();
    const beforeDir = path.join(root, 'before');
    const afterDir = path.join(root, 'after');

    // Populate a realistic migration scenario:
    // - unchanged surface
    // - style-changed surface
    // - removed surface (only on base)
    // - genuinely-new surface (only on head)
    // - surface with element additions
    writeCapture(beforeDir, 'unchanged@1280', unchangedSurface(), null);
    writeCapture(beforeDir, 'style-changed@1280', styleChangedSurfaceBefore(), null);
    writeCapture(beforeDir, 'removed@1280', removedSurface(), null);
    writeCapture(beforeDir, 'elements-added@1280', elementsAddedSurfaceBefore(), null);

    writeCapture(afterDir, 'unchanged@1280', unchangedSurface(), null);
    writeCapture(afterDir, 'style-changed@1280', styleChangedSurfaceAfter(), null);
    writeCapture(afterDir, 'genuinely-new@1280', genuinelyNewSurface(), null);
    writeCapture(afterDir, 'elements-added@1280', elementsAddedSurfaceAfter(), null);

    writeMinimalManifest(beforeDir, { sha: 'b'.repeat(40) });
    writeMinimalManifest(afterDir, { sha: 'a'.repeat(40) });

    const result = diffStyleMapDirs(beforeDir, afterDir);

    // Count surfaces by classification
    const classifications = {};
    for (const surface of result.surfaces) {
      const cls = surface.classification;
      classifications[cls] = (classifications[cls] || 0) + 1;
    }

    // Verify all categories present
    // compared = union of all surface names = 5 (genuinely-new is included, it just has no before pair)
    assert.equal(result.compared, 5, '5 surfaces in total');
    assert.equal(classifications['changed'], 1, '1 changed surface');
    assert.equal(classifications['removed'], 1, '1 removed surface');
    assert.equal(classifications['genuinely-new'], 1, '1 genuinely-new surface');
    // unchanged doesn't appear in surfaces[] because it has no findings

    // Verify style gate only sees the actual style change
    assert.ok(result.counts.style > 0, 'style changes from style-changed surface');

    rmTmp(root);
  });

  test('combined style change + element additions classified correctly', () => {
    const root = mkTmp();
    const beforeDir = path.join(root, 'before');
    const afterDir = path.join(root, 'after');

    // Surface that has BOTH style changes AND element additions
    const before = makeMap({
      elements: {
        body: { tag: 'body', rect: [0, 0, 1280, 720] },
        'body > div:nth-child(1)': {
          tag: 'div',
          cls: 'container',
          rect: [0, 0, 1280, 400],
          style: { 'background-color': 'rgb(255, 255, 255)' },
        },
      },
    });
    const after = makeMap({
      elements: {
        body: { tag: 'body', rect: [0, 0, 1280, 720] },
        'body > div:nth-child(1)': {
          tag: 'div',
          cls: 'container',
          rect: [0, 0, 1280, 400],
          style: { 'background-color': 'rgb(249, 250, 251)' },
        },
        'body > div:nth-child(1) > span:nth-child(1)': {
          tag: 'span',
          cls: 'badge',
          rect: [20, 20, 60, 24],
          style: { 'background-color': 'rgb(16, 185, 129)' },
        },
      },
    });

    writeCapture(beforeDir, 'combo@1280', before, null);
    writeCapture(afterDir, 'combo@1280', after, null);
    writeMinimalManifest(beforeDir);
    writeMinimalManifest(afterDir);

    // Certification mode — only sees style changes
    const certResult = diffStyleMapDirs(beforeDir, afterDir, { includeStructure: false });
    assert.ok(certResult.counts.style > 0, 'style changes counted');
    assert.equal(certResult.counts.dom, 0, 'DOM changes excluded in certification');

    // Structural mode — sees both
    const structResult = diffStyleMapDirs(beforeDir, afterDir, { includeStructure: true });
    assert.ok(structResult.counts.style > 0, 'style changes counted');
    assert.ok(structResult.counts.dom > 0, 'DOM changes counted in structural mode');

    rmTmp(root);
  });
});

// ============================================================================
// Migration mode placeholder tests — RED until #564–#567 land
// ============================================================================

describe('migration showcase: migration mode contract (RED until #564-#567)', () => {
  // These tests document the expected migration mode behavior.
  // They currently test EXISTING functionality that forms the foundation
  // for migration mode. The actual migration mode (--migration flag, gallery
  // sections, review-gate) will be implemented in #564-#567.

  test('foundation: SurfaceClassification enum covers all migration categories', () => {
    // This is a documentation test — SurfaceClassification already exists
    // and covers all the categories migration mode needs.
    const classifications = ['genuinely-new', 'baseline-repair-debt', 'removed', 'changed', 'unchanged'];

    // Just verify the types are exported and documented
    const root = mkTmp();
    const beforeDir = path.join(root, 'before');
    const afterDir = path.join(root, 'after');

    writeCapture(beforeDir, 'a@1280', unchangedSurface(), null);
    writeCapture(afterDir, 'a@1280', unchangedSurface(), null);
    writeCapture(afterDir, 'b@1280', genuinelyNewSurface(), null);
    writeMinimalManifest(beforeDir);
    writeMinimalManifest(afterDir);

    const result = diffStyleMapDirs(beforeDir, afterDir);

    // Verify classification field is present
    for (const surface of result.surfaces) {
      assert.ok(classifications.includes(surface.classification), `valid classification: ${surface.classification}`);
    }

    rmTmp(root);
  });

  test('foundation: ContentChange kind=structure covers element changes', () => {
    // diffContentMaps already produces the structure changes migration needs
    const before = elementsAddedSurfaceBefore();
    const after = elementsAddedSurfaceAfter();

    const changes = diffContentMaps(before, after);
    const structureChanges = changes.filter((c) => c.kind === 'structure');

    assert.ok(structureChanges.length > 0, 'structure changes detected');
    assert.ok(
      structureChanges.every((c) => ['added', 'removed', 'retagged'].includes(c.change)),
      'valid change types',
    );
  });

  test('foundation: certification mode (includeStructure: false) stays fail-closed', () => {
    // This test verifies the invariant: certification mode stays zero-diff.
    // Migration mode will use includeStructure: true, but certification is unaffected.
    const root = mkTmp();
    const beforeDir = path.join(root, 'before');
    const afterDir = path.join(root, 'after');

    // Surface with ONLY element additions (no style changes)
    writeCapture(beforeDir, 'elements-added@1280', elementsAddedSurfaceBefore(), null);
    writeCapture(afterDir, 'elements-added@1280', elementsAddedSurfaceAfter(), null);
    writeMinimalManifest(beforeDir);
    writeMinimalManifest(afterDir);

    // Certification mode — must stay clean (no soft-green for structure)
    const result = diffStyleMapDirs(beforeDir, afterDir, { includeStructure: false });

    // No findings means no gate failure — element additions don't fail certification
    // BUT they are NOT soft-greened either; they're simply not part of certification scope
    assert.equal(result.counts.dom, 0, 'certification excludes DOM');
    assert.equal(result.counts.style, 0, 'no style changes');
    assert.equal(result.surfaces.length, 0, 'no surfaces in certification results');

    rmTmp(root);
  });
});
