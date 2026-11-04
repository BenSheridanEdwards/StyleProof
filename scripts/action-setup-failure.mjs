/** Resolve only the status destination; setup may have failed before a base was resolved.
 * Keep the exact-head/repository binding aligned with src/action-context.ts.
 * Identity resolution needs no runtime dependencies or generated files.
 */
export async function resolveSetupFailureContext({ eventName, payload, repository, github, core }) {
  let pullRequestNumber;
  let headCommit;
  const hasFullHeadCommit = () =>
    typeof headCommit === 'string' && headCommit.length === 40 && /^[0-9a-f]{40}$/i.test(headCommit);
  if (eventName !== 'workflow_run') {
    pullRequestNumber = payload.pull_request?.number;
    headCommit = payload.pull_request?.head?.sha;
  } else if (eventName === 'workflow_run') {
    const workflowRun = payload.workflow_run;
    headCommit = workflowRun?.head_sha;
    const matchesCapture = (pullRequest) => {
      const headRepository = pullRequest?.head?.repo;
      const captureRepository = workflowRun?.head_repository;
      const matchesRepository =
        typeof headRepository?.id === 'number' && typeof captureRepository?.id === 'number'
          ? headRepository.id === captureRepository.id
          : typeof headRepository?.full_name === 'string' &&
            typeof captureRepository?.full_name === 'string' &&
            headRepository.full_name.toLowerCase() === captureRepository.full_name.toLowerCase();
      return pullRequest?.head?.sha === headCommit && matchesRepository;
    };
    const association = workflowRun?.pull_requests?.[0];
    pullRequestNumber = matchesCapture(association) ? association.number : undefined;
    if (!pullRequestNumber && hasFullHeadCommit()) {
      try {
        const response = await github.rest.repos.listPullRequestsAssociatedWithCommit({
          ...repository,
          commit_sha: headCommit,
        });
        pullRequestNumber = response.data.find(
          (pullRequest) => pullRequest.state === 'open' && matchesCapture(pullRequest),
        )?.number;
      } catch (error) {
        core.warning(`StyleProof: setup failure PR lookup unavailable: ${error.message}`);
      }
    }
  }
  return Number.isSafeInteger(pullRequestNumber) && pullRequestNumber > 0 && hasFullHeadCommit()
    ? { pullRequestNumber, headCommit }
    : undefined;
}

async function setupFailureStatusSuperseded({ github, context, headCommit, statusContext, runAttempt }) {
  const response = await github.rest.repos.listCommitStatusesForRef({
    ...context.repo,
    ref: headCommit,
    per_page: 100,
  });
  const latest = response.data.find((status) => status.context === statusContext);
  const target = new URL(latest?.target_url || 'about:blank');
  const runPrefix = `/${context.repo.owner}/${context.repo.repo}/actions/runs/`;
  const receipt = target.pathname.startsWith(runPrefix)
    ? target.pathname.slice(runPrefix.length).match(/^(\d+)(?:\/(artifacts|attempts)\/(\d+))?\/?$/)
    : null;
  if (
    target.origin !== 'https://github.com' ||
    target.search ||
    target.hash ||
    !receipt ||
    !/^\d+$/.test(String(context.runId))
  )
    return false;
  const laterRun = BigInt(receipt[1]) > BigInt(context.runId);
  const laterAttempt =
    receipt[1] === String(context.runId) &&
    receipt[2] === 'attempts' &&
    /^\d+$/.test(runAttempt ?? '') &&
    BigInt(receipt[3]) > BigInt(runAttempt);
  return laterRun || laterAttempt;
}

export async function setSetupFailureStatus({
  github,
  context,
  core,
  actionPath,
  statusContext,
  commentMarker,
  runAttempt,
}) {
  const destination = await resolveSetupFailureContext({
    eventName: context.eventName,
    payload: context.payload,
    repository: context.repo,
    github,
    core,
  });
  if (!destination) {
    core.warning('StyleProof: setup failed, but no trusted PR head could be resolved — no status can be written.');
    return;
  }
  const { pullRequestNumber, headCommit } = destination;
  try {
    const { reviewRunSuperseded } = await import(`${actionPath}/dist/comment-supersession.js`);
    if (
      await reviewRunSuperseded({
        github,
        repo: context.repo,
        headSha: headCommit,
        prNumber: pullRequestNumber,
        runId: String(context.runId),
        runAttempt,
        statusContext,
        commentMarker,
      })
    ) {
      core.info('StyleProof: a later run took over this commit — status unchanged.');
      return;
    }
  } catch (error) {
    try {
      if (await setupFailureStatusSuperseded({ github, context, headCommit, statusContext, runAttempt })) {
        core.info('StyleProof: a later status run or attempt took over this commit — status unchanged.');
        return;
      }
    } catch (statusError) {
      core.warning(`StyleProof: setup failure status receipts unavailable: ${statusError.message}`);
    }
    core.warning(`StyleProof: setup failure run order could not be proven; failing closed: ${error.message}`);
  }
  await github.rest.repos.createCommitStatus({
    ...context.repo,
    sha: headCommit,
    context: statusContext,
    state: 'failure',
    description: 'StyleProof setup failed — re-run for a verdict',
    target_url: `https://github.com/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`,
  });
}
