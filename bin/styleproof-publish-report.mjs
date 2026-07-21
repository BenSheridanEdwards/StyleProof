#!/usr/bin/env node
// Publish a generated report folder to the report branch through the GitHub
// git-data API, verify the receipt at the published commit, and emit the
// action outputs. Costs the size of this report, not the size of the branch —
// see src/report-publish.ts for why cloning (even bloblessly) cannot do that.
//
// Usage:
//   styleproof-publish-report.mjs --repository owner/repo --branch styleproof-reports \
//     --report-path pr-123 --report-dir styleproof-report --head-sha <sha> \
//     --run-id <id> --run-attempt <n>
//
// Requires GH_TOKEN. Honours GITHUB_API_URL and appends sha/url/raw-base to
// GITHUB_OUTPUT when set.
import fs from 'node:fs';
import { collectReportFiles, publishReportFolder, verifyPublishedReceipt } from '../dist/report-publish.js';

const argv = process.argv.slice(2);
const options = {};
for (let index = 0; index < argv.length; index += 1) {
  const argument = argv[index];
  if (!argument.startsWith('--')) {
    console.error(`styleproof-publish-report: unexpected argument ${argument}`);
    process.exit(2);
  }
  options[argument.slice(2)] = argv[++index];
}

const required = ['repository', 'branch', 'report-path', 'report-dir', 'head-sha', 'run-id', 'run-attempt'];
for (const name of required) {
  if (!options[name]) {
    console.error(`styleproof-publish-report: missing --${name}`);
    process.exit(2);
  }
}
const token = process.env.GH_TOKEN;
if (!token) {
  console.error('styleproof-publish-report: GH_TOKEN is required');
  process.exit(2);
}

const apiBaseUrl = process.env.GITHUB_API_URL || 'https://api.github.com';
const expectedReceipt = `styleproof-receipt head-sha:${options['head-sha']} run-id:${options['run-id']} run-attempt:${options['run-attempt']}`;

const files = collectReportFiles(options['report-dir']);
// The receipt rides inside report.md so the read-back can prove the published
// artifact belongs to THIS run, not a stale survivor from an earlier attempt.
files[0] = {
  relativePath: 'report.md',
  content: Buffer.concat([files[0].content, Buffer.from(`\n<!-- ${expectedReceipt} -->\n`)]),
};

try {
  const { commitSha } = await publishReportFolder({
    apiBaseUrl,
    repository: options.repository,
    token,
    branch: options.branch,
    reportPath: options['report-path'],
    files,
    commitMessage: `StyleProof report ${options['report-path']} @ ${options['head-sha']}`,
  });
  await verifyPublishedReceipt({
    apiBaseUrl,
    repository: options.repository,
    token,
    reportPath: options['report-path'],
    commitSha,
    expectedReceipt,
  });
  console.error(`report receipt verified at ${commitSha}/${options['report-path']}`);
  const outputs = [
    `sha=${commitSha}`,
    `url=https://github.com/${options.repository}/blob/${commitSha}/${options['report-path']}/report.md`,
    `raw-base=https://raw.githubusercontent.com/${options.repository}/${commitSha}/${options['report-path']}`,
  ];
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${outputs.join('\n')}\n`);
  } else {
    console.log(outputs.join('\n'));
  }
} catch (error) {
  console.error(`::error::StyleProof: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
