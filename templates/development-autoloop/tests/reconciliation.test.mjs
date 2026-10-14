import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileSessionLifecycle, extractSessionClaimId } from '../src/reconciliation.mjs';
import { InMemoryStateAdapter } from '../src/claims.mjs';

test('extractSessionClaimId extracts claimId from prompt or title', () => {
  assert.equal(extractSessionClaimId({ prompt: 'Task description [claimId: claim-123-abc]' }), 'claim-123-abc');
  assert.equal(extractSessionClaimId({ title: 'Session title [claimId: claim-456-def]' }), 'claim-456-def');
  assert.equal(extractSessionClaimId({ prompt: 'No claim ID' }), null);
});

test('reconcileSessionLifecycle returns error on invalid repository or config', async () => {
  const invalidRepo = await reconcileSessionLifecycle({
    repository: 'invalid-repo',
    providerClient: { listSessions: async () => [] }
  });
  assert.equal(invalidRepo.success, false);
  assert.equal(invalidRepo.decisionCode, 'RECONCILIATION_INVALID_REPOSITORY');

  const invalidConfig = await reconcileSessionLifecycle({
    config: { enabled: 'not-a-boolean' },
    repository: 'owner/repo',
    providerClient: { listSessions: async () => [] }
  });
  assert.equal(invalidConfig.success, false);
  assert.equal(invalidConfig.decisionCode, 'RECONCILIATION_INVALID_CONFIG');
});

test('reconcileSessionLifecycle fails closed on provider pagination fault or listSessions rejection', async () => {
  const providerError = await reconcileSessionLifecycle({
    repository: 'owner/repo',
    providerClient: {
      listSessions: async () => { throw new Error('Provider HTTP 500 Server Error X-Goog-Api-Key: secret123'); }
    }
  });

  assert.equal(providerError.success, false);
  assert.equal(providerError.decisionCode, 'RECONCILIATION_PAGINATION_FAILED');
  assert.equal(providerError.mutated, false);
  assert.equal(providerError.blockers.length, 1);
  assert.match(providerError.blockers[0].reason, /Provider API failure/);
  assert.doesNotMatch(JSON.stringify(providerError), /secret123/);
});

test('reconcileSessionLifecycle catches API errors from fetchPullRequest, fetchIssue, and fetchBranch and fails closed safely', async () => {
  const prApiError = await reconcileSessionLifecycle({
    repository: 'owner/repo',
    providerClient: {
      findSourceForRepository: async () => ({ name: 'sources/github/owner/repo' }),
      listSessions: async () => [{
        name: 'sessions/s-err',
        state: 'IN_PROGRESS',
        sourceContext: { source: 'sources/github/owner/repo' },
        outputs: [{ pullRequest: { url: 'https://github.com/owner/repo/pull/99' } }]
      }]
    },
    fetchPullRequest: async () => { throw new Error('GitHub API 502 Bad Gateway'); }
  });

  assert.equal(prApiError.success, false);
  assert.equal(prApiError.decisionCode, 'RECONCILIATION_API_FAILED');
  assert.equal(prApiError.blockers[0].code, 'BLOCK_API_ERROR');

  const issueApiError = await reconcileSessionLifecycle({
    repository: 'owner/repo',
    providerClient: { listSessions: async () => [] },
    stateAdapter: new InMemoryStateAdapter({
      claims: [{
        schemaVersion: 1,
        claimId: 'claim-issue-err',
        repository: { owner: 'owner', repo: 'repo' },
        issueNumber: 15,
        owner: 'autoloop',
        provider: 'jules',
        sessionId: null,
        createdAt: '2026-01-01T00:00:00Z',
        expiresAt: '2026-01-01T01:00:00Z',
        status: 'ACTIVE',
        reconciliationStatus: 'PENDING',
        updatedAt: '2026-01-01T00:00:00Z'
      }]
    }),
    fetchIssue: async () => { throw new Error('GitHub API rate limit exceeded'); }
  });

  assert.equal(issueApiError.success, false);
  assert.equal(issueApiError.decisionCode, 'RECONCILIATION_API_FAILED');
  assert.equal(issueApiError.blockers[0].code, 'BLOCK_API_ERROR');
});

