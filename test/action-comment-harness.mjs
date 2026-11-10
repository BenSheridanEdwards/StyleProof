// Run the literal action.yml "Upsert PR comment" github-script step against a report directory
// with stubbed GitHub APIs, and return the comment body it would post. Test-only.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const actionYml = fs.readFileSync(path.join(root, 'action.yml'), 'utf8');
const nativeRequire = createRequire(import.meta.url);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const APPROVAL_STATUS = {
  id: 7,
  context: 'StyleProof',
  state: 'success',
  description: 'Approved by @maintainer (run 77)',
  created_at: '2026-01-01T00:00:30Z',
  creator: { type: 'Bot', login: 'github-actions[bot]' },
};

/** Every `${{ … }}` expression the comment step reads (its script and its env block). */
export function commentStepExpressions() {
  const step = actionYml.match(/- name: Upsert PR comment[\s\S]*?(?=\n {4}- name:)/)?.[0] ?? '';
  return [...new Set([...step.matchAll(/\$\{\{ (.+?) \}\}/g)].map((m) => m[1]))].sort();
}

/**
 * The Action inputs and step outputs the comment step reads, as the matrix varies them. Every
 * `${{ … }}` expression in the step must have a value here (the harness throws otherwise), so a
 * new input cannot slip past the matrix unnoticed.
 *
 * @param {{ reportDir: string, mode: 'review-gate' | 'certify' | 'migration' | 'advisory', trustState: string,
 *   failOnDiff?: boolean, requireApproval?: boolean, repositoryPrivate?: boolean, storage?: 'branch' | 'artifact',
 *   includeContent?: boolean, contentChanges?: number, baseCaptureFailed?: boolean, untrusted?: boolean,
 *   blocking?: 'true' | 'false' | 'advisory', changed?: boolean, approved?: boolean }} options
 */
