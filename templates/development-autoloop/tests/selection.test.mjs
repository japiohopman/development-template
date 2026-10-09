import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  selectCandidateIssue,
  extractDependencyIssueNumbers,
  evaluateHumanReadiness,
  evaluateDependencyState,
  orderCandidates
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

test('returns BLOCK_INCOMPLETE_SNAPSHOT when snapshot is incomplete or unverified', () => {
  const incompleteSnapshot = makeSnapshot({ snapshotComplete: false });
  const result = selectCandidateIssue(incompleteSnapshot, VALID_CONFIG);

  assert.equal(result.decisionCode, 'BLOCK_INCOMPLETE_SNAPSHOT');
  assert.equal(result.selectedCandidate, null);
  assert.equal(result.safeToDispatch, false);
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

  const snapshot = {
    snapshotComplete: true,
    issues: [dep101Completed, dep102Open, dep103NotPlanned, dep104Duplicate, dep105Unknown]
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

test('blocks candidate represented by an open PR, active claim, or active session', () => {
  const candidate = makeValidIssue({ number: 10 });

  const snapshotWithPR = makeSnapshot({
    issues: [candidate],
    pullRequests: [{ number: 50, state: 'open', issue_number: 10 }]
  });
  const resPR = selectCandidateIssue(snapshotWithPR, VALID_CONFIG);
  assert.equal(resPR.decisionCode, 'WAIT_OPEN_PR');

  const snapshotWithClaim = makeSnapshot({
    issues: [candidate],
    claims: [{ claimId: 'c-123', issueNumber: 10, reconciled: false }]
  });
  const resClaim = selectCandidateIssue(snapshotWithClaim, VALID_CONFIG);
  assert.equal(resClaim.decisionCode, 'BLOCK_ACTIVE_CLAIM');

  const snapshotWithSession = makeSnapshot({
    issues: [candidate],
    sessions: [{ name: 'sess-1', issueNumber: 10, state: 'IN_PROGRESS' }]
  });
  const resSession = selectCandidateIssue(snapshotWithSession, VALID_CONFIG);
  assert.equal(resSession.decisionCode, 'BLOCK_ACTIVE_SESSION');
});

test('supports optional sequenceSource ordering and fallback ascending issue number tie breaker', () => {
  const issueA = makeValidIssue({ number: 30, title: 'Issue 30' });
  const issueB = makeValidIssue({ number: 10, title: 'Issue 10' });
  const issueC = makeValidIssue({ number: 20, title: 'Issue 20' });

  const snapshot = makeSnapshot({
    issues: [issueA, issueB, issueC],
    sequence: [20, 30, 10]
  });

  const sequencedConfig = { ...VALID_CONFIG, sequenceSource: 'docs/sequence.md' };
  const resSequenced = selectCandidateIssue(snapshot, sequencedConfig);
  assert.equal(resSequenced.decisionCode, 'CANDIDATE_SELECTED');
  assert.equal(resSequenced.selectedCandidate.number, 20);

  const defaultOrderRes = selectCandidateIssue(snapshot, VALID_CONFIG);
  assert.equal(defaultOrderRes.decisionCode, 'CANDIDATE_SELECTED');
  assert.equal(defaultOrderRes.selectedCandidate.number, 10);
});

test('selection function is dry-run pure and produces stable decision output', () => {
  const snapshot = Object.freeze(makeSnapshot());
  const config = Object.freeze({ ...VALID_CONFIG });

  const result = selectCandidateIssue(snapshot, config);
  assert.equal(result.decisionCode, 'CANDIDATE_SELECTED');
  assert.equal(result.safeToDispatch, false);
  assert.ok(typeof result.reason === 'string');
  assert.ok(typeof result.nextAction === 'string');
  assert.ok(Array.isArray(result.blockers));
  assert.ok(Array.isArray(result.evaluatedCandidates));
});
