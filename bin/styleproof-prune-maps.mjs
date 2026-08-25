#!/usr/bin/env node
// Prune stale bundles from the sha-keyed map store branch and squash its
// history to a single commit, through the GitHub git-data API — never by
// cloning the branch (#423). The map store is a cache: bundles for commits the
// base branch has moved past can never be restored again, and nothing links
// into the branch, so both the tip and the history are safe to rewrite.
//
//   styleproof-prune-maps --repository owner/repo \
//     [--branch styleproof-maps] [--retention-days 14] [--max-bundles 40] \
//     [--history-limit 30]
//
// Requires GH_TOKEN with contents:write. Honours GITHUB_API_URL. Exits 0 when
// there is nothing to prune or the branch does not exist yet.
import { compactMapStoreBranch } from '../dist/map-store-prune.js';

const HELP = `usage: styleproof-prune-maps --repository <owner/repo> [options]

Options:
  --branch <name>          map store branch (default: styleproof-maps)
  --retention-days <days>  bundles newer than this survive (default: 14)
  --max-bundles <count>    at most this many bundles survive (default: 40)
  --history-limit <count>  skip the rewrite when nothing is prunable and the
                           branch holds no more than this many commits
                           (default: 30)
  -h, --help               show this help`;

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(HELP);
  process.exit(0);
}
const options = {};
for (let index = 0; index < argv.length; index += 1) {
  const argument = argv[index];
  if (!argument.startsWith('--')) {
    console.error(`styleproof-prune-maps: unexpected argument ${argument}`);
    process.exit(2);
  }
  const equals = argument.indexOf('=');
  const name = argument.slice(2, equals === -1 ? undefined : equals);
  const value = equals === -1 ? argv[++index] : argument.slice(equals + 1);
  if (!name || value === undefined || value === '' || value.startsWith('--')) {
    console.error(`styleproof-prune-maps: missing value for --${name || argument.slice(2)}`);
    process.exit(2);
  }
  options[name] = value;
}

if (!options.repository) {
  console.error('styleproof-prune-maps: missing --repository');
  process.exit(2);
}
const numericOption = (name, fallback) => {
  if (options[name] === undefined) return fallback;
  const parsed = Number(options[name]);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.error(`styleproof-prune-maps: --${name} must be a finite non-negative number`);
    process.exit(2);
  }
  return parsed;
};
const retentionDays = numericOption('retention-days', 14);
const maximumBundleCount = numericOption('max-bundles', 40);
const historyCommitLimit = numericOption('history-limit', 30);

const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!token) {
  console.error('styleproof-prune-maps: GH_TOKEN (or GITHUB_TOKEN) is required');
  process.exit(2);
}

try {
  const result = await compactMapStoreBranch({
    apiBaseUrl: process.env.GITHUB_API_URL || 'https://api.github.com',
    repository: options.repository,
    token,
    branch: options.branch || 'styleproof-maps',
    retentionDays,
    maximumBundleCount,
    historyCommitLimit,
  });
  if (result.compacted) {
    console.log(
      `styleproof-prune-maps: retained ${result.retainedDirectoryNames.length}, ` +
        `pruned ${result.prunedDirectoryNames.length}, history squashed to one commit`,
    );
  } else {
    console.log('styleproof-prune-maps: nothing to prune');
  }
} catch (error) {
  console.error(`styleproof-prune-maps: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
