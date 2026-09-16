#!/usr/bin/env node
// Publish a generated report folder to the report branch through the GitHub
// git-data API, verify the receipt at the published commit, and emit the action
// outputs (sha, url, raw-base). Costs the size of this report, not of the branch.
import { collectReportFiles, publishReportFolder, verifyPublishedReceipt } from '../dist/report-publish.js';
import { defineCli, emitOutputs, githubApi, run } from './cli.mjs';

const NAME = 'styleproof-publish-report';
const cli = defineCli({
  name: NAME,
  alias: 'publish-report',
  usage: [
    `${NAME} --repository <owner/repo> --branch <name> --report-path <path> --report-dir <dir> --head-sha <sha> --run-id <id> --run-attempt <n>`,
  ],
  flags: {
    repository: { value: 'owner/repo', help: 'GitHub repository', required: true },
    branch: { value: 'name', help: 'report branch', required: true },
    'report-path': { value: 'path', help: 'destination folder on the report branch', required: true },
    'report-dir': { value: 'dir', help: 'generated report directory', required: true },
    'head-sha': { value: 'sha', help: 'pull request head commit', required: true },
    'run-id': { value: 'id', help: 'GitHub Actions run id', required: true },
    'run-attempt': { value: 'n', help: 'GitHub Actions run attempt', required: true },
  },
});

const { opts } = cli.parse();
const api = githubApi(NAME, { repository: opts.repository, branch: opts.branch });
const reportPath = opts['report-path'];
const expectedReceipt = `styleproof-receipt head-sha:${opts['head-sha']} run-id:${opts['run-id']} run-attempt:${opts['run-attempt']}`;

// The receipt rides inside report.md so the read-back proves the published
// artifact belongs to THIS run, not a stale survivor from an earlier attempt.
const files = collectReportFiles(opts['report-dir']);
files[0] = {
  relativePath: 'report.md',
  content: Buffer.concat([files[0].content, Buffer.from(`\n<!-- ${expectedReceipt} -->\n`)]),
};

await run(NAME, async () => {
  const { commitSha } = await publishReportFolder({
    ...api,
    reportPath,
    files,
    commitMessage: `StyleProof report ${reportPath} @ ${opts['head-sha']}`,
  });
  await verifyPublishedReceipt({ ...api, reportPath, commitSha, expectedReceipt });
  console.error(`report receipt verified at ${commitSha}/${reportPath}`);
  emitOutputs([
    `sha=${commitSha}`,
    `url=https://github.com/${opts.repository}/blob/${commitSha}/${reportPath}/report.md`,
    `raw-base=https://raw.githubusercontent.com/${opts.repository}/${commitSha}/${reportPath}`,
  ]);
});
