# Recovery and operations

## Required report on every block
Emit the decision code, timestamp, Issue/PR/session/claim identifiers, failed check or API, whether anything was mutated, and the next safe action and owner.

## Recovery cases
- **Provider API unavailable or pagination incomplete:** stop. Do not treat missing results as no active sessions. Retry a read-only reconciliation after the service recovers.
- **Unknown provider state:** retain the block and inspect provider documentation and the live session before updating the configured state map.
- **Active or paused session:** resume/resolve the existing work or escalate it. Do not create a second session as a workaround.
- **Open PR with missing session:** keep the work blocked while the PR is open. Recover the existing session reference or let a human explicitly resolve the PR.
- **Closed but unmerged PR:** require human classification. Do not treat closure alone as successful completion.
- **Merged PR and stale provider session:** verify the repository and merge state, then reconcile the historical session record.
- **Expired claim:** lease expiry alone MUST NEVER release or authorize reuse of a claim. Safe recovery requires explicit, verified reconciliation evidence across three domains:
  1. **Provider sessions:** confirmed terminal (`COMPLETED`, `FAILED`, `CANCELLED`, `EXPIRED`) or verified non-existent (`none`).
  2. **Git branches:** confirmed clean, deleted, merged, or verified non-existent (`none`).
  3. **Pull requests:** confirmed merged, closed with explicit human classification, or verified non-existent (`none`).
  Missing, partial, failed, or unknown evidence blocks recovery (`CLAIM_RECOVERY_BLOCKED`).

- **Evidence scope and freshness:** the evidence record must name the exact `claimId`, repository, Issue number, `verifiedBy`, and ISO `verifiedAt`. Each of `sessions`, `branches`, and `pullRequests` must independently include `verified: true`, the same repository and Issue number, a source identifier, an ISO `observedAt`, and a permitted status. A non-`none` session result must identify the exact inspected session; if the claim already has a `sessionId`, the evidence must match it.
- **Time bounds:** each domain's `observedAt` must not be later than `verifiedAt` and must not predate the claim. Recovery rejects evidence that is future-dated or more than five minutes old at the moment of recovery.
- **Verification responsibility:** this claim layer validates the evidence's schema, scope, timestamps, freshness, and audit persistence. It does not itself contact Jules or query GitHub to prove the evidence is true. The future reconciliation/controller layer must only produce this record after the corresponding read-only checks have actually succeeded.
- **Ambiguous provider creation timeout:** perform read-only reconciliation by exact claim ID/correlation marker, source, and starting branch. If exactly one session is affirmatively verified, attach it to the durable claim. If no match, multiple matches, malformed/incomplete API data, or reconciliation errors remain, preserve the blocked claim and escalate for human inspection. **Never automatically retry session creation after an ambiguous outcome**, because visibility may be delayed. A human must document authoritative evidence that no session was created before authorizing any later attempt.
- **Failed or ambiguous state write:** state updates perform exact `claimId` read-back confirmation. If write response is ambiguous and read-back does not confirm the claim, report `CLAIM_PERSISTENCE_FAILED` and do not report success.
- **Review event for an old PR head:** mark it stale and require review of the current head SHA.
- **Unsatisfied or ambiguous dependency state (`BLOCK_DEPENDENCY_*`):** verify dependency completion state (`completed` state_reason required) or resolve missing/unplanned dependencies before candidate re-selection.
- **Missing human readiness evidence (`BLOCK_HUMAN_READINESS_REQUIRED`):** verify the governing Issue has explicit human readiness evidence or label before dispatch.

## Exact-ID Inspect and Recovery Contract
Manual or automated claim management must target exact claim IDs (`claimId`):
- `inspectClaim({ stateAdapter, claimId })`: inspect authoritative state for exact claim record and active lock status.
- `reconcileAndRecoverClaim({ stateAdapter, claimId, evidence, targetStatus })`: perform atomic compare-and-swap state transition to `RECLAIMED` or `RELEASED` only when complete verified evidence is provided.
- **No bulk deletion or silent abandonment:** claims must be preserved with full historical reconciliation audit records. Never execute bulk deletion commands on state stores.


## Jules API key for manual read-only reconciliation

After installing the template into a consumer repository, configure a GitHub Actions repository secret named `JULES_API_KEY` under **Settings → Secrets and variables → Actions → New repository secret** to use the manual `reconcile-readonly.yml` workflow. Restrict workflow access to the repository that needs it. Keep the value out of source files, logs, Issues, PRs, and test fixtures. CI and tests must use mocked provider requests and must not read this secret.

The `reconcile-readonly.yml` workflow requires a manual `workflow_dispatch` run and exact repository-name confirmation. It has only `contents: read`, `issues: read`, and `pull-requests: read` permissions. It reads the `autoloop-state` branch by default; set the Actions variable `AUTOLOOP_STATE_BRANCH` if the consumer repository uses a different dedicated state branch. A missing/uninitialized branch or unreadable `claims.json` blocks the run instead of being interpreted as an empty claim ledger. The workflow performs no dispatch, provider session creation, GitHub writes, automatic merge, or scheduled heartbeat.

Do not enable live dispatch until the disposable-repository pilot and all definition-of-done checks are complete.

## Manual handling of ambiguous creation

A timeout or network error during `POST /v1alpha/sessions` does not prove the request failed. Do not rerun dispatch or submit another create request automatically. Leave the durable claim blocked and inspect the exact Jules session inventory using the correlation marker, source, and starting branch. If exactly one session can be verified, associate that existing session. If evidence is missing, stale, malformed, or has zero/multiple matches, stop and escalate to a human. Record the claim ID, request result, read-only lookup results, and human decision before any further attempt.
