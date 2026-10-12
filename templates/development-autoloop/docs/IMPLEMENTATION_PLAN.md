# Implementation plan

Do not enable unattended live automation before steps 1–8 are complete and the disposable-repository pilot passes.

## Ordered milestones
1. **Contracts and config validation.** *(Complete)* Define issue/PR schemas, state model, required sections, repository settings, and configuration validator.
2. **Pure preflight and selection.** *(Complete)* Test issue eligibility, dependencies, open-PR duplication, unknown provider states, deterministic ordering, and per-repository concurrency.
3. **Durable claims.** *(Complete)* [Issue #4](https://github.com/japiohopman/development-template/issues/4) / [PR #13](https://github.com/japiohopman/development-template/pull/13). Implement a stable claimId, owner, issue number, provider, session ID, creation time, expiry, reconciled status, and atomic compare-and-swap. Add race and crash tests.
4. **Provider adapter.** *(Complete)* [Issue #5](https://github.com/japiohopman/development-template/issues/5) / [PR #14](https://github.com/japiohopman/development-template/pull/14). Create at most one provider session only after exact manual confirmation. Handle ambiguous timeouts by reconciling sessions before retrying. Recompute candidate selection from an authoritative snapshot at the dispatch boundary.
5. **Session/PR loop.** Reconcile actual sessions, issues, branches, and PRs; add optional scheduled heartbeat only after manual dispatch is proven safe.
6. **PR contract gate.** Validate required sections, linked Issue, changed files, exact head SHA evidence, required checks, blockers, and no-op commits.
7. **Review relay.** Consume trusted reviewers' decisions; deduplicate events and key decisions to repository, PR number, and head SHA.
8. **Mocked end-to-end tests and recovery docs.** Cover races, timeouts, duplicate dispatch, stale/missing claims, pagination, merged/closed PRs, review replay, and persistence failures.
9. **Pilot and release.** Install to a disposable repository, verify permissions/secrets and recovery scenarios, document outcomes, then mark Ready for pilot. Enable schedule only as an explicit opt-in.

## Definition of done for live dispatch
- Exact authorization value is enforced by the workflow and adapter.
- A durable claim is committed before provider session creation.
- Claim conflicts and ambiguous provider responses cannot trigger duplicate work.
- Incomplete API snapshots, unknown states, API failures, and failed state writes block safely.
- One current open PR or unresolved provider session prevents a second task for the same work.
- Tests prove a merged PR resolves an old session while closed-but-unmerged PRs do not.
- Human merge approval remains the default.
