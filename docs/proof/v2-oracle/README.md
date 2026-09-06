# Oracle-backed v2 migration proof

The screenshot renders verbatim local command output. It compares the original
three production modules at main ff9f1cd6 with this branch using a real five-run
capture of the committed example. The local capture was made on macOS with a
dirty working tree; that limitation remains visible. No upload succeeded or is
claimed. The hosted dogfood workflow separately captures a clean Linux checkout,
publishes/restores its temporary v1 branch, and verifies local v2 migration.

The directory in the baseline exception is replaced with `<bundle>` for privacy.
The transcript records the SHA-256 of the three changed production source files
in the listed order. It proves storage equivalence, not application completeness.
The legacy coverage stays unasserted and determinism stays proven.

Reproduce under Node 22 in a fresh directory (counts and byte hashes depend on the
browser/platform and source commit):

```sh
npm ci
npx playwright install chromium
PATH="$PWD/node_modules/.bin:$PATH" node bin/styleproof-map.mjs \
  --spec example/styleproof.spec.ts --dir captured --base-dir .styleproof/v2-dogfood \
  --prove-determinism --no-upload -- --config example/store-dogfood.playwright.config.ts
node scripts/store-v2-dogfood.mjs .styleproof/v2-dogfood/captured \
  .styleproof/v2-dogfood/v2 "$(git rev-parse HEAD)" > /tmp/styleproof-v2-local-receipt.json
node --input-type=module <<'JS'
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const bundle = path.resolve('.styleproof/v2-dogfood/captured');
const receipt = JSON.parse(fs.readFileSync('/tmp/styleproof-v2-local-receipt.json', 'utf8'));
const captureManifest = JSON.parse(fs.readFileSync(path.join(bundle, 'styleproof-manifest.json'), 'utf8'));
const ts = (await import(pathToFileURL(path.join(root, 'node_modules/typescript/lib/typescript.js')).href)).default;
const changedSources = ['src/evidence-import.ts', 'src/confidence-ledger.ts', 'src/map-store.ts'];
const baseline = 'ff9f1cd6feed2b47a28df50c6dd13b51c020423c';
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-v2-proof-'));
try {
  fs.writeFileSync(path.join(temporary, 'package.json'), '{"type":"module"}');
  fs.cpSync('dist', path.join(temporary, 'dist'), { recursive: true });
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(temporary, 'node_modules'), 'dir');
  for (const source of changedSources) {
    const original = execFileSync('git', ['show', `${baseline}:${source}`], { encoding: 'utf8' });
    fs.writeFileSync(path.join(temporary, source.replace('src/', 'dist/').replace('.ts', '.js')),
      ts.transpileModule(original, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
  }
  console.log('Oracle-backed v2 migration (local, self-attested)');
  console.log(`Capture platform: ${captureManifest.platform}; dirty: ${captureManifest.dirty}`);
  console.log('Production-source SHA-256 (three changed modules, listed order):');
  console.log(createHash('sha256').update(Buffer.concat(changedSources.map(file => fs.readFileSync(file)))).digest('hex'));
  const original = await import(pathToFileURL(path.join(temporary, 'dist/evidence-import.js')).href);
  try {
    original.importMapBundleToEvidenceStore({ bundleDirectory: bundle, storeRoot: path.join(temporary, 'before-store') });
    throw new Error('baseline unexpectedly accepted oracle evidence');
  } catch (error) {
    if (!error.message.includes('malformed styleproof-coverage.json')) throw error;
    console.log(`Before: ${error.message.replaceAll(bundle, '<bundle>')}`);
  }
  console.log(`After: coverage=${receipt.trust.coverageBasis}; determinism=${receipt.trust.determinismStatus}`);
  console.log(`Restored: ${receipt.evidence.fileCount} files; ${receipt.evidence.mapCount} maps; ${receipt.evidence.byteCount} bytes`);
  console.log(`Repeated import: ${receipt.repeatedImport}; restored paths/bytes: ${receipt.restoredBytes}`);
  console.log('Original five-run oracle receipt retained as metadata.');
  console.log('Local storage equivalence; application completeness not asserted.');
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
JS
```
