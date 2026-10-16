# Development Autoloop

## Purpose

Development Autoloop is a reusable GitHub workflow for managing development tasks safely from start to finish:

**discover an Issue → run preflight → reserve one task → dispatch to a coding agent → reconcile the session and PR → check PR evidence → relay trusted review feedback → safely continue or stop.**

The workflow is the coordinator. Code under src/ contains reusable decisions, code under scripts/ reads live data and calls those decisions, and workflows under .github/workflows/ decide when steps run and which permissions are available.

**Status: Foundation — not ready for unattended or scheduled use.** The catalog's checks do not start Jules. The connection from preflight to an executable Actions dispatcher is implemented as a manual-only, plan-first workflow in [Issue #19](https://github.com/japiohopman/development-template/issues/19). Live session creation remains disabled by default. A guarded review-relay foundation binds decisions to the exact current PR head and records deduplicated handoffs only when existing work is verified. It never starts repair sessions; the disposable consumer-repository pilot remains outstanding.

## A simple way to understand the parts

Imagine a workshop:

- GitHub Actions workflows are the schedule and safety rules for when a job may start.
- Scripts are the workers that collect current facts from GitHub and the coding-agent service.
- Source modules are the checklist: they decide whether the facts prove that a task is safe, blocked, or complete.
- Tests try ordinary and tricky situations before the checklist is trusted on real work.

The source code should not be mistaken for a running workflow. Each step must be connected to a workflow, use trusted inputs, and explain the result to the person responsible.

## What works today?

| Part | In everyday words | Current state |
| --- | --- | --- |
| Configuration and contracts | Check that settings and Issues/PRs contain the required information. | Built and tested |
| Preflight and selection | Look for existing work and choose only one eligible Issue from a complete snapshot. | Decision logic built and tested |
| Durable claim | Reserve an Issue so competing runs do not knowingly start the same task. | Built and tested |
| Provider adapter and dispatch logic | Prepare and validate a task packet for Jules and handle uncertain results carefully. | Built and tested; manual plan-first Actions dispatcher connected |
| Session/Issue/branch/PR reconciliation | Compare provider sessions with real GitHub Issues, branches, PRs, and claims. | Read-only reconciliation built; consumer workflow is manual-only |
| PR contract gate | Verify current-head evidence, changed paths, configured required checks, and handoff completeness. | Implemented in the Issue #7 draft; requires review and consumer configuration |
| Trusted review relay | Accept only configured reviewers, bind verdicts to the current head, and route feedback to existing work. | Guarded event workflow and deduplicated audit handoff implemented; live repair dispatch remains blocked |
| Complete loop and pilot | Test all steps together in a separate disposable repository. | Not built |

See the [implementation plan](docs/IMPLEMENTATION_PLAN.md) for the remaining sequence.

## Which workflow do I see in the catalog Actions tab?

In the main development-template repository, the active workflow is called **Template validation**. It is a checker, not a worker.

Imagine we are building a robot:
- The checker looks at the robot's parts and tests whether they behave as expected.
- A dispatcher is the button and wiring that tells the robot which job to do.
- We have the checker and several robot parts. The dispatcher and the full work-and-review loop still need to be connected.

### What does Template validation check?

The workflow lives at the repository root in [`.github/workflows/template-ci.yml`](../../.github/workflows/template-ci.yml). When relevant code or documentation changes, GitHub runs these steps:

1. **Set up:** GitHub downloads the version of the code it is checking and starts Node.js 20.
2. **Syntax checks (`npm run check`):** Node.js checks that the listed code files are written in a form it can read. This catches certain typing and syntax mistakes. It does not prove the whole system works.
3. **Unit tests (`npm test`):** small automatic tests try lots of situations and check the answers. For example, they test whether unclear or unsafe situations are blocked.
4. **Report:** GitHub marks the run green if both steps pass, or red if a step fails.

Some tests pretend to be the Jules service by returning made-up test responses. These are called **mocks**. This lets us test timeouts, errors, and successful replies without using a real API key or creating a real Jules session.

A green check means only this: **the syntax checks and automated tests passed on the exact commit being checked.** It does not mean that Jules was given work, a PR was reviewed, or the entire loop was tested from start to finish.

The file `.github/workflows/ci.yml` inside this template folder is an example workflow that travels with the template. GitHub does not run that nested file as a workflow in this catalog repository; the active checker is the root workflow linked above.

### Autoloop plan dispatcher

The consumer workflow `.github/workflows/autoloop-dispatch.yml` and script `scripts/autoloop-runner.mjs` provide the initial manual-only, plan-first task coordinator. It runs on `workflow_dispatch` only and requires explicit `confirm_repository` confirmation matching `GITHUB_REPOSITORY`.