export async function runActionComment({
  reportDir,
  mode,
  trustState,
  failOnDiff = mode === 'certify',
  requireApproval = mode === 'review-gate',
  repositoryPrivate = false,
  storage = 'branch',
  includeContent = false,
  contentChanges = 0,
  baseCaptureFailed = false,
  untrusted = false,
  blocking = 'true',
  changed = trustState !== 'NO_REVIEWABLE_STYLE_CHANGES',
  approved = false,
}) {
  const repository = { owner: 'BenSheridanEdwards', repo: 'StyleProof' };
  const sha = 'a'.repeat(40);
  const url =
    storage === 'branch'
      ? `https://github.com/${repository.owner}/${repository.repo}/blob/${sha}/pr-42/report.md`
      : `https://github.com/${repository.owner}/${repository.repo}/actions/runs/9001/artifacts/4451`;
  const values = new Map([
    ['steps.context.outputs.pr-number', '42'],
    ['github.run_id', '9001'],
    ['github.run_attempt', '1'],
    ['steps.publish.outputs.url || steps.report-artifact.outputs.artifact-url', url],
    ['steps.report-artifact.outputs.artifact-digest', 'd'.repeat(64)],
    ['steps.delivery.outputs.upload', 'true'],
    ['steps.publish.outputs.sha', sha],
    ['inputs.report-storage', storage],
    ['inputs.report-retention-days', '30'],
    ['steps.diff.outputs.changed', String(changed)],
    ['inputs.require-approval', String(requireApproval)],
    [
      "inputs.fail-on-diff == 'true' && inputs.require-approval != 'true' && inputs.mode == 'certify'",
      String(failOnDiff && !requireApproval && mode === 'certify'),
    ],
    ['inputs.mode', mode],
    ['steps.config.outputs.blocking', blocking],
    ['steps.gate.outputs.approved', 'false'],
    ['steps.gate.outputs.approver', ''],
    ['inputs.status-context', 'StyleProof'],
    ['toJSON(inputs.comment-marker)', JSON.stringify('<!-- styleproof-report -->')],
    ['steps.verdict.outputs.state', trustState],
    ['steps.verdict.outputs.diff-digest', 'd'.repeat(64)],
    ['steps.context.outputs.head-sha', 'c'.repeat(40)],
    ['inputs.include-content', String(includeContent)],
    ['steps.report.outputs.content-changes', String(contentChanges)],
    ['inputs.base-capture-failed', String(baseCaptureFailed)],
    ['steps.context.outputs.untrusted-capture', String(untrusted)],
  ]);
  const step = actionYml.match(/- name: Upsert PR comment[\s\S]*?script: \|\n([\s\S]*?)(?=\n\s{4}#|\n\s{4}- name:)/);
  if (!step) throw new Error('action.yml has no "Upsert PR comment" script');
  let script = step[1]
    .split('\n')
    .map((line) => line.replace(/^ {10}/, ''))
    .join('\n');
  const envBlock = actionYml.match(/- name: Upsert PR comment[\s\S]*?\n {6}env:\n([\s\S]*?)\n {6}with:/);
  const environment = {};
  for (const [, name, expression] of (envBlock?.[1] ?? '').matchAll(/^ {8}([A-Z_]+): \$\{\{ (.+?) \}\}$/gm)) {
    if (!values.has(expression)) throw new Error(`no harness value for ${expression}`);
    environment[name] = values.get(expression);
  }
  script = `Object.assign(process.env, ${JSON.stringify(environment)});\n${script}`;
  for (const [expression, value] of values) script = script.replaceAll(`\${{ ${expression} }}`, value);
  if (/\$\{\{/.test(script)) throw new Error('unreplaced expression in the comment step');

  const created = [];
  const github = {
    paginate: async (route, params) => (await route({ ...params, page: 1 })).data,
    rest: {
      pulls: { get: async () => ({ data: { head: { sha: 'c'.repeat(40) } } }) },
      // An already-approved re-run: the commit carries a valid approval receipt for this digest,
      // the runtime input readReviewApproval reads (src/review-approval.ts).
      repos: { listCommitStatusesForRef: async () => ({ data: approved ? [APPROVAL_STATUS] : [] }) },
      actions: {
        getWorkflowRun: async () => ({
          data: {
            status: 'completed',
            conclusion: 'success',
            event: 'issue_comment',
            head_branch: 'main',
            triggering_actor: { login: 'maintainer' },
            run_started_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:01:00Z',
          },
        }),
        listWorkflowRunArtifacts: async () => ({
          data: { artifacts: [{ name: `styleproof-approval-42-${'c'.repeat(40)}-${'d'.repeat(64)}`, expired: false }] },
        }),
      },
      issues: {
        listComments: async () => ({ data: [] }),
        createComment: async (input) => {
          created.push(input);
          return { data: { id: 1 } };
        },
        updateComment: async () => ({ data: { id: 1 } }),
      },
    },
  };
  const files = {
    'styleproof-report/report.md': path.join(reportDir, 'report.md'),
    'styleproof-report/report.json': path.join(reportDir, 'report.json'),
  };
  const requireForScript = (specifier) =>
    specifier === 'fs'
      ? {
          existsSync: (file) => file in files && fs.existsSync(files[file]),
          readFileSync: (file) => fs.readFileSync(files[file], 'utf8'),
        }
      : nativeRequire(specifier);
  const core = { setOutput: () => {}, info: () => {}, warning: () => {} };
  const context = { repo: repository, payload: { repository: { private: repositoryPrivate, default_branch: 'main' } } };
  const previous = process.env.GITHUB_ACTION_PATH;
  process.env.GITHUB_ACTION_PATH = root;
  try {
    await new AsyncFunction('require', 'github', 'context', 'core', script)(requireForScript, github, context, core);
  } finally {
    if (previous === undefined) delete process.env.GITHUB_ACTION_PATH;
    else process.env.GITHUB_ACTION_PATH = previous;
  }
  if (!created[0]) throw new Error('the comment step posted no comment');
  return created[0].body;
}