test('reconcileSessionLifecycle verifies starting branches using fetchBranch', async () => {
  const branchResult = await reconcileSessionLifecycle({
    repository: 'owner/repo',
    providerClient: {
      findSourceForRepository: async () => ({ name: 'sources/github/owner/repo' }),
      listSessions: async () => [{
        name: 'sessions/s-branch-1',
        state: 'IN_PROGRESS',
        startingBranch: 'feat/nonexistent-branch',
        sourceContext: { source: 'sources/github/owner/repo' }
      }]
    },
    fetchBranch: async (name) => {
      if (name === 'feat/nonexistent-branch') return null;
      return { name };
    }
  });

  assert.equal(branchResult.success, false);
  assert.equal(branchResult.decisionCode, 'RECONCILIATION_BLOCKED');
  assert.equal(branchResult.blockers[0].code, 'BLOCK_BRANCH_NOT_FOUND');
});

test('reconcileSessionLifecycle cross-validates active session claimId against stateAdapter claims', async () => {
  const missingClaimResult = await reconcileSessionLifecycle({
    repository: 'owner/repo',
    providerClient: {
      findSourceForRepository: async () => ({ name: 'sources/github/owner/repo' }),
      listSessions: async () => [{
        name: 'sessions/s-claim-missing',
        state: 'IN_PROGRESS',
        prompt: 'Work item [claimId: claim-unknown-999]',
        sourceContext: { source: 'sources/github/owner/repo' }
      }]
    },
    stateAdapter: new InMemoryStateAdapter({ claims: [] })
  });

  assert.equal(missingClaimResult.success, false);
  assert.equal(missingClaimResult.blockers.some(b => b.code === 'BLOCK_SESSION_CLAIM_NOT_FOUND'), true);
});

test('reconcileSessionLifecycle returns clear when no active sessions or claims exist', async () => {
  const result = await reconcileSessionLifecycle({
    repository: 'owner/repo',
    providerClient: { listSessions: async () => [] }
  });

  assert.equal(result.success, true);
  assert.equal(result.decisionCode, 'RECONCILIATION_CLEAR');
  assert.equal(result.mutated, false);
  assert.equal(result.blockers.length, 0);
});

test('reconcileSessionLifecycle clears historical session on verified merged PR with matching repository source', async () => {
  const result = await reconcileSessionLifecycle({
    repository: 'owner/repo',
    providerClient: {
      findSourceForRepository: async () => ({ name: 'sources/github/owner/repo' }),
      listSessions: async () => [{
        name: 'sessions/s-1',
        state: 'IN_PROGRESS',
        sourceContext: { source: 'sources/github/owner/repo' },
        outputs: [{ pullRequest: { url: 'https://github.com/owner/repo/pull/10' } }]
      }]
    },
    fetchPullRequest: async (num) => {
      assert.equal(num, 10);
      return { number: 10, state: 'closed', merged: true };
    }
  });

  assert.equal(result.success, true);
  assert.equal(result.decisionCode, 'RECONCILIATION_CLEAR');
  assert.equal(result.blockers.length, 0);
});

test('reconcileSessionLifecycle blocks merged PR when session source metadata is missing', async () => {
  const result = await reconcileSessionLifecycle({
    repository: 'owner/repo',
    providerClient: {
      findSourceForRepository: async () => ({ name: 'sources/github/owner/repo' }),
      listSessions: async () => [{
        name: 'sessions/s-2',
        state: 'IN_PROGRESS',
        outputs: [{ pullRequest: { url: 'https://github.com/owner/repo/pull/11' } }]
      }]
    },
    fetchPullRequest: async () => ({ number: 11, state: 'closed', merged: true })
  });

  assert.equal(result.success, false);
  assert.equal(result.decisionCode, 'RECONCILIATION_BLOCKED');
  assert.equal(result.blockers.length, 1);
  assert.equal(result.blockers[0].code, 'BLOCK_MERGED_PR_MISSING_SOURCE');
});

