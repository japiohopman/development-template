# Development Autoloop

A project-neutral foundation for safe, issue-first development automation.

**Status: Foundation — not enabled for live dispatch.**

This template contains a pure preflight decision layer, pagination helpers, schema-backed configuration validation, contract validators, deterministic Issue selection and dependency checks, tests, and operating contracts. It does not create external provider sessions, claim issues, mutate labels, merge pull requests, or auto-promote issues.

## Start here

1. Copy `config/autoloop.example.json` to `config/autoloop.json` in a consuming repository and adapt only repository-specific settings.
2. Read `docs/ARCHITECTURE.md` and `docs/IMPLEMENTATION_PLAN.md`.
3. Use Node.js 20 or newer and run `npm test` and `npm run check` from this template directory.
4. The configuration contract is defined in `config/autoloop.schema.v1.json`. `src/config.mjs` validates against that versioned schema and returns stable `{ path, code, message }` diagnostics. The local evaluator supports the schema keyword subset explicitly used by the schema and fails closed if an unsupported keyword is introduced.
5. Deterministic Issue selection and dependency checks are in `src/selection.mjs`. Candidate selection validates readiness labels, issue contracts, `humanReadinessRequired` gates, dependency states (requiring explicit completion reasons), active PRs/claims/sessions, and sequence ordering. Selection is pure and dry-run only.
6. Complete the implementation plan in order before enabling live automation.

## Consuming-repository Environment and secrets setup

**Current state: none required yet.** This foundation has no live-dispatch workflow and no workflow references a GitHub Environment. Do not configure a provider secret just to use the current validation-only stage.

| Name | Current requirement | How it is supplied |
| --- | --- | --- |
| GitHub Actions `GITHUB_TOKEN` | No manual secret setup for the current stage. Future GitHub API workflows may use it when their permissions are explicitly configured. | GitHub Actions supplies the token automatically to a running workflow. Its permission scope must still be defined with least privilege. |
| `JULES_API_KEY` | **Future only; not required now.** Add it only when the Jules adapter is implemented and its workflow contract names the Environment and secret. | A repository administrator must add it manually as an Environment secret in the consuming repository. Never put the value in a file or comment. |

When a later adapter introduces a named Environment, follow the exact Environment name documented by that adapter's workflow. In the consuming repository, go to **Settings → Environments**, create or select that Environment, then add only the listed secret names under its Environment secrets. Do not guess an Environment name before the corresponding workflow uses it.

Environment definitions and Environment secrets do **not** carry over when a repository is created from this template. Configure them separately in every consuming repository that actually needs them. Never commit credential values to configuration, source, test fixtures, documentation, or logs.

## Core safety rules

- A GitHub Issue is the authoritative execution contract. A roadmap can order work but cannot override issue scope or acceptance criteria.
- Live dispatch must require exact manual authorization during commissioning.
- One active execution per repository is the safe default.
- Paused, waiting-for-feedback, and approval-waiting sessions block another dispatch.
- Unknown provider states and incomplete API snapshots fail closed.
- An associated merged PR may be treated as durable completion only after the PR has been verified.
- An open or closed-but-unmerged PR remains unresolved.
- A review approval applies to the exact PR head SHA; a new commit invalidates it.
- Discovery may propose work but cannot dispatch its own suggestions.
- Humans retain merge authority by default. Automatic merge is disabled.
- Do not persist transient queue state by committing generated state files to the protected default branch.

## Current boundaries and gaps

The code here is intentionally provider-neutral. A production implementation still needs:
- a provider adapter and source/repository identity verification;
- durable claims with compare-and-swap semantics and stale-claim recovery;
- session creation with an explicit dispatch confirmation;
- reconciliation across provider sessions, issues, branches, and PRs;
- a trusted-reviewer state machine tied to the current PR head;
- API-mocked integration tests and a disposable-repository pilot.

No workflow in this template should create live external work until those gaps are implemented and the documented gates pass.
