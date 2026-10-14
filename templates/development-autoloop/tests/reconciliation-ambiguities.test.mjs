import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileSessionLifecycle } from '../src/reconciliation.mjs';

const sourceName = 'sources/github/owner/repo';
const claim = {
  schemaVersion: 1, claimId: 'claim-1', repository: { owner: 'owner', repo: 'repo' },
  issueNumber: 7, owner: 'autoloop', provider: 'jules', sessionId: 's-1',
  createdAt: '2026-10-13T00:00:00Z', expiresAt: '2026-10-13T01:00:00Z',
  status: 'ACTIVE', reconciliationStatus: 'PENDING', updatedAt: '2026-10-13T00:00:00Z'
};
const session = overrides => ({
  id: 's-1', name: 'sessions/s-1', title: 'Task [claimId: claim-1]', prompt: 'Task [claimId: claim-1]',
  state: 'IN_PROGRESS', sourceContext: { source: sourceName, githubRepoContext: { startingBranch: 'main' } },
  outputs: [{ pullRequest: { url: 'https://github.com/owner/repo/pull/8' } }],
  ...overrides
});
const base = overrides => ({
  repository: 'owner/repo',
  providerClient: {
    findSourceForRepository: async () => ({ name: sourceName, githubRepo: { owner: 'owner', repo: 'repo' } }),
    listSessions: async () => [session()]
  },
  stateAdapter: { readState: async () => ({ head: 'a'.repeat(40), claims: [claim] }) },
  fetchBranch: async name => ({ name }),
  fetchIssue: async number => ({ number, state: 'open', title: 'Issue #7' }),
  fetchPullRequest: async number => ({ number, state: 'open', merged: false, title: 'Change #7', body: 'Closes #7' }),
  ...overrides
});

test('malformed source objects block instead of being mistaken for foreign sessions', async () => {
  const result = await reconcileSessionLifecycle(base({
    providerClient: {
      findSourceForRepository: async () => ({ name: sourceName, githubRepo: { owner: 'owner', repo: 'repo' } }),
      listSessions: async () => [session({ sourceContext: { source: { name: sourceName }, githubRepoContext: { startingBranch: 'main' } } })]
    },
    stateAdapter: { readState: async () => ({ head: 'a'.repeat(40), claims: [] }) }
  }));
  assert.equal(result.success, false);
  assert.ok(result.blockers.some(item => item.code === 'BLOCK_MISSING_SESSION_SOURCE'));
});

test('multiple linked PRs block instead of selecting the first', async () => {
  const result = await reconcileSessionLifecycle(base({
    providerClient: {
      findSourceForRepository: async () => ({ name: sourceName, githubRepo: { owner: 'owner', repo: 'repo' } }),
      listSessions: async () => [session({ outputs: [
        { pullRequest: { url: 'https://github.com/owner/repo/pull/8' } },
        { pullRequest: { url: 'https://github.com/owner/repo/pull/9' } }
      ] })]
    }
  }));
  assert.equal(result.success, false);
  assert.ok(result.blockers.some(item => item.code === 'BLOCK_MULTIPLE_LINKED_PRS'));
});

test('malformed PR output blocks instead of being ignored', async () => {
  const result = await reconcileSessionLifecycle(base({
    providerClient: {
      findSourceForRepository: async () => ({ name: sourceName, githubRepo: { owner: 'owner', repo: 'repo' } }),
      listSessions: async () => [session({ outputs: [{ pullRequest: {} }] })]
    }
  }));
  assert.equal(result.success, false);
  assert.ok(result.blockers.some(item => item.code === 'BLOCK_MALFORMED_PR_OUTPUT'));
});

test('a non-commit state snapshot head is invalid', async () => {
  const result = await reconcileSessionLifecycle(base({
    providerClient: {
      findSourceForRepository: async () => ({ name: sourceName, githubRepo: { owner: 'owner', repo: 'repo' } }),
      listSessions: async () => []
    },
    stateAdapter: { readState: async () => ({ head: 'not-a-commit-sha', claims: [] }) }
  }));
  assert.equal(result.success, false);
  assert.equal(result.blockers[0].code, 'BLOCK_CLAIM_STATE_INVALID');
});
