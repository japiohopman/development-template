# Development Autoloop

## Purpose

Development Autoloop is a reusable GitHub workflow for managing development tasks safely from start to finish:

**discover an Issue → run preflight → reserve one task → dispatch to a coding agent → reconcile the session and PR → check PR evidence → relay trusted review feedback → safely continue or stop.**

The workflow is the coordinator. Code under src/ contains reusable decisions, code under scripts/ reads live data and calls those decisions, and workflows under .github/workflows/ decide when steps run and which permissions are available.

**Status: Foundation — not ready for unattended or scheduled use.** The catalog's checks do not start Jules. The full automatic dispatcher and trusted review relay are not connected end to end, and the disposable consumer-repository pilot remains outstanding.

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
| Provider adapter and dispatch logic | Prepare and validate a task packet for Jules and handle uncertain results carefully. | Logic exists; not wired to a live Actions dispatcher |
| Session/Issue/branch/PR reconciliation | Compare provider sessions with real GitHub Issues, branches, PRs, and claims. | Read-only reconciliation built; consumer workflow is manual-only |
| PR contract gate | Verify current-head evidence, changed paths, configured required checks, and handoff completeness. | Implemented in the Issue #7 draft; requires review and consumer configuration |
| Trusted review relay | Turn trusted approve/changes-requested decisions into safe, non-duplicated next steps. | Not built |
| Complete loop and pilot | Test all steps together in a separate disposable repository. | Not built |

See the [implementation plan](docs/IMPLEMENTATION_PLAN.md) for the remaining sequence.

## Which workflow do I see in the catalog Actions tab?

In the main development-template repository, **Template validation** is the active workflow. It checks source-file syntax and runs unit tests. It is not the task dispatcher and does not create a Jules session.

The workflows under this template's nested .github/workflows/ folder are examples for a consuming repository. GitHub does not run them from this nested directory. After installation, copy the template contents into the consumer repository so the workflow files live in .github/workflows/ at the repository root.

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

- **PR contract gate:** no custom secret is required. GitHub supplies GITHUB_TOKEN to Actions, and this workflow needs only read permissions for repository contents, Issues, pull requests, and check runs.
- **Manual read-only session reconciliation:** set a repository Actions secret named JULES_API_KEY only if you install and use reconcile-readonly.yml, because that workflow reads the provider's session inventory. Do not put the key in a configuration file, source code, test fixture, Issue, PR body, or log.
- **GitHub Environment:** the current template workflows do not declare an environment. No named Environment is used by these workflows. Therefore, a secret belongs in the repository's Actions secrets unless the workflow is deliberately changed to reference an Environment and that change is reviewed.

AUTOLOOP_STATE_BRANCH is an optional repository variable for the manual reconciliation workflow. It defaults to autoloop-state. Missing or uninitialized claim state is a blocker, not an empty queue.

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
