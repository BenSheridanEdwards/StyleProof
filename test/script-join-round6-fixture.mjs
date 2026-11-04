import { transform } from 'esbuild';
import { mapScriptCoverage } from '../dist/script-reach.js';
import { compactScriptEvidence } from '../dist/script-reach-storage.js';
import { changedScriptRanges } from '../dist/script-join-git.js';
import { makeMap } from './helpers.mjs';

export const overlaySource = (rendered = false) => `
const css = (parts) => parts.join('');
const h = (tag, attrs, ...children) => {
  const node = document.createElement(tag);
  if (attrs?.style) node.setAttribute('style', attrs.style);
  node.append(...children);
  return node;
};
function Overlay() {
  const style = css\`
    color: red;
  \`;
  return <p style={style}>
    Service is down,
  </p>;
}
document.body.textContent = 'healthy';
window.overlay = Overlay;
${rendered ? 'document.body.append(Overlay());' : ''}
`;

export function patches(before, after) {
  const base = before.split('\n'),
    head = after.split('\n');
  return base
    .flatMap((line, i) => (line === head[i] ? [] : [`@@ -${i + 1} +${i + 1} @@\n-${line}\n+${head[i]}\n`]))
    .join('');
}

export async function shapedCapture(text, ran) {
  const bundle = await transform(text, {
    loader: 'tsx',
    target: 'es2022',
    sourcefile: 'app.tsx',
    sourcemap: 'external',
    jsxFactory: 'h',
  });
  const start = bundle.code.indexOf('function Overlay(');
  const end = bundle.code.indexOf('\n}', start) + 2;
  if (start < 0 || end <= start) throw new Error('overlay range missing');
  const files = mapScriptCoverage(
    {
      functions: [
        {
          ranges: [
            { startOffset: 0, endOffset: bundle.code.length, count: 1 },
            { startOffset: start, endOffset: end, count: ran ? 1 : 0 },
          ],
        },
      ],
    },
    bundle.code,
    JSON.parse(bundle.map),
    'https://overlay.test/app.js.map',
  );
  return {
    ...makeMap(),
    scriptReach: {
      version: 1,
      window: 'navigation',
      status: 'measured',
      projectRootPrefix: '',
      scripts: [compactScriptEvidence({ url: '/app.js', status: 'mapped', files })],
    },
  };
}

export function sourceChanges(before, after) {
  return changedScriptRanges(patches(before, after), { base: before, head: after }, 'app.tsx');
}
