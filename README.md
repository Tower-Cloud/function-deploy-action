# Tower Cloud function deploy action

Builds and deploys a [Tower Cloud](https://tower.cloud) source function from your
repository. Tower installs a workflow that calls this action when you enable auto-deploy
on a function.

**The installed workflow is yours.** Tower writes it once, by pull request, and does not
rewrite it afterwards. Edit it freely — add path filters for shared code, pin this action
to a commit, change `runs-on`, add steps before or after. Re-enabling auto-deploy rotates
the function's token; it does not touch your file.

## Usage

```yaml
- name: Build and deploy on Tower
  uses: Tower-Cloud/function-deploy-action@v1
  with:
    api-url: ${{ secrets.TOWER_API_URL }}
    function-id: 0f43c4de-637c-43f8-b5a6-6f6bba67b382
    token: ${{ secrets.TOWER_FN_DEPLOY_TOKEN_0F43C4DE_637C_43F8_B5A6_6F6BBA67B382 }}
    ref: ${{ github.ref_name }}
    idempotency-key: ${{ github.sha }}-${{ github.run_attempt }}
```

Both secrets are written into the repository by Tower when auto-deploy is enabled.

### Releasing the build slot on cancellation

`concurrency.cancel-in-progress` stops the **runner**, not the build running on Tower.
Without the step below, a superseded build keeps its slot until it hits Tower's 30-minute
build timeout:

```yaml
- name: Release the Tower build slot on cancellation
  if: cancelled()
  uses: Tower-Cloud/function-deploy-action@v1
  with:
    api-url: ${{ secrets.TOWER_API_URL }}
    function-id: <function id>
    token: ${{ secrets.TOWER_FN_DEPLOY_TOKEN_<FUNCTION_ID> }}
    cancel: "true"
```

This step never fails the job — the run is already being torn down, and a red X here
would report a cancellation as a build failure.

## Inputs

| input | required | default | notes |
|---|---|---|---|
| `api-url` | yes | — | Base URL of the Tower API. Comes from the `TOWER_API_URL` secret; arrives empty if that secret is missing. Must be `https` (except `localhost`). |
| `function-id` | yes | — | Must match the function the token was minted for. |
| `token` | yes | — | The function's deploy token. Masked in logs. |
| `ref` | no | `${{ github.ref_name }}` | The ref this run fired on. See *Why the ref is sent* below. |
| `idempotency-key` | no | `${{ github.sha }}-${{ github.run_attempt }}` | Keep `run_attempt` in it — see *Re-running a failed build*. |
| `wait` | no | `true` | `false` returns as soon as the build is accepted. The build still runs; the job stops billing runner minutes while it does. |
| `poll-interval-seconds` | no | `5` | |
| `timeout-seconds` | no | `2100` | How long to wait for a terminal state. Tower's own build timeout is 30m, so shorter values can report a timeout for a healthy build. |
| `cancel` | no | `false` | Cancel mode, for an `if: cancelled()` step. |

## Outputs

| output | notes |
|---|---|
| `build-id` | |
| `status` | Terminal status, or `queued`/`running` when `wait: false`. |
| `image-reference` | Set when the build succeeded. |
| `image-digest` | Set when the build succeeded. |

## Exit behaviour

What the job reports is meant to match what actually happened:

| situation | result |
|---|---|
| build succeeded | ✅ pass |
| build failed | ❌ fail, with the build's error code and message |
| build **superseded** | ✅ pass, with a notice — a newer commit won the race, which is routine under push-to-deploy |
| build cancelled | ✅ pass, with a notice |
| function no longer exists (404) | ⚠️ pass, with a warning to delete the workflow — an orphaned workflow must not leave a permanent red X |
| **token rejected (401/403)** | ❌ fail — see below |
| watch timed out | ❌ fail, and the build is **not** cancelled |

A rejected token deliberately **fails** rather than warning-and-passing. Auto-deploy may
have been disabled, or the token rotated without the repository secret being updated. If
this exited `0`, every push would report as deployed while nothing was ever built — a
worse outcome than a visible failure.

A watch timeout does not cancel the build: it means this job stopped watching, not that
the build is wrong. Tower's build timeout governs the build itself.

## Why the ref is sent

The server can fill the ref from the function's binding. If it did so silently, a
workflow edited to watch `develop` would quietly build `main` instead — a wrong deploy
that looks like a success. Sending the ref turns that into an explicit
`REF_NOT_IN_CONNECTED_REPO` failure naming the branch problem.

## Re-running a failed build

The idempotency key includes `github.run_attempt` on purpose. Tower replays a build for a
repeated key, so a key of `${{ github.sha }}` alone would make a failed commit
permanently unbuildable: clicking **Re-run** would replay the recorded failure rather than
build again. `run_attempt` increments on a re-run, so a network retry of the same attempt
replays and a human re-run genuinely rebuilds.

## Monorepos

Tower emits a `paths:` filter when the function is bound to a subdirectory, so only
changes under it trigger a build. If your function depends on shared code elsewhere in the
repo, add those paths yourself:

```yaml
on:
  push:
    branches: ["main"]
    paths:
      - "services/orders/**"
      - "packages/shared/**"   # added by you
```

Two functions in one repository get two workflows and two tokens, and are independent:
disabling one does not affect the other.

## Security

The token is scoped to **one function** and to exactly three operations — start, read and
cancel a build — for that function only. It cannot read logs, list functions, deploy, or
reach any other function. It may build only the function's declared source: the connected
GitHub repository, the bound ref, the bound path. It cannot choose a runtime.

Re-enabling auto-deploy rotates the token and revokes the previous one.

This action has **no dependencies** and runs directly from source — there is no bundled
`dist/` to audit. Pin it to a commit SHA if you want a fixed version:

```yaml
uses: Tower-Cloud/function-deploy-action@<commit-sha>
```

## Development

```bash
node --test 'test/*.test.js'
```

Tests run against a real local HTTP server rather than a stubbed `fetch`, so the wire
contract — auth header, idempotency header, and the exact request body the deploy-token
pin accepts — is genuinely exercised.
