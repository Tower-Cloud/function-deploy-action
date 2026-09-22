'use strict';

const { TowerClient, ApiError, FunctionGoneError, TERMINAL, NEUTRAL, sleep } = require('./api');

// The env var carrying the build id from the deploy step to the `if: cancelled()` step.
// Two separate steps in one job, so the handoff has to go through GITHUB_ENV.
const BUILD_ID_ENV = 'TOWER_BUILD_ID';

function explain(err) {
  // Map the API's error codes to something a tenant can act on without reading our docs.
  switch (err.code) {
    case 'REF_NOT_IN_CONNECTED_REPO':
      return 'This workflow tried to build something other than the function\'s connected source. ' +
        'That usually means the workflow watches a different branch than the function is bound to — ' +
        'either point `on.push.branches` at the bound branch, or rebind the function in Tower.';
    case 'BUILD_RATE_LIMITED': {
      const d = err.details || {};
      const window = d.window || d.windowSeconds ? ` (limit ${d.limit ?? '?'} per ${d.window ?? d.windowSeconds + 's'})` : '';
      return `This function has hit its build rate limit${window}. No build was created. ` +
        'Later pushes will build normally once the window rolls over.';
    }
    case 'DEPLOYMENT_MODE_MISMATCH':
      return 'This function is not a source function, so it has no builds. Auto-deploy does not apply to it.';
    case 'OPERATION_IN_PROGRESS':
      return 'Another operation on this function is still in flight. This push did not build; push again once it settles.';
    default:
      return null;
  }
}

// "<sha>-<attempt>": the attempt number matters. Without it a failed commit could never
// be rebuilt, because Tower replays a repeated key and would return the recorded failure
// forever. A network retry keeps one attempt (replays); a human "re-run" increments it.
function defaultIdempotencyKey() {
  const sha = process.env.GITHUB_SHA;
  if (!sha) return '';
  return `${sha}-${process.env.GITHUB_RUN_ATTEMPT || '1'}`;
}

async function deploy(core, client, opts) {
  const { ref, commit, idempotencyKey, wait, pollIntervalMs, timeoutMs } = opts;

  const from = commit ? `${ref || 'the bound ref'}@${commit.slice(0, 7)}` : (ref || 'the bound ref');
  core.info(`Starting a Tower build for function ${client.functionId} from ${from}.`);
  const build = await client.startBuild({ ref, commit, idempotencyKey });
  if (!build?.id) throw new Error('Tower accepted the build but returned no build id.');

  // Recorded before anything can fail, so a cancellation a moment from now still knows
  // which build to stop.
  core.exportVariable(BUILD_ID_ENV, build.id);
  core.setOutput('build-id', build.id);
  core.info(`Build ${build.id} accepted (status: ${build.status}).`);

  if (!wait) {
    core.setOutput('status', build.status);
    core.notice(`Build ${build.id} is running on Tower. This job is not waiting for it (wait: false).`);
    core.summary(`### Tower build started\n\nBuild \`${build.id}\` was accepted and is running on Tower.\n`);
    return 0;
  }

  const deadline = Date.now() + timeoutMs;
  let current = build;
  let lastStatus = null;
  while (!TERMINAL.has(current.status)) {
    if (Date.now() > deadline) {
      // Deliberately does NOT cancel the build. The timeout means we stopped watching,
      // not that the build is wrong; Tower's own 30-minute timeout governs the build.
      core.error(
        `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for build ${current.id}. ` +
        `It is still running on Tower — check the function's builds there. ` +
        `Raise timeout-seconds if your builds legitimately take this long.`
      );
      core.setOutput('status', current.status);
      return 1;
    }
    await sleep(pollIntervalMs);
    current = await client.getBuild(current.id);
    if (current.status !== lastStatus) {
      core.info(`Build ${current.id}: ${current.status}`);
      lastStatus = current.status;
    }
  }

  core.setOutput('status', current.status);
  if (current.image?.reference) {
    core.setOutput('image-reference', current.image.reference);
    core.setOutput('image-digest', current.image.digest || '');
  }

  if (current.status === 'succeeded') {
    const img = current.image?.reference ? `\n\nImage: \`${current.image.reference}\`` : '';
    core.info(`Build ${current.id} succeeded.`);
    core.summary(`### Tower deploy succeeded\n\nBuild \`${current.id}\` for function \`${client.functionId}\`.${img}\n`);
    return 0;
  }

  if (NEUTRAL.has(current.status)) {
    const why = current.status === 'superseded'
      ? 'A newer commit started its own build and replaced this one.'
      : 'This build was cancelled.';
    core.notice(`Build ${current.id} did not deploy: ${why}`);
    core.summary(`### Tower build ${current.status}\n\n${why}\n`);
    return 0;
  }

  const reason = current.error?.message || 'no reason reported';
  const code = current.error?.code ? ` [${current.error.code}]` : '';
  core.error(`Build ${current.id} failed${code}: ${reason}`);
  core.summary(`### Tower build failed\n\nBuild \`${current.id}\`${code}\n\n${reason}\n`);
  return 1;
}

