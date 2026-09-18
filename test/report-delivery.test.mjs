import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as publicApi from '../dist/index.js';
import { buildReportDelivery, buildArtifactReportDelivery } from '../dist/report-delivery.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const actionYml = fs.readFileSync(path.join(root, 'action.yml'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
const deliveryContractPath = path.join(root, 'docs', 'report-delivery-contract.md');
const nativeRequire = createRequire(import.meta.url);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const repository = 'BenSheridanEdwards/StyleProof';
const foreignRepository = 'attacker/repo';
const publicationSha = 'a'.repeat(40);
const prNumber = 42;
const reportUrl = `https://github.com/${repository}/blob/${publicationSha}/pr-42/report.md`;

function actionCommentScript({
  url = reportUrl,
  sha = publicationSha,
  reportStorage = 'branch',
  artifactDigest = 'd'.repeat(64),
} = {}) {
  const match = actionYml.match(/- name: Upsert PR comment[\s\S]*?script: \|\n([\s\S]*?)(?=\n\s{4}#|\n\s{4}- name:)/);
  assert.ok(match, 'action.yml should contain the PR comment github-script program');
  const replacements = new Map([
    ['steps.context.outputs.pr-number', '42'],
    ['github.run_id', '9001'],
    ['github.run_attempt', '2'],
    ['steps.publish.outputs.url || steps.report-artifact.outputs.artifact-url', url],
    ['steps.report-artifact.outputs.artifact-digest', artifactDigest],
    ['steps.publish.outputs.sha', sha],
    ['inputs.report-storage', reportStorage],
    ['steps.diff.outputs.changed', 'true'],
    ['inputs.require-approval', 'true'],
    ['inputs.mode', 'certify'],
    ['steps.config.outputs.blocking', 'true'],
    ['steps.gate.outputs.approved', 'false'],
    ['steps.gate.outputs.approver', ''],
    ['inputs.status-context', 'StyleProof'],
    ['toJSON(inputs.comment-marker)', JSON.stringify('<!-- styleproof-report -->')],
    ['steps.verdict.outputs.state', 'STYLE_REVIEW_REQUIRED'],
    ['steps.context.outputs.head-sha', 'c'.repeat(40)],
    ['inputs.include-content', 'false'],
    ['steps.report.outputs.content-changes', '0'],
    ['inputs.base-capture-failed', 'false'],
  ]);
  let script = match[1]
    .split('\n')
    .map((line) => line.replace(/^ {10}/, ''))
    .join('\n');
  for (const [expression, value] of replacements) {
    script = script.replaceAll(`\${{ ${expression} }}`, value);
  }
  assert.doesNotMatch(script, /\$\{\{/);
  return new AsyncFunction('require', 'github', 'context', 'core', script);
}

async function executeActionComment({ repositoryPrivate, url, sha, reportStorage, artifactDigest, created = [] } = {}) {
  const outputs = new Map();
  const github = {
    rest: {
      issues: {
        listComments: async () => ({ data: [] }),
        createComment: async (input) => {
          created.push(input);
        },
        updateComment: async () => {
          throw new Error('unexpected comment update');
        },
      },
    },
  };
  const context = {
    repo: { owner: 'BenSheridanEdwards', repo: 'StyleProof' },
    payload: { repository: { private: repositoryPrivate } },
  };
  const core = {
    setOutput: (name, value) => outputs.set(name, value),
    info: () => {},
  };
  const requireForScript = (specifier) => {
    if (specifier === 'fs') return { existsSync: () => false };
    return nativeRequire(specifier);
  };
  const previousActionPath = process.env.GITHUB_ACTION_PATH;
  process.env.GITHUB_ACTION_PATH = root;
  try {
    await actionCommentScript({ url, sha, reportStorage, artifactDigest })(requireForScript, github, context, core);
  } finally {
    if (previousActionPath === undefined) delete process.env.GITHUB_ACTION_PATH;
    else process.env.GITHUB_ACTION_PATH = previousActionPath;
  }
  return { created, outputs };
}

test('public and private reports use one commit-bound linked-delivery contract', () => {
  const publicDelivery = buildReportDelivery({
    repository,
    publicationSha,
    prNumber,
    reportUrl,
    repositoryVisibility: 'public',
  });
  const privateDelivery = buildReportDelivery({
    repository,
    publicationSha,
    prNumber,
    reportUrl,
    repositoryVisibility: 'private',
  });

  for (const delivery of [publicDelivery, privateDelivery]) {
    assert.equal(delivery.mode, 'linked-report');
    assert.equal(delivery.cropDelivery, 'relative-paths-in-committed-report');
    assert.equal(delivery.url, reportUrl);
    assert.equal(delivery.markdown, `### 📊 [**View the side-by-side visual report →**](${reportUrl})`);
  }
  assert.equal(publicDelivery.access, 'public-github-view');
  assert.equal(privateDelivery.access, 'authenticated-github-view');
});

test('report delivery formatter remains Action-internal rather than a public package promise', () => {
  assert.equal(Object.hasOwn(publicApi, 'buildReportDelivery'), false);
  assert.equal(Object.hasOwn(publicApi, 'buildArtifactReportDelivery'), false);
});

test('literal Action comment uses the same one-link body for public and private repositories', async () => {
  const publicRun = await executeActionComment({ repositoryPrivate: false });
  const privateRun = await executeActionComment({ repositoryPrivate: true });
  assert.equal(publicRun.created.length, 1);
  assert.equal(privateRun.created.length, 1);
  const publicBody = publicRun.created[0].body;
  const privateBody = privateRun.created[0].body;
  assert.equal(publicBody, privateBody);
  assert.equal(publicBody.split(reportUrl).length - 1, 1);
  assert.match(publicBody, /- \[ \] \*\*Approve all changes\*\*/);
  assert.doesNotMatch(publicBody, /!\[|raw\.githubusercontent|\]\(crops\//);
  assert.equal(publicRun.outputs.get('stale-delivery'), 'false');
});

test('literal Action comment makes no GitHub write without exact delivery identity', async () => {
  for (const fixture of [
    { url: '', sha: publicationSha },
    { url: reportUrl, sha: '' },
    { url: reportUrl.replace('pr-42', 'pr-43'), sha: publicationSha },
  ]) {
    const created = [];
    await assert.rejects(executeActionComment({ repositoryPrivate: false, created, ...fixture }), /report delivery/i);
    assert.deepEqual(created, []);
  }
  for (const repositoryPrivate of [undefined, 'false']) {
    const created = [];
    await assert.rejects(executeActionComment({ repositoryPrivate, created }), /repository visibility/i);
    assert.deepEqual(created, []);
  }
});

test('literal Action comment links the workflow artifact in artifact storage mode (#587)', async () => {
  const artifactUrl = `https://github.com/${repository}/actions/runs/9001/artifacts/4451`;
  const run = await executeActionComment({ url: artifactUrl, reportStorage: 'artifact' });
  assert.equal(run.created.length, 1);
  const body = run.created[0].body;
  assert.equal(body.split(artifactUrl).length - 1, 1);
  assert.match(body, /\*\*Download the visual report artifact →\*\*/);
  assert.doesNotMatch(body, /View the side-by-side/);
  // #702: the digest marker binds the comment to the uploaded bytes.
  assert.match(body, new RegExp(`<!-- styleproof-artifact-digest:sha256:${'d'.repeat(64)} -->`));
});

test('a malformed upload-artifact digest fails the comment before any write (#702)', async () => {
  const created = [];
  for (const artifactDigest of ['', 'sha256:not-hex', 'deadbeef', `sha256:${'d'.repeat(63)}`]) {
    await assert.rejects(
      executeActionComment({
        url: `https://github.com/${repository}/actions/runs/9001/artifacts/4451`,
        reportStorage: 'artifact',
        artifactDigest,
        created,
      }),
      /artifact-digest/,
    );
  }
  assert.deepEqual(created, []);
});

test('a sha256:-prefixed upload-artifact digest is normalised into the marker (#702)', async () => {
  const created = [];
  const run = await executeActionComment({
    url: `https://github.com/${repository}/actions/runs/9001/artifacts/4451`,
    reportStorage: 'artifact',
    artifactDigest: `sha256:${'e'.repeat(64)}`,
    created,
  });
  assert.match(run.created[0].body, new RegExp(`<!-- styleproof-artifact-digest:sha256:${'e'.repeat(64)} -->`));
});

test('literal Action comment makes no GitHub write for a foreign artifact link (#587)', async () => {
  const created = [];
  await assert.rejects(
    executeActionComment({
      url: `https://github.com/${foreignRepository}/actions/runs/1/artifacts/1`,
      reportStorage: 'artifact',
      created,
    }),
    /report delivery/i,
  );
  assert.deepEqual(created, []);
});

test('artifact report delivery pins the link inside this repository run and fails closed otherwise (#587)', () => {
  const artifactUrl = `https://github.com/${repository}/actions/runs/9001/artifacts/4451`;
  const delivery = buildArtifactReportDelivery({ repository, reportUrl: artifactUrl });
  assert.equal(delivery.mode, 'workflow-artifact');
  assert.equal(delivery.cropDelivery, 'inside-workflow-artifact');
  assert.equal(delivery.access, 'authenticated-artifact-download');
  assert.equal(delivery.url, artifactUrl);
  assert.equal(delivery.markdown, `### 📊 [**Download the visual report artifact →**](${artifactUrl})`);

  const runPage = buildArtifactReportDelivery({
    repository,
    reportUrl: `https://github.com/${repository}/actions/runs/9001`,
  });
  assert.equal(runPage.url, `https://github.com/${repository}/actions/runs/9001`);

  for (const candidate of [
    '',
    'not a URL',
    ` ${artifactUrl}`,
    `${artifactUrl} `,
    `${artifactUrl}?x=1`,
    `${artifactUrl}#`,
    `https://github.com/${repository}/actions/runs/abc`,
    `https://github.com/${repository}/actions/runs/9001/artifacts/abc`,
    `https://github.com/${repository}/actions/runs/9001/artifacts/`,
    `https://github.com/${foreignRepository}/actions/runs/9001/artifacts/4451`,
    `https://github.com/${repository}/blob/${publicationSha}/pr-42/report.md`,
    `https://raw.githubusercontent.com/${repository}/runs/9001/artifacts/4451`,
  ]) {
    assert.throws(
      () => buildArtifactReportDelivery({ repository, reportUrl: candidate }),
      /report delivery/i,
      candidate,
    );
  }
});

test('missing, malformed, raw, wrong-repository, and wrong-commit report delivery fails closed', () => {
  const invalid = [
    '',
    'not a URL',
    ` ${reportUrl}`,
    `${reportUrl} `,
    reportUrl.replace('github.com', 'git\nhub.com'),
    reportUrl.replace('github.com', 'GITHUB.com'),
    reportUrl.replace('github.com', 'github.com:443'),
    `${reportUrl}?`,
    `${reportUrl}#`,
    `https://github.com:444/${repository}/blob/${publicationSha}/pr-42/report.md`,
    `https://user@github.com/${repository}/blob/${publicationSha}/pr-42/report.md`,
    `https://raw.githubusercontent.com/${repository}/${publicationSha}/pr-42/report.md`,
    `https://github.com/attacker/repo/blob/${publicationSha}/pr-42/report.md`,
    `https://github.com/${repository}/blob/${'b'.repeat(40)}/pr-42/report.md`,
    `https://github.com/${repository}/blob/${publicationSha}/pr-43/report.md`,
    `https://github.com/${repository}/blob/${publicationSha}/pr-42/report.json`,
    `https://github.com/${repository}/blob/${publicationSha}/pr-42/report.md?raw=1`,
  ];

  for (const candidate of invalid) {
    assert.throws(
      () =>
        buildReportDelivery({
          repository,
          publicationSha,
          prNumber,
          reportUrl: candidate,
          repositoryVisibility: 'public',
        }),
      /report delivery/i,
      candidate,
    );
  }
});

test('report delivery rejects malformed contract identity instead of guessing', () => {
  for (const invalidPrNumber of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '42']) {
    assert.throws(
      () =>
        buildReportDelivery({
          repository,
          publicationSha,
          prNumber: invalidPrNumber,
          reportUrl,
          repositoryVisibility: 'public',
        }),
      /report delivery/i,
    );
  }
  assert.throws(
    () =>
      buildReportDelivery({
        repository: 'owner-only',
        publicationSha,
        prNumber,
        reportUrl,
        repositoryVisibility: 'public',
      }),
    /report delivery/i,
  );
  assert.throws(
    () =>
      buildReportDelivery({
        repository,
        publicationSha: 'abc',
        prNumber,
        reportUrl,
        repositoryVisibility: 'public',
      }),
    /report delivery/i,
  );
  assert.throws(
    () =>
      buildReportDelivery({
        repository,
        publicationSha,
        prNumber,
        reportUrl,
        repositoryVisibility: 'internal',
      }),
    /report delivery/i,
  );
});

test('Action metadata, generated comment, and README expose one linked-delivery contract', () => {
  assert.doesNotMatch(actionYml, /inline images for public repos/);
  assert.match(actionYml, /report-storage/);
  assert.match(actionYml, /buildReportDelivery/);
  assert.match(actionYml, /buildArtifactReportDelivery/);
  assert.match(actionYml, /const publicationSha = '\$\{\{ steps\.publish\.outputs\.sha \}\}';/);
  assert.match(actionYml, /prNumber,\n\s+publicationSha,\n\s+reportUrl: url,/);
  assert.match(actionYml, /if: success\(\) && steps\.context\.outputs\.pr-number != ''/);
  assert.match(actionYml, /repositoryVisibility/);
  assert.match(actionYml, /const link = delivery\.markdown/);
  assert.doesNotMatch(actionYml, /const link = `### 📊/);
  assert.doesNotMatch(
    actionYml
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n'),
    /--image-base-url/,
  );

  assert.match(readme, /PR comment is the same linked summary for public and private repositories/);
  assert.match(readme, /Every report viewer needs an authenticated GitHub session/);
  assert.match(readme, /If publication or receipt verification fails, StyleProof posts no delivery claim/);
  assert.match(changelog, /Action report delivery now uses one commit-bound GitHub blob link/);
});

test('report delivery contract documents artifacts, access, permissions, outputs, and failure', () => {
  assert.equal(fs.existsSync(deliveryContractPath), true);
  const contract = fs.readFileSync(deliveryContractPath, 'utf8');
  assert.match(contract, /## Report storage/);
  assert.match(contract, /## Pull-request comment/);
  assert.match(contract, /## Public and private access/);
  assert.match(contract, /## Required permissions/);
  assert.match(contract, /## Action outputs/);
  assert.match(contract, /## Failure semantics/);
  assert.match(contract, /report\.md/);
  assert.match(contract, /report\.json/);
  // #475: the release-confidence sidecar is deleted and must not reappear.
  assert.doesNotMatch(contract, /styleproof-release-confidence\.json/);
  assert.match(contract, /current pull request/);
  assert.match(contract, /No publication receipt means no new delivery claim/);
});

test('artifact report upload is overwrite-safe so same-run job re-runs republish (#688)', () => {
  const step = actionYml.match(/- id: report-artifact[\s\S]*?(?=\n {4}- name:|\n {4}- id:)/);
  assert.ok(step, 'action.yml should contain the report-artifact upload step');
  assert.match(step[0], /uses: actions\/upload-artifact@/);
  assert.match(step[0], /overwrite: true/);
});
