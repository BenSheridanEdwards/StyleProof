import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { generateStyleMapReport } from '../dist/report.js';
import { reportCommentSummary, COMMENT_SUMMARY_MAX_CHARS } from '../dist/report-comment.js';
import { makeMap, mkTmp, rmTmp, writeCapture } from './helpers.mjs';

// QA1-01: the PR comment carries the approved per-change content (github-comment.md), not
// only the summary: each section's name, line and CSS; images only behind a verified URL.
const card = (i) => `body > main:nth-child(1) > article:nth-child(${i})`;
function report(t, extraText = '') {
  const root = mkTmp('styleproof-comment-');
  t.after(() => rmTmp(root));
  for (const [i, side] of ['before', 'after'].entries()) {
    const elements = {};
    for (const n of [1, 2]) {
      elements[card(n)] = { tag: 'article', cls: 'card', rect: [24 + (n - 1) * 420, 100, 400, 150] };
      elements[`${card(n)} > h2:nth-child(1)`] = {
        tag: 'h2',
        cls: 'card-title',
        rect: [40 + (n - 1) * 420, 120, 300, 24],
        text: n === 1 ? `Lamp${extraText}` : 'Chair',
        style: { color: i ? 'rgb(150, 30, 60)' : 'rgb(30, 60, 120)' },
      };
    }
    const png = new PNG({ width: 1280, height: 400 });
    png.data.fill(240);
    writeCapture(path.join(root, side), 'shop@1280', makeMap({ elements }), PNG.sync.write(png));
  }
  const result = generateStyleMapReport({
    layout: 'visual-first',
    beforeDir: path.join(root, 'before'),
    afterDir: path.join(root, 'after'),
    outDir: path.join(root, 'out'),
  });
  return fs.readFileSync(result.reportMdPath, 'utf8');
}

const BASE = 'https://github.com/BenSheridanEdwards/StyleProof/blob/' + 'c'.repeat(40) + '/pr-7/';

