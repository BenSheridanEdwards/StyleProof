#!/usr/bin/env node
import path from 'node:path';
import { importMapBundleToEvidenceStore } from '../dist/evidence-import.js';
import { EvidenceStoreError, readEvidenceRef, writeEvidenceRef } from '../dist/evidence-store.js';

const HELP = `usage: styleproof store import <bundle-dir> [options]

Import a v1 map bundle into the experimental content-addressed evidence store.
Coverage and determinism are derived fail-closed from the bundle's own ledgers.

Options:
  --root <dir>   evidence store root (default: .styleproof/evidence)
  --include-har  persist HAR files (excluded by default)
  --no-ref       import immutable objects without updating the commit ref
  --json         print a deterministic machine-readable receipt
  -h, --help     show this help`;

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h') || argv.length === 0) {
  process.stdout.write(`${HELP}\n`);
  process.exit(0);
}

const subcommand = argv.shift();
if (subcommand !== 'import') {
  process.stderr.write(`styleproof store: unknown command: ${subcommand}\nNext: run styleproof store --help.\n`);
  process.exit(2);
}

let bundleDirectory;
let storeRoot = '.styleproof/evidence';
let includeHar = false;
let updateRef = true;
let json = false;
for (let index = 0; index < argv.length; index += 1) {
  const argument = argv[index];
  if (!argument.startsWith('-')) {
    if (bundleDirectory !== undefined) {
      process.stderr.write(`styleproof store import: unexpected argument ${argument}\n`);
      process.exit(2);
    }
    bundleDirectory = argument;
    continue;
  }
  if (argument === '--include-har') {
    includeHar = true;
    continue;
  }
  if (argument === '--no-ref') {
    updateRef = false;
    continue;
  }
  if (argument === '--json') {
    json = true;
    continue;
  }
  if (argument === '--root') {
    storeRoot = argv[++index];
    if (!storeRoot || storeRoot.startsWith('-')) {
      process.stderr.write('styleproof store import: --root requires a directory\n');
      process.exit(2);
    }
    continue;
  }
  if (argument.startsWith('--root=')) {
    storeRoot = argument.slice('--root='.length);
    if (!storeRoot) {
      process.stderr.write('styleproof store import: --root requires a directory\n');
      process.exit(2);
    }
    continue;
  }
  process.stderr.write(`styleproof store import: unknown option ${argument}\n`);
  process.exit(2);
}

if (!bundleDirectory) {
  process.stderr.write('styleproof store import: bundle directory is required\n');
  process.exit(2);
}

try {
  const resolvedStoreRoot = path.resolve(storeRoot);
  const imported = importMapBundleToEvidenceStore({
    bundleDirectory: path.resolve(bundleDirectory),
    storeRoot: resolvedStoreRoot,
    includeHar,
  });
  const referenceKey = `commits/${imported.manifest.source.sha}/${imported.manifest.source.compatibilityKey}`;
  if (updateRef) {
    const current = readEvidenceRef(resolvedStoreRoot, referenceKey);
    const unchanged =
      current?.algorithm === imported.capture.algorithm &&
      current.digest === imported.capture.digest &&
      current.size === imported.capture.size;
    if (!unchanged) writeEvidenceRef(resolvedStoreRoot, referenceKey, imported.capture, current);
  }
  const receipt = {
    capture: imported.capture,
    trust: imported.manifest.trust,
    ref: updateRef ? referenceKey : null,
  };
  if (json) {
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } else {
    process.stdout.write(`StyleProof evidence capture: sha256:${receipt.capture.digest}\n`);
    process.stdout.write(
      `Trust: coverage=${receipt.trust.coverageBasis}, determinism=${receipt.trust.determinismStatus}\n`,
    );
    if (receipt.ref) process.stdout.write(`Ref: ${receipt.ref}\n`);
  }
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  process.stderr.write(`styleproof store import: ${detail}\n`);
  process.exit(error instanceof EvidenceStoreError ? 2 : 1);
}
