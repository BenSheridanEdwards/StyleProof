import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commentProblems, htmlText, reportProblems, situationCounts } from './rule5-detector.mjs';

// The detector must fail on each class rule 5 forbids, using shapes earlier rounds shipped.
const LINK =
  '\n\n### 📊 [**Open the full visual report →**](https://github.com/BenSheridanEdwards/StyleProof/blob/x/pr-1/report.md)\n\n---\n';

test('a fact said twice in other words is caught (QA9-01 volatile triple)', () => {
  const md = [
    '✗ Not certified — a subtree became volatile on head and was excluded from the comparison, so StyleProof cannot certify this compare; not a clean no-change.',
    '',
    '✗ **1 subtree(s) newly volatile on head** — still mutating at capture settle on the head but settled and compared on the base, so it was excluded from the comparison and whatever changed inside it is **not certified**.',
  ].join('\n');
  assert.ok(reportProblems('report.md', md).some((p) => /share|said twice|say the same thing/.test(p)));
});

test('a surface list repeated in the summary and the footer is caught (QA9-02)', () => {
  const body =
    '## 🗺️ StyleProof report\n\n⚠️ **2 surfaces failed to capture on the base:** `p0@1280` at `' +
    'b'.repeat(40) +
    '`, `p1@1280` at `' +
    'b'.repeat(40) +
    '`. The rest of the base was captured; repair those surfaces on that commit and recapture.' +
    LINK +
    '_`p0@1280` at `' +
    'b'.repeat(40) +
    '` failed on the listed base SHA — this is not a base recapture failure. Repair those surfaces on that SHA._';
  const found = commentProblems('comment', body);
  assert.ok(
    found.some((p) => /p0@1280 is stated in two blocks/.test(p)),
    found.join('\n'),
  );
  assert.ok(
    found.some((p) => /contradiction/.test(p)),
    found.join('\n'),
  );
});

test('approval talk in report text and "below" in the comment are caught (QA9-01, QA9-05)', () => {
  assert.ok(
    reportProblems('report.md', 'Review the head rendering there and approve.').some((p) => /approval/.test(p)),
  );
  const body =
    '## 🗺️ StyleProof report\n\n📝 _1 advisory content change(s) below — they do not affect the check._' + LINK;
  assert.ok(commentProblems('comment', body).some((p) => /below/.test(p)));
});

test('a count that disagrees with report.json is caught', () => {
  const md =
    '⚠️ **12 surfaces failed to capture on the base:** `p0@1280` at `x` and 3 more, all listed in report.json.';
  const found = situationCounts(md, { baselineFailures: Array.from({ length: 12 }), surfaces: [] });
  assert.ok(
    found.some((p) => /names 1 failed surfaces and 3 more, but says 12/.test(p)),
    found.join('\n'),
  );
});

test('approval wording inside emphasis and in any inflection is caught (QA10-03)', () => {
  for (const line of [
    '_Approving this surface accepts the change._',
    '*approve* once reviewed.',
    'The differences are not shown as changes to approve.',
    '_⚠️ Page capped: the rest is not shown, so approving this surface accepts content not reviewed here._',
    'Sign off on it once the new colour is reviewed.',
    '**Approved** changes stay green.',
    'Approval accepts it.',
  ]) {
    assert.ok(
      reportProblems('report.md', line).some((p) => /approval/.test(p)),
      line,
    );
    assert.ok(
      commentProblems('comment', `## 🗺️ StyleProof report\n\n${line}${LINK}`).some((p) => /approval/.test(p)),
      line,
    );
  }
});

test('pointers at places the comment does not carry are caught (QA10-03)', () => {
  for (const line of [
    '_The content changes are further down._',
    '_The content changes are _below_._',
    'The content changes are **below**.',
    'The content changes are <em>Below</em>.',
    '_The content changes are **Further down**._',
    '_The content changes are in the next section._',
    '_1 surface with computed-style differences; each change is a section under Changes._',
    '_The never-matched rules: see Changed but never matched._',
  ]) {
    assert.ok(commentProblems('comment', `## 🗺️ StyleProof report\n\n${line}${LINK}`).length > 0, line);
  }
  assert.deepEqual(
    commentProblems(
      'comment',
      '## 🗺️ StyleProof report\n\n_Each rule is named in the full report; see the full report._' + LINK,
    ),
    [],
  );
});

const section = (title, line, extra = []) => [`### ${title}`, '', line, '', ...extra, ''].join('\n');

test('parallel per-section lines are allowed by rule; a note repeated per section is not (QA10-03)', () => {
  // Two sections, each with its own change line ending in the same clause: parallel, allowed.
  const parallel = [
    '## Changes',
    '',
    section(
      'Add to basket buttons',
      'On all 3 Add to basket buttons, the background changes from dark indigo to red when hovered. At rest they look the same.',
    ),
    section(
      'Opt labels',
      'On both opt labels (Email, SMS), the text colour changes from green to red when the matching opt is checked. At rest they look the same.',
      ['`label.opt-label` · 2 elements restyled · when `input.opt` is `:checked`'],
    ),
    section(
      'Offers label',
      'On the offers label (Offers), the text colour changes from green to red when the offers check is checked.',
      ['`label.offers-label` · 1 element restyled · when `input.offers-check` is `:checked`'],
    ),
  ].join('\n');
  assert.deepEqual(reportProblems('report.md', parallel), []);
  // The same note as its own paragraph under two sections: said twice.
  const note =
    '_Crop omitted: this change group reached the `--max-crops` limit (8). The change is still listed and counted._';
  const repeated = [
    '## Changes',
    '',
    section('Chip', 'The chip text colour changes from teal to red.', [note]),
    section('Badge', 'The badge text colour changes from green to red.', [note]),
  ].join('\n');
  assert.ok(
    reportProblems('report.md', repeated).some((p) => /said twice/.test(p)),
    reportProblems('report.md', repeated).join('\n'),
  );
  // Outside change sections the same clause is a repeat, as before.
  assert.ok(
    reportProblems(
      'report.md',
      'The buttons change colour. At rest they look the same.\n\nAt rest they look the same.',
    ).some((p) => /said twice/.test(p)),
  );
});

test('an empty paragraph under the title is caught (QA10-04)', () => {
  const md = '## 🗺️ StyleProof report\n\n\n✗ **1 subtree(s) newly volatile on head** — excluded.\n';
  assert.ok(reportProblems('report.md', md).some((p) => /empty paragraph/.test(p)));
  assert.deepEqual(reportProblems('report.md', md.replace('\n\n\n', '\n\n')), []);
});

test('approval wording inside HTML emphasis is caught in report.html (QA10-03)', () => {
  const html = '<main><p>The page is capped, <em>so approving this surface</em> accepts it.</p></main>';
  assert.ok(reportProblems('report.html', htmlText(html)).some((p) => /approval/.test(p)));
});