test('without a verified image URL the comment carries each section as text', (t) => {
  const comment = reportCommentSummary(report(t), { imageBase: '' });
  assert.match(
    comment,
    /^## 🗺️ StyleProof report\n\n\*\*1 change to review\*\* on `shop` at 1280px wide: 2 elements\./,
  );
  assert.match(comment, /^### Card titles$/m);
  assert.match(comment, /^Both card titles \(Lamp, Chair\) change text colour from dark indigo to dark red\.$/m);
  assert.match(comment, /<sub>Where: Card titles on shop @ 1280<\/sub>/);
  assert.match(comment, /<details>\n<summary>Show the CSS<\/summary>\n\n\| Property \| Before \| After \|/);
  assert.doesNotMatch(comment, /<img|crops\/|^\| Before \| After \|$/m, 'no image can resolve, so none is posted');
  assert.doesNotMatch(comment, /<!--|^## Changes$/m, 'no hidden data, no empty Changes heading');
});

test('with the commit-bound branch URL the comment embeds the Where map and the clean pair', (t) => {
  const comment = reportCommentSummary(report(t), { imageBase: BASE });
  assert.match(
    comment,
    new RegExp(
      `<img src="${BASE}crops/shop-1280-1-1-where\\.png\\?raw=1" width="320" alt="Where on shop @ 1280: Card titles highlighted"><br><sub>`,
    ),
  );
  assert.match(comment, /^\| Before \| After \|$/m);
  assert.match(
    comment,
    new RegExp(
      `\\| <img src="${BASE}crops/shop-1280-1-before\\.png\\?raw=1" width="340" alt="Before: the first card title"> \\| <img src="${BASE}crops/shop-1280-1-after\\.png\\?raw=1"`,
    ),
  );
  assert.doesNotMatch(comment, /src="crops\//, 'every image is absolute');
});

test('the comment stays inside its size budget and counts what it leaves out', (t) => {
  const md = report(t);
  const one = reportCommentSummary(md, { imageBase: BASE });
  const sections = md.split('\n').filter((l) => l.startsWith('### ')).length;
  const many = [
    md.split('\n## Changes\n')[0],
    '## Changes',
    ...Array.from({ length: 400 }, () => md.split('\n## Changes\n')[1]),
  ].join('\n');
  const capped = reportCommentSummary(many, { imageBase: BASE });
  assert.ok(capped.length <= COMMENT_SUMMARY_MAX_CHARS, `${capped.length} characters`);
  // QA18-05: the note says why and what to do, and its count agrees with the full report.
  assert.match(
    capped,
    /^_This comment reached GitHub's size limit\. \d+ more changes? (?:is|are) listed in the full report: open it from the link at the end of this comment\._$/m,
  );
  const left = Number(capped.match(/(\d+) more changes?/)[1]);
  assert.equal(
    left,
    many.split('\n').filter((l) => l.startsWith('### ')).length -
      capped.split('\n').filter((l) => l.startsWith('### ')).length,
  );
  assert.ok(one.length < capped.length);
  assert.equal(sections, 1);
});

test('map-supplied text cannot inject a mention or a javascript link into the comment', (t) => {
  // Must stay at or under shortText's 32-character cap and must not include `<!--`,
  // or the generator drops the text and this test would pass with no escaping at all.
  const hostile = '@owner [x](javascript:1)';
  const md = report(t, hostile);
  assert.match(md, /@\u200bowner/, 'the captured text must reach report.md');
  const comment = reportCommentSummary(md, { imageBase: '' });
  assert.match(comment, /@\u200bowner/, 'the escaped mention must reach the comment');
  assert.doesNotMatch(comment, /@owner/, 'mentions are neutralised');
  assert.doesNotMatch(comment, /\[x\]\(javascript:/, 'the javascript link is not live');
});

test('the opening block is capped too, even with no change section (RV2-02)', () => {
  const long = Array.from(
    { length: 5000 },
    (_, i) => `⚠️ line ${i} of a very long blocking notice that keeps going`,
  ).join('\n\n');
  const md = [
    '## 🗺️ StyleProof report',
    '',
    '<!-- styleproof-captured x -->',
    long,
    '',
    '<details>',
    '<summary>Evidence</summary>',
    '',
    'x',
    '</details>',
  ].join('\n');
  const summary = reportCommentSummary(md, { maxChars: 2000 });
  assert.ok(summary.length <= 2000, `${summary.length} characters`);
  assert.match(summary, /^## 🗺️ StyleProof report/);
  assert.match(
    summary,
    /This comment reached GitHub's size limit\. The rest is in the full report: open it from the link at the end of this comment\._$/,
  );
  assert.doesNotMatch(summary, /Evidence/);
});

test('keepImages keeps image lines a caller already made resolvable, without an image base (RV2-13)', (t) => {
  const md = report(t).replaceAll('src="crops/', 'src="docs/readme/live-report/crops/');
  const comment = reportCommentSummary(md, { keepImages: true });
  assert.match(comment, /<img src="docs\/readme\/live-report\/crops\/[^"]+-before\.png"/);
  assert.doesNotMatch(comment, /\?raw=1/);
});

test('an unbound report keeps its source-binding warning and its summary line in the comment (RV18-06)', () => {
  const note =
    '> ⚠ UNVERIFIED DIAGNOSTIC: source binding was not verified. This report did not check that its captures ' +
    'came from the base and head commits; run it with `--expected-before-sha` and `--expected-after-sha` to check them.';
  const md = [
    note,
    '',
    '## 🗺️ StyleProof report',
    '',
    '**1 change to review** on `home` at 1280px wide: 1 element.',
    '',
    '## Changes',
    '',
    '### Cta',
    '',
    'The cta changes background from black to red.',
    '',
  ].join('\n');
  const comment = reportCommentSummary(md);
  assert.ok(comment.startsWith(note), comment);
  assert.match(comment, /^\*\*1 change to review\*\* on `home` at 1280px wide: 1 element\.$/m);
});

const META = '<!-- styleproof-section x -->';
const changeBlock = (body = 'The titles change colour.') =>
  ['### Card titles', '', META, '', body, '', '<!-- styleproof-section-end -->'].join('\n');
const newSurfaceBlock = (key = 'fresh@1280') =>
  [
    `### \`${key}\` · new surface <!-- styleproof-new -->`,
    '',
    `![new surface — after](crops/${key.replace('@', '-')}-1-new.png)`,
    '',
    '_No baseline to compare against. This is a reviewable first-adoption surface; approve it before it becomes part of the baseline._',
  ].join('\n');
const reportShell = (...blocks) =>
  [
    '## 🗺️ StyleProof report',
    '',
    '**1 change to review** on `shop` at 1280px wide: 2 elements.',
    '',
    '<!-- styleproof-captured x -->',
    '',
    ...blocks,
  ].join('\n');

test('an unverified imageBase does not embed images and a verified one still does', () => {
  const md = reportShell(
    changeBlock(
      [
        '<img src="crops/shop-1280-1-where.png" width="320" alt="Where"><br><sub>Where: 2 card titles</sub>',
        '',
        '| Before | After |',
        '| --- | --- |',
        '| <img src="crops/shop-1280-1-before.png" width="340" alt="Before"> | <img src="crops/shop-1280-1-after.png" width="340" alt="After"> |',
      ].join('\n'),
    ),
  );
  const sha = 'a'.repeat(40);
  const root = `${'https://github.com/BenSheridanEdwards/StyleProof/blob/'}${sha}`;
  const rejected = [
    `http://github.com/BenSheridanEdwards/StyleProof/blob/${sha}/pr-1/`,
    `https://github.com.evil.com/BenSheridanEdwards/StyleProof/blob/${sha}/pr-1/`,
    `https://github.com@evil.com/BenSheridanEdwards/StyleProof/blob/${sha}/pr-1/`,
    `${root}/pr-1/?x=1`,
    `${root}/pr-1/#x`,
    `${root}/pr-1/"onerror="`,
    `${root}/pr-1/\n`,
    `javascript:${root}/pr-1/`,
    `https://github.com/${'../../'}a/`,
    `https://github.com/${'/'}evil.com/`,
    `${root}/../pr-1/`,
    `${root}/./pr-1/`,
  ];
  for (const imageBase of rejected) {
    const comment = reportCommentSummary(md, { imageBase });
    assert.doesNotMatch(comment, /<img|crops\//, imageBase);
  }
  const ok = reportCommentSummary(md, { imageBase: BASE });
  assert.match(ok, new RegExp(`src="${BASE}crops/shop-1280-1-before\\.png\\?raw=1"`));
});

test('unrecognised image lines and single-quoted img tags do not appear in the comment', () => {
  const md = reportShell(
    changeBlock(
      [
        'The titles change colour.',
        '',
        '![a](crops/x.png)',
        "<img src='crops/x.png'>",
        '<img src="https://evil.example/x.png">',
        '<img src="crops/shop-1280-1-where.png" width="320" alt="Where"><br><sub>Where: 2 card titles</sub>',
      ].join('\n'),
    ),
  );
  const textOnly = reportCommentSummary(md, {});
  assert.doesNotMatch(textOnly, /<img|!\[|crops\//);
  assert.match(textOnly, /The titles change colour\./);
  const pub = reportCommentSummary(md, { imageBase: BASE });
  assert.doesNotMatch(pub, /!\[a\]|src='crops\/|evil\.example|src="crops\//);
  assert.match(pub, new RegExp(`src="${BASE}crops/shop-1280-1-where\\.png\\?raw=1"`));
});

test('a multi-line HTML comment cannot leak a receipt or an approval box into the comment', () => {
  const md = reportShell(
    changeBlock(
      [
        'The titles change colour.',
        '<!-- styleproof-receipt head-sha:x',
        '- [x] Approve all changes',
        'run-id:1 -->',
        'Visible after the comment.',
      ].join('\n'),
    ),
  );
  const comment = reportCommentSummary(md, {});
  assert.equal(comment.includes('styleproof-receipt') || comment.includes('head-sha'), false);
  assert.equal(comment.includes('<!--') || comment.includes('-->'), false);
  assert.doesNotMatch(comment, /^\s*- \[[ xX]\]/m);
  assert.match(comment, /The titles change colour\./);
  assert.match(comment, /Visible after the comment\./);
});

test('crop filenames that climb out of the report directory are not rebased', () => {
  const md = reportShell(
    changeBlock(
      [
        '<img src="crops/../../../x/y.png" width="320" alt="escape">',
        '<img src="crops/%2e%2e/x.png" width="320" alt="encoded">',
        '<img src="crops/shop-1280-1-before.png" width="340" alt="Before">',
      ].join('\n'),
    ),
  );
  const pub = reportCommentSummary(md, { imageBase: BASE });
  assert.doesNotMatch(pub, /\.\.\/|%2e%2e|src="crops\//);
  assert.doesNotMatch(pub, /\/x\/y\.png/);
  assert.match(pub, new RegExp(`src="${BASE}crops/shop-1280-1-before\\.png\\?raw=1"`));
});

test('new-surface sections are in the comment and in the left-out count', () => {
  const md = reportShell(newSurfaceBlock(), '', changeBlock());
  const comment = reportCommentSummary(md, { imageBase: BASE });
  assert.match(comment, /^### `fresh@1280` · new surface$/m);
  assert.doesNotMatch(comment, /styleproof-new/);
  assert.match(comment, /reviewable first-adoption surface/);
  assert.match(comment, new RegExp(`!\\[new surface — after\\]\\(${BASE}crops/fresh-1280-1-new\\.png\\?raw=1\\)`));
  assert.match(comment, /### Card titles/);
  const textOnly = reportCommentSummary(md, {});
  assert.match(textOnly, /^### `fresh@1280` · new surface$/m);
  assert.doesNotMatch(textOnly, /!\[|crops\//);
  const many = reportShell(
    ...Array.from({ length: 80 }, (_, i) => newSurfaceBlock(`fresh-${i}@1280`)),
    '',
    changeBlock(),
  );
  const capped = reportCommentSummary(many, { imageBase: BASE, maxChars: 2500 });
  assert.match(
    capped,
    /^_This comment reached GitHub's size limit\. \d+ more changes? (?:is|are) listed in the full report: open it from the link at the end of this comment\._$/m,
  );
  const left = Number(capped.match(/(\d+) more changes?/)[1]);
  const total = many.split('\n').filter((l) => l.startsWith('### ')).length;
  const shown = capped.split('\n').filter((l) => l.startsWith('### ')).length;
  assert.equal(left, total - shown);
  assert.ok(left > 0);
  assert.match(capped, /### `fresh-0@1280` · new surface/);
});

test('a new-surface section stops before a later group heading or Evidence fold', () => {
  const md = reportShell(
    newSurfaceBlock(),
    '',
    '## State coverage',
    '',
    '| Surface | States |',
    '| --- | --- |',
    '| `fresh@1280` | rest |',
    '',
    '<details>',
    '<summary>Evidence</summary>',
    '',
    'hidden receipts',
    '</details>',
  );
  const comment = reportCommentSummary(md, { imageBase: BASE });
  assert.match(comment, /^### `fresh@1280` · new surface$/m);
  assert.match(comment, /reviewable first-adoption surface/);
  assert.doesNotMatch(comment, /State coverage|Evidence|hidden receipts/);
});

test('a generated new-surface section reaches the comment (visual-first)', (t) => {
  const root = mkTmp('styleproof-comment-new-');
  t.after(() => rmTmp(root));
  const png = new PNG({ width: 1280, height: 400 });
  png.data.fill(240);
  for (const [i, side] of ['before', 'after'].entries()) {
    const elements = {
      [card(1)]: { tag: 'article', cls: 'card', rect: [24, 100, 400, 150] },
      [`${card(1)} > h2:nth-child(1)`]: {
        tag: 'h2',
        cls: 'card-title',
        rect: [40, 120, 300, 24],
        text: 'Lamp',
        style: { color: i ? 'rgb(150, 30, 60)' : 'rgb(30, 60, 120)' },
      },
    };
    writeCapture(path.join(root, side), 'shop@1280', makeMap({ elements }), PNG.sync.write(png));
  }
  writeCapture(
    path.join(root, 'after'),
    'fresh@1280',
    makeMap({
      elements: {
        'body > main:nth-child(1)': { tag: 'main', cls: 'page', rect: [0, 0, 1280, 400] },
      },
    }),
    PNG.sync.write(png),
  );
  const result = generateStyleMapReport({
    layout: 'visual-first',
    beforeDir: path.join(root, 'before'),
    afterDir: path.join(root, 'after'),
    outDir: path.join(root, 'out'),
  });
  const md = fs.readFileSync(result.reportMdPath, 'utf8');
  assert.match(md, /### `fresh@1280` · new surface <!-- styleproof-new -->/);
  const comment = reportCommentSummary(md, { imageBase: BASE });
  assert.match(comment, /^### `fresh@1280` · new surface$/m);
  assert.doesNotMatch(comment, /styleproof-new/);
  assert.match(comment, /### Card title/);
});

function wrapReceipt(depth) {
  // Each wrap peels to a leftover receipt plus comment closers; the 8-pass cap used to leave both.
  let s = '<!-- dummy --> styleproof-receipt FORGED';
  for (let i = 0; i < depth; i++) s = `<!${s}-->`;
  return s;
}

test('deeply nested HTML comment wrapping cannot leave a live comment or receipt', () => {
  for (const depth of [1, 7, 8, 9, 20]) {
    const md = reportShell(changeBlock(['Visible before.', wrapReceipt(depth), 'Visible after.'].join('\n')));
    const comment = reportCommentSummary(md, {});
    assert.equal(comment.includes('<!--') || comment.includes('styleproof-receipt'), false, `depth ${depth}`);
    assert.match(comment, /Visible before\./);
    assert.match(comment, /Visible after\./);
  }
});

test('every image target must start with imageBase; foreign and split forms are dropped', () => {
  const ev = `https://${'evil.example'}/x.png`;
  const gh = `https://github.com/${'not-this-repo'}/repo/raw/${'b'.repeat(40)}/x.png`;
  const md = reportShell(
    changeBlock(
      [
        'The titles change colour.',
        `![a][r]`,
        `[r]: ${ev}`,
        `![a](${ev})`,
        `![a](<${ev}>)`,
        `![a](${ev} "t")`,
        `![a]( ${ev} )`,
        `![a [b]](${ev})`,
        '![r2]',
        `[r2]:${ev}`,
        '![s]',
        '[s]:',
        ev,
        `<video poster="${ev}"></video>`,
        `<img src="${ev}">`,
        `<img\nsrc=\n"${ev}">`,
        `<img src="&#104;ttps://${'evil.example'}/x.png">`,
        `<IMG SRC='crops/../../evil.png'>`,
        `<img src=/evil/repo/raw/main/x.png>`,
        `<img src="${gh}">`,
        `<img src="${BASE}${'../../../../'}evil/repo/raw/main/x.png">`,
        `![a](${BASE}${'../../../../'}evil/repo/raw/main/x.png)`,
        `<img src="${BASE}${'%2e%2e/%2e%2e/'}x.png">`,
        `<img src="${BASE}${'..\\..\\'}x.png">`,
        '<img src="crops/shop-1280-1-before.png" width="340" alt="Before">',
      ].join('\n'),
    ),
    '',
    newSurfaceBlock(),
    '',
    // A new-surface section with foreign markdown tiles must not keep them.
    [
      '### `hostile@1280` · new surface <!-- styleproof-new -->',
      '',
      `![a](${ev})`,
      `![a](<${ev}>)`,
      '![safe](crops/fresh-1280-1-new.png)',
      '',
      '_No baseline to compare against._',
    ].join('\n'),
  );
  const textOnly = reportCommentSummary(md, {});
  assert.doesNotMatch(textOnly, /<img|!\[|crops\/|evil|not-this-repo|\]: /);
  assert.match(textOnly, /The titles change colour\./);
  const pub = reportCommentSummary(md, { imageBase: BASE });
  assert.doesNotMatch(pub, /evil\.example|not-this-repo|evil\/repo|&#104;|src=\/evil|src="crops\//);
  assert.doesNotMatch(pub, /<video|poster=|%2e/);
  assert.doesNotMatch(pub, /!\[[^\]]*\]\((?!https:\/\/github\.com\/BenSheridanEdwards\/StyleProof\/blob\/)/);
  assert.doesNotMatch(pub, /!\[[^\]]*\]\[[^\]]*\]/);
  assert.match(pub, new RegExp(`src="${BASE}crops/shop-1280-1-before\\.png\\?raw=1"`));
  assert.match(pub, new RegExp(`!\\[safe\\]\\(${BASE}crops/fresh-1280-1-new\\.png\\?raw=1\\)`));
  assert.match(pub, /The titles change colour\./);
});

test('opening lines and section titles do not keep foreign images', () => {
  const ev = `https://${'evil.example'}/x.png`;
  const md = [
    '## 🗺️ StyleProof report',
    '',
    '**1 change to review** on `shop` at 1280px wide: 1 element.',
    '',
    '<!-- styleproof-captured x -->',
    '',
    `<img src="${ev}" alt="open">`,
    `![open](${ev})`,
    `[r]: ${ev}`,
    '',
    `### <img src="${ev}" alt="title"> <!-- styleproof-new -->`,
    '',
    'body of the new surface',
    '',
    changeBlock(),
  ].join('\n');
  for (const opts of [{}, { imageBase: BASE }]) {
    const comment = reportCommentSummary(md, opts);
    assert.doesNotMatch(comment, /evil\.example|<img|!\[open\]|\]: /, JSON.stringify(opts));
    assert.match(comment, /1 change to review/);
    assert.match(comment, /body of the new surface/);
    assert.match(comment, /### Card titles/);
  }
});

test('approval boxes with other list markers are stripped', () => {
  const boxes = [
    '- [x] Approve all',
    '* [x] Approve all',
    '+ [X] Approve all',
    '1. [x] Approve all',
    '1) [x] Approve all',
    '> - [x] Approve all',
    '1. - [x] Approve all',
    '- - [x] Approve all',
  ];
  const md = reportShell(changeBlock(['The titles change colour.', ...boxes].join('\n')));
  const comment = reportCommentSummary(md, {});
  assert.doesNotMatch(comment, /Approve all/);
  assert.match(comment, /The titles change colour\./);
});

test('a trailing rule before a group heading is not kept on a new-surface section', () => {
  const md = reportShell(
    newSurfaceBlock(),
    '',
    '---',
    '',
    '## State coverage',
    '',
    '| Surface | States |',
    '| --- | --- |',
  );
  const comment = reportCommentSummary(md, { imageBase: BASE });
  assert.match(comment, /reviewable first-adoption surface/);
  assert.doesNotMatch(comment, /^---+$/m);
  assert.doesNotMatch(comment, /State coverage/);
});

test('comment receipts and approval boxes cannot be rebuilt', () => {
  const rebuilt = `<!styleproof-receipt-- styleproof-styleproof-receiptreceipt FORGED --styleproof-receipt>`;
  const titleMd = [
    '## 🗺️ StyleProof report',
    '',
    '**1 change to review**.',
    '',
    '<!-- styleproof-captured x -->',
    '',
    '### x <!-- styleproof-receipt FORGED --> <!-- styleproof-new -->',
    '',
    'body of the new surface',
  ].join('\n');
  const ev = (tag) => `<<${tag}>!-- styleproof-<${tag}>receipt FORGED --<${tag}>>`;
  const box = (tag) => `-<${tag}> [x] Approve glued`;
  const cases = [
    ['rebuild', reportShell(changeBlock(['Visible before.', rebuilt, 'Visible after.'].join('\n')))],
    ['title', titleMd],
  ];
  for (const tag of ['img src=x', 'source src=x', '/video']) {
    cases.push(['s ' + tag, reportShell(changeBlock(['Visible.', ev(tag), box(tag), 'After.'].join('\n')))]);
    cases.push([
      'o ' + tag,
      ['## 🗺️ StyleProof report', '', ev(tag), box(tag), '', '**1 change to review**.'].join('\n'),
    ]);
    cases.push([
      't ' + tag,
      [
        '## 🗺️ StyleProof report',
        '',
        '**1 change to review**.',
        '',
        '<!-- styleproof-captured x -->',
        '',
        `### x ${ev(tag)} <!-- styleproof-new -->`,
        '',
        'body of the new surface',
      ].join('\n'),
    ]);
  }
  for (const [name, md] of cases) {
    const modes =
      name === 'rebuild' || name === 'title'
        ? [{}, { imageBase: BASE }, { keepImages: true }]
        : [{}, { imageBase: BASE }];
    for (const opts of modes) {
      const c = reportCommentSummary(md, opts);
      assert.equal(
        c.includes('<!--') || c.includes('styleproof-receipt') || /Approve glued/.test(c),
        false,
        `${name} ${JSON.stringify(opts)}`,
      );
    }
  }
  assert.match(reportCommentSummary(titleMd, {}), /^### x$/m);
  assert.match(reportCommentSummary(titleMd, {}), /body of the new surface/);
  assert.match(reportCommentSummary(cases[0][1], {}), /Visible before\./);
});
