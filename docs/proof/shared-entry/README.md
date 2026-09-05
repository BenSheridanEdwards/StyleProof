# Selective remap reproduction

Run the following from the repository root after `npm run build`.
It loads the actual base implementation from git and the built branch
implementation, then prints their decisions for the same public synthetic inputs.

`output.txt` is verbatim stdout. `output.png` is an unmodified browser screenshot
of that text served as `text/plain`; it is a rendering of local command output,
not an application screenshot or independent certification. The source digest
binds the transcript to `src/affected-surfaces.ts`.

The before output incorrectly reuses an affected surface. The after output
recaptures it. CLI regressions additionally verify JSON and human-readable
capture/reuse recommendations.

```sh
node --input-type=module <<'JS'
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import * as current from './dist/affected-surfaces.js';

const root = process.cwd();
const baseRef = '6537938';
const source = execFileSync('git', ['show', `${baseRef}:src/affected-surfaces.ts`], { cwd: root, encoding: 'utf8' });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-proof-'));
try {
  const file = path.join(temp, 'base.mjs');
  fs.writeFileSync(
    file,
    ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } })
      .outputText,
  );
  const base = await import(pathToFileURL(file).href);
  const hash = createHash('sha256')
    .update(fs.readFileSync(path.join(root, 'src/affected-surfaces.ts')))
    .digest('hex');
  console.log('Shared entry states: changed page.tsx');
  console.log('Local reproduction using public synthetic source fixtures.');
  console.log('Advisory remap decisions; not a captured-style certification.');
  console.log(`Base: ${baseRef}; current source SHA-256:`);
  console.log(hash);
  const sources = { 'page.tsx': 'export default 1', 'other.tsx': 'export default 2' };
  const input = {
    surfaces: { rest: 'page.tsx', open: './page.tsx', other: 'other.tsx' },
    changedFiles: ['page.tsx'],
    graph: [],
    files: Object.keys(sources),
    readFile: (p) => sources[p],
  };
  for (const [label, api] of [
    [`BEFORE (main ${baseRef})`, base],
    ['AFTER (this branch)', current],
  ]) {
    console.log(`\n${label}`);
    console.log(api.explainAffectedSurfaces(api.affectedSurfaces(input), Object.keys(input.surfaces)));
  }
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
JS
```
