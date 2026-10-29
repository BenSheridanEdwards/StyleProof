import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import yaml from 'js-yaml';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const customMarker = '<!-- custom-report -->';
const head = 'a'.repeat(40);
const contains = (body, marker) => body.includes(marker);
const reusable = yaml.load(
  fs.readFileSync(new URL('../.github/workflows/styleproof-approve-reusable.yml', import.meta.url), 'utf8'),
);

test('1148: reusable approval declares the same comment-marker default as the Action', () => {
  assert.equal(
    reusable.on.workflow_call.inputs['comment-marker']?.default,
    '<!-- styleproof-report -->',
    'callers cannot pass the Action instance marker to approval',
  );
});

test('1148: the approval job admits a tick on the custom instance report', () => {
  const github = {
    event: {
      issue: { pull_request: {} },
      comment: { user: { type: 'Bot' }, body: customMarker },
      sender: { type: 'User' },
    },
  };
  const expression = reusable.jobs.approve.if.replaceAll('inputs.comment-marker', 'inputs["comment-marker"]');
  const accepted = new Function('github', 'inputs', 'contains', `return !!(${expression});`)(
    github,
    { 'comment-marker': customMarker },
    contains,
  );
  assert.equal(accepted, true, 'custom-marker checkbox edits are dropped before the approval job runs');
});

for (const file of ['.github/workflows/styleproof-approve-reusable.yml', 'example/styleproof-approve.yml']) {
  for (const marker of ['<!-- styleproof-report -->', customMarker]) {
    test(`1148: ${file} processes ${marker} and selects its own artifact`, async () => {
      const workflow = yaml.load(fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));
      const step = workflow.jobs.approve.steps.find((step) => step.with?.script);
      const url = 'https://github.com/owner/repo/actions/runs/42';
      const body = `${marker}\n- [x] **Approve all changes**\n[View report](${url})\n<!-- styleproof-sha:${head} -->\n<!-- styleproof-run-id:42 run-attempt:1 -->\n<!-- styleproof-artifact-digest:sha256:${'d'.repeat(64)} -->`;
      const comment = { id: 1, body, user: { type: 'Bot', login: 'github-actions[bot]' } };
      const downloads = [];
      const artifactName = `${marker.slice(5, -4)}-pr-7`;
      const github = {
        rest: {
          issues: {
            getComment: async () => ({ data: comment }),
            listComments: async () => ({ data: [comment] }),
            createComment: async () => ({}),
            updateComment: async () => ({}),
          },
          pulls: { get: async () => ({ data: { head: { sha: head }, user: { login: 'author' } } }) },
          repos: {
            getCollaboratorPermissionLevel: async () => ({ data: { permission: 'write' } }),
            listCommitStatusesForRef: async () => ({
              data: [
                {
                  context: 'StyleProof',
                  state: 'failure',
                  description: 'StyleProof changes need sign-off — tick the box in the report comment',
                  target_url: url,
                  creator: { type: 'Bot', login: 'github-actions[bot]' },
                },
              ],
            }),
          },
          actions: {
            listWorkflowRunArtifacts: async () => ({ data: [{ id: 99, name: artifactName }] }),
            downloadArtifact: async ({ artifact_id }) => {
              downloads.push(artifact_id);
              throw Object.assign(new Error('Not Found'), { status: 404 });
            },
          },
        },
      };
      github.paginate = async (method, parameters) => (await method(parameters)).data;
      const previous = { ...process.env };
      process.env.STYLEPROOF_STATUS_CONTEXT = 'StyleProof';
      process.env.STYLEPROOF_COMMENT_MARKER = marker;
      try {
        await new AsyncFunction('github', 'context', step.with.script)(github, {
          repo: { owner: 'owner', repo: 'repo' },
          payload: { issue: { number: 7 }, comment, sender: { login: 'reviewer' } },
        });
      } finally {
        for (const key of ['STYLEPROOF_STATUS_CONTEXT', 'STYLEPROOF_COMMENT_MARKER']) {
          if (previous[key] === undefined) delete process.env[key];
          else process.env[key] = previous[key];
        }
      }
      assert.deepEqual(
        downloads,
        [99],
        'a valid tick must reach its marker-derived artifact, even when that artifact has expired',
      );
    });
  }
}
