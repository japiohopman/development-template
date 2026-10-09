# Development Autoloop

A project-neutral foundation for safe, issue-first development automation.

**Status: Foundation — not enabled for live dispatch.**

This template begins the shared control-plane work. The current implementation contains a pure preflight decision layer, pagination helpers, tests, and operating contracts. It does not create external provider sessions, claim issues, mutate labels, merge pull requests, or auto-promote issues.

## Start here
1. Copy config/autoloop.example.json to config/autoloop.json in a consuming repository and adapt only repository-specific settings.
2. Read docs/ARCHITECTURE.md and docs/IMPLEMENTATION_PLAN.md.
3. Use Node.js 20 or newer and run npm test and npm run check.
4. Complete the implementation plan in order before enabling live automation.

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
- deterministic Issue selection and dependency validation;
- durable claims with compare-and-swap semantics and stale-claim recovery;
- session creation with an explicit dispatch confirmation;
- reconciliation across provider sessions, issues, branches, and PRs;
- a trusted-reviewer state machine tied to the current PR head;
- API-mocked integration tests and a disposable-repository pilot.

No workflow in this template should create live external work until those gaps are implemented and the documented gates pass.
