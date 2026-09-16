#!/usr/bin/env node
// Prune pr-<n>/ report folders from the report branch through the GitHub git-data
// API — never by cloning the branch. Close mode deletes one PR's folder; sweep mode
// applies the retention window, then the size budget (oldest closed first).
import {
  deleteReportFolders,
  readClosedPullRequestTimestamps,
  selectReportFoldersToPrune,
} from '../dist/report-prune.js';
import { loadStyleProofConfigAsync } from '../dist/config.js';
import { defineCli, githubApi, number, run } from './cli.mjs';

const NAME = 'styleproof-prune-reports';
const cli = defineCli({
  name: NAME,
  alias: 'prune-reports',
  usage: [`${NAME} --repository <owner/repo> [options]`],
  summary:
    'Delete one closed pull request report (--pull-request), or sweep closed reports by retention and size budget.',
  flags: {
    repository: { value: 'owner/repo', help: 'GitHub repository', required: true },
    'pull-request': { value: 'n', help: 'delete this pull request report folder' },
    'retention-days': {
      value: 'days',
      help: 'sweep: reports closed longer ago than this (default: reportStore.pruneRetentionDays or 30)',
    },
    'budget-bytes': {
      value: 'bytes',
      help: 'sweep: branch size budget (default: reportStore.pruneBudgetBytes or 2GB)',
    },
    branch: { value: 'name', help: 'report branch', default: 'styleproof-reports' },
  },
});

const { opts } = cli.parse();
const sweepMode =
  opts['retention-days'] !== undefined || opts['budget-bytes'] !== undefined || opts['pull-request'] === undefined;
if (sweepMode && opts['pull-request'] !== undefined) {
  console.error(`${NAME}: pass either --pull-request <n>, or --retention-days <d> with --budget-bytes <b>`);
  process.exit(2);
}
const pullRequest = number(NAME, 'pull-request', opts['pull-request'], { integer: true, min: 1 });
const retentionDays = number(NAME, 'retention-days', opts['retention-days'], { min: 0 });
const budgetBytes = number(NAME, 'budget-bytes', opts['budget-bytes'], { min: 0 });
const config = await loadStyleProofConfigAsync();
const api = githubApi(NAME, { repository: opts.repository, branch: opts.branch });

await run(NAME, async () => {
  if (!sweepMode) {
    const { deletedFolders } = await deleteReportFolders({
      ...api,
      selectFolders: () => [`pr-${pullRequest}`],
      commitMessage: () => `chore(styleproof): prune report for closed PR #${pullRequest}`,
    });
    console.error(
      deletedFolders.length ? `pruned ${deletedFolders.join(', ')}` : `no pr-${pullRequest}/ folder — nothing to prune`,
    );
    return;
  }
  const days = retentionDays ?? config.reportStore?.pruneRetentionDays ?? 30;
  const retentionCutoffEpochSeconds = Math.floor(Date.now() / 1000) - days * 86400;
  const closedAtEpochSecondsByPath = await readClosedPullRequestTimestamps(api);
  const { deletedFolders } = await deleteReportFolders({
    ...api,
    selectFolders: (folderSizesBytesByPath) => {
      const selection = selectReportFoldersToPrune({
        folderSizesBytesByPath,
        closedAtEpochSecondsByPath,
        retentionCutoffEpochSeconds,
        budgetBytes: budgetBytes ?? config.reportStore?.pruneBudgetBytes ?? 2_000_000_000,
      });
      console.error(`branch size after prune: ${(selection.branchSizeAfterBytes / 1e9).toFixed(2)} GB`);
      if (selection.openFoldersExceedBudget) {
        console.error(
          '::warning::open pull request reports alone exceed the size budget; every closed report is already pruned',
        );
      }
      return selection.foldersToDelete;
    },
    commitMessage: (count) => `chore(styleproof): prune ${count} expired reports`,
  });
  console.error(
    deletedFolders.length
      ? `pruned ${deletedFolders.length} report folders`
      : 'no report folders were outside the retention window or the size budget',
  );
});
