# CHATGPT.md — Development Template Project Memory

> **Maintenance and authority**
>
> - Maintained by ChatGPT as durable project context across conversations.
> - Jules and other implementation agents must treat this file as read-only; they must not edit it unless a GitHub Issue explicitly authorizes changing the project-memory policy.
> - This file is advisory context, not an execution queue, dispatch authorization, or substitute for repository evidence.
> - The assigned GitHub Issue is the implementation contract. Repository rules, specialist instructions, tests, source code, current workflow evidence, and explicit user instructions take precedence.
> - Reconstruct the current state from GitHub at the start of each session. Do not assume this file or chat history is perfectly current.

---

## Project identity

**Repository:** `japiohopman/development-template`

This repository is a catalog of reusable software-development templates. Its active focus is the **Development Autoloop**: a project-neutral, safe GitHub workflow that can discover an eligible Issue, preflight existing work, reserve one task, hand work to a coding agent such as Jules, reconcile provider/GitHub state, verify a pull request, relay trusted review decisions, and stop clearly when facts are incomplete or ambiguous.

The goal is a reusable template, not a product-specific workflow and not merely a collection of unconnected JavaScript helpers.

## Authority and collaboration

### Jaap — project owner
- Owns project direction and authorizes material changes to operating policy.
- Retains final merge authority.
- Must explicitly approve enabling live/scheduled dispatch or unattended operation after the disposable-repository pilot and readiness review.

### ChatGPT — planner, reviewer, and project-memory maintainer
- Inspects current Issues, PRs, branches, code, workflows, test results, and repository instructions.
- Handles code review, test planning, safety analysis, and issue/PR preparation.
- Can put precise continuation instructions in the existing PR body and explicitly mention `@Jules` when Jules needs to continue.
- Reuses existing branches, sessions, claims, and PRs whenever they represent the same work.
- Maintains this file; does not treat it as an execution queue.

### Jules — implementation agent
- Implements the assigned Issue and its acceptance criteria.
- Reports actual blockers, failures, uncertainty, and verification evidence in the existing PR.
- Continues in the same branch and PR for in-scope review fixes.
- Must not silently expand scope, start unrelated work, or treat an acknowledgement/reaction as proof of progress.

### CodeRabbit and other reviewers
- Their feedback is useful evidence, not automatic authority.
- Validate every finding against the current code and exact PR head before accepting or rejecting it.

## Current maturity and safety boundary

**Development Autoloop status: Foundation — not ready for unattended or scheduled use.**

The catalog's active `Template validation` workflow checks source syntax and runs tests. It does not dispatch Jules. Workflow files nested under `templates/development-autoloop/.github/workflows/` are template files and do not run from this catalog; they become active only when installed at the root `.github/workflows/` of a consuming repository.

The dispatcher is currently manual-only and plan-first. The safe default is no external side effects. Do not enable live Jules dispatch, scheduled automation, unattended operation, or automatic merging without explicit user approval after the safety review and a successful disposable-consumer pilot.

**Current standing restrictions**
- Do not create a Jules session or trigger a dispatch just to perform a review, run tests, or check status.
- Do not dispatch the next Issue while current work is unresolved or existing work could still be active.
- Do not create a replacement session to repair a PR when the existing Issue/PR/claim/session should be continued.
- Do not automatically merge. Human merge approval remains required.
- Do not claim the end-to-end loop is ready because a unit test or CI run is green.

## Intended workflow

```
Issue contract
  -> complete GitHub/provider snapshot
  -> preflight and reconciliation
  -> deterministic selection of one eligible Issue
  -> durable claim
  -> explicitly authorized provider dispatch
  -> reconcile session, Issue, branch, claim and PR
  -> verify PR contract and exact-head checks
  -> trusted review relay to existing work
  -> human review and merge
```

Each stage must be connected to an actual workflow. Source modules hold reusable decision rules; scripts gather live data and invoke those rules; GitHub Actions workflows define triggers, permissions, and execution boundaries. Do not duplicate decision logic in workflow YAML.

## Core design and safety principles

1. **Fail closed.** Missing, partial, stale, conflicting, unknown, or unverifiable data is a blocker, never evidence that no work exists or that work is safe.
2. **One task at a time by default.** Select deterministically and reserve work durably. Do not start competing work when ownership or status is unclear.
3. **Issue-first contracts.** Each implementation task needs a governing Issue with scope, acceptance criteria, constraints, dependencies, and verification expectations.
4. **Project-neutral by default.** Consumer-specific labels, branch names, required check names, trusted reviewers, and policy belong in configuration. Shared logic must not assume another project’s business rules.
5. **Exact-head evidence.** Review decisions and required checks must apply to the exact current PR head SHA. A new commit invalidates approval/check evidence for the old SHA.
6. **Reconcile before retry.** A timeout or uncertain provider response is not permission to retry. First determine whether the original operation created or continued work.
7. **No duplicate work.** Reuse the existing Issue, branch, PR, claim, and provider session when they are the verified task context.
8. **Least privilege.** Privileged workflows must use trusted default-branch code, minimal permissions, pinned third-party actions, and narrowly scoped secrets.
9. **Tests do not use live providers.** Normal CI uses deterministic fixtures/mocks and must not create real Jules sessions.
10. **Human merge authority.** Green CI, agent completion text, review comments, and relay checks are evidence—not merge authorization.
11. **Explain blocks.** Every blocker should state what was checked, what is unknown or unsafe, whether state changed, and the next safe action.

