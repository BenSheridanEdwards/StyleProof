import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { classifyScriptReach } from '../../../dist/script-join.js';
import { publishedReach, reachStripLines, reachSectionLines } from '../../../dist/report/reach.js';
import { renderReportHtml } from '../../../dist/report/html.js';
import { budgetScriptReach, reserveScriptNotice } from '../../../dist/report/script-units.js';

const proofDir = path.dirname(fileURLToPath(import.meta.url));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-map-guidance-proof-'));
const capture = (scripts) => ({ scriptReach: { version: 1, status: 'measured', window: 'navigation', scripts } });
const mapped = capture([{ url: '/app.js', status: 'mapped', files: [] }]);
const absent = (...urls) => capture(urls.map((url) => ({ url, status: 'unmeasured', reason: 'source map absent' })));
const reports = [
  ['Next.js head maps absent', mapped, absent('/_next/static/chunks/app.js'), 'source-map-gap.png'],
  ['Other bundler head maps absent', mapped, absent('/assets/app.js'), 'other-source-map-gap.png'],
  ['Base maps absent; head maps available', absent('/assets/app.js'), mapped, 'base-source-map-gap.png'],
  [
    'Missing-map count after detail truncation',
    absent('/base-a.js', '/base-b.js'),
    absent('/head-a.js', '/head-b.js', '/head-c.js'),
    'budgeted-source-map-gap.png',
    0,
  ],
].map(([name, base, head, png, budget]) => {
  const reach = {
    level: 'warn',
    blocking: 0,
    complete: false,
    ledger: 'complete',
    counts: { reached: 0, 'never-rendered': 0, unmeasured: 0, 'blind-channel': 0 },
    rules: [],
    unreadableSheets: 0,
    scripts: [],
    scriptCounts: { reached: 0, 'never-rendered': 0, unmeasured: 0, unknown: 0 },
    classes: [],
    gaps: classifyScriptReach([base], [head], []).gaps,
  };
  return { name, png, reach: budget === 0 ? budgetScriptReach(reach, reserveScriptNotice(reach), 0).reach : reach };
});
const markdownFor = ({ name, reach }) =>
  [
    '# Source-map guidance diagnostic',
    '',
    'Synthetic fixture; this does not certify a CSS comparison.',
    '',
    `## ${name}`,
    ...reachStripLines(reach),
    ...reachSectionLines(reach),
  ].join('\n');
let browser;
try {
  fs.writeFileSync(path.join(proofDir, 'report.md'), reports.map(markdownFor).join('\n\n'));
  fs.writeFileSync(
    path.join(proofDir, 'report.json'),
    JSON.stringify(
      { synthetic: true, cases: reports.map(({ name, reach }) => ({ name, gaps: publishedReach(reach).gaps })) },
      null,
      2,
    ) + '\n',
  );
  const htmlPath = path.join(scratch, 'report.html');
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  for (const report of reports) {
    fs.writeFileSync(htmlPath, renderReportHtml(markdownFor(report)));
    await page.goto(pathToFileURL(htmlPath).href);
    await page.screenshot({ path: path.join(proofDir, report.png), fullPage: true });
  }
  console.log('Generated the J2 notice and remedy from the current branch.');
} finally {
  await browser?.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}