test('reconcileSessionLifecycle blocks open PRs and closed-unmerged PRs', async () => {
  const openPrResult = await reconcileSessionLifecycle({
    repository: 'owner/repo',
    providerClient: {
      findSourceForRepository: async () => ({ name: 'sources/github/owner/repo' }),
      listSessions: async () => [{
        name: 'sessions/s-3',
        state: 'IN_PROGRESS',
        sourceContext: { source: 'sources/github/owner/repo' },
        outputs: [{ pullRequest: { url: 'https://github.com/owner/repo/pull/12' } }]
      }]
    },
    fetchPullRequest: async () => ({ number: 12, state: 'open', merged: false })
  });

  assert.equal(openPrResult.success, false);
  assert.equal(openPrResult.blockers[0].code, 'BLOCK_OPEN_PR');

  const closedUnmergedResult = await reconcileSessionLifecycle({
    repository: 'owner/repo',
    providerClient: {
      findSourceForRepository: async () => ({ name: 'sources/github/owner/repo' }),
      listSessions: async () => [{
        name: 'sessions/s-4',
        state: 'COMPLETED',
        sourceContext: { source: 'sources/github/owner/repo' },
        outputs: [{ pullRequest: { url: 'https://github.com/owner/repo/pull/13' } }]
      }]
    },
    fetchPullRequest: async () => ({ number: 13, state: 'closed', merged: false })
  });

  assert.equal(closedUnmergedResult.success, false);
  assert.equal(closedUnmergedResult.blockers[0].code, 'BLOCK_CLOSED_UNMERGED_PR');
});

test('reconcileSessionLifecycle detects multiple active sessions for the same claimId or Issue', async () => {
  const result = await reconcileSessionLifecycle({
    repository: 'owner/repo',
    providerClient: {
      findSourceForRepository: async () => ({ name: 'sources/github/owner/repo' }),
      listSessions: async () => [
        {
          name: 'sessions/s-10',
          state: 'IN_PROGRESS',
          prompt: 'Task 1 [claimId: claim-dup-1]',
          issueNumber: 42,
          sourceContext: { source: 'sources/github/owner/repo' }
        },
        {
          name: 'sessions/s-11',
          state: 'PAUSED',
          prompt: 'Task 2 [claimId: claim-dup-1]',
          issueNumber: 42,
          sourceContext: { source: 'sources/github/owner/repo' }
        }
      ]
    }
  });

  assert.equal(result.success, false);
  assert.equal(result.decisionCode, 'RECONCILIATION_BLOCKED');
  const codes = result.blockers.map(b => b.code);
  assert.ok(codes.includes('BLOCK_MULTIPLE_ACTIVE_SESSIONS'));
});

test('reconcileSessionLifecycle leaves state adapter completely untouched (pure read-only)', async () => {
  const stateAdapter = new InMemoryStateAdapter({
    claims: [{
      schemaVersion: 1,
      claimId: 'claim-read-only-1',
      repository: { owner: 'owner', repo: 'repo' },
      issueNumber: 5,
      owner: 'autoloop',
      provider: 'jules',
      sessionId: 'sess-1',
      createdAt: '2026-01-01T00:00:00Z',
      expiresAt: '2026-01-01T01:00:00Z',
      status: 'ACTIVE',
      reconciliationStatus: 'PENDING',
      updatedAt: '2026-01-01T00:00:00Z'
    }]
  });

  const commitCountBefore = stateAdapter.commitCount;

  const result = await reconcileSessionLifecycle({
    repository: 'owner/repo',
    providerClient: {
      findSourceForRepository: async () => ({ name: 'sources/github/owner/repo' }),
      listSessions: async () => []
    },
    stateAdapter
  });

  assert.equal(result.mutated, false);
  assert.equal(stateAdapter.commitCount, commitCountBefore);
});
