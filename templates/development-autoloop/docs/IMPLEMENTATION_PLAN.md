# Implementation plan

Do not enable unattended live automation before the ordered milestones and the disposable-repository pilot pass.

## Ordered milestones

1. **Contracts and config validation — complete.** Define Issue/PR sections, state model, required sections, repository settings, and configuration validation.
2. **Pure preflight and selection — complete.** Test eligibility, dependencies, open-PR duplication, unknown provider states, deterministic ordering, and concurrency.
3. **Durable claims — complete.** [Issue #4](https://github.com/japiohopman/development-template/issues/4) / [PR #13](https://github.com/japiohopman/development-template/pull/13). Use a stable claim ID, compare-and-swap, conflict detection, and read-back after ambiguous writes.
4. **Provider adapter — implemented, review-gated.** [Issue #5](https://github.com/japiohopman/development-template/issues/5) / [PR #14](https://github.com/japiohopman/development-template/pull/14). Validate task packets, source identity, claims, confirmation, and uncertain provider outcomes.
5. **Session/PR lifecycle reconciliation — merged.** [Issue #6](https://github.com/japiohopman/development-template/issues/6) / [PR #17](https://github.com/japiohopman/development-template/pull/17). Compare real sessions with Issues, branches, claims, and PRs; fail closed on missing or ambiguous metadata. The consumer reconciliation workflow is manual and read-only.
6. **PR contract gate — implemented in the Issue #7 review branch.** Validate the governing Issue, substantive PR evidence, exact changed paths, exact head SHA, required check runs, no-op commits, risks, and the next owner/action. The consumer workflow is read-only and runs trusted base-branch code only. Configuration and independent review are required before treating it as operational.
7. **Trusted review relay — not built.** Consume trusted review events, deduplicate them, bind each decision to repository/PR/head SHA, and route requested fixes back to existing work.
8. **Mocked end-to-end tests and recovery — not complete.** Cover races, timeouts, duplicate dispatch, stale/missing claims, pagination, PR/Issue state, review replay, and persistence failures.
9. **Disposable consumer pilot — not complete.** Install the template into a separate throwaway repository, verify permissions/config/secrets, test recovery and teardown, record the result, then consider the status Ready for pilot.

## Workflow-first implementation rule

- A workflow under the consuming repository's root .github/workflows/ decides when each step runs and which permissions it receives.
- A script under scripts/ reads live GitHub/provider evidence and calls the reusable decision functions.
- A module under src/ makes a deterministic decision and is tested without real API calls.
- Documentation and Actions output must explain the result, whether state changed, and the next safe action in everyday language.

A module that has tests but is not called by an executable workflow is a building block, not a completed automatic workflow.

## Definition of done for live dispatch

- The workflow and adapter enforce the exact authorization value.
- A durable claim is committed before an external provider session is created.
- Claim conflicts and ambiguous provider responses cannot trigger duplicate work.
- Incomplete snapshots, unknown states, API failures, and failed persistence block safely.
- An unresolved session or PR prevents a duplicate task.
- A merged PR only resolves a session after ownership is verified; closed-but-unmerged PRs remain unresolved.
- The PR gate binds evidence and required checks to the exact current head SHA and cannot execute PR-head code in a privileged workflow.
- The trusted review relay invalidates stale approvals and treats acknowledgement reactions/comments as acknowledgements only.
- A disposable consumer pilot and documented recovery paths pass before the template status changes to Ready for pilot.
- Human merge approval remains the default.
