/**
 * Migration gallery tests (#566).
 *
 * Tests that the migration-mode report includes the Q9-locked gallery sections:
 *   - **Changed styles** → SurfaceClassification: 'changed'
 *   - **New surfaces** → SurfaceClassification: 'genuinely-new'
 *   - **New/removed elements** → ContentChange kind: 'structure'
 *
 * Q10 lockdown: Removed surfaces stay SEPARATE from migration gallery buckets.
 *
 * North star: Never weaken fail-closed style/certify gates.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { generateStyleMapReport, MIGRATION_GALLERY_LABELS } from '../dist/index.js';
import { makeMap, mkTmp, rmTmp, writeCapture, fixtureCompatibilityKey } from './helpers.mjs';

// ============================================================================
// Fixture builders — privacy-clean demo surfaces for migration gallery tests
// ============================================================================

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
    compatibilityKey: fixtureCompatibilityKey('migration-gallery'),
    createdAt: new Date().toISOString(),
    ...(opts.surfaceCaptureFailures ? { surfaceCaptureFailures: opts.surfaceCaptureFailures } : {}),
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'styleproof-manifest.json'), JSON.stringify(manifest));
};

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
    },
  });

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
    },
  });

// ============================================================================
// Migration gallery Q9 label tests
// ============================================================================

describe('migration gallery: Q9-locked labels (#566)', () => {
  test('MIGRATION_GALLERY_LABELS has correct locked labels', () => {
    assert.equal(MIGRATION_GALLERY_LABELS.changedStyles, 'Changed styles');
    assert.equal(MIGRATION_GALLERY_LABELS.newSurfaces, 'New surfaces');
    assert.equal(MIGRATION_GALLERY_LABELS.newRemovedElements, 'New/removed elements');
  });
});

// ============================================================================
// Migration gallery structure tests
// ============================================================================

describe('migration gallery: report structure (#566)', () => {
  test('migration: true returns migrationGallery in result', () => {
    const root = mkTmp();
    const beforeDir = path.join(root, 'before');
    const afterDir = path.join(root, 'after');
    const outDir = path.join(root, 'out');

    writeCapture(beforeDir, 'unchanged@1280', unchangedSurface(), null);
    writeCapture(afterDir, 'unchanged@1280', unchangedSurface(), null);
    writeMinimalManifest(beforeDir);
    writeMinimalManifest(afterDir);

    const result = generateStyleMapReport({
      beforeDir,
      afterDir,
      outDir,
      migration: true,
    });

    assert.ok(result.migrationGallery, 'migrationGallery should be present');
    assert.ok(Array.isArray(result.migrationGallery.changedStyles), 'changedStyles should be an array');
    assert.ok(Array.isArray(result.migrationGallery.newSurfaces), 'newSurfaces should be an array');
    assert.ok(Array.isArray(result.migrationGallery.newRemovedElements), 'newRemovedElements should be an array');

    rmTmp(root);
  });

  test('migration: false does NOT return migrationGallery', () => {
    const root = mkTmp();
    const beforeDir = path.join(root, 'before');
    const afterDir = path.join(root, 'after');
    const outDir = path.join(root, 'out');

    writeCapture(beforeDir, 'unchanged@1280', unchangedSurface(), null);
    writeCapture(afterDir, 'unchanged@1280', unchangedSurface(), null);
    writeMinimalManifest(beforeDir);
    writeMinimalManifest(afterDir);

    const result = generateStyleMapReport({
      beforeDir,
      afterDir,
      outDir,
      migration: false,
    });

    assert.equal(result.migrationGallery, undefined, 'migrationGallery should not be present when migration: false');

    rmTmp(root);
  });
});

// ============================================================================
// Migration gallery classification tests
// ============================================================================

describe('migration gallery: classification buckets (#566)', () => {
  test('Changed styles section includes surfaces with classification "changed"', () => {
    const root = mkTmp();
    const beforeDir = path.join(root, 'before');
    const afterDir = path.join(root, 'after');
    const outDir = path.join(root, 'out');

    writeCapture(beforeDir, 'style-changed@1280', styleChangedSurfaceBefore(), null);
    writeCapture(afterDir, 'style-changed@1280', styleChangedSurfaceAfter(), null);
    writeMinimalManifest(beforeDir);
    writeMinimalManifest(afterDir);

    const result = generateStyleMapReport({
      beforeDir,
      afterDir,
      outDir,
      migration: true,
    });

    assert.ok(result.migrationGallery, 'migrationGallery should be present');
    const changedStyles = result.migrationGallery.changedStyles;
    assert.equal(changedStyles.length, 1, 'should have 1 changed styles surface');
    assert.equal(changedStyles[0].surface, 'style-changed@1280');
    assert.ok(changedStyles[0].findingCount > 0, 'should have findings');

    rmTmp(root);
  });

  test('New surfaces section includes surfaces with classification "genuinely-new"', () => {
    const root = mkTmp();
    const beforeDir = path.join(root, 'before');
    const afterDir = path.join(root, 'after');
    const outDir = path.join(root, 'out');

    writeCapture(beforeDir, 'existing@1280', unchangedSurface(), null);
    writeCapture(afterDir, 'existing@1280', unchangedSurface(), null);
    writeCapture(afterDir, 'genuinely-new@1280', genuinelyNewSurface(), null);
    writeMinimalManifest(beforeDir);
    writeMinimalManifest(afterDir);

    const result = generateStyleMapReport({
      beforeDir,
      afterDir,
      outDir,
      migration: true,
    });

    assert.ok(result.migrationGallery, 'migrationGallery should be present');
    const newSurfaces = result.migrationGallery.newSurfaces;
    assert.equal(newSurfaces.length, 1, 'should have 1 new surface');
    assert.equal(newSurfaces[0].surface, 'genuinely-new@1280');

    rmTmp(root);
  });

  test('New/removed elements section includes surfaces with structure changes', () => {
    const root = mkTmp();
    const beforeDir = path.join(root, 'before');
    const afterDir = path.join(root, 'after');
    const outDir = path.join(root, 'out');

    writeCapture(beforeDir, 'elements-added@1280', elementsAddedSurfaceBefore(), null);
    writeCapture(afterDir, 'elements-added@1280', elementsAddedSurfaceAfter(), null);
    writeMinimalManifest(beforeDir);
    writeMinimalManifest(afterDir);

    const result = generateStyleMapReport({
      beforeDir,
      afterDir,
      outDir,
      migration: true,
    });

    assert.ok(result.migrationGallery, 'migrationGallery should be present');
    const newRemovedElements = result.migrationGallery.newRemovedElements;
    assert.equal(newRemovedElements.length, 1, 'should have 1 surface with element changes');
    assert.equal(newRemovedElements[0].surface, 'elements-added@1280');
    assert.ok(newRemovedElements[0].added > 0, 'should have added elements');

    rmTmp(root);
  });
});

// ============================================================================
// Q10 lockdown: Removed surfaces stay separate
// ============================================================================

describe('migration gallery: Q10 removed surfaces separation (#566)', () => {
  test('removed surfaces are NOT included in migration gallery buckets', () => {
    const root = mkTmp();
    const beforeDir = path.join(root, 'before');
    const afterDir = path.join(root, 'after');
    const outDir = path.join(root, 'out');

    writeCapture(beforeDir, 'existing@1280', unchangedSurface(), null);
    writeCapture(beforeDir, 'removed@1280', removedSurface(), null);
    writeCapture(afterDir, 'existing@1280', unchangedSurface(), null);
    writeMinimalManifest(beforeDir);
    writeMinimalManifest(afterDir);

    const result = generateStyleMapReport({
      beforeDir,
      afterDir,
      outDir,
      migration: true,
    });

    assert.ok(result.migrationGallery, 'migrationGallery should be present');

    const allGallerySurfaces = [
      ...result.migrationGallery.changedStyles.map((s) => s.surface),
      ...result.migrationGallery.newSurfaces.map((s) => s.surface),
      ...result.migrationGallery.newRemovedElements.map((s) => s.surface),
    ];

    assert.ok(
      !allGallerySurfaces.includes('removed@1280'),
      'removed surface should NOT be in any migration gallery bucket (Q10 lockdown)',
    );

    rmTmp(root);
  });
});

// ============================================================================
// Migration report markdown tests
// ============================================================================

describe('migration gallery: markdown output (#566)', () => {
  test('report.md includes Q9 gallery section headers in migration mode', () => {
    const root = mkTmp();
    const beforeDir = path.join(root, 'before');
    const afterDir = path.join(root, 'after');
    const outDir = path.join(root, 'out');

    writeCapture(beforeDir, 'style-changed@1280', styleChangedSurfaceBefore(), null);
    writeCapture(afterDir, 'style-changed@1280', styleChangedSurfaceAfter(), null);
    writeCapture(afterDir, 'genuinely-new@1280', genuinelyNewSurface(), null);
    writeMinimalManifest(beforeDir);
    writeMinimalManifest(afterDir);

    const result = generateStyleMapReport({
      beforeDir,
      afterDir,
      outDir,
      migration: true,
    });

    const reportMd = fs.readFileSync(result.reportMdPath, 'utf8');

    assert.ok(
      reportMd.includes(MIGRATION_GALLERY_LABELS.changedStyles),
      `report.md should include "${MIGRATION_GALLERY_LABELS.changedStyles}" header`,
    );
    assert.ok(
      reportMd.includes(MIGRATION_GALLERY_LABELS.newSurfaces),
      `report.md should include "${MIGRATION_GALLERY_LABELS.newSurfaces}" header`,
    );

    rmTmp(root);
  });

  test('report.md includes Migration Report header in migration mode', () => {
    const root = mkTmp();
    const beforeDir = path.join(root, 'before');
    const afterDir = path.join(root, 'after');
    const outDir = path.join(root, 'out');

    writeCapture(beforeDir, 'style-changed@1280', styleChangedSurfaceBefore(), null);
    writeCapture(afterDir, 'style-changed@1280', styleChangedSurfaceAfter(), null);
    writeMinimalManifest(beforeDir);
    writeMinimalManifest(afterDir);

    const result = generateStyleMapReport({
      beforeDir,
      afterDir,
      outDir,
      migration: true,
    });

    const reportMd = fs.readFileSync(result.reportMdPath, 'utf8');

    assert.ok(reportMd.includes('StyleProof Migration Report'), 'report.md should include Migration Report header');

    rmTmp(root);
  });
});

// ============================================================================
// Certification gate invariant tests
// ============================================================================

describe('migration gallery: certification gates remain fail-closed (#566)', () => {
  test('style changes still affect counts in migration mode (no soft-green)', () => {
    const root = mkTmp();
    const beforeDir = path.join(root, 'before');
    const afterDir = path.join(root, 'after');
    const outDir = path.join(root, 'out');

    writeCapture(beforeDir, 'style-changed@1280', styleChangedSurfaceBefore(), null);
    writeCapture(afterDir, 'style-changed@1280', styleChangedSurfaceAfter(), null);
    writeMinimalManifest(beforeDir);
    writeMinimalManifest(afterDir);

    const result = generateStyleMapReport({
      beforeDir,
      afterDir,
      outDir,
      migration: true,
    });

    assert.ok(result.changedSurfaces > 0, 'changedSurfaces count should reflect style changes');
    assert.ok(result.totalFindings > 0, 'totalFindings should reflect style changes');

    rmTmp(root);
  });

  test('migration mode does NOT soft-green style findings', () => {
    const root = mkTmp();
    const beforeDir = path.join(root, 'before');
    const afterDir = path.join(root, 'after');
    const outDir = path.join(root, 'out');

    writeCapture(beforeDir, 'style-changed@1280', styleChangedSurfaceBefore(), null);
    writeCapture(afterDir, 'style-changed@1280', styleChangedSurfaceAfter(), null);
    writeMinimalManifest(beforeDir);
    writeMinimalManifest(afterDir);

    const withMigration = generateStyleMapReport({
      beforeDir,
      afterDir,
      outDir,
      migration: true,
    });

    const outDir2 = path.join(root, 'out2');
    const withoutMigration = generateStyleMapReport({
      beforeDir,
      afterDir,
      outDir: outDir2,
      migration: false,
    });

    assert.equal(
      withMigration.changedSurfaces,
      withoutMigration.changedSurfaces,
      'changedSurfaces should be same in migration and non-migration mode',
    );
    assert.equal(
      withMigration.totalFindings,
      withoutMigration.totalFindings,
      'totalFindings should be same in migration and non-migration mode',
    );

    rmTmp(root);
  });
});
