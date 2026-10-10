import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  selectCandidateIssue,
  extractDependencyIssueNumbers,
  evaluateHumanReadiness,
  evaluateDependencyState
} from '../src/selection.mjs';

const VALID_CONFIG = JSON.parse(
  readFileSync(new URL('../config/autoloop.example.json', import.meta.url), 'utf8')
);

function makeValidIssue(overrides = {}) {
  return {
    number: 10,
    title: 'Valid Issue Title',
    state: 'open',
    labels: ['roadmap-ready'],
    humanReadiness: true,
    body: `
# Scope
Scope content here.

# Acceptance criteria
Criteria content here.

# Dependencies
None

# Out of scope
Out of scope content here.

# Validation plan
Validation plan content here.
    `.trim(),
    ...overrides
  };
}

function makeSnapshot(overrides = {}) {
  return {
    snapshotComplete: true,
    issues: [makeValidIssue()],
    pullRequests: [],
    sessions: [],
    claims: [],
    ...overrides
  };
}

test('selects candidate deterministically on identical snapshots', () => {
  const snapshot = makeSnapshot();
  const run1 = selectCandidateIssue(snapshot, VALID_CONFIG);
  const run2 = selectCandidateIssue(snapshot, VALID_CONFIG);

  assert.equal(run1.decisionCode, 'CANDIDATE_SELECTED');
  assert.equal(run1.selectedCandidate.number, 10);
  assert.deepEqual(run1, run2);
});

test('returns BLOCK_INCOMPLETE_SNAPSHOT when snapshot is incomplete or missing collections', () => {
  const incompleteSnapshot = makeSnapshot({ snapshotComplete: false });
  assert.equal(selectCandidateIssue(incompleteSnapshot, VALID_CONFIG).decisionCode, 'BLOCK_INCOMPLETE_SNAPSHOT');

  const missingIssues = { snapshotComplete: true, pullRequests: [], sessions: [], claims: [] };
  assert.equal(selectCandidateIssue(missingIssues, VALID_CONFIG).decisionCode, 'BLOCK_INCOMPLETE_SNAPSHOT');

  const missingPRs = { snapshotComplete: true, issues: [makeValidIssue()], sessions: [], claims: [] };
  assert.equal(selectCandidateIssue(missingPRs, VALID_CONFIG).decisionCode, 'BLOCK_INCOMPLETE_SNAPSHOT');

  const missingSessions = { snapshotComplete: true, issues: [makeValidIssue()], pullRequests: [], claims: [] };
  assert.equal(selectCandidateIssue(missingSessions, VALID_CONFIG).decisionCode, 'BLOCK_INCOMPLETE_SNAPSHOT');

  const missingClaims = { snapshotComplete: true, issues: [makeValidIssue()], pullRequests: [], sessions: [] };
  assert.equal(selectCandidateIssue(missingClaims, VALID_CONFIG).decisionCode, 'BLOCK_INCOMPLETE_SNAPSHOT');
});

test('fails closed with BLOCK_AMBIGUOUS_ACTIVE_WORK when pullRequests, sessions, or claims contain malformed active work', () => {
  const malformedPRSnapshot = makeSnapshot({
    pullRequests: [{ state: 'open' }] // missing pr number and issue linkage
  });
  assert.equal(selectCandidateIssue(malformedPRSnapshot, VALID_CONFIG).decisionCode, 'BLOCK_AMBIGUOUS_ACTIVE_WORK');

  const malformedSessionSnapshot = makeSnapshot({
    sessions: [{ state: 'IN_PROGRESS' }] // missing name and issue number
  });
  assert.equal(selectCandidateIssue(malformedSessionSnapshot, VALID_CONFIG).decisionCode, 'BLOCK_AMBIGUOUS_ACTIVE_WORK');

  const malformedClaimSnapshot = makeSnapshot({
    claims: [{ reconciled: false }] // missing claimId and issue number
  });
  assert.equal(selectCandidateIssue(malformedClaimSnapshot, VALID_CONFIG).decisionCode, 'BLOCK_AMBIGUOUS_ACTIVE_WORK');
});

test('returns BLOCK_INVALID_CONFIG on invalid configuration', () => {
  const result = selectCandidateIssue(makeSnapshot(), { invalid: true });

  assert.equal(result.decisionCode, 'BLOCK_INVALID_CONFIG');
  assert.equal(result.selectedCandidate, null);
  assert.equal(result.safeToDispatch, false);
});

