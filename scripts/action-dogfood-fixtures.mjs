import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { PNG } from 'pngjs';

const root = process.argv[2] || 'action-dogfood';

function map(color = 'rgb(0, 0, 0)') {
  return {
    defaults: {},
    elements: {
      body: { tag: 'body', cls: '', rect: [0, 0, 320, 180], style: {} },
      'body > main:nth-child(1)': {
        tag: 'main',
        cls: 'panel',
        rect: [24, 24, 180, 80],
        style: { color },
      },
    },
    states: {},
  };
}

function png([r, g, b]) {
  const image = new PNG({ width: 320, height: 180 });
  for (let i = 0; i < image.data.length; i += 4) {
    image.data[i] = r;
    image.data[i + 1] = g;
    image.data[i + 2] = b;
    image.data[i + 3] = 255;
  }
  return PNG.sync.write(image);
}

function writeCapture(dir, surface, styleMap, image) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${surface}.json.gz`), gzipSync(JSON.stringify(styleMap)));
  fs.writeFileSync(path.join(dir, `${surface}.png`), image);
}

fs.rmSync(root, { recursive: true, force: true });

writeCapture(path.join(root, 'clean-base'), 'home@320', map(), png([240, 240, 240]));
writeCapture(path.join(root, 'clean-head'), 'home@320', map(), png([240, 240, 240]));

writeCapture(path.join(root, 'changed-base'), 'home@320', map('rgb(0, 0, 0)'), png([240, 240, 240]));
writeCapture(path.join(root, 'changed-head'), 'home@320', map('rgb(255, 0, 0)'), png([255, 230, 230]));

writeCapture(path.join(root, 'new-base'), 'home@320', map(), png([240, 240, 240]));
writeCapture(path.join(root, 'new-head'), 'home@320', map(), png([240, 240, 240]));
writeCapture(path.join(root, 'new-head'), 'pricing@320', map('rgb(0, 0, 255)'), png([230, 230, 255]));
