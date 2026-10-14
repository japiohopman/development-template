# Architecture

## The goal

Development Autoloop is a repository-level control system for safely moving work from an Issue through a coding agent and pull request, then through review and recovery. It must remain reusable across projects. It does not invent the consuming project's product requirements or own final merge authority.

The intended cycle is:

**discover → preflight → select one Issue → claim → dispatch → reconcile → PR gate → trusted review relay → safely continue or stop.**

## Which layer does what?

1. **GitHub Actions workflows — when and with which permissions.** Events trigger the steps, permissions are restricted, and the result becomes a visible check in GitHub.
2. **Scripts — collect the facts.** These adapters read GitHub/provider data, validate that a snapshot is complete, and pass the facts into the decision modules.
3. **Pure source modules — make the decision.** They do not call the network or mutate state; the same rules can be tested with local fixtures.
4. **Issue selection — choose exactly one task.** Eligibility, dependencies, unresolved PRs, active sessions, and concurrent work must be accounted for before a candidate can be selected.
5. **Durable claims — prevent duplicate work.** A stable claim ID and compare-and-swap transitions protect against two runs reserving the same Issue.
6. **Provider adapter — hand over work safely.** The adapter turns an approved execution packet into a provider request and reconciles ambiguous responses rather than blindly retrying.
7. **Lifecycle reconciliation — compare intended work to reality.** Provider sessions, Issues, branches, claims, and PRs are checked for ownership and consistency.
8. **PR contract gate — verify current evidence.** The gate checks the governing Issue, required handoff sections, criterion evidence, changed paths, check runs, and exact head SHA. It reports CI separately from contract completeness and human approval.
9. **Trusted review relay — route decisions.** Review decisions are accepted only from configured trusted reviewers, are tied to a PR head SHA, and should direct repair to the existing work rather than create duplicates.
10. **Recovery and reporting — explain safely.** Every block needs a reason, relevant identifiers, whether state changed, and the next safe action.

## Why decision logic lives under src/

The workflow is the coordinator; the source modules are reusable rules. Keeping decisions out of long workflow files makes them easier to test against missing metadata, API errors, stale SHAs, duplicate tasks, and unknown states. It also avoids maintaining two different versions of the same safety rules.

A source file by itself is not an automated loop. Its runner must be called by the correct workflow, with the right permissions and trusted inputs. Conversely, a privileged workflow must never execute or install code supplied by the pull-request head.

## Current implementation state

- Configuration validation, Issue/PR contracts, preflight, selection, durable claims, provider dispatch logic, and lifecycle reconciliation have tested implementations.
- The read-only reconciliation workflow is an example for a consuming repository and must be invoked manually.
- The PR contract gate and its read-only consumer workflow are implemented in the Issue #7 change; they remain review-gated until the exact commit has passed CI and the implementation is independently reviewed.
- The automatic dispatcher is not yet connected to an active Actions runner.
- The trusted review relay and full end-to-end pilot are still outstanding.

This is Foundation, not production-ready unattended automation. Live or scheduled dispatch must remain disabled.

## State and concurrency

Do not push transient queue-state files to the protected default branch. State writes target a dedicated configurable state branch such as autoloop-state.

State updates use strict compare-and-swap (CAS) ref checks. A claim includes its stable ID, repository, Issue, owner, provider, session ID, lifecycle status, timestamps, and reconciliation status. Race tests and ambiguous-write read-back verification are required before live dispatch can be trusted.

A separate controller/database may be needed for an account-wide concurrency limit across multiple independent template copies.

## Security boundaries

- Catalog CI may test source code and mocked external responses; it must not create real provider sessions.
- Use pull_request_target only for trusted base-branch code and GitHub metadata. Never check out, import, install, or execute PR-head code in a privileged workflow.
- Use the smallest permission set per workflow/job. The PR contract gate needs read-only repository contents, Issues, pull requests, and check runs.
- Verify live API evidence for the exact current commit rather than trusting a SHA or green status written in the PR body.
- Re-read the PR head after gathering evidence; if the head changed during evaluation, block.
- Store credentials only in the consuming repository's secret settings.
- Human merge approval remains the default.