test('returns NO_ELIGIBLE_CANDIDATE when no candidate has readiness label', () => {
  const snapshot = makeSnapshot({
    issues: [makeValidIssue({ labels: ['other-label'] })]
  });
  const result = selectCandidateIssue(snapshot, VALID_CONFIG);

  assert.equal(result.decisionCode, 'NO_ELIGIBLE_CANDIDATE');
  assert.equal(result.selectedCandidate, null);
});

test('enforces human-readiness gate when humanReadinessRequired is enabled', () => {
  const snapshotWithoutHumanReady = makeSnapshot({
    issues: [makeValidIssue({ humanReadiness: false })]
  });
  const result = selectCandidateIssue(snapshotWithoutHumanReady, VALID_CONFIG);

  assert.equal(result.decisionCode, 'BLOCK_HUMAN_READINESS_REQUIRED');
  assert.equal(result.selectedCandidate, null);

  const disabledConfig = { ...VALID_CONFIG, humanReadinessRequired: false };
  const result2 = selectCandidateIssue(snapshotWithoutHumanReady, disabledConfig);
  assert.equal(result2.decisionCode, 'CANDIDATE_SELECTED');
  assert.equal(result2.selectedCandidate.number, 10);
});

test('accepts human-readiness via labels or structured objects', () => {
  const labelReady = makeValidIssue({ humanReadiness: undefined, labels: ['roadmap-ready', 'human-ready'] });
  const objectReady = makeValidIssue({ humanReadiness: { verified: true } });

  assert.equal(evaluateHumanReadiness(labelReady, VALID_CONFIG).verified, true);
  assert.equal(evaluateHumanReadiness(objectReady, VALID_CONFIG).verified, true);
});

test('extracts dependency numbers from Markdown body and structured arrays', () => {
  const issueWithDeps = makeValidIssue({
    dependencies: [20, '#21'],
    body: `
# Scope
Scope

# Acceptance criteria
Criteria

# Dependencies
Requires #22 and https://github.com/example/repo/issues/23

# Out of scope
Out of scope

# Validation plan
Validation
    `
  });

  const extracted = extractDependencyIssueNumbers(issueWithDeps);
  assert.deepEqual(extracted, [20, 21, 22, 23]);
});

test('handles completed, missing, open, not-planned, duplicate, and unknown dependency states', () => {
  const dep101Completed = { number: 101, state: 'closed', state_reason: 'completed' };
  const dep102Open = { number: 102, state: 'open' };
  const dep103NotPlanned = { number: 103, state: 'closed', state_reason: 'not_planned' };
  const dep104Duplicate = { number: 104, state: 'closed', state_reason: 'duplicate' };
  const dep105Unknown = { number: 105, state: 'closed', state_reason: '' };
  const dep106BypassAttempt = { number: 106, state: 'closed', state_reason: '', completed: true };

  const snapshot = {
    snapshotComplete: true,
    issues: [dep101Completed, dep102Open, dep103NotPlanned, dep104Duplicate, dep105Unknown, dep106BypassAttempt]
  };

  assert.equal(evaluateDependencyState(101, snapshot).valid, true);

  const missingRes = evaluateDependencyState(999, snapshot);
  assert.equal(missingRes.valid, false);
  assert.equal(missingRes.code, 'BLOCK_DEPENDENCY_MISSING');

  const openRes = evaluateDependencyState(102, snapshot);
  assert.equal(openRes.valid, false);
  assert.equal(openRes.code, 'BLOCK_DEPENDENCY_UNSATISFIED');

  const notPlannedRes = evaluateDependencyState(103, snapshot);
  assert.equal(notPlannedRes.valid, false);
  assert.equal(notPlannedRes.code, 'BLOCK_DEPENDENCY_NOT_PLANNED');

  const duplicateRes = evaluateDependencyState(104, snapshot);
  assert.equal(duplicateRes.valid, false);
  assert.equal(duplicateRes.code, 'BLOCK_DEPENDENCY_DUPLICATE');

  const unknownRes = evaluateDependencyState(105, snapshot);
  assert.equal(unknownRes.valid, false);
  assert.equal(unknownRes.code, 'BLOCK_DEPENDENCY_UNKNOWN_REASON');

  const bypassRes = evaluateDependencyState(106, snapshot);
  assert.equal(bypassRes.valid, false);
  assert.equal(bypassRes.code, 'BLOCK_DEPENDENCY_UNKNOWN_REASON');
});

