# Development Templates

Reusable development templates maintained in one neutral repository.

This repository is a **catalog of building blocks**, not one finished automation system. Each template lives in its own folder under `templates/` and explains what is ready, what is not ready, and how to use it.

## Available templates

| Template | Status | Purpose |
| --- | --- | --- |
| [Development Autoloop](templates/development-autoloop/README.md) | Foundation — not live-enabled | Building blocks for a careful Issue → coding agent → pull request → review workflow. The automatic dispatch button/runner and the full review loop are not wired up yet. |

## First: what does “Template validation” mean?

When you see **Template validation** in the GitHub **Actions** tab, that is a code checker. It is **not** the system that gives work to Jules.

Think of it like checking a bicycle before a ride:
- **Syntax checks** make sure the source files are written in a form Node.js can read.
- **Unit tests** run small automatic tests to see whether the code makes the expected decisions.
- Some Jules API tests use pretend replies (mocks), so the tests do not create real Jules sessions.

The current workflow is defined in [`.github/workflows/template-ci.yml`](.github/workflows/template-ci.yml). It:
1. Downloads the exact version of the repository being checked.
2. Starts Node.js 20.
3. Runs `npm run check` inside `templates/development-autoloop/`.
4. Runs `npm test` in the same folder.

A green result means **these syntax checks and tests passed for that commit**. It does **not** mean Jules has started a task, a pull request has been reviewed, or the full automation loop works.

### Why does it run?

GitHub starts this checker when relevant files are pushed or a pull request is opened/updated. You can also start it manually from **Actions → Template validation → Run workflow**. It has no schedule.

Sometimes you may see a run for the push and another for the pull request. Those are two separate GitHub events checking the same code. That is normal.

The workflow only has permission to read repository contents. It does not dispatch work, create Jules sessions, change Issues or PR labels, merge PRs, or run on a timer.

## What is “dispatch”?

**Dispatch means actually handing a selected Issue to Jules as a coding task.**

The Development Autoloop folder now contains the selection logic, durable claim code, and a Jules adapter. However, there is not yet a GitHub Actions workflow or executable runner connected to those parts that gathers the live GitHub information and calls the dispatch function. So there is currently **no working “start the next Issue” button in Actions**.

The next steps are to connect these building blocks safely, check the live Issue/session/branch/PR state, add the PR contract gate and review relay, and test the complete loop in a separate disposable repository. See the [Development Autoloop README](templates/development-autoloop/README.md) and its [implementation plan](templates/development-autoloop/docs/IMPLEMENTATION_PLAN.md).

## Design principles

- **Reusable by default:** no project-specific business rules in shared logic.
- **Configuration over forks:** each project supplies its own labels, branch names, required checks, and policy settings.
- **Fail safely:** missing data, unknown states, conflicting claims, or unfinished work must stop the automation rather than guess.
- **Human control:** automatic dispatch must be deliberately enabled; merging stays a human decision by default.
- **Keep secrets private:** API keys belong in the consuming repository's secret settings, never in code, tests, README files, Issues, or PR comments.

## Repository layout

```text
templates/
  development-autoloop/
    .github/   # Files that travel with a copied template
    config/    # Example settings and their rules
    docs/      # Architecture, roadmap, and recovery notes
    src/       # The actual code
    tests/     # Automatic checks for the code
docs/
  TEMPLATE_STANDARDS.md
.github/
  workflows/
    template-ci.yml  # The checker that runs in this repository
```

## Adding a template

1. Create a dedicated directory under `templates/<template-name>/`.
2. Add a README using plain language to explain the purpose, current readiness, setup, risks, and removal/recovery steps.
3. Keep project settings in an example configuration and do not include secrets.
4. Add automatic tests for safety-critical decisions.
5. Try the template in a disposable test repository before declaring it ready for reuse.
6. Update this catalog only when the template's status is clear.

## Status vocabulary

- **Design:** the plan is being worked out; do not install it yet.
- **Foundation:** useful parts exist and tests may pass, but the full workflow is not ready for unattended use.
- **Ready for pilot:** setup and safety checks are complete; test it in a disposable repository first.
- **Stable:** a successful pilot was completed and recovery steps are documented.

A green validation check is useful evidence, but it is not proof that a template is ready to run by itself.
