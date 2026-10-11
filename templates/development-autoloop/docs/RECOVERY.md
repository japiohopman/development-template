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
- **Ambiguous provider creation timeout:** search/reconcile by claim ID and provider metadata before retrying. If it cannot be resolved, stop and escalate.
- **Failed or ambiguous state write:** state updates perform exact `claimId` read-back confirmation. If write response is ambiguous and read-back does not confirm the claim, report `CLAIM_PERSISTENCE_FAILED` and do not report success.
- **Review event for an old PR head:** mark it stale and require review of the current head SHA.
- **Unsatisfied or ambiguous dependency state (`BLOCK_DEPENDENCY_*`):** verify dependency completion state (`completed` state_reason required) or resolve missing/unplanned dependencies before candidate re-selection.
- **Missing human readiness evidence (`BLOCK_HUMAN_READINESS_REQUIRED`):** verify the governing Issue has explicit human readiness evidence or label before dispatch.

## Exact-ID Inspect and Recovery Contract
Manual or automated claim management must target exact claim IDs (`claimId`):
- `inspectClaim({ stateAdapter, claimId })`: inspect authoritative state for exact claim record and active lock status.
- `reconcileAndRecoverClaim({ stateAdapter, claimId, evidence, targetStatus })`: perform atomic compare-and-swap state transition to `RECLAIMED` or `RELEASED` only when complete verified evidence is provided.
- **No bulk deletion or silent abandonment:** claims must be preserved with full historical reconciliation audit records. Never execute bulk deletion commands on state stores.