test('blocks selection if candidate has unsatisfied or missing dependencies', () => {
  const candidate = makeValidIssue({
    number: 10,
    dependencies: [20]
  });

  const snapshotMissingDep = makeSnapshot({
    issues: [candidate]
  });
  const res1 = selectCandidateIssue(snapshotMissingDep, VALID_CONFIG);
  assert.equal(res1.decisionCode, 'BLOCK_DEPENDENCY_MISSING');

  const openDep = { number: 20, state: 'open' };
  const snapshotOpenDep = makeSnapshot({
    issues: [candidate, openDep]
  });
  const res2 = selectCandidateIssue(snapshotOpenDep, VALID_CONFIG);
  assert.equal(res2.decisionCode, 'BLOCK_DEPENDENCY_UNSATISFIED');
});

test('blocks candidate represented by an open PR or closed-unmerged PR, but accepts verified merged PR', () => {
  const candidate = makeValidIssue({ number: 10 });

  const snapshotOpenPR = makeSnapshot({
    issues: [candidate],
    pullRequests: [{ number: 50, state: 'open', issue_number: 10 }]
  });
  assert.equal(selectCandidateIssue(snapshotOpenPR, VALID_CONFIG).decisionCode, 'WAIT_OPEN_PR');

  const snapshotClosedUnmergedPR = makeSnapshot({
    issues: [candidate],
    pullRequests: [{ number: 50, state: 'closed', merged: false, issue_number: 10 }]
  });
  assert.equal(selectCandidateIssue(snapshotClosedUnmergedPR, VALID_CONFIG).decisionCode, 'WAIT_OPEN_PR');

  const snapshotMergedPR = makeSnapshot({
    issues: [candidate],
    pullRequests: [{ number: 50, state: 'closed', merged: true, merged_at: '2025-01-01T00:00:00Z', issue_number: 10 }]
  });
  assert.equal(selectCandidateIssue(snapshotMergedPR, VALID_CONFIG).decisionCode, 'CANDIDATE_SELECTED');
});

test('blocks candidate represented by active claim or active session', () => {
  const candidate = makeValidIssue({ number: 10 });

  const snapshotWithClaim = makeSnapshot({
    issues: [candidate],
    claims: [{ claimId: 'c-123', issueNumber: 10, reconciled: false }]
  });
  assert.equal(selectCandidateIssue(snapshotWithClaim, VALID_CONFIG).decisionCode, 'BLOCK_ACTIVE_CLAIM');

  const snapshotWithSession = makeSnapshot({
    issues: [candidate],
    sessions: [{ name: 'sess-1', issueNumber: 10, state: 'IN_PROGRESS' }]
  });
  assert.equal(selectCandidateIssue(snapshotWithSession, VALID_CONFIG).decisionCode, 'BLOCK_ACTIVE_SESSION');
});

test('counts active claims toward repository maxConcurrentSessions concurrency limit', () => {
  const candidate = makeValidIssue({ number: 10 });

  const snapshotWithOtherClaim = makeSnapshot({
    issues: [candidate],
    claims: [{ claimId: 'c-999', issueNumber: 5, reconciled: false }]
  });

  const res = selectCandidateIssue(snapshotWithOtherClaim, VALID_CONFIG);
  assert.equal(res.decisionCode, 'WAIT_CONCURRENCY_LIMIT');
});

test('counts active session with only a PR URL toward repository maxConcurrentSessions concurrency limit', () => {
  const candidate = makeValidIssue({ number: 10 });

  const snapshotWithPRURLSession = makeSnapshot({
    issues: [candidate],
    sessions: [
      {
        state: 'IN_PROGRESS',
        outputs: [
          {
            pullRequest: {
              url: 'https://github.com/example/repo/pull/99'
            }
          }
        ]
      }
    ]
  });

  const res = selectCandidateIssue(snapshotWithPRURLSession, VALID_CONFIG);
  assert.equal(res.decisionCode, 'WAIT_CONCURRENCY_LIMIT');
});

test('sequenceSource ordering and ambiguous sequence error cases', () => {
  const issueA = makeValidIssue({ number: 30, title: 'Issue 30' });
  const issueB = makeValidIssue({ number: 10, title: 'Issue 10' });

  const sequencedConfig = { ...VALID_CONFIG, sequenceSource: 'docs/sequence.md' };

  const validSnapshot = makeSnapshot({
    issues: [issueA, issueB],
    sequence: [30, 10]
  });
  const resValid = selectCandidateIssue(validSnapshot, sequencedConfig);
  assert.equal(resValid.decisionCode, 'CANDIDATE_SELECTED');
  assert.equal(resValid.selectedCandidate.number, 30);

  const multipleNoSeqRes = selectCandidateIssue(makeSnapshot({ issues: [issueA, issueB] }), VALID_CONFIG);
  assert.equal(multipleNoSeqRes.decisionCode, 'BLOCK_AMBIGUOUS_CHOICE');

  const duplicateSeqRes = selectCandidateIssue(
    makeSnapshot({ issues: [issueA, issueB], sequence: [30, 30] }),
    sequencedConfig
  );
  assert.equal(duplicateSeqRes.decisionCode, 'BLOCK_AMBIGUOUS_CHOICE');

  const incompleteSeqRes = selectCandidateIssue(
    makeSnapshot({ issues: [issueA, issueB], sequence: [30] }),
    sequencedConfig
  );
  assert.equal(incompleteSeqRes.decisionCode, 'BLOCK_AMBIGUOUS_CHOICE');
});