async function cancel(core, client) {
  const buildId = process.env[BUILD_ID_ENV];
  if (!buildId) {
    // The run was cancelled before the start call returned an id. Nothing here can find
    // it — a deploy token cannot list builds — but an abandoned build is not permanent:
    // the next push supersedes it, and Tower's build timeout bounds it either way.
    core.warning(
      'Run cancelled before a Tower build id was known, so no build could be cancelled. ' +
      'If a build did start, it will be superseded by the next push or stopped by Tower\'s build timeout.'
    );
    return 0;
  }
  core.info(`Releasing the Tower build slot for build ${buildId}.`);
  try {
    await client.cancelBuild(buildId);
    core.info(`Cancellation requested for build ${buildId}.`);
  } catch (err) {
    // Never fail the job from the cancellation step: the run is already being torn down,
    // and a red X here would misreport a cancellation as a failure.
    core.warning(`Could not cancel build ${buildId}: ${err.message}. Tower's build timeout will stop it.`);
  }
  return 0;
}

async function run(core, { fetchImpl } = {}) {
  let client;
  try {
    const token = core.getInput('token', { required: true });
    core.mask(token);
    const apiUrl = core.getInput('api-url', { required: true });
    const functionId = core.getInput('function-id', { required: true });
    client = new TowerClient({
      baseUrl: apiUrl,
      token,
      functionId,
      fetchImpl,
      onRetry: ({ attempt, backoff, status, error }) =>
        core.info(`Tower request failed (${status ? `HTTP ${status}` : error}); retry ${attempt} in ${backoff}ms.`),
    });

    if (core.getBool('cancel', false)) return await cancel(core, client);

    // Defaulted here rather than in action.yml: GitHub evaluates ${{ }} everywhere in
    // that file — descriptions included — and rejects the whole action if an expression
    // names a context it does not allow there. The runner exports the same values as
    // env vars, so reading them at runtime is both valid and equivalent.
    return await deploy(core, client, {
      ref: core.getInput('ref') || process.env.GITHUB_REF_NAME || '',
      commit: core.getInput('commit') || process.env.GITHUB_SHA || '',
      idempotencyKey: core.getInput('idempotency-key') || defaultIdempotencyKey(),
      wait: core.getBool('wait', true),
      pollIntervalMs: core.getNumber('poll-interval-seconds', 5) * 1000,
      timeoutMs: core.getNumber('timeout-seconds', 2100) * 1000,
    });
  } catch (err) {
    if (err instanceof core.InputError) {
      core.error(`${err.message} Fix the inputs in this workflow file.`);
      return 1;
    }
    if (err instanceof FunctionGoneError) {
      // The function no longer exists, so this workflow is orphaned. Failing every future
      // push would leave a permanent red X on a repository whose owner did nothing wrong.
      core.warning(
        `Tower function ${client?.functionId ?? ''} no longer exists, so there is nothing to deploy. ` +
        'You can safely delete this workflow file.'
      );
      return 0;
    }
    if (err instanceof ApiError) {
      const hint = explain(err);
      // The function itself is gone. Nothing can restore it and nothing here can succeed
      // ever again, so this workflow is orphaned — failing every future push would leave a
      // permanent red X on a repository whose owner did nothing wrong. Distinct from a
      // revoked token below, which is a fixable problem and must stay loud.
      if (err.reason === 'DEPLOY_TOKEN_FUNCTION_DELETED') {
        core.warning(
          `The Tower function this workflow deploys no longer exists, so there is nothing to ` +
          `build. You can safely delete this workflow file${
            process.env.GITHUB_WORKFLOW_REF ? ` (${process.env.GITHUB_WORKFLOW_REF.split('@')[0]})` : ''
          }.`
        );
        core.summary('### Tower function deleted\n\nThis workflow no longer has a function to deploy and can be removed.\n');
        return 0;
      }
      if (err.status === 401 || err.status === 403) {
        // NOT treated as orphaned. A revoked or stale token must fail loudly: exiting 0
        // here would report every push as deployed while nothing was built.
        core.error(
          `Tower rejected this function's deploy token (HTTP ${err.status}${err.code ? ` ${err.code}` : ''}). ` +
          'Auto-deploy may have been disabled, or the token rotated without updating the repository secret. ' +
          'Re-enable auto-deploy for this function in Tower to mint a fresh token, or delete this workflow.'
        );
        return 1;
      }
      core.error(hint || `Tower returned ${err.status}${err.code ? ` ${err.code}` : ''}: ${err.message}`);
      if (err.requestId) core.info(`Tower request id: ${err.requestId}`);
      return 1;
    }
    core.error(err.message);
    return 1;
  }
}

module.exports = { run, deploy, cancel, explain, BUILD_ID_ENV };