Its execution path:
- Validates repository confirmation and project configuration (`config/autoloop.json`).
- Assembles a complete paginated API snapshot of Issues, open PRs, claim ledger state (`AUTOLOOP_STATE_BRANCH`), and provider sessions.
- Evaluates candidate selection deterministically (`selectCandidateIssue`).
- Produces a plain-language plan report outputting the selected candidate (or blocker / eligibility reason), mutation status (`mutated: false`), and safe next action.
- Operates strictly side-effect free: no claims are written, no provider sessions are created, and no Issues or PRs are mutated.

The separate `.github/workflows/autoloop-live-dispatch.yml` is the only workflow that has write permission for the claim state branch. It is manual-only and asks for both the exact repository name and the exact dispatch authorization phrase configured in `config/autoloop.json`. It checks those values and confirms `enabled: true` plus `runMode: "live"` **before** the Jules API key is exposed to the dispatch step. The runner then recomputes selection, acquires a durable claim before creating a session, and reconciles ambiguous provider responses rather than blindly retrying.

**Keep live dispatch disabled.** The example config remains `enabled: false` and `runMode: "dry-run"`. Do not enable live dispatch merely because this workflow exists: the end-to-end tests and disposable consumer-repository pilot in Issue #9 still need review and explicit readiness approval.

### Trusted review relay

The consumer workflow `.github/workflows/review-relay.yml` and runner `scripts/review-relay.mjs` handle PR head changes automatically from trusted default-branch code. A submitted review is observed by `.github/workflows/review-relay-observer.yml`, which has no secrets, no write permissions, and does not check out or execute repository code. It then wakes the privileged workflow through `workflow_run`, where trusted default-branch code re-reads current reviews and check runs from GitHub. This bridge avoids giving the Jules secret to a `pull_request_review` merge-ref workflow. Fork PR reviews are not bridged automatically because `workflow_run.pull_requests` is empty for forks. A configured trusted reviewer can post `[autoloop:relay-review]` as a manual retry, including for fork PRs. The workflow never checks out or executes the pull-request head. Configure `trustedReviewers` with exact GitHub logins and configure non-empty `requiredChecks` with exact check-run names; without those settings, review approval cannot advance.

The privileged relay uses the protected `autoloop-dispatch` Environment. Manually configure its `JULES_API_KEY` Environment secret for the changes-requested handoff path only: that path reads provider state to verify existing work. Approvals, head synchronization, and escalation do not need the key. GitHub automatically supplies `GITHUB_TOKEN` with `contents: read`, `pull-requests: read`, `checks: write`, and `issues: write`; do not create a custom token for the relay. These write permissions let trusted workflow code alter check conclusions and post PR audit comments, and the provider key grants access to Jules. Compromised default-branch code or actions could misuse those capabilities. Restrict Environment access to the default branch, review workflow changes, and keep actions pinned to reviewed commit SHAs.

Only trusted review decisions on the current PR head count. Approvals are blocked unless every required check passed on that same SHA. A new commit invalidates previous approval evidence. Generic comments and acknowledgements (including 👀) do not count as verdicts; escalation requires an explicit `[autoloop:escalate] reason` from a configured trusted reviewer.

Decisions from re-read reviews, head synchronization, or trusted escalation are persisted as the managed GitHub check run `Autoloop trusted review relay` on the exact PR head; a repeat updates the same check rather than creating a second result. Unrelated metadata events and comments do not overwrite it. This check is the durable per-head state signal for downstream gates. A trusted `CHANGES_REQUESTED` result triggers read-only reconciliation of the existing provider session, claim, governing Issue, branch, and PR. If exactly one task context is verified, the relay also writes one audit comment keyed by repository, PR, head SHA, review ID, and review version. For an approval after a prior changes-requested review, the reviewer must include both `Findings addressed: ...` and `Findings remaining: ...` in the review body; the runner also verifies that the current head has real changed paths and a different tree from its parent. If that context is missing/ambiguous or comment history cannot be read completely, it blocks. Duplicate deliveries find the existing marker and do not create another handoff.

**This relay does not create sessions, write claims, change labels, approve PRs, or merge.** The recorded repair handoff remains blocked pending observable reconciliation and the separately reviewed pilot/readiness gate. A pushed repair is reported with its exact SHA, changed paths, required-check results and prior trusted findings, but the relay never declares those findings fixed automatically.

To roll back the relay, disable `review-relay.yml` in the consuming repository's Actions settings. Existing check runs and audit comments remain; disabling the workflow does not remove them.

### PR contract gate

The consumer workflow .github/workflows/pr-contract-gate.yml is deliberately read-only. It uses trusted base-branch code and GitHub metadata to check the PR's governing Issue, acceptance-criteria evidence, exact changed-file list, current head SHA, required checks, and whether the latest commit actually changes the file tree.

Its report separates:
- **Contract:** is the Issue/PR handoff complete and supported by evidence?
- **CI/checks:** did the configured required check runs finish successfully for this exact commit?
- **Human review:** still separate and required; this gate never approves or merges.

A green PR contract gate is not permission to dispatch Jules, merge a PR, or enable a schedule. If the event is stale, evidence is missing, checks have not finished, or configuration is incomplete, the gate blocks and explains the next safe action.

