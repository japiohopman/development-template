# Disposable consumer-repository pilot runbook

**Status: prepared, not executed.** This document is a checklist for proving the template in a throwaway repository. A completed checklist must contain links and observed results; the existence of this document or green catalog tests is not evidence that the pilot passed.

## Safety boundary

- Use a new, disposable private GitHub repository with no production data, secrets, or deployment access.
- Keep `config/autoloop.json` at its example defaults: `enabled: false`, `runMode: "dry-run"`, `repairDispatchEnabled: false`, `automaticMerge: false`, and `scheduleEnabled: false`.
- Do not run the live dispatch workflow, add a real Jules API key, enable schedules, or enable automatic merging unless the repository owner separately approves that exact pilot step.
- Never test against a production repository or a real customer Issue.
- Stop if an observed result differs from the expected result below. Record the run URL, decision code, mutation status, and next action before doing anything else.

## 1. Prepare the disposable repository

1. Create a new private repository used only for this test. Record its full name and default branch.
2. Copy the contents of `templates/development-autoloop/` to the repository root. The workflows must be under `.github/workflows/`, not nested under the template directory.
3. Copy `config/autoloop.example.json` to `config/autoloop.json` without enabling live features.
4. Review the copied workflow permissions and branch protection. The plan-only runner needs `JULES_API_KEY` for read-only session inventory; do not add it until the owner explicitly approves that read-only provider access for this disposable repository.
5. Initialize the configured state branch (default: `autoloop-state`) and a valid `claims.json` containing an empty `claims` array. Do not interpret a missing state branch or file as an empty queue.
6. Add one deliberately simple test Issue that has the required sections, configured ready labels, no unresolved dependencies, no linked open PR, and no active claim. Do not use a real project task.

## 2. Run safe plan-only checks

1. Run the template's syntax and unit tests from `templates/development-autoloop/` in the catalog repository; record the exact commit and run URL.
2. In the disposable repository, manually run **Development Autoloop Dispatch (Plan-Only)** from the default branch and type the exact `owner/repository` value.
3. Expected: the report identifies the eligible test Issue (or gives a clear blocker), says `mutated: false`, and does not create a claim, Jules session, Issue comment, branch, or PR.
4. Repeat the same workflow once. Expected: the same input and repository state produce the same selection/blocker and still no mutation.
5. Test the fail-closed paths by using an incorrect repository confirmation, an unavailable/invalid state branch, and an incomplete pagination/API response in mocked tests. Expected: a structured block, no mutation, and an explicit safe next action.
6. Verify the workflow run logs contain no secret values. Negative tests that stop before provider inventory can run without a provider key. A successful full plan-only snapshot requires the read-only `JULES_API_KEY` Environment secret; add it only after the owner explicitly approves that access for this disposable repository, and never use it to create a session.

## 3. Live one-task smoke test — requires separate explicit approval

Do not perform this section merely because the plan-only checks pass. Before running it, the repository owner must explicitly approve a live provider request for the disposable repository and verify all of the following:

- The exact disposable repository and test Issue are identified.
- The Environment `autoloop-dispatch` is restricted to the default branch and has only the intended `JULES_API_KEY` Environment secret.
- `config/autoloop.json` was reviewed and the required live gates/authorization phrase were deliberately configured for this disposable repository only.
- Automatic merge and schedules remain disabled.
- The owner understands that the step can create a real Jules session and incur provider usage.

After approval, run the live workflow manually from the default branch with the exact repository confirmation and configured authorization phrase. Do not repeat a run after a timeout or ambiguous response. First inspect the claim ledger and read-only Jules session inventory using the correlation/claim identifiers.

Expected success: one durable claim is written before provider session creation, one uniquely correlated session is recorded, and the output includes the session/claim identifiers. Any unknown or ambiguous outcome must block and require reconciliation; it must never silently create a second session.

## 4. Recovery cases to prove before readiness

Record the expected blocker and observed evidence for each case using mocked tests first; exercise live recovery only if separately approved.

- Duplicate dispatch / competing run: at most one claim can reserve the Issue.
- Provider timeout during session creation: no blind retry; reconcile by exact correlation marker and source.
- Missing, expired, or unreconciled claim: selection blocks until verified recovery evidence exists.
- Unknown provider state or incomplete pagination: block with the exact affected Issue/claim/session identifiers where available.
- PR exists but session/claim correlation is missing or ambiguous: do not dispatch replacement work.
- A new PR commit invalidates old-head review/check evidence.
- A failed state write or ambiguous read-back reports failure and does not claim success.

For each block, capture the workflow run URL, exact commit SHA, decision code, relevant non-secret identifiers, whether state changed, and the next safe action. Redact tokens, API keys, and private provider payloads.

## 5. Pilot evidence record

Complete this record only after observing the run; do not pre-fill success claims.

- Disposable repository:
- Default branch and tested template commit:
- Catalog CI run URL and result:
- Plan-only run URL and result:
- Repeat-run URL and result:
- Negative-test results:
- Live run URL (only if separately approved):
- Claim ID / session ID (non-secret identifiers only):
- Recovery scenarios and evidence:
- Unexpected behavior / follow-up issues:
- Reviewer and date:
- Final decision: `NOT RUN` / `BLOCKED` / `PASS`

**Readiness rule:** the template remains **Foundation — not ready for unattended use** until the exact-head tests pass, the approved disposable pilot and recovery cases are recorded, and a separate explicit readiness decision is made. This runbook does not authorize production dispatch, scheduling, or automatic merging.
