#!/usr/bin/env node
// Prune pr-<n>/ report folders from the report branch through the GitHub
// git-data API — never by cloning the branch. Two modes:
//
//   Close (delete one PR's folder):
//     styleproof-prune-reports.mjs --repository owner/repo --pull-request 123
//
//   Scheduled sweep (retention window, then a hard size budget,
//   oldest-closed first, open PRs never touched):
//     styleproof-prune-reports.mjs --repository owner/repo \
//       --retention-days 14 --budget-bytes 1500000000
//
// Requires GH_TOKEN. Honours GITHUB_API_URL. --branch defaults to
// styleproof-reports. Exits 0 when there is nothing to prune.
import {
  deleteReportFolders,
  readClosedPullRequestTimestamps,
  selectReportFoldersToPrune,
} from '../dist/report-prune.js';

const HELP = `usage: styleproof-prune-reports --repository <owner/repo> [options]

Delete one closed pull request report:
  --pull-request <n>

Sweep closed reports by retention and branch-size budget:
  --retention-days <days> --budget-bytes <bytes>

Options:
  --branch <name>       report branch (default: styleproof-reports)
  -h, --help            show this help`;

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(HELP);
  process.exit(0);
}
const options = {};
for (let index = 0; index < argv.length; index += 1) {
  const argument = argv[index];
  if (!argument.startsWith('--')) {
    console.error(`styleproof-prune-reports: unexpected argument ${argument}`);
    process.exit(2);
  }
  const equals = argument.indexOf('=');
  const name = argument.slice(2, equals === -1 ? undefined : equals);
  const value = equals === -1 ? argv[++index] : argument.slice(equals + 1);
  if (!name || value === undefined || value === '' || value.startsWith('--')) {
    console.error(`styleproof-prune-reports: missing value for --${name || argument.slice(2)}`);
    process.exit(2);
  }
  options[name] = value;
}

if (!options.repository) {
  console.error('styleproof-prune-reports: missing --repository');
  process.exit(2);
}
const sweepMode = options['retention-days'] !== undefined || options['budget-bytes'] !== undefined;
if (sweepMode === (options['pull-request'] !== undefined)) {
  console.error(
    'styleproof-prune-reports: pass either --pull-request <n>, or --retention-days <d> with --budget-bytes <b>',
  );
  process.exit(2);
}
if (sweepMode && (options['retention-days'] === undefined || options['budget-bytes'] === undefined)) {
  console.error('styleproof-prune-reports: sweep mode needs both --retention-days and --budget-bytes');
  process.exit(2);
}
const pullRequest = options['pull-request'] === undefined ? undefined : Number(options['pull-request']);
if (pullRequest !== undefined && (!Number.isInteger(pullRequest) || pullRequest <= 0)) {
  console.error('styleproof-prune-reports: --pull-request must be a positive integer');
  process.exit(2);
}
const retentionDays = options['retention-days'] === undefined ? undefined : Number(options['retention-days']);
if (retentionDays !== undefined && (!Number.isFinite(retentionDays) || retentionDays < 0)) {
  console.error('styleproof-prune-reports: --retention-days must be a finite non-negative number');
  process.exit(2);
}
const budgetBytes = options['budget-bytes'] === undefined ? undefined : Number(options['budget-bytes']);
if (budgetBytes !== undefined && (!Number.isFinite(budgetBytes) || budgetBytes < 0)) {
  console.error('styleproof-prune-reports: --budget-bytes must be a finite non-negative number');
  process.exit(2);
}
const token = process.env.GH_TOKEN;
if (!token) {
  console.error('styleproof-prune-reports: GH_TOKEN is required');
  process.exit(2);
}

const apiOptions = {
  apiBaseUrl: process.env.GITHUB_API_URL || 'https://api.github.com',
  repository: options.repository,
  token,
  branch: options.branch || 'styleproof-reports',
};

try {
  if (!sweepMode) {
    const { deletedFolders } = await deleteReportFolders({
      ...apiOptions,
      selectFolders: () => [`pr-${pullRequest}`],
      commitMessage: () => `chore(styleproof): prune report for closed PR #${pullRequest}`,
    });
    console.error(
      deletedFolders.length === 0
        ? `no pr-${pullRequest}/ folder — nothing to prune`
        : `pruned ${deletedFolders.join(', ')}`,
    );
  } else {
    const retentionCutoffEpochSeconds = Math.floor(Date.now() / 1000) - retentionDays * 86400;
    const closedAtEpochSecondsByPath = await readClosedPullRequestTimestamps(apiOptions);
    const { deletedFolders } = await deleteReportFolders({
      ...apiOptions,
      selectFolders: (folderSizesBytesByPath) => {
        const selection = selectReportFoldersToPrune({
          folderSizesBytesByPath,
          closedAtEpochSecondsByPath,
          retentionCutoffEpochSeconds,
          budgetBytes,
        });
        console.error(`branch size after prune: ${(selection.branchSizeAfterBytes / 1e9).toFixed(2)} GB`);
        if (selection.openFoldersExceedBudget) {
          console.error(
            '::warning::open pull request reports alone exceed the size budget; every closed report is already pruned',
          );
        }
        return selection.foldersToDelete;
      },
      commitMessage: (deletedFolderCount) => `chore(styleproof): prune ${deletedFolderCount} expired reports`,
    });
    console.error(
      deletedFolders.length === 0
        ? 'no report folders were outside the retention window or the size budget'
        : `pruned ${deletedFolders.length} report folders`,
    );
  }
} catch (error) {
  console.error(`::error::StyleProof: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
