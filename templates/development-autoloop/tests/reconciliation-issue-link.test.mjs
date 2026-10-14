import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileSessionLifecycle } from '../src/reconciliation.mjs';

function buildOptions(pullRequest) {
  const sourceName = 'sources/github/owner/repo';
  const claim = {
    schemaVersion: 1,
    claimId: 'claim-issue-link',
    repository: { owner: 'owner', repo: 'repo' },
    issueNumber: 42,
    owner: 'autoloop',
    provider: 'jules',
    sessionId: 'session-1',
    createdAt: '2026-10-13T00:00:00Z',
    expiresAt: '2026-10-13T01:00:00Z',
    status: 'ACTIVE',
    reconciliationStatus: 'PENDING',
    updatedAt: '2026-10-13T00:00:00Z'
  };
  return {
    repository: 'owner/repo',
    providerClient: {
      findSourceForRepository: async () => ({ name: sourceName, githubRepo: { owner: 'owner', repo: 'repo' } }),
      listSessions: async () => [{
        id: 'session-1',
        name: 'sessions/session-1',
        title: 'Task [claimId: claim-issue-link]',
        prompt: 'Task [claimId: claim-issue-link]',
        state: 'IN_PROGRESS',
        sourceContext: { source: sourceName, githubRepoContext: { startingBranch: 'main' } },
        issueNumber: 42,
        outputs: [{ pullRequest: { url: 'https://github.com/owner/repo/pull/43' } }]
      }]
    },
    stateAdapter: { readState: async () => ({ head: 'a'.repeat(40), claims: [claim] }) },
    fetchIssue: async number => ({ number, state: 'open', title: 'Unrelated governing Issue record' }),
    fetchBranch: async name => ({ name }),
    fetchPullRequest: async number => ({ number, state: 'open', merged: false, ...pullRequest })
  };
}

test('explicit closing keyword and issue reference satisfies PR-to-Issue evidence', async () => {
  const result = await reconcileSessionLifecycle(buildOptions({ title: 'Routine change', body: 'Closes #42' }));
  assert.ok(result.blockers.some(blocker => blocker.code === 'BLOCK_OPEN_PR'));
  assert.equal(result.blockers.some(blocker => blocker.code === 'BLOCK_PR_ISSUE_LINK_MISSING'), false);
});

test('a bare matching issue number in unrelated prose does not satisfy PR-to-Issue evidence', async () => {
  const result = await reconcileSessionLifecycle(buildOptions({
    title: 'Routine cleanup',
    body: 'The report contains the number #42 as an unrelated example.'
  }));
  assert.ok(result.blockers.some(blocker => blocker.code === 'BLOCK_PR_ISSUE_LINK_MISSING'));
});
