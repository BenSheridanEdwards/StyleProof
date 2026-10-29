import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import yaml from 'js-yaml';

const action = yaml.load(fs.readFileSync(new URL('../action.yml', import.meta.url), 'utf8'));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

for (const association of ['MEMBER', 'COLLABORATOR']) {
  test(`1147: a read-only ${association} cannot suppress comment and status delivery`, async () => {
    const outputs = {};
    const step = action.runs.steps.find((step) => step.id === 'comment');
    // Execute the real guard through its return, before report rendering or filesystem reads.

    const source = step.with.script
      .split('const reportStorage =')[0]
      .replaceAll('${{ toJSON(inputs.comment-marker) }}', JSON.stringify('<!-- styleproof-report -->'))
      .replaceAll('${{ github.run_id }}', '4242')
      .replaceAll('${{ github.run_attempt }}', '1')
      .replaceAll('${{ steps.context.outputs.pr-number }}', '7')
      .replaceAll('${{ steps.diff.outputs.changed }}', 'true');

    const comments = [
      {
        id: 1,
        user: { type: 'User', login: 'read-only-reviewer' },
        author_association: association,
        body: '<!-- styleproof-report -->\n<!-- styleproof-run-id:4242 run-attempt:99 -->',
      },
    ];

    const github = {
      paginate: async () => comments,
      rest: {
        issues: { listComments: async () => ({ data: comments }) },
        repos: { getCollaboratorPermissionLevel: async () => ({ data: { permission: 'read' } }) },
      },
    };

    const previous = process.env.GITHUB_ACTION_PATH;
    process.env.GITHUB_ACTION_PATH = new URL('../', import.meta.url).pathname;

    try {
      await new AsyncFunction('github', 'context', 'core', 'require', source)(
        github,
        { repo: { owner: 'owner', repo: 'repo' } },
        {
          setOutput: (key, value) => {
            outputs[key] = value;
          },
          info: () => {},
        },
        createRequire(import.meta.url),
      );
    } finally {
      if (previous === undefined) delete process.env.GITHUB_ACTION_PATH;
      else process.env.GITHUB_ACTION_PATH = previous;
    }

    assert.equal(
      outputs['stale-delivery'],
      'false',
      `${association} with read permission forged a later-attempt receipt and suppressed delivery`,
    );
  });
}
