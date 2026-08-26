#!/usr/bin/env node
import path from 'node:path';
import { importMapBundleToEvidenceStore } from '../dist/evidence-import.js';
import {
  EvidenceStoreError,
  materializeEvidenceCapture,
  readEvidenceRef,
  verifyEvidenceCapture,
  writeEvidenceRef,
} from '../dist/evidence-store.js';

const HELP = `StyleProof content-addressed evidence store

usage: styleproof store import <bundle-dir> [options]
       styleproof store verify <ref> [options]
       styleproof store restore <ref> <out-dir> [options]

commands:
  import    migrate a v1 map bundle into immutable v2 evidence
  verify    verify a ref, capture manifest, and every referenced object
  restore   atomically materialize a verified ref into a new directory

options:
  --root <dir>   evidence store root (default: .styleproof/evidence)
  --include-har  import HAR files (import only; excluded by default)
  --no-ref       import objects without updating the commit ref (import only)
  --json         print a deterministic machine-readable receipt
  -h, --help     show this help`;

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h') || argv.length === 0) {
  process.stdout.write(`${HELP}\n`);
  process.exit(0);
}

const subcommand = argv.shift();
if (!['import', 'verify', 'restore'].includes(subcommand)) {
  process.stderr.write(`styleproof store: unknown command: ${subcommand}\nNext: run styleproof store --help.\n`);
  process.exit(2);
}

const positionals = [];
let storeRoot = '.styleproof/evidence';
let includeHar = false;
let updateRef = true;
let json = false;
for (let index = 0; index < argv.length; index += 1) {
  const argument = argv[index];
  if (!argument.startsWith('-')) {
    positionals.push(argument);
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
      process.stderr.write(`styleproof store ${subcommand}: --root requires a directory\n`);
      process.exit(2);
    }
    continue;
  }
  if (argument.startsWith('--root=')) {
    storeRoot = argument.slice('--root='.length);
    if (!storeRoot) {
      process.stderr.write(`styleproof store ${subcommand}: --root requires a directory\n`);
      process.exit(2);
    }
    continue;
  }
  process.stderr.write(`styleproof store ${subcommand}: unknown option ${argument}\n`);
  process.exit(2);
}

if (subcommand !== 'import' && (includeHar || !updateRef)) {
  process.stderr.write(`styleproof store ${subcommand}: --include-har and --no-ref are import-only options\n`);
  process.exit(2);
}
const expectedPositionals = subcommand === 'restore' ? 2 : 1;
if (positionals.length !== expectedPositionals) {
  const expected = subcommand === 'import' ? '<bundle-dir>' : subcommand === 'verify' ? '<ref>' : '<ref> <out-dir>';
  process.stderr.write(`styleproof store ${subcommand}: expected ${expected}\n`);
  process.exit(2);
}

try {
  const resolvedStoreRoot = path.resolve(storeRoot);
  if (subcommand === 'import') {
    const imported = importMapBundleToEvidenceStore({
      bundleDirectory: path.resolve(positionals[0]),
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
    if (json) process.stdout.write(`${JSON.stringify(receipt)}\n`);
    else {
      process.stdout.write(`StyleProof evidence capture: sha256:${receipt.capture.digest}\n`);
      process.stdout.write(
        `Trust: coverage=${receipt.trust.coverageBasis}, determinism=${receipt.trust.determinismStatus}\n`,
      );
      if (receipt.ref) process.stdout.write(`Ref: ${receipt.ref}\n`);
    }
  } else {
    const referenceKey = positionals[0];
    const capture = readEvidenceRef(resolvedStoreRoot, referenceKey);
    if (!capture) throw new EvidenceStoreError(`evidence ref not found: ${referenceKey}`);
    if (subcommand === 'verify') {
      const manifest = verifyEvidenceCapture(resolvedStoreRoot, capture);
      const receipt = {
        status: 'verified',
        capture,
        ref: referenceKey,
        files: manifest.files.length,
        trust: manifest.trust,
      };
      if (json) process.stdout.write(`${JSON.stringify(receipt)}\n`);
      else
        process.stdout.write(
          `Verified ${referenceKey}: ${receipt.files} files, coverage=${receipt.trust.coverageBasis}, determinism=${receipt.trust.determinismStatus}\n`,
        );
    } else {
      const outputDirectory = path.resolve(positionals[1]);
      const manifest = materializeEvidenceCapture(resolvedStoreRoot, capture, outputDirectory);
      const receipt = {
        status: 'restored',
        capture,
        ref: referenceKey,
        output: outputDirectory,
        files: manifest.files.length,
      };
      if (json) process.stdout.write(`${JSON.stringify(receipt)}\n`);
      else process.stdout.write(`Restored ${referenceKey} to ${outputDirectory} (${receipt.files} files)\n`);
    }
  }
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  process.stderr.write(`styleproof store ${subcommand}: ${detail}\n`);
  process.exit(error instanceof EvidenceStoreError ? 2 : 1);
}
