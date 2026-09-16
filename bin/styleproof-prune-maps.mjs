#!/usr/bin/env node
// Prune stale bundles from the sha-keyed map store branch and squash its history
// through the GitHub git-data API — never by cloning the branch. Requires GH_TOKEN
// with contents:write. Exits 0 when nothing is prunable or the branch is absent.
import { compactMapStoreBranch } from '../dist/map-store-prune.js';
import { loadStyleProofConfigAsync } from '../dist/config.js';
import { defineCli, githubApi, number, run } from './cli.mjs';

const NAME = 'styleproof-prune-maps';
const cli = defineCli({
  name: NAME,
  alias: 'prune-maps',
  usage: [`${NAME} --repository <owner/repo> [options]`],
  flags: {
    repository: { value: 'owner/repo', help: 'GitHub repository', required: true },
    branch: { value: 'name', help: 'map store branch', default: 'styleproof-maps' },
    'retention-days': {
      value: 'days',
      help: 'bundles newer than this survive (default: mapStore.pruneRetentionDays or 14)',
    },
    'max-bundles': { value: 'count', help: 'at most this many bundles survive', default: 40 },
    'budget-bytes': {
      value: 'bytes',
      help: 'prune oldest bundles over this size budget (default: mapStore.pruneBudgetBytes or 1.5GB)',
    },
    'history-limit': {
      value: 'count',
      help: 'skip the rewrite when nothing is prunable and the branch holds no more commits than this',
      default: 30,
    },
  },
});

const { opts } = cli.parse();
const config = await loadStyleProofConfigAsync();
const numeric = (flag, fallback) => number(NAME, flag, opts[flag], { min: 0 }) ?? fallback;

await run(NAME, async () => {
  const result = await compactMapStoreBranch({
    ...githubApi(NAME, { repository: opts.repository, branch: opts.branch, tokenEnv: ['GH_TOKEN', 'GITHUB_TOKEN'] }),
    retentionDays: numeric('retention-days', config.mapStore?.pruneRetentionDays ?? 14),
    maximumBundleCount: numeric('max-bundles', 40),
    budgetBytes: numeric('budget-bytes', config.mapStore?.pruneBudgetBytes ?? 1_500_000_000),
    historyCommitLimit: numeric('history-limit', 30),
  });
  console.log(
    result.compacted
      ? `${NAME}: retained ${result.retainedDirectoryNames.length}, pruned ${result.prunedDirectoryNames.length}, history squashed to one commit`
      : `${NAME}: nothing to prune`,
  );
});
