// Issue #1141 (investigate): does report.md pair elements like the certifier after a sibling insert?
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { diffStyleMapDirs } from '../dist/diff.js';
import { generateStructuralStyleMapReportForTesting as generateStyleMapReport } from '../dist/report.js';
import { makeMap, pairFixture, rmTmp } from './helpers.mjs';

const card = (top, bg) => ({
  tag: 'section',
  cls: 'card',
  rect: [0, top, 300, 100],
  style: { 'background-color': bg },
});

function page({ banner, card3 }) {
  const elements = { body: { tag: 'body', cls: '', rect: [0, 0, 1280, 800], style: {} } };
  let i = 1;
  let top = 0;

  if (banner) {
    elements[`body > div:nth-child(${i++})`] = {
      tag: 'div',
      cls: 'banner',
      rect: [0, 0, 1280, 50],
      style: { 'background-color': 'rgb(255, 255, 0)' },
    };
    top = 50;
  }

  for (const bg of ['rgb(255, 255, 255)', 'rgb(255, 255, 255)', card3]) {
    elements[`body > section:nth-child(${i++})`] = card(top, bg);
    top += 100;
  }

  return makeMap({ elements });
}

test('#1141 a restyle on a card shifted by an inserted banner is in report.md', () => {
  const { beforeDir, afterDir, outDir, root } = pairFixture({
    surface: 's@1280',
    before: page({ banner: false, card3: 'rgb(255, 255, 255)' }),
    after: page({ banner: true, card3: 'rgb(255, 0, 0)' }),
  });

  try {
    const res = generateStyleMapReport({ beforeDir, afterDir, outDir });
    const md = fs.readFileSync(res.reportMdPath, 'utf8');
    const json = JSON.parse(fs.readFileSync(res.reportJsonPath, 'utf8'));
    assert.equal(json.reportConsistency.ok, true);
    assert.match(md, /div\.banner[^\n]*added/, 'the banner add is reported');
    // The certifier pairs the shifted cards and counts card 3's restyle; the report must agree.
    assert.match(md, /`#ffffff` → `#ff0000`/, `report.md does not show card 3's restyle:\n${md}`);
    assert.doesNotMatch(md, /section\.card[^\n]*removed/, 'no card was removed');
  } finally {
    rmTmp(root);
  }
});

for (const [name, banners, cards, descendants] of [
  ['single card and descendant', 1, 1, true],
  ['wide shift', 2, 3, false],
]) {
  test(`#1141 ${name} retains every certifier restyle`, () => {
    const map = (shift, color) => {
      const elements = { body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} } };

      for (let i = 1; i <= shift; i++) {
        elements[`body > div:nth-child(${i})`] = {
          tag: 'div',
          cls: 'banner',
          rect: [0, (i - 1) * 50, 300, 50],
          style: {},
        };
      }

      for (let i = 1; i <= cards; i++) {
        const owner = `body > section:nth-child(${i + shift})`;
        elements[owner] = card(shift * 50 + (i - 1) * 100, color);

        if (descendants)
          elements[`${owner} > span:nth-child(1)`] = {
            tag: 'span',
            cls: 'label',
            rect: [0, shift * 50, 100, 20],
            style: { color },
          };
      }

      return makeMap({ elements });
    };

    const { beforeDir, afterDir, outDir, root } = pairFixture({
      surface: 'cards@1280',
      before: map(0, 'rgb(255, 255, 255)'),
      after: map(banners, 'rgb(255, 0, 0)'),
    });

    try {
      const certifier = diffStyleMapDirs(beforeDir, afterDir);
      const result = generateStyleMapReport({ beforeDir, afterDir, outDir });
      const md = fs.readFileSync(result.reportMdPath, 'utf8');
      const report = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));
      assert.equal((md.match(/`#ffffff` → `#ff0000`/g) ?? []).length, cards + Number(descendants));
      assert.doesNotMatch(md, /(?:section\.card|span\.label)[^\n]*(?:removed|added)/);
      assert.equal(certifier.counts.style, cards + Number(descendants));
      assert.equal(report.counts.style, certifier.counts.style);
      assert.equal(report.counts.state, certifier.counts.state);
      assert.equal(report.counts.dom, banners, 'only inserted banners contribute structural findings');
    } finally {
      rmTmp(root);
    }
  });
}