## Trusted review relay requirements

The relay must:
- accept verdicts only from configured trusted GitHub reviewer identities;
- bind every decision and handoff to repository, PR number, exact head SHA, and review identity/version;
- distinguish `APPROVED`, `CHANGES_REQUESTED`, and explicit `ESCALATION` outcomes;
- ignore generic comments, acknowledgements, and reactions as verdicts;
- require configured non-empty required checks to pass on the same head before approval can advance;
- invalidate old approval when the PR head changes;
- deduplicate repeated webhook deliveries and write durable, inspectable state;
- verify the governing Issue and existing claim/session/branch/PR relationship before a repair handoff;
- never treat an identifier alone, an incomplete lookup, or a failed API read as proof of correlation;
- route in-scope repair to the existing work, never create a replacement Jules session;
- report exact repair SHA, changed paths, check/test evidence, findings addressed, and findings remaining;
- reject no-op commits as successful repair;
- handle missing, ambiguous, failed, timed-out, or unknown provider outcomes as structured blockers rather than retry loops.

Privileged workflows must not check out or execute untrusted PR-head code. A secret-free observer may collect a review event and wake a privileged workflow, but the privileged workflow must re-read current review/check data using trusted default-branch code.

Keep `JULES_API_KEY` exposure to the narrow existing-work verification/reconciliation path that actually requires it. Approval, head synchronization, and escalation should not receive the provider key. Use the protected `autoloop-dispatch` Environment and restrict it to the default branch. Do not put secret values in code, configuration, fixtures, logs, Issues, or PR text.

The relay foundation is not the complete loop. The disposable consumer-repository pilot and end-to-end readiness evidence are required before enabling live repair or unattended operation.

## PR continuation protocol

When a PR needs in-scope corrections:
1. Keep the same branch and PR.
2. Put the authoritative continuation instruction in the PR body and explicitly mention `@Jules` when assigning work to Jules.
3. State `NOT READY`, the precise changes required, tests/checks to run, and explicit boundaries on what must not change.
4. Require factual progress/blocker reporting and evidence on the PR.
5. Re-review the resulting exact head SHA and verify fresh CI before changing the verdict.

When implementation is complete, mark it **READY FOR HUMAN REVIEW** only after the Issue contract, tests, current-head checks, and documentation agree. Never imply that this status means auto-merge is authorized.

Do not open duplicate branches/PRs for ordinary review continuation. Create a new Issue when the work is genuinely outside the governing Issue's scope.

## Repository layout

- `README.md` — catalog purpose, status, principles, and links.
- `docs/TEMPLATE_STANDARDS.md` — standards for all reusable templates.
- `templates/development-autoloop/config/` — example consumer configuration and schema.
- `templates/development-autoloop/docs/` — architecture, implementation plan, recovery, and setup guidance.
- `templates/development-autoloop/scripts/` — GitHub/provider adapters and workflow runners.
- `templates/development-autoloop/src/` — reusable, testable decision logic.
- `templates/development-autoloop/tests/` — unit and mocked safety tests.
- `templates/development-autoloop/.github/workflows/` — workflows to install in a consuming repository, not active catalog workflows.

Read the relevant template README and implementation/recovery documents before making workflow or installation claims. Keep each template's README explicit about maturity, installation, required permissions, Environment secrets, risks, rollback, and pilot requirements.

## Verification and review checklist

Before giving a GO:
- Read this file, the repository README, relevant template README, and relevant architecture/implementation/recovery docs.
- Read the governing Issue and current PR description/diff.
- Confirm the branch and exact current head SHA.
- Check current CI/check-run results for that exact SHA; do not rely on stale screenshots, prior commit checks, or a summary alone.
- Run the relevant syntax and test commands where the available environment permits; tests must remain mocked and offline from live provider dispatch.
- Review security boundaries, permissions, secret exposure, webhook trust, event deduplication, failure handling, and rollback.
- Reconcile all substantive review findings with the current code; do not assume old comments remain applicable if code has changed.
- Ensure docs, PR body, workflow triggers, actual behavior, and declared maturity agree.
- If instructions, evidence, or API state cannot be retrieved, state the limitation and do not invent verification.

A GO is a code-review recommendation, not permission to merge. Jaap retains the final decision.

## Context recovery order

At the beginning of a new session:
1. Read `CHATGPT.md` and root `README.md`.
2. Read the active Issue and current PR/branch/head SHA.
3. Read the relevant template README and architecture, implementation plan, recovery notes, and standards.
4. Inspect current code and tests.
5. Inspect current CI/checks, review feedback, Actions runs, and relevant Environment setup evidence.
6. Decide the next safe action from current facts—not from assumptions or stale conversation summaries.

## Anti-patterns

Do not:
- treat the README or this file as a task queue;
- infer “no active work” from incomplete API results;
- dispatch from a roadmap or issue number alone;
- retry uncertain provider requests blindly;
- treat a reaction, acknowledgement, or generic comment as a review decision;
- trust checks or approvals from an old head SHA;
- grant provider secrets to unrelated privileged event paths;
- let an untrusted PR ref execute with secrets or write permissions;
- create duplicate sessions, claims, branches, or PRs to work around ambiguity;
- mark the template stable before a disposable consumer pilot and documented recovery test;
- merge automatically or bypass the user's final review.