test('fails closed on malformed or duplicate issue records regardless of input array order', () => {
  const nonObjectIssueSnapshot = makeSnapshot({
    issues: ['not-an-object']
  });
  assert.equal(selectCandidateIssue(nonObjectIssueSnapshot, VALID_CONFIG).decisionCode, 'BLOCK_AMBIGUOUS_CANDIDATE');

  const missingNumberSnapshot = makeSnapshot({
    issues: [{ title: 'No Number', state: 'open', labels: ['roadmap-ready'] }]
  });
  assert.equal(selectCandidateIssue(missingNumberSnapshot, VALID_CONFIG).decisionCode, 'BLOCK_AMBIGUOUS_CANDIDATE');

  const unknownStateSnapshot = makeSnapshot({
    issues: [{ number: 99, title: 'Unknown state', state: 'invalid-state', labels: ['roadmap-ready'] }]
  });
  assert.equal(selectCandidateIssue(unknownStateSnapshot, VALID_CONFIG).decisionCode, 'BLOCK_AMBIGUOUS_CANDIDATE');

  const duplicateIssueA = makeValidIssue({ number: 10, title: 'Title First', humanReadiness: true });
  const duplicateIssueB = makeValidIssue({ number: 10, title: 'Title Second', humanReadiness: false });

  const duplicateSnapshot1 = makeSnapshot({ issues: [duplicateIssueA, duplicateIssueB] });
  const duplicateSnapshot2 = makeSnapshot({ issues: [duplicateIssueB, duplicateIssueA] });

  const resDup1 = selectCandidateIssue(duplicateSnapshot1, VALID_CONFIG);
  const resDup2 = selectCandidateIssue(duplicateSnapshot2, VALID_CONFIG);

  assert.equal(resDup1.decisionCode, 'BLOCK_AMBIGUOUS_CANDIDATE');
  assert.equal(resDup2.decisionCode, 'BLOCK_AMBIGUOUS_CANDIDATE');
  assert.equal(JSON.stringify(resDup1), JSON.stringify(resDup2));
});

test('permutation invariance: shuffling collection elements produces byte-for-byte identical output', () => {
  const issueA = makeValidIssue({ number: 10, title: 'Issue 10' });
  const issueB = makeValidIssue({ number: 20, title: 'Issue 20' });
  const pr1 = { number: 100, state: 'closed', merged: true, issue_number: 5 };
  const pr2 = { number: 101, state: 'closed', merged: true, issue_number: 6 };
  const claim1 = { claimId: 'c-1', issueNumber: 5, reconciled: true };
  const claim2 = { claimId: 'c-2', issueNumber: 6, reconciled: true };
  const session1 = { name: 's-1', issueNumber: 5, state: 'COMPLETED' };
  const session2 = { name: 's-2', issueNumber: 6, state: 'COMPLETED' };

  const sequencedConfig = { ...VALID_CONFIG, sequenceSource: 'docs/sequence.md' };

  const snapshot1 = {
    snapshotComplete: true,
    issues: [issueA, issueB],
    pullRequests: [pr1, pr2],
    claims: [claim1, claim2],
    sessions: [session1, session2],
    sequence: [20, 10]
  };

  const snapshot2 = {
    snapshotComplete: true,
    issues: [issueB, issueA],
    pullRequests: [pr2, pr1],
    claims: [claim2, claim1],
    sessions: [session2, session1],
    sequence: [20, 10]
  };

  const res1 = selectCandidateIssue(snapshot1, sequencedConfig);
  const res2 = selectCandidateIssue(snapshot2, sequencedConfig);

  assert.equal(res1.decisionCode, 'CANDIDATE_SELECTED');
  assert.equal(res1.selectedCandidate.number, 20);
  assert.deepEqual(res1, res2);
  assert.equal(JSON.stringify(res1), JSON.stringify(res2));
});
