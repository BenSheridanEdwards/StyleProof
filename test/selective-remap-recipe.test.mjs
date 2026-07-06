import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { affectedSurfaces, explainAffectedSurfaces } from '../dist/affected-surfaces.js';

// ---------------------------------------------------------------------------
// The wired selective-remap recipe, proven end to end at map-dir level (#75).
//
//   git diff --name-only  →  dependency-cruiser graph  →  affectedSurfaces()
//   →  capture only the returned subset, reuse committed base maps for the rest
//
// No browser: the pipeline is graph + set logic + file IO. The "capture" is
// simulated by writing a per-surface JSON into a map dir, so the test proves the
// SUBSET plumbing (which surfaces re-capture, which reuse base) deterministically.
// The graph is a REAL dependency-cruiser run over a generic React-ish fixture
// (see test/fixtures/selective-remap/README.md for how it was generated).
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'selective-remap');

// The declared surfaces: capture key → entry module (page), as they appear in the graph.
const SURFACES = {
  home: 'src/pages/Home.tsx',
  pricing: 'src/pages/Pricing.tsx',
  dashboard: 'src/pages/Dashboard.tsx',
};

// Map the committed dependency-cruiser JSON into the ModuleEdge[] shape — the exact
// transform the README "Optional: selective remap (advisory)" recipe documents.
function loadGraph() {
  const cruise = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'graph.depcruise.json'), 'utf8'));
  const graph = cruise.modules.flatMap((m) =>
    (m.dependencies ?? []).map((d) => ({ from: m.source, to: d.resolved, dynamic: d.dynamic })),
  );
  return { graph, files: cruise.modules.map((m) => m.source) };
}

const readFixture = (p) => fs.readFileSync(path.join(FIXTURE, p), 'utf8');

function computeAffected(changedFiles) {
  const { graph, files } = loadGraph();
  return affectedSurfaces({ changedFiles, surfaces: SURFACES, graph, files, readFile: readFixture });
}

// Simulate the committed base map dir: one map per surface, tagged so we can prove
// later whether a surface was reused-from-base or freshly re-captured.
function seedBaseMaps(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const key of Object.keys(SURFACES)) {
    fs.writeFileSync(path.join(dir, `${key}.json`), JSON.stringify({ surface: key, origin: 'base' }));
  }
}

/**
 * Run the recipe against a map dir: every surface NOT in the affected set reuses
 * its committed base map; every surface in it (or all, on 'all') is "re-captured".
 * Returns, per surface, whether it was reused or re-captured — the exact decision a
 * pre-push hook makes. Fails loudly if a surface has neither a base nor a capture.
 */
function applyRecipe(baseDir, affected) {
  const keys = Object.keys(SURFACES);
  const recapture = affected === 'all' ? new Set(keys) : affected;
  const outcome = {};
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-remap-head-'));
  for (const key of keys) {
    const target = path.join(outDir, `${key}.json`);
    if (recapture.has(key)) {
      fs.writeFileSync(target, JSON.stringify({ surface: key, origin: 'recaptured' }));
      outcome[key] = 'recaptured';
    } else {
      // Reuse the committed base map verbatim — the whole point of the skip.
      fs.copyFileSync(path.join(baseDir, `${key}.json`), target);
      outcome[key] = 'reused-base';
    }
  }
  return { outDir, outcome };
}

test('recipe: a component-scoped change re-captures exactly its surface, reuses base for the rest', () => {
  const affected = computeAffected(['src/components/Chart.module.css']);
  // Chart is imported only by Dashboard → only the dashboard surface can differ.
  assert.notEqual(affected, 'all');
  assert.deepEqual([...affected].sort(), ['dashboard']);

  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-remap-base-'));
  seedBaseMaps(baseDir);
  const { outDir, outcome } = applyRecipe(baseDir, affected);

  assert.deepEqual(outcome, { home: 'reused-base', pricing: 'reused-base', dashboard: 'recaptured' });
  // The reused surfaces carry the committed BASE bytes; only dashboard is fresh.
  assert.equal(JSON.parse(fs.readFileSync(path.join(outDir, 'home.json'), 'utf8')).origin, 'base');
  assert.equal(JSON.parse(fs.readFileSync(path.join(outDir, 'dashboard.json'), 'utf8')).origin, 'recaptured');
});

test('recipe: a token/global CSS change forces a full re-capture (→ all)', () => {
  const affected = computeAffected(['src/tokens.css']);
  assert.equal(affected, 'all');

  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-remap-base-'));
  seedBaseMaps(baseDir);
  const { outcome } = applyRecipe(baseDir, affected);
  // Every surface re-captures — nothing is trusted from base under 'all'.
  assert.deepEqual(outcome, { home: 'recaptured', pricing: 'recaptured', dashboard: 'recaptured' });
});

test('recipe: a shared component change fans out to every surface that imports it', () => {
  const affected = computeAffected(['src/components/Header.tsx']);
  // Header is imported by all three pages.
  assert.deepEqual([...affected].sort(), ['dashboard', 'home', 'pricing']);
});

// --- #157 boundary decisions, proven through the real graph path (not just the unit) ---

test('recipe boundary: a .module.scss with @use → all (Sass fail-closed)', () => {
  // Overlay a Sass module carrying an @use load onto Hero's colocated module path.
  const changed = ['src/components/Hero.module.scss'];
  const { graph, files } = loadGraph();
  const readWithSass = (p) =>
    p === 'src/components/Hero.module.scss' ? "@use '../tokens';\n.hero{padding:8px}" : readFixture(p);
  const affected = affectedSurfaces({
    changedFiles: changed,
    surfaces: SURFACES,
    graph,
    files,
    readFile: readWithSass,
  });
  assert.equal(affected, 'all');
});

test('recipe boundary: an unlisted CSS-in-JS global API in a .tsx stays scope (documented residual)', () => {
  // The allowlist can't fail closed on an unknown member; this is the caller-gated
  // residual (README: an unsupported styling system is a reason to skip selective
  // remap). A made-up global API reads as scope and follows the import graph.
  const changed = ['src/components/Hero.tsx'];
  const { graph, files } = loadGraph();
  const readWithUnlisted = (p) =>
    p === 'src/components/Hero.tsx'
      ? "import {createGlobalStyles} from 'fictional-css-lib';\nexport const G=createGlobalStyles({});"
      : readFixture(p);
  const affected = affectedSurfaces({
    changedFiles: changed,
    surfaces: SURFACES,
    graph,
    files,
    readFile: readWithUnlisted,
  });
  // Hero is imported only by Home → scoped verdict, NOT 'all'.
  assert.notEqual(affected, 'all');
  assert.deepEqual([...affected].sort(), ['home']);
});

test('recipe: explain renders a reviewer-checkable skip list for the scoped case', () => {
  const affected = computeAffected(['src/components/Chart.module.css']);
  const lines = explainAffectedSurfaces(affected, Object.keys(SURFACES));
  assert.match(lines, /re-capture 1, reuse 2 from base/);
  assert.match(lines, /↻ dashboard \(re-capture/);
  assert.match(lines, /✓ home \(reuse base map/);
  assert.match(lines, /✓ pricing \(reuse base map/);
});
