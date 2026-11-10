import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commentProblems, reportProblems, situationCounts } from './rule5-detector.mjs';

// The detector must fail on each class rule 5 forbids, using shapes earlier rounds shipped.
const LINK = '\n\n### 📊 [**Open the full visual report →**](https://github.com/o/r/blob/x/pr-1/report.md)\n\n---\n';

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
