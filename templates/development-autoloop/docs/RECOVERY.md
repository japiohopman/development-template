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
- **Expired claim:** expiry alone is insufficient. Reconcile provider sessions and PRs, then reclaim only through an atomic compare-and-swap write.
- **Ambiguous provider creation timeout:** search/reconcile by claim ID and provider metadata before retrying. If it cannot be resolved, stop and escalate.
- **Failed state write:** dispatch must not be reported as successful. Recover state storage and reconcile before authorizing further work.
- **Review event for an old PR head:** mark it stale and require review of the current head SHA.

Manual cleanup must require explicit entity IDs and an exact typed confirmation. Never bulk-delete or silently abandon provider sessions. No cleanup command should be enabled until its dry-run output and tests exist.
