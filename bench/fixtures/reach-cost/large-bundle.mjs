import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** A deterministic product catalogue plus React/ReactDOM, without padding or eval. */
export async function buildLargeReachBundle(outdir) {
  const records = Array.from({ length: 7000 }, (_, id) => ({
    id,
    title: `Product ${id}`,
    description:
      `Item ${id}: a useful catalogue description with delivery, availability and product information. `.repeat(2),
  }));
  const source = `import React from 'react';import {createRoot} from 'react-dom/client';
 const records=${JSON.stringify(records)};
 function Catalogue(){return <main><h1>Catalogue</h1><ul>{records.slice(0,40).map(item=><li key={item.id}><h2>{item.title}</h2><p>{item.description}</p></li>)}</ul></main>}
 createRoot(document.getElementById('root')).render(<Catalogue/>);`;
  await build({
    stdin: {
      contents: source,
      loader: 'jsx',
      sourcefile: path.join(projectRoot, 'bench/fixtures/reach-cost/catalogue.jsx'),
      resolveDir: projectRoot,
    },
    bundle: true,
    minify: true,
    sourcemap: true,
    define: { 'process.env.NODE_ENV': '"production"' },
    outfile: path.join(outdir, 'large.js'),
    logLevel: 'warning',
  });
  absolutizeMapSources(path.join(outdir, 'large.js.map'));
  fs.writeFileSync(
    path.join(outdir, 'large.html'),
    '<!doctype html><body><div id="root"></div><script src="large.js"></script>',
  );
  return {
    url: pathToFileURL(path.join(outdir, 'large.html')).href,
    bytes: fs.statSync(path.join(outdir, 'large.js')).size,
  };
}

/** Keep file identities explicit when the generated fixture is also served over HTTP. */
export function absolutizeMapSources(file) {
  const map = JSON.parse(fs.readFileSync(file, 'utf8'));
  map.sources = map.sources.map((source) => new URL(source, pathToFileURL(file)).href);
  fs.writeFileSync(file, JSON.stringify(map));
}