## Install and configure in a consuming repository

1. Copy the contents of templates/development-autoloop/ into the root of the repository that will use the template. Do not leave the workflows nested one level too deep.
2. Copy config/autoloop.example.json to config/autoloop.json.
3. Keep live dispatch disabled and automatic merge disabled. Configure requiredChecks with the exact check-run names the consumer repository requires. An empty list deliberately produces “not configured”, not “CI passed”.
4. Review the permissions and workflow files before enabling any workflow in that repository.
5. Run syntax/unit tests, inspect the gate report, and follow Issue #9's disposable-repository pilot plan before treating the complete workflow as operational.

The configuration is project-neutral. Do not add product-specific assumptions to the shared decision modules.

## Consuming-repository Environment and secrets setup

The catalog repository's settings and secrets do **not** copy into a consuming repository.

1. **Create the Actions Environment:** In the consumer repository settings under **Settings → Environments**, create a GitHub Actions Environment named `autoloop-dispatch`.
2. **Restrict Deployment Branches:** Configure `autoloop-dispatch` deployment branch policies to permit execution from the repository's default branch (`main`) only. *Note: this branch policy restriction is a manual repository setting in GitHub settings and is not created automatically by workflow YAML files.*
3. **Store JULES_API_KEY as an Environment Secret:** Store `JULES_API_KEY` as an Environment secret within `autoloop-dispatch`. Do **not** store `JULES_API_KEY` as a repository-level secret, and avoid leaving duplicate repository-level secrets available to non-default branches. Never put API keys in configuration files, source code, test fixtures, Issues, PR bodies, or logs.
4. **Workflow Environment Access:** `autoloop-dispatch.yml`, `reconcile-readonly.yml`, and `review-relay.yml` declare `environment: autoloop-dispatch`. GitHub Actions resolves the manually configured `JULES_API_KEY` through this Environment after its deployment branch policies and protection rules pass. The review relay uses the key only for read-only verification of existing work on the changes-requested handoff path; it does not require it for approvals, head synchronization, or escalation.
5. **PR contract gate:** No custom secret is required for `pr-contract-gate.yml`. GitHub supplies standard `GITHUB_TOKEN` to Actions with read permissions.
6. **Review relay token and observer:** GitHub automatically supplies `GITHUB_TOKEN` to `review-relay.yml` with `contents: read`, `pull-requests: read`, `checks: write`, and `issues: write` to manage its check run and audit comments. Install `review-relay-observer.yml` alongside it for the automatic review bridge; the observer needs no secrets or write permissions. Review the privileged relay's permission risks above before enabling it. Rollback means disabling `review-relay.yml`; existing check runs and audit comments remain.

AUTOLOOP_STATE_BRANCH is an optional repository variable for the manual reconciliation and dispatcher workflows. It defaults to autoloop-state. Missing or uninitialized claim state is a blocker, not an empty queue.

## Run the tests in the template folder

You need Node.js 20 or newer. From templates/development-autoloop/:

- npm run check checks that listed source and script files have readable JavaScript syntax.
- npm test runs the automated behavior and security-boundary tests.

These commands use local fixtures and mocked responses. They do not call Jules or create external sessions.

## Important terms

- **Preflight:** check for existing tasks, claims, sessions, and pull requests before starting anything new.
- **Claim:** a reservation that says which run currently owns an Issue.
- **Dispatch:** actually send an eligible Issue to Jules as a task.
- **Reconciliation:** compare what the coding-agent service says with the state that really exists in GitHub.
- **Exact head SHA:** the unique identifier of the current PR commit. Evidence for an older commit must not count for a newer one.
- **Fail closed:** missing, conflicting, or unknown information stops the workflow instead of being guessed.
- **No-op commit:** a new commit record whose file tree is identical to its parent, so it does not represent a real change.

## Safety and recovery

- Live and scheduled dispatch stay disabled until the complete safety plan and disposable pilot pass.
- Never start another task when previous work may still be active.
- Do not blindly retry a timed-out provider request; reconcile the outcome first.
- A green test/check run does not approve a PR.
- A new commit invalidates evidence and approval tied to an older head.
- Human approval remains required for merging by default.
- If an installed workflow behaves unexpectedly, disable that workflow first. The PR contract gate is read-only, so it does not require a state rollback.

The desired normal experience is that you need to do very little. If the system reaches a real problem, it must explain what happened, whether anything changed, and the next safe action—without hiding the problem in an endless retry loop.

## CodeRabbit automatic reviews

The repository-level `.coderabbit.yaml` enables automatic reviews and incremental reviews for ready-for-review pull requests, while excluding Draft pull requests until they are marked ready. The Development Autoloop template includes the same configuration at its root so it can be copied into a consuming repository.

**This file configures preferences; it does not install or authorize the CodeRabbit GitHub App.** A repository owner must install/authorize the app, and account or organization policies may override these settings.
