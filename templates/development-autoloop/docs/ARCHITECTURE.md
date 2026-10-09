# Architecture

## Responsibility boundary
The template is a repository-level development control plane. It coordinates safe issue execution and review handoff. It does not determine a consuming project's product strategy, invent acceptance criteria, or own final merge authority.

## Core lifecycle
Proposed → ready → claimed → in progress → awaiting review → changes requested or approved → merged.

Blocked and escalated are explicit outcomes, not hidden retries. A material scope expansion must become a separately reviewed Issue. Fixes should remain attached to the existing Issue and PR where possible.

## Layers
1. **Configuration validation:** schema and repo identity, branch, labels, checks, limits, confirmation mode.
2. **Read-only preflight:** collect complete snapshots of issues, claims, provider sessions, branches, and PRs.
3. **Pure decision functions:** make a deterministic allow/wait/block decision without side effects.
4. **Issue selection:** select exactly one eligible Issue; validate dependencies and existing PRs.
5. **Durable claim store:** reserve a claim ID before creating external work, atomically detect conflicts, and expose persistence errors.
6. **Provider adapter:** map the generic execution packet to an external agent/session provider.
7. **Review relay:** accept configured trusted reviewer events, bind decision to current PR head SHA, and invalidate stale approvals.
8. **Recovery/diagnostics:** record block reason, IDs, run timestamp, mutations, and next safe action.

## Current implementation
The code currently implements only the safe foundation for pagination, session/PR reconciliation, and preflight decisions. Layers 1 and 4–8 require additional work before live dispatch is enabled.

## State and concurrency
Do not push transient queue-state files to the protected default branch. A preferred GitHub-native starting point is a dedicated state branch updated with expected-head/compare-and-swap semantics. A dedicated controller/database may be required for cross-repository global concurrency; separate template copies cannot promise an account-wide cap by themselves.

## Security
- Keep code tests on unprivileged pull_request workflows.
- Use pull_request_target only for trusted base-branch workflow logic and metadata operations; never execute PR-head code in a privileged workflow.
- Use minimum workflow permissions per job.
- Validate API/check evidence for the exact commit rather than trusting status prose in the PR body.
- Store provider credentials only in GitHub Actions secrets.
