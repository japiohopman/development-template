import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ACTIVE_SESSION_STATES,
  sessionDisposition,
  isOpenPullRequest,
  isMergedPullRequest,
  extractPullRequestNumber,
  reconcileSessions,
  evaluatePreflight,
} from '../src/preflight.mjs';

test('paused and waiting sessions are blockers', () => {
  for (const state of ['PAUSED', 'AWAITING_USER_FEEDBACK', 'AWAITING_PLAN_APPROVAL']) {
    assert.equal(sessionDisposition({ state }).disposition, 'blocking');
    assert.ok(DEFAULT_ACTIVE_SESSION_STATES.has(state));
  }
});

test('unknown provider state fails closed', () => {
  const result = sessionDisposition({ state: 'NEW_PROVIDER_STATE' });
  assert.equal(result.disposition, 'blocking');
  assert.match(result.reason, /Unrecognized/);
});

test('empty provider state fails closed', () => {
  assert.equal(sessionDisposition({}).state, 'UNKNOWN');
  assert.equal(sessionDisposition({}).disposition, 'blocking');
});

test('recognizes pull request states and extracts its number', () => {
  assert.equal(isOpenPullRequest({ state: 'open', merged: false }), true);
  assert.equal(isMergedPullRequest({ merged: true }), true);
  assert.equal(extractPullRequestNumber('https://github.com/example/project/pull/42'), 42);
  assert.equal(extractPullRequestNumber('not a URL'), null);
});

test('a verified merged PR clears a stale historical session', async () => {
  const blockers = await reconcileSessions([{
    name: 'sessions/1',
    state: 'IN_PROGRESS',
    sourceContext: { source: 'source-a' },
    outputs: [{ pullRequest: { url: 'https://github.com/example/project/pull/12' } }],
  }], {
    sourceName: 'source-a',
    fetchPullRequest: async number => {
      assert.equal(number, 12);
      return { state: 'closed', merged: true };
    },
  });
  assert.deepEqual(blockers, []);
});

test('missing source metadata blocks instead of assuming another repository', async () => {
  const blockers = await reconcileSessions([{ name: 'sessions/2', state: 'COMPLETED' }], {
    sourceName: 'source-a',
    fetchPullRequest: async () => null,
  });
  assert.equal(blockers.length, 1);
  assert.match(blockers[0].reason, /source is missing/);
});

test('closed but unmerged PR remains unresolved', async () => {
  const blockers = await reconcileSessions([{
    name: 'sessions/3',
    state: 'COMPLETED',
    sourceContext: { source: 'source-a' },
    outputs: [{ pullRequest: { url: 'https://github.com/example/project/pull/13' } }],
  }], {
    sourceName: 'source-a',
    fetchPullRequest: async () => ({ state: 'closed', merged: false }),
  });
  assert.equal(blockers.length, 1);
});

test('provider API lookup errors propagate and block the caller', async () => {
  await assert.rejects(() => reconcileSessions([{
    name: 'sessions/4',
    state: 'IN_PROGRESS',
    sourceContext: { source: 'source-a' },
    outputs: [{ pullRequest: { url: 'https://github.com/example/project/pull/14' } }],
  }], {
    sourceName: 'source-a',
    fetchPullRequest: async () => { throw new Error('GitHub API unavailable'); },
  }), /GitHub API unavailable/);
});

test('incomplete snapshot blocks live work despite confirmation', () => {
  const result = evaluatePreflight({
    snapshotComplete: false,
    issue: { number: 10, state: 'open' },
    confirmation: 'DISPATCH',
  });
  assert.equal(result.action, 'BLOCK_INCOMPLETE_SNAPSHOT');
  assert.equal(result.dispatchAuthorized, false);
});

test('open PR prevents duplicate dispatch', () => {
  const result = evaluatePreflight({
    snapshotComplete: true,
    issue: { number: 10, state: 'open' },
    openManagedPullRequests: [{ state: 'open', merged: false, issue_number: 10 }],
    confirmation: 'DISPATCH',
  });
  assert.equal(result.action, 'WAIT_ISSUE_PR');
  assert.equal(result.dispatchAuthorized, false);
});

test('stale claim cannot be reclaimed until reconciliation is recorded', () => {
  const result = evaluatePreflight({
    snapshotComplete: true,
    issue: { number: 10, state: 'open' },
    claim: { expiresAt: '2020-01-01T00:00:00Z', reconciled: false },
    now: new Date('2026-01-01T00:00:00Z'),
    confirmation: 'DISPATCH',
  });
  assert.equal(result.action, 'WAIT_EXPIRED_CLAIM_RECONCILIATION');
});

test('safe preflight without confirmation remains plan-only', () => {
  const result = evaluatePreflight({
    snapshotComplete: true,
    issue: { number: 10, state: 'open' },
  });
  assert.equal(result.action, 'PLAN_ONLY');
  assert.equal(result.safeToDispatch, true);
  assert.equal(result.dispatchAuthorized, false);
});

test('exact confirmation is required to authorize dispatch', () => {
  const inputs = {
    snapshotComplete: true,
    issue: { number: 10, state: 'open' },
  };
  assert.equal(evaluatePreflight({ ...inputs, confirmation: 'dispatch' }).dispatchAuthorized, false);
  assert.equal(evaluatePreflight({ ...inputs, confirmation: 'DISPATCH' }).dispatchAuthorized, true);
});
