import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  generateStyleMapReport as generateContentReport,
  generateStructuralStyleMapReportForTesting as generateStyleMapReport,
} from '../dist/report.js';
import { makeMap, rmTmp, solidPng, tmpDirs, writeCapture } from './helpers.mjs';

// #1150: a change on an element inside <main> that every page renders is promoted by the
// structural shared-chrome rule, but it is not a nav, header or footer, so the wording must not say so.
test('#1150 a frame-wide change outside any nav/header/footer is not called a nav, header or footer change', () => {
  const { beforeDir, afterDir, outDir, root } = tmpDirs();

  const page = (color) => ({
    'html > body > main': { tag: 'main', cls: 'content', style: { display: 'block' } },
    'html > body > main > button': { tag: 'button', cls: 'cta', style: { color } },
  });

  for (const v of ['home', 'settings', 'reports']) {
    writeCapture(beforeDir, `${v}@1280`, makeMap({ elements: page('rgb(0, 0, 0)') }), solidPng(1280, 400));
    writeCapture(afterDir, `${v}@1280`, makeMap({ elements: page('rgb(255, 0, 0)') }), solidPng(1280, 400));
  }

  try {
    const res = generateStyleMapReport({ beforeDir, afterDir, outDir });
    const md = fs.readFileSync(res.reportMdPath, 'utf8');
    assert.match(md, /cta/, 'the change is reported');
    assert.doesNotMatch(md, /nav, header,? or footer/i, md.slice(0, 2000));
  } finally {
    rmTmp(root);
  }
});

for (const landmark of ['main', 'nav', 'header', 'footer', 'navigation']) {
  test(`#1150 shared additions under ${landmark} use only evidenced landmark wording`, () => {
    const { beforeDir, afterDir, outDir, root } = tmpDirs();
    const host = `html > body > ${landmark}`;
    const container = { [host]: { tag: landmark, cls: 'shared', style: { display: 'block' } } };

    for (const surface of ['home@1280', 'settings@1280']) {
      writeCapture(beforeDir, surface, makeMap({ elements: container }), null);
      writeCapture(
        afterDir,
        surface,
        makeMap({
          elements: {
            ...container,
            [`${host} > button`]: { tag: 'button', cls: 'cta' },
          },
        }),
        null,
      );
    }

    try {
      const result = generateContentReport({ beforeDir, afterDir, outDir, includeContent: true });
      const md = fs.readFileSync(result.reportMdPath, 'utf8');

      assert.match(md, /added or removed identically on every captured surface base/);

      if (['nav', 'header', 'footer'].includes(landmark)) {
        assert.match(md, /inside a nav, header or footer/);
      } else {
        assert.doesNotMatch(md, /nav, header,? or footer/i);
      }
    } finally {
      rmTmp(root);
    }
  });
}
