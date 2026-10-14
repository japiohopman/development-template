# Development Templates

## Purpose: reusable automatic development workflows

This repository is a catalog of reusable templates. The main product we are building is the Development Autoloop: a safe, reusable GitHub workflow that can discover work, check whether it is safe to start, hand one task to a coding agent such as Jules, follow that task through a pull request, relay review feedback, and stop safely when something is unclear.

The goal is not to create a pile of JavaScript helpers. A working installation must connect the helpers to GitHub Actions workflows in the consuming repository.

## The intended loop

1. Discover an Issue. Read current Issues, labels, dependencies, and repository rules. Never assume an incomplete API response means there is no work.
2. Run preflight. Check whether another session, pull request, or claim already represents the work. Stop if anything is missing or ambiguous.
3. Select and reserve one Issue. Choose one eligible task, then record a durable claim so another run cannot unknowingly start the same task.
4. Dispatch the task. Only after the configured safety and human-readiness gates pass, the dispatcher may send the task to Jules.
5. Reconcile reality. Compare the provider's session with the actual Issue, branch, pull request, and claim in GitHub.
6. Check the PR handoff. Verify the governing Issue, acceptance evidence, changed paths, required checks, and exact current PR head SHA.
7. Relay review feedback. A trusted reviewer decision should route repairs back to the existing work rather than create duplicate tasks.
8. Explain the outcome. Every block should say what happened, whether state changed, and what the next safe action is.

The template is not ready for unattended use until the full loop has been tested in a separate disposable repository.

## Available templates

| Template | Status | Purpose |
| --- | --- | --- |
| Development Autoloop | Foundation — not live-enabled | Reusable building blocks and consumer workflows for an Issue → coding agent → PR → review cycle. The automatic dispatcher and complete review relay are not yet connected end to end. |

See the [Development Autoloop README](templates/development-autoloop/README.md).

## Why are there many files under src/?

Each layer has a separate responsibility:

- The workflows under .github/workflows/ decide when GitHub should run a step and which permissions it receives.
- Scripts gather real information from GitHub or an external provider and pass it to the decision code.
- Source modules under src/ contain the rules that decide whether work is eligible, blocked, complete, or ready for human review. They should be testable without live API calls.
- Tests under tests/ check normal behavior and dangerous edge cases.

A source module alone is not an automatic workflow. It must be invoked by the appropriate workflow and runner. A workflow should not contain a second, unrelated copy of the same decision rules.

## What runs in this catalog repository today?

The active workflow in the main development-template repository is **Template validation**. It is a code checker, not the Jules dispatcher.

The workflow is defined in [.github/workflows/template-ci.yml](.github/workflows/template-ci.yml). It checks out the commit being tested, starts Node.js, checks JavaScript syntax, and runs the unit tests. Some tests use pretend provider replies, so ordinary CI does not create Jules sessions.

A green result means only that the syntax checks and tests passed for that exact commit. It does not mean Jules was given a task, a consumer workflow is installed, a PR was approved, or the complete automatic loop has passed a pilot.

Workflow files stored under templates/development-autoloop/.github/workflows/ are template files. GitHub does not run those files while they are nested inside this catalog. They become active only after installation into a consuming repository, with the workflow files at that repository's root .github/workflows/ directory.

## Current state and next steps

The template has tested logic for configuration, contracts, selection, durable claims, provider dispatch, and session/Issue/branch/PR reconciliation. The PR contract gate is being added as its own read-only gate. The full dispatcher is not yet connected to an active Actions runner, and the trusted review relay plus a complete disposable-repository pilot remain future work.

Follow the template's [architecture](templates/development-autoloop/docs/ARCHITECTURE.md), [implementation plan](templates/development-autoloop/docs/IMPLEMENTATION_PLAN.md), [recovery notes](templates/development-autoloop/docs/RECOVERY.md), and [template standards](docs/TEMPLATE_STANDARDS.md).

## Design principles

- Reusable by default: no product-specific business rules in shared logic.
- Configuration over forks: each project supplies its own labels, branch names, required checks, and policy settings.
- Fail safely: missing data, unknown states, conflicting claims, partial pages, or failed API calls stop the automation rather than trigger a guess.
- Workflow-first: Actions orchestrates; scripts gather evidence; source modules decide; tests prove behavior.
- Human control: live dispatch must be deliberately enabled; human merge approval remains the default.
- Keep secrets private: API keys belong in the consuming repository's secret settings, never in code, tests, README files, Issues, PR comments, or logs.

## Repository layout

- .github/workflows/template-ci.yml — checks the template source in this catalog repository.
- templates/development-autoloop/.github/ — workflows and a PR template copied into a consuming repository.
- templates/development-autoloop/config/ — example settings and the configuration schema.
- templates/development-autoloop/docs/ — architecture, roadmap, recovery, and setup instructions.
- templates/development-autoloop/scripts/ — adapters that read real provider/GitHub data.
- templates/development-autoloop/src/ — reusable decision rules.
- templates/development-autoloop/tests/ — automatic checks for rules and workflow safety.
- docs/TEMPLATE_STANDARDS.md — the required standard for reusable templates.

## Adding a template

1. Create a dedicated directory under templates/<template-name>/.
2. Document the real purpose, maturity, setup, permissions, risks, and recovery in plain language.
3. Keep project settings in configuration and never include secret values.
4. Add automatic tests for safety-critical decisions.
5. Install the template in a disposable consumer repository and test it before declaring it ready for reuse.
6. Update the catalog status only when the evidence supports it.

## Status vocabulary

- Design: the plan is being worked out; do not install it yet.
- Foundation: useful parts exist and tests may pass, but the complete workflow is not ready for unattended use.
- Ready for pilot: setup and safety checks are complete; test it in a disposable repository first.
- Stable: a successful pilot was completed and recovery steps are documented.

A green validation check is useful evidence, not proof that a template is ready to run by itself.
