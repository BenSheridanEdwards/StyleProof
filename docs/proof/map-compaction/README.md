# Conditional map compaction proof

The screenshot is an unmodified browser rendering of the verbatim local output
from the command below. It uses the regression test's deterministic API fixture
to interleave a publication between retention selection and the ref update,
comparing actual main 4aaff438 source with the changed built implementation.
This is self-attested local behavioral proof. The Map store dogfood workflow
separately exercises real GitHub compaction and restoration on a scratch branch.

Reproduce under Node 22 after `npm ci`:

```sh
npm run build
node --test test/map-store-prune.test.mjs
node --input-type=module <<'JS'
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const ts = (await import(pathToFileURL(path.join(root, 'node_modules/typescript/lib/typescript.js')).href)).default;
const tests = fs.readFileSync('test/map-store-prune.test.mjs', 'utf8');
const factory = tests.slice(tests.indexOf('function buildFakeGitHub('), tests.indexOf('\nconst apiOptions ='));
const publisher = tests.slice(tests.indexOf('function publishCommit('), tests.indexOf('\nconst FRESH_SHA ='));
// Reuse the regression's exact deterministic API interleaving, not a second fixture.
const buildFakeGitHub = new Function('NOW', 'DAY_IN_SECONDS', `${publisher}\n${factory}\nreturn buildFakeGitHub;`)(1_800_000_000, 86400);
const baseline = '4aaff438e3a0cbcb667962a49fbcfa7db90df88f';
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-compaction-proof-'));
try {
  const original = execFileSync('git', ['show', `${baseline}:src/map-store-prune.ts`], { encoding: 'utf8' });
  const originalFile = path.join(temporary, 'original.mjs');
  fs.writeFileSync(originalFile, ts.transpileModule(original, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
  const before = await import(pathToFileURL(originalFile).href);
  const after = await import(pathToFileURL(path.join(root, 'dist/map-store-prune.js')).href);
  console.log('Map compaction race (local, self-attested API fixture)');
  console.log('Source SHA-256:');
  console.log(createHash('sha256').update(fs.readFileSync('src/map-store-prune.ts')).digest('hex'));
  for (const [label, implementation] of [['Before (main 4aaff438)', before], ['After', after]]) {
    const fake = buildFakeGitHub({
      rootTreeEntries: [{ path: 'cccccccccccc3333333333333333333333333333', type: 'tree', mode: '040000', sha: 'legacy-tree' }],
      racingPublication: { path: 'dddddddddddd4444444444444444444444444444', type: 'tree', mode: '040000', sha: 'racing-tree' },
    });
    const result = await implementation.compactMapStoreBranch({ apiBaseUrl: 'https://api.example', repository: 'acme/widgets', token: 'test-token', branch: 'styleproof-maps', nowEpochSeconds: 1_800_000_000, fetchImplementation: fake.fetchImplementation, sleepImplementation: async () => {}, log: () => {} });
    console.log(`${label}: racing capture ${result.retainedDirectoryNames.includes('dddddddddddd4444444444444444444444444444') ? 'RETAINED' : 'LOST'}`);
    console.log(`  Compaction attempts: ${fake.state.createdCommits.length}`);
    console.log(`  Expected-tip guard: ${fake.state.refUpdates[0].beforeOid ?? 'none'}`);
  }
  console.log('Hosted scratch-branch dogfood verifies the real API separately.');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
JS
```
