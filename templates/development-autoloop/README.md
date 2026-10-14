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

In the main development-template repository, **Template validation** is the active workflow. It checks source-file syntax and runs unit tests. It is not the task dispatcher and does not create a Jules session.

The workflows under this template's nested .github/workflows/ folder are examples for a consuming repository. GitHub does not run them from this nested directory. After installation, copy the template contents into the consumer repository so the workflow files live in .github/workflows/ at the repository root.

### Autoloop plan dispatcher

The consumer workflow `.github/workflows/autoloop-dispatch.yml` and script `scripts/autoloop-runner.mjs` provide the initial manual-only, plan-first task coordinator. It runs on `workflow_dispatch` only and requires explicit `confirm_repository` confirmation matching `GITHUB_REPOSITORY`.

Its execution path:
- Validates repository confirmation and project configuration (`config/autoloop.json`).
- Assembles a complete paginated API snapshot of Issues, open PRs, claim ledger state (`AUTOLOOP_STATE_BRANCH`), and provider sessions.
- Evaluates candidate selection deterministically (`selectCandidateIssue`).
- Produces a plain-language plan report outputting the selected candidate (or blocker / eligibility reason), mutation status (`mutated: false`), and safe next action.
- Operates strictly side-effect free: no claims are written, no provider sessions are created, and no Issues or PRs are mutated.

### Trusted review relay

The consumer workflow `.github/workflows/review-relay.yml` and runner `scripts/review-relay.mjs` handle PR head changes automatically from trusted default-branch code. A submitted review is deliberately not processed by the privileged workflow directly: `pull_request_review` can resolve to a PR merge ref, which must not receive the Jules secret. After submitting a review, a configured trusted reviewer posts the exact comment `[autoloop:relay-review]`; the workflow then re-reads current reviews and check runs from GitHub using trusted default-branch code. This makes the handoff explicit without granting the secret to an untrusted event workflow. The workflow never checks out or executes the pull-request head. Configure `trustedReviewers` with exact GitHub logins and configure non-empty `requiredChecks` with exact check-run names; without those settings, review approval cannot advance.

Only trusted review decisions on the current PR head count. Approvals are blocked unless every required check passed on that same SHA. A new commit invalidates previous approval evidence. Generic comments and acknowledgements (including 👀) do not count as verdicts; escalation requires an explicit `[autoloop:escalate] reason` from a configured trusted reviewer.

Every relay decision is persisted as the managed GitHub check run `Autoloop trusted review relay` on the exact PR head; a repeat updates the same check rather than creating a second result. This check is the durable per-head state signal for downstream gates. A trusted `CHANGES_REQUESTED` result triggers read-only reconciliation of the existing provider session, claim, governing Issue, branch, and PR. If exactly one task context is verified, the relay also writes one audit comment keyed by repository, PR, head SHA, review ID, and review version. For an approval after a prior changes-requested review, the reviewer must include both `Findings addressed: ...` and `Findings remaining: ...` in the review body; the runner also verifies that the current head has real changed paths and a different tree from its parent. If that context is missing/ambiguous or comment history cannot be read completely, it blocks. Duplicate deliveries find the existing marker and do not create another handoff.

**This relay does not create sessions, write claims, change labels, approve PRs, or merge.** The recorded repair handoff remains blocked pending observable reconciliation and the separately reviewed pilot/readiness gate. A pushed repair is reported with its exact SHA, changed paths, required-check results and prior trusted findings, but the relay never declares those findings fixed automatically.

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
4. **Workflow Environment Access:** Both `autoloop-dispatch.yml` and `reconcile-readonly.yml` declare `environment: autoloop-dispatch`. When executed, GitHub Actions resolves `JULES_API_KEY` through the `autoloop-dispatch` Environment boundary after verifying default-branch branch protection rules.
5. **PR contract gate:** No custom secret is required for `pr-contract-gate.yml`. GitHub supplies standard `GITHUB_TOKEN` to Actions with read permissions.

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
