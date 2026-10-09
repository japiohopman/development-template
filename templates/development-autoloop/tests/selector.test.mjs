import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { selectCandidateIssue, extractDependencies, isDependencyCompleted, isPullRequestLinkedToIssue } from '../src/selector.mjs';

const VALID_CONFIG = JSON.parse(
  readFileSync(new URL('../config/autoloop.example.json', import.meta.url), 'utf8')
);

const READY_LABEL = VALID_CONFIG.labels.ready; // 'roadmap-ready'

function makeValidIssue(number, {
  state = 'open',
  labels = [READY_LABEL],
  dependencies = 'None',
  body = null
} = {}) {
  const issueBody = body ?? [
    '## Scope',
    'Scope description.',
    '## Acceptance criteria',
    '- Criteria 1',
    '## Dependencies',
    dependencies,
    '## Out of scope',
    'None',
    '## Validation plan',
    'Run tests'
  ].join('\n');

  return {
    number,
    state,
    labels: labels.map(l => (typeof l === 'string' ? { name: l } : l)),
    body: issueBody
  };
}

function makeSnapshot({
  complete = true,
  issues = [],
  pullRequests = [],
  sessions = [],
  sequence = null
} = {}) {
  const snap = {
    complete,
    issues,
    pullRequests,
    sessions
  };
  if (sequence !== null) {
    snap.sequence = sequence;
  }
  return snap;
}

test('extractDependencies extracts issue numbers and ignores self / non-issue text', () => {
  const body = `
## Scope
Test scope
## Acceptance criteria
Test criteria
## Dependencies
Depends on #10, #12, https://github.com/org/repo/issues/15, and self #5. Also "none" mentioned in prose.
## Out of scope
None
## Validation plan
Unit tests
`;
  const deps = extractDependencies(body, 5);
  assert.deepEqual(deps, [10, 12, 15]);
});

test('isDependencyCompleted verifies completion and rejects duplicate/not_planned', () => {
  assert.deepEqual(isDependencyCompleted({ number: 1, state: 'open' }), {
    completed: false,
    reason: 'Dependency Issue #1 is still open.'
  });

  assert.deepEqual(isDependencyCompleted({ number: 2, state: 'closed', state_reason: 'completed' }), {
    completed: true
  });

  assert.deepEqual(isDependencyCompleted({ number: 3, state: 'closed', state_reason: 'duplicate' }), {
    completed: false,
    reason: 'Dependency Issue #3 was closed as duplicate.'
  });

  assert.deepEqual(isDependencyCompleted({ number: 4, state: 'closed', state_reason: 'not_planned' }), {
    completed: false,
    reason: 'Dependency Issue #4 was closed as not planned.'
  });
});

test('isPullRequestLinkedToIssue identifies direct and indirect PR issue linkage', () => {
  assert.equal(isPullRequestLinkedToIssue({ issue_number: 10 }, 10), true);
  assert.equal(isPullRequestLinkedToIssue({ title: 'Fixes #10' }, 10), true);
  assert.equal(isPullRequestLinkedToIssue({ body: 'Closes issue #10' }, 10), true);
  assert.equal(isPullRequestLinkedToIssue({ title: 'Fixes #11' }, 10), false);
});

test('selectCandidateIssue fails closed on invalid config', () => {
  const res = selectCandidateIssue(makeSnapshot(), { invalid: 'config' });
  assert.equal(res.selectedCandidate, null);
  assert.equal(res.decisionCode, 'INVALID_CONFIG');
  assert.equal(res.blockers.length > 0, true);
});

test('selectCandidateIssue fails closed on incomplete snapshot or missing collections', () => {
  const resIncomplete = selectCandidateIssue({ complete: false, issues: [], pullRequests: [], sessions: [] }, VALID_CONFIG);
  assert.equal(resIncomplete.selectedCandidate, null);
  assert.equal(resIncomplete.decisionCode, 'INCOMPLETE_SNAPSHOT');

  const resMissingCol = selectCandidateIssue({ complete: true, issues: [] }, VALID_CONFIG);
  assert.equal(resMissingCol.selectedCandidate, null);
  assert.equal(resMissingCol.decisionCode, 'INCOMPLETE_SNAPSHOT');
});

