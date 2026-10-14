# Development Autoloop

A reusable set of building blocks for a careful Issue → coding agent → pull request → review workflow.

**Status: Foundation — not ready to run tasks automatically.**

In plain language: some important parts have been built and tested, including the Jules adapter. But those parts are not yet connected to a working GitHub Actions workflow that chooses an Issue, gathers the latest GitHub information, and starts Jules. There is **no automatic task dispatcher in Actions yet**. A separate manual, read-only reconciliation workflow is included for consumer repositories after the template is installed.

## What you will see in GitHub Actions

In the main `development-template` repository, the active workflow is called **Template validation**. It is a checker, not a worker.

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

The files inside `.github/workflows/` in this template folder are examples that travel with the template. GitHub does not run those nested files in this catalog repository; the active checker here is the root workflow linked above. After copying the template into a consumer repository, `reconcile-readonly.yml` provides a **manual, read-only** inventory check; it does not dispatch Jules or change GitHub state.

## What has been built so far?

| Part | In everyday words | Current state |
| --- | --- | --- |
| Configuration checks | Make sure the settings follow the agreed rules. | Built and tested |
| Issue and PR contracts | Check that an Issue or PR contains the information we require. | Built and tested |
| Issue selection | Choose one safe next Issue from a complete set of GitHub information. If the choice is unclear, stop instead of guessing. | Built and tested; decision logic only |
| Durable claim | Put a reservation on the Issue so a second run does not start the same work at the same time. | Built and tested |
| Jules adapter and dispatch code | The code knows how to validate a task, find the right Jules source, request a session, and handle uncertain responses carefully. | Code exists; no Actions runner calls it yet |
| Session / Issue / branch / PR reconciliation | Compare the task Jules says it is doing with the actual Issue, branch, and PR in GitHub. | Built and tested; review-gated |
| PR contract gate | Check that a PR has the required information and evidence for its exact latest commit. | Not built yet |
| Review relay | Turn a trusted review into a safe next step, and send requested fixes back to the existing work instead of starting duplicates. | Not built yet |
| Full loop and pilot | Test the whole process in a separate, disposable repository before relying on it. | Not built yet |

Follow the [implementation plan](docs/IMPLEMENTATION_PLAN.md) for the order of work. The key remaining milestones are [Issue #7: PR contract gate](https://github.com/japiohopman/development-template/issues/7), [Issue #8: review relay](https://github.com/japiohopman/development-template/issues/8), and [Issue #9: end-to-end tests and pilot](https://github.com/japiohopman/development-template/issues/9).

## A few words explained

- **Preflight / safety check:** look around before doing anything, like checking that the road is clear before crossing.
- **Snapshot:** one collected picture of the current Issues, claims, sessions, branches, and PRs.
- **Claim:** a reservation that says, “this run owns this Issue for now.”
- **Dispatch:** actually send an eligible Issue to Jules as a coding task.
- **Reconciliation:** compare records with what really exists and fix or block disagreements.
- **Fail closed:** when information is missing or confusing, stop safely instead of guessing.
- **PR / pull request:** a proposal to add code changes to the main code. It is reviewed before being merged.

## How to run the tests yourself

You need Node.js 20 or newer.

1. Open a terminal in this folder: `templates/development-autoloop/`.
2. Run `npm run check` to check the source files' syntax.
3. Run `npm test` to run the automatic tests.

These commands do not dispatch work to Jules.

## Environment and secrets

**You do not need to add a Jules API key for the current validation workflow.**

The template's automated validation tests do not need a Jules API key. The separate manual `reconcile-readonly.yml` workflow does require a repository Actions secret named `JULES_API_KEY` after you install the template into a consumer repository, because it reads the provider's session inventory. It has read-only GitHub permissions and does not dispatch or create sessions. The actual dispatch workflow is still not connected.

GitHub provides `GITHUB_TOKEN` to Actions automatically. Its permissions still need to be kept as small as possible. Secrets must never be committed to configuration files, source code, test fixtures, Issues, PR comments, or logs.

The read-only reconciliation workflow also reads the claim ledger from the `autoloop-state` branch by default. Set the Actions repository variable `AUTOLOOP_STATE_BRANCH` only if your consumer repository uses a different dedicated state branch. Missing/uninitialized state is a blocker, never an empty ledger. Secrets and Environment settings do not copy over automatically when a repository is created from a template; configure them separately in a project that actually needs them.

## Safety rules

- Keep dispatch disabled by default until the complete workflow has passed the planned checks.
- Require exact authorization at the dispatch boundary.
- Never start another task when the old session or PR may still be active.
- Do not assume a failed or timed-out request means that Jules did not receive it. Check first; do not blindly retry session creation.
- Missing data, unknown states, or failed API calls must block work rather than look like an empty work queue.
- A green test run does not approve a PR.
- A review approval applies only to the exact PR commit that was reviewed; a new commit needs a new review.
- Human approval remains required for merging by default.

## Recovery and next steps

Read [Architecture](docs/ARCHITECTURE.md), [Implementation plan](docs/IMPLEMENTATION_PLAN.md), and [Recovery and operations](docs/RECOVERY.md) for the detailed rules.

The goal is to make normal work require very little attention from you. If the system reaches a genuine problem, it must explain what happened, what it changed (if anything), and the next safe action. It must not hide the problem in an endless retry loop.
