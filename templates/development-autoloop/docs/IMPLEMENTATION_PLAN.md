# Implementation plan

Do not enable unattended live automation before the ordered milestones and the disposable-repository pilot pass.

## Ordered milestones

1. **Contracts and config validation — complete.** Define Issue/PR sections, state model, required sections, repository settings, and configuration validation.
2. **Pure preflight and selection — complete.** Test eligibility, dependencies, open-PR duplication, unknown provider states, deterministic ordering, and concurrency.
3. **Durable claims — complete.** [Issue #4](https://github.com/japiohopman/development-template/issues/4) / [PR #13](https://github.com/japiohopman/development-template/pull/13). Use a stable claim ID, compare-and-swap, conflict detection, and read-back after ambiguous writes.
4. **Provider adapter — implemented, review-gated.** [Issue #5](https://github.com/japiohopman/development-template/issues/5) / [PR #14](https://github.com/japiohopman/development-template/pull/14). Validate task packets, source identity, claims, confirmation, and uncertain provider outcomes.
5. **Session/PR lifecycle reconciliation — merged.** [Issue #6](https://github.com/japiohopman/development-template/issues/6) / [PR #17](https://github.com/japiohopman/development-template/pull/17). Compare real sessions with Issues, branches, claims, and PRs; fail closed on missing or ambiguous metadata. The consumer reconciliation workflow is manual and read-only.
6. **PR contract gate — implemented in the Issue #7 review branch.** Validate the governing Issue, substantive PR evidence, exact changed paths, exact head SHA, required check runs, no-op commits, risks, and the next owner/action. The consumer workflow is read-only and runs trusted base-branch code only. Configuration and independent review are required before treating it as operational.
7. **Connect the dispatcher to GitHub Actions — implementation complete; pilot still required.** [Issue #19](https://github.com/japiohopman/development-template/issues/19). The manual plan workflow (`autoloop-dispatch.yml`) and the separately gated manual live workflow (`autoloop-live-dispatch.yml`) use the runner (`autoloop-runner.mjs`) for configuration, complete snapshot, preflight, and one-Issue selection. The plan workflow is side-effect free. Live session creation requires exact repository confirmation, the configured dispatch authorization, `enabled: true`, and `runMode: live` before the provider secret is exposed. Defaults remain disabled; no schedule or unattended operation is enabled.
8. **Trusted review relay — guarded existing-session continuation implemented; outcome reconciliation outstanding.** [Issue #8](https://github.com/japiohopman/development-template/issues/8).
   - **Implemented:** the no-secret review observer automatically wakes the privileged relay through `workflow_run`; trusted default-branch code re-reads reviews and checks. A configured reviewer can post `[autoloop:relay-review]` as a manual retry. The relay stores decisions in one managed per-head GitHub check run, verifies exact-current-head approvals and required checks, and ignores arbitrary actors and acknowledgements. For requested changes it reconciles existing work read-only and records a deduplicated audit comment only when the claim/session/Issue/branch/PR relationship is proven. It does not create provider sessions or mark findings fixed automatically.
   - **Guarded continuation implemented in merged PR #27:** the relay now checks every explicit repair/pilot configuration gate, verifies the exact open PR head and existing Issue/PR/claim/session correlation, fetches the same Jules session, and requires its exact repository source, claim marker, and active state. It records a durable per-review attempt marker before sending one follow-up to that existing session; it never creates a replacement session. A provider acceptance remains `action_required` and is not a successful repair. If the send result is uncertain, automatic retry is blocked and the owner must inspect the same session. The default config still disables this path. **Still outstanding:** complete observable reconciliation of the provider outcome against a new exact PR head, changed paths, checks, and finding dispositions; automatic fork-review bridging; and the disposable consumer-repository pilot.
9. **Mocked end-to-end tests and disposable pilot — not complete.** [Issue #9](https://github.com/japiohopman/development-template/issues/9). Cover races, timeouts, duplicate dispatch, stale/missing claims, pagination, PR/Issue state, review replay, and persistence failures; then install into a throwaway repository and document permissions, recovery, teardown, and pilot results.

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