test('selectCandidateIssue fails closed on malformed Issues', () => {
  const snapshot = makeSnapshot({
    issues: [{ number: 1, state: 'open' }] // missing required body contract sections
  });
  const res = selectCandidateIssue(snapshot, VALID_CONFIG);
  assert.equal(res.selectedCandidate, null);
  assert.equal(res.decisionCode, 'MALFORMED_ISSUE');
  assert.equal(res.blockers.length > 0, true);
});

test('selectCandidateIssue respects readiness label and humanReadinessRequired', () => {
  const issueNotReady = makeValidIssue(1, { labels: ['proposed'] });
  const snapshot = makeSnapshot({ issues: [issueNotReady] });
  const res = selectCandidateIssue(snapshot, VALID_CONFIG);
  assert.equal(res.selectedCandidate, null);
  assert.equal(res.decisionCode, 'NO_ELIGIBLE_CANDIDATES');

  const issueReady = makeValidIssue(2, { labels: [READY_LABEL] });
  const snapshotReady = makeSnapshot({ issues: [issueReady] });
  const resReady = selectCandidateIssue(snapshotReady, VALID_CONFIG);
  assert.equal(resReady.decisionCode, 'CANDIDATE_SELECTED');
  assert.equal(resReady.selectedCandidate.number, 2);
});

test('selectCandidateIssue blocks candidates with unresolved dependencies', () => {
  const depIssueOpen = makeValidIssue(10, { state: 'open', labels: ['proposed'] });
  const depIssueDuplicate = makeValidIssue(11, { state: 'closed', labels: ['proposed'] });
  depIssueDuplicate.state_reason = 'duplicate';

  const candidate = makeValidIssue(20, { dependencies: 'Depends on #10 and #11' });

  const snapshot = makeSnapshot({ issues: [depIssueOpen, depIssueDuplicate, candidate] });
  const res = selectCandidateIssue(snapshot, VALID_CONFIG);
  assert.equal(res.selectedCandidate, null);
  assert.equal(res.decisionCode, 'CANDIDATES_BLOCKED');
  assert.equal(res.blockers.some(b => b.code === 'UNRESOLVED_DEPENDENCY'), true);
});

test('selectCandidateIssue allows candidate when dependencies are closed completed', () => {
  const depIssueClosed = makeValidIssue(10, { state: 'closed' });
  depIssueClosed.state_reason = 'completed';

  const candidate = makeValidIssue(20, { dependencies: 'Depends on #10' });

  const snapshot = makeSnapshot({ issues: [depIssueClosed, candidate] });
  const res = selectCandidateIssue(snapshot, VALID_CONFIG);
  assert.equal(res.decisionCode, 'CANDIDATE_SELECTED');
  assert.equal(res.selectedCandidate.number, 20);
});

test('selectCandidateIssue blocks candidate if open or unmerged PR exists', () => {
  const candidate = makeValidIssue(10);
  const openPR = { number: 101, state: 'open', issue_number: 10 };
  const snapshot = makeSnapshot({ issues: [candidate], pullRequests: [openPR] });

  const res = selectCandidateIssue(snapshot, VALID_CONFIG);
  assert.equal(res.selectedCandidate, null);
  assert.equal(res.decisionCode, 'CANDIDATES_BLOCKED');
  assert.equal(res.blockers.some(b => b.code === 'UNRESOLVED_PULL_REQUEST'), true);

  const closedUnmergedPR = { number: 102, state: 'closed', merged: false, issue_number: 10 };
  const snapshotUnmerged = makeSnapshot({ issues: [candidate], pullRequests: [closedUnmergedPR] });

  const resUnmerged = selectCandidateIssue(snapshotUnmerged, VALID_CONFIG);
  assert.equal(resUnmerged.selectedCandidate, null);
  assert.equal(resUnmerged.decisionCode, 'CANDIDATES_BLOCKED');
  assert.equal(resUnmerged.blockers.some(b => b.code === 'UNRESOLVED_PULL_REQUEST'), true);
});

