import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { renderArtifactHtml } from '../../../dist/report/html.js';

const proofDir = path.dirname(fileURLToPath(import.meta.url));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-storage-proof-'));
const markdown =
  '# Artifact storage diagnostic\n\nSynthetic fixture; no CSS comparison is being certified. A 1.1 MB JSON receipt exercises the storage notice without uploading raw captures.\n';
let browser;
try {
  fs.writeFileSync(path.join(scratch, 'report.md'), markdown);
  fs.writeFileSync(
    path.join(scratch, 'report.json'),
    JSON.stringify({ synthetic: true, padding: 'x'.repeat(1_100_000) }),
  );
  const receiptBytes = ['report.md', 'report.json'].reduce(
    (sum, name) => sum + fs.statSync(path.join(scratch, name)).size,
    0,
  );
  const html = renderArtifactHtml(markdown, { outDir: scratch, maxBytes: 2_000_000, receiptBytes });
  const htmlPath = path.join(scratch, 'report.html');
  fs.writeFileSync(htmlPath, html);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  await page.goto(pathToFileURL(htmlPath).href);
  await page.screenshot({ path: path.join(proofDir, 'report-size-warning.png'), fullPage: true });
  console.log('Generated the storage notice from the current branch; receipt bytes:', receiptBytes);
} finally {
  await browser?.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}
