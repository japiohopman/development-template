import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRepairContinuationGate } from '../src/review-relay.mjs';

const head = 'a'.repeat(40);
const config = {
  enabled: true, runMode: 'live', repairDispatchEnabled: true, repairPilotApproved: true,
  humanReadinessRequired: true, automaticMerge: false, scheduleEnabled: false
};
const pullRequest = { number: 17, state: 'open', merged: false, draft: false, head: { sha: head } };
const existingWork = {
  verified: true, repositoryFullName: 'example/project', issueNumber: 12,
  pullRequestNumber: 17, claimId: 'claim-12-test', sessionId: 'session-1'
};
const session = {
  id: 'session-1', title: 'Task [claimId: claim-12-test]', state: 'IN_PROGRESS', normalizedState: 'ACTIVE',
  sourceContext: { source: 'sources/github/example/project', githubRepoContext: { startingBranch: 'main' } }
};
function evaluate(overrides = {}) {
  return evaluateRepairContinuationGate({
    config, repositoryFullName: 'example/project', pullRequest, governingIssueNumber: 12,
    existingWork, session, ...overrides
  });
}

test('repair continuation is allowed only for the exact active existing session and explicit pilot gates', () => {
  const result = evaluate();
  assert.equal(result.allowed, true);
  assert.equal(result.decisionCode, 'REPAIR_CONTINUATION_READY');
  assert.equal(result.sessionId, 'session-1');
  assert.equal(result.headSha, head);
});

for (const [field, value] of [
  ['enabled', false], ['runMode', 'dry-run'], ['repairDispatchEnabled', false],
  ['repairPilotApproved', false], ['humanReadinessRequired', false],
  ['automaticMerge', true], ['scheduleEnabled', true]
]) {
  test('repair continuation blocks when safety gate ' + field + ' is not explicitly safe', () => {
    const result = evaluate({ config: { ...config, [field]: value } });
    assert.equal(result.allowed, false);
    assert.equal(result.decisionCode, 'BLOCK_REPAIR_CONTINUATION_CONFIG');
    assert.ok(result.failedGates.includes(field === 'automaticMerge' ? 'automatic_merge_disabled'
      : field === 'scheduleEnabled' ? 'schedule_disabled'
      : field === 'humanReadinessRequired' ? 'human_readiness_required'
      : field === 'repairPilotApproved' ? 'repair_pilot_approved'
      : field === 'repairDispatchEnabled' ? 'repair_dispatch_enabled'
      : field === 'runMode' ? 'live_mode' : 'enabled'));
  });
}

test('repair continuation blocks unknown, waiting, paused, failed, and terminal sessions', () => {
  for (const normalizedState of ['UNKNOWN', 'QUEUED', 'AWAITING_INPUT', 'PAUSED', 'FAILED', 'COMPLETED']) {
    const result = evaluate({ session: { ...session, normalizedState } });
    assert.equal(result.allowed, false, normalizedState);
    assert.equal(result.decisionCode, 'BLOCK_REPAIR_CONTINUATION_SESSION');
  }
});

test('repair continuation blocks mismatched session ID, repository source, or claim marker', () => {
  assert.equal(evaluate({ session: { ...session, id: 'another-session' } }).allowed, false);
  assert.equal(evaluate({ session: { ...session, sourceContext: { source: 'sources/github/other/repo' } } }).allowed, false);
  assert.equal(evaluate({ session: { ...session, title: 'Task without correlation' } }).allowed, false);
});

test('repair continuation blocks a PR or governing Issue mismatch', () => {
  assert.equal(evaluate({ existingWork: { ...existingWork, pullRequestNumber: 18 } }).allowed, false);
  assert.equal(evaluate({ existingWork: { ...existingWork, repositoryFullName: undefined } }).allowed, false);
  assert.equal(evaluate({ session: { ...session, state: 'COMPLETED', normalizedState: 'ACTIVE' } }).allowed, false);
  assert.equal(evaluate({ existingWork: { ...existingWork, issueNumber: 13 } }).allowed, false);
  assert.equal(evaluate({ governingIssueNumber: 13 }).allowed, false);
  assert.equal(evaluate({ pullRequest: { ...pullRequest, head: { sha: 'bad' } } }).allowed, false);
  assert.equal(evaluate({ pullRequest: { ...pullRequest, state: 'closed' } }).allowed, false);
});