test('selectCandidateIssue blocks candidate if active work session exists', () => {
  const candidate = makeValidIssue(10);
  const activeSession = { name: 'sess-1', state: 'IN_PROGRESS', issue_number: 10 };
  const snapshot = makeSnapshot({ issues: [candidate], sessions: [activeSession] });

  const res = selectCandidateIssue(snapshot, VALID_CONFIG);
  assert.equal(res.selectedCandidate, null);
  assert.equal(res.decisionCode, 'CANDIDATES_BLOCKED');
  assert.equal(res.blockers.some(b => b.code === 'ACTIVE_WORK_EXISTS'), true);
});

test('selectCandidateIssue uses sequenceSource ordering when configured', () => {
  const configWithSeq = { ...VALID_CONFIG, sequenceSource: 'sequence' };
  const issueA = makeValidIssue(10);
  const issueB = makeValidIssue(20);

  const snapshotSeq = makeSnapshot({
    issues: [issueA, issueB],
    sequence: [20, 10]
  });

  const res = selectCandidateIssue(snapshotSeq, configWithSeq);
  assert.equal(res.decisionCode, 'CANDIDATE_SELECTED');
  assert.equal(res.selectedCandidate.number, 20);
});

test('selectCandidateIssue blocks on duplicate or malformed sequence entries', () => {
  const configWithSeq = { ...VALID_CONFIG, sequenceSource: 'sequence' };
  const issueA = makeValidIssue(10);
  const issueB = makeValidIssue(20);

  const snapshotDupSeq = makeSnapshot({
    issues: [issueA, issueB],
    sequence: [10, 10]
  });

  const res = selectCandidateIssue(snapshotDupSeq, configWithSeq);
  assert.equal(res.selectedCandidate, null);
  assert.equal(res.decisionCode, 'INVALID_SEQUENCE');
  assert.equal(res.blockers.some(b => b.code === 'DUPLICATE_SEQUENCE_ENTRY'), true);
});

test('selectCandidateIssue blocks on ambiguous ordering when multiple candidates and no sequenceSource', () => {
  const issueA = makeValidIssue(10);
  const issueB = makeValidIssue(20);

  const snapshot = makeSnapshot({ issues: [issueA, issueB] });

  const res = selectCandidateIssue(snapshot, VALID_CONFIG);
  assert.equal(res.selectedCandidate, null);
  assert.equal(res.decisionCode, 'AMBIGUOUS_ORDERING');
  assert.equal(res.blockers.some(b => b.code === 'MULTIPLE_ELIGIBLE_CANDIDATES'), true);
});

test('permutation invariance: shuffling input arrays yields byte-for-byte equivalent decision output', () => {
  const configWithSeq = { ...VALID_CONFIG, sequenceSource: 'sequence' };
  const issue1 = makeValidIssue(10, { dependencies: 'None' });
  const issue2 = makeValidIssue(20, { dependencies: 'None' });
  const issueDep = makeValidIssue(5, { state: 'closed' });
  issueDep.state_reason = 'completed';

  const pr1 = { number: 100, state: 'closed', merged: true, issue_number: 10 };
  const sess1 = { name: 'sess-1', state: 'COMPLETED', issue_number: 10 };

  const baseSnapshot = makeSnapshot({
    issues: [issue1, issue2, issueDep],
    pullRequests: [pr1],
    sessions: [sess1],
    sequence: [20, 10]
  });

  const resBase = selectCandidateIssue(baseSnapshot, configWithSeq);

  const shuffledSnapshot = makeSnapshot({
    issues: [issueDep, issue2, issue1],
    pullRequests: [pr1],
    sessions: [sess1],
    sequence: [20, 10]
  });

  const resShuffled = selectCandidateIssue(shuffledSnapshot, configWithSeq);

  assert.deepEqual(resShuffled, resBase);
  assert.equal(JSON.stringify(resShuffled), JSON.stringify(resBase));
});
