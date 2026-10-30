import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  generateStyleMapReport as generateContentReport,
  generateStructuralStyleMapReportForTesting as generateStyleMapReport,
} from '../dist/report.js';
import { stampCertifyingFixture } from './certifying-fixture.mjs';
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

test('#1150 different restyles on every hosting base do not claim identical changes', () => {
  const { beforeDir, afterDir, outDir, root } = tmpDirs();

  const nav = (color) => ({
    'html > body > nav > a.link': { tag: 'a', cls: 'link', style: { color } },
  });

  for (const base of ['settings', 'reports', 'home']) {
    writeCapture(beforeDir, `${base}@1280`, makeMap({ elements: nav('rgb(0, 0, 0)') }), null);
    const color = base === 'home' ? 'rgb(0, 0, 255)' : 'rgb(255, 0, 0)';
    writeCapture(afterDir, `${base}@1280`, makeMap({ elements: nav(color) }), null);
  }

  try {
    const result = generateStyleMapReport({ beforeDir, afterDir, outDir });
    const md = fs.readFileSync(result.reportMdPath, 'utf8');
    const banner = md.slice(md.indexOf('## 🧱 Global chrome'));
    const digest = md.split('\n').find((line) => line.startsWith('- ') && line.includes('global chrome'));
    stampCertifyingFixture(beforeDir, '1'.repeat(40));
    stampCertifyingFixture(afterDir, '2'.repeat(40));

    const cli = spawnSync(process.execPath, ['bin/styleproof-diff.mjs', beforeDir, afterDir], {
      encoding: 'utf8',
    });

    assert.equal(cli.status, 1, cli.stderr);

    for (const [surface, text] of [
      ['banner', banner],
      ['digest', digest],
      ['CLI', cli.stdout],
    ]) {
      assert.match(text, /changed on every surface base that renders it/, surface);
      assert.doesNotMatch(text, /identically/, surface);
    }

    assert.match(md, /across 2 of 3 captured surface base/);
    assert.match(cli.stdout, /home@1280: 1 element/);
  } finally {
    rmTmp(root);
  }
});
