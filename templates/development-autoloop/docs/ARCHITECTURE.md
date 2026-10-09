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
The code currently implements configuration validation (`validateConfig`), contract validation (`validateIssueContract`), safe pagination, session/PR reconciliation, pure preflight decisions (`evaluatePreflight`), and deterministic Issue selection and dependency checks (`selectCandidateIssue`). Layers 5–8 require additional work before live dispatch is enabled.

### Issue Selector & Snapshot Contract (`selectCandidateIssue`)
- **Input:** Snapshot object `{ complete: true, issues: [...], pullRequests: [...], sessions: [...], sequence?: [...] }` and configuration object.
- **Eligibility:** Candidates must be open Issues (`state === 'open'`), pass `validateIssueContract`, and carry the configured `ready` label (`humanReadinessRequired` is enforced).
- **Dependencies:** Extracted from the `Dependencies` Markdown section. A dependency is completed ONLY if closed and completed (`state === 'closed'` and not `duplicate`/`not_planned`). Unknown or open dependency states block the candidate.
- **Unresolved Work:** Open or closed-but-unmerged PRs and active provider sessions linked to the Issue block selection.
- **Ordering & Sequence:** If `sequenceSource` is configured, candidates are ordered according to the sequence collection. Absent sequence source with multiple eligible candidates or ambiguous/tied/duplicate sequence entries return explicit block decisions (`AMBIGUOUS_ORDERING`, `INVALID_SEQUENCE`).
- **Deterministic Output:** Returns dry-run `{ selectedCandidate, decisionCode, blockers, nextSafeAction }`. Output is byte-for-byte identical regardless of snapshot collection permutation.

## State and concurrency
Do not push transient queue-state files to the protected default branch. A preferred GitHub-native starting point is a dedicated state branch updated with expected-head/compare-and-swap semantics. A dedicated controller/database may be required for cross-repository global concurrency; separate template copies cannot promise an account-wide cap by themselves.

## Security
- Keep code tests on unprivileged pull_request workflows.
- Use pull_request_target only for trusted base-branch workflow logic and metadata operations; never execute PR-head code in a privileged workflow.
- Use minimum workflow permissions per job.
- Validate API/check evidence for the exact commit rather than trusting status prose in the PR body.
- Store provider credentials only in GitHub Actions secrets.
