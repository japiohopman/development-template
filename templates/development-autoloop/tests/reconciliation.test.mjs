import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileSessionLifecycle, extractSessionClaimId } from '../src/reconciliation.mjs';

const repo = 'owner/repo';
const sourceName = 'sources/github/owner/repo';
const now = '2026-10-14T00:00:00.000Z';

function makeClaim(overrides = {}) {
  return {
    schemaVersion: 1,
    claimId: 'claim-42-test',
    repository: { owner: 'owner', repo: 'repo' },
    issueNumber: 42,
    owner: 'autoloop',
    provider: 'jules',
    sessionId: 'session-1',
    createdAt: '2026-10-13T00:00:00Z',
    expiresAt: '2026-10-13T01:00:00Z',
    status: 'ACTIVE',
    reconciliationStatus: 'PENDING',
    updatedAt: '2026-10-13T00:00:00Z',
    ...overrides
  };
}

function makeSession(overrides = {}) {
  return {
    id: 'session-1',
    name: 'sessions/session-1',
    title: 'Implement issue #42 [claimId: claim-42-test]',
    prompt: 'Work on Issue #42 [claimId: claim-42-test]',
    state: 'IN_PROGRESS',
    sourceContext: {
      source: sourceName,
      githubRepoContext: { startingBranch: 'feat/issue-42' }
    },
    issueNumber: 42,
    outputs: [{ pullRequest: { url: 'https://github.com/owner/repo/pull/43' } }],
    ...overrides
  };
}

function makePullRequest(overrides = {}) {
  return {
    number: 43,
    title: 'Implement task (#42)',
    body: 'Closes #42',
    state: 'open',
    merged: false,
    head: { ref: 'feat/issue-42' },
    ...overrides
  };
}

function options(overrides = {}) {
  const claims = [makeClaim()];
  return {
    repository: repo,
    now,
    providerClient: {
      findSourceForRepository: async () => ({
        name: sourceName,
        githubRepo: { owner: 'owner', repo: 'repo' }
      }),
      listSessions: async () => [makeSession()]
    },
    stateAdapter: {
      readState: async () => ({ head: 'a'.repeat(40), claims })
    },
    fetchIssue: async number => ({ number, state: 'open', state_reason: null, title: 'Issue #42' }),
    fetchBranch: async name => ({ name, commit: { sha: 'b'.repeat(40) } }),
    fetchPullRequest: async number => makePullRequest({ number }),
    ...overrides
  };
}

test('extractSessionClaimId requires exactly one well-formed marker', () => {
  assert.equal(extractSessionClaimId(makeSession()), 'claim-42-test');
  assert.equal(extractSessionClaimId({ title: '[claimId: one] [claimId: two]' }), null);
  assert.equal(extractSessionClaimId({ title: 'no marker' }), null);
});

test('missing stateAdapter blocks an otherwise empty queue', async () => {
  const result = await reconcileSessionLifecycle({
    repository: repo,
    providerClient: {
      findSourceForRepository: async () => ({ name: sourceName, githubRepo: { owner: 'owner', repo: 'repo' } }),
      listSessions: async () => []
    },
    fetchIssue: async () => null,
    fetchBranch: async () => null,
    fetchPullRequest: async () => null
  });
  assert.equal(result.success, false);
  assert.equal(result.blockers[0].code, 'BLOCK_REQUIRED_EVIDENCE_ADAPTER_MISSING');
});

test('a missing or malformed claim snapshot never becomes an empty claim list', async () => {
  for (const snapshot of [null, {}, { head: null, claims: [] }, { head: 'abc', claims: null }]) {
    const result = await reconcileSessionLifecycle(options({
      providerClient: {
        findSourceForRepository: async () => ({ name: sourceName, githubRepo: { owner: 'owner', repo: 'repo' } }),
        listSessions: async () => []
      },
      stateAdapter: { readState: async () => snapshot }
    }));
    assert.equal(result.success, false);
    assert.equal(result.decisionCode, 'RECONCILIATION_STATE_INVALID');
    assert.equal(result.blockers[0].code, 'BLOCK_CLAIM_STATE_INVALID');
  }
});

test('a failed source lookup blocks instead of guessing a resource name', async () => {
  const result = await reconcileSessionLifecycle(options({
    providerClient: {
      findSourceForRepository: async () => { throw Object.assign(new Error('private details'), { code: 'JULES_HTTP_ERROR' }); },
      listSessions: async () => []
    }
  }));
  assert.equal(result.success, false);
  assert.equal(result.blockers[0].code, 'BLOCK_SOURCE_LOOKUP_FAILED');
});

test('a source with unverified repository identity blocks', async () => {
  const result = await reconcileSessionLifecycle(options({
    providerClient: {
      findSourceForRepository: async () => ({ name: sourceName, githubRepo: { owner: 'another', repo: 'repo' } }),
      listSessions: async () => []
    }
  }));
  assert.equal(result.success, false);
  assert.equal(result.blockers[0].code, 'BLOCK_SOURCE_IDENTITY_UNVERIFIED');
});

test('missing Issue, branch, or PR adapters blocks the run before it can report clear', async () => {
  for (const adapter of ['fetchIssue', 'fetchBranch', 'fetchPullRequest']) {
    const setup = options();
    delete setup[adapter];
    const result = await reconcileSessionLifecycle(setup);
    assert.equal(result.success, false);
    assert.equal(result.blockers[0].code, 'BLOCK_REQUIRED_EVIDENCE_ADAPTER_MISSING');
  }
});

test('provider inventory and state API failures block safely', async () => {
  const providerResult = await reconcileSessionLifecycle(options({
    providerClient: {
      findSourceForRepository: async () => ({ name: sourceName, githubRepo: { owner: 'owner', repo: 'repo' } }),
      listSessions: async () => { throw Object.assign(new Error('hidden'), { code: 'JULES_HTTP_ERROR' }); }
    }
  }));
  assert.equal(providerResult.success, false);
  assert.equal(providerResult.blockers[0].code, 'BLOCK_PROVIDER_INVENTORY_FAILED');

  const stateResult = await reconcileSessionLifecycle(options({
    stateAdapter: { readState: async () => { throw Object.assign(new Error('hidden'), { status: 403 }); } }
  }));
  assert.equal(stateResult.success, false);
  assert.equal(stateResult.blockers[0].code, 'BLOCK_CLAIM_STATE_READ_FAILED');
});

test('missing branch metadata blocks even when all adapters are provided', async () => {
  const result = await reconcileSessionLifecycle(options({
    providerClient: {
      findSourceForRepository: async () => ({ name: sourceName, githubRepo: { owner: 'owner', repo: 'repo' } }),
      listSessions: async () => [makeSession({ sourceContext: { source: sourceName, githubRepoContext: {} } })]
    }
  }));
  assert.equal(result.success, false);
  assert.equal(result.blockers.some(blocker => blocker.code === 'BLOCK_MISSING_STARTING_BRANCH'), true);
});

test('a session without a claim marker blocks', async () => {
  const result = await reconcileSessionLifecycle(options({
    providerClient: {
      findSourceForRepository: async () => ({ name: sourceName, githubRepo: { owner: 'owner', repo: 'repo' } }),
      listSessions: async () => [makeSession({ title: 'No marker', prompt: 'No marker' })]
    }
  }));
  assert.equal(result.success, false);
  assert.equal(result.blockers.some(blocker => blocker.code === 'BLOCK_MISSING_CLAIM_ID'), true);
});

test('claim repository, provider, and session ID mismatches block', async () => {
  const variants = [
    makeClaim({ repository: { owner: 'other', repo: 'repo' } }),
    makeClaim({ provider: 'other-provider' }),
    makeClaim({ sessionId: 'different-session' })
  ];
  for (const claim of variants) {
    const result = await reconcileSessionLifecycle(options({
      stateAdapter: { readState: async () => ({ head: 'a'.repeat(40), claims: [claim] }) }
    }));
    assert.equal(result.success, false);
    assert.ok(result.blockers.length > 0);
  }
});

test('a session linked to a missing claim blocks', async () => {
  const result = await reconcileSessionLifecycle(options({
    stateAdapter: { readState: async () => ({ head: 'a'.repeat(40), claims: [] }) }
  }));
  assert.equal(result.success, false);
  assert.equal(result.blockers.some(blocker => blocker.code === 'BLOCK_SESSION_CLAIM_NOT_FOUND'), true);
});

test('Issue, branch, and PR lookup errors return structured blockers without raw error text', async () => {
  for (const adapter of ['fetchIssue', 'fetchBranch', 'fetchPullRequest']) {
    const setup = options();
    setup[adapter] = async () => { throw Object.assign(new Error('hidden'), { status: 503 }); };
    const result = await reconcileSessionLifecycle(setup);
    assert.equal(result.success, false);
    assert.ok(result.blockers.length > 0);
    assert.doesNotMatch(JSON.stringify(result), /hidden/);
  }
});

test('open PR and unresolved active session block without changing the ledger', async () => {
  const result = await reconcileSessionLifecycle(options());
  assert.equal(result.success, false);
  assert.equal(result.blockers.some(blocker => blocker.code === 'BLOCK_OPEN_PR'), true);
  assert.equal(result.mutated, false);
});

test('closed but unmerged PR remains blocked', async () => {
  const result = await reconcileSessionLifecycle(options({
    fetchPullRequest: async number => makePullRequest({ number, state: 'closed', merged: false })
  }));
  assert.equal(result.success, false);
  assert.equal(result.blockers.some(blocker => blocker.code === 'BLOCK_CLOSED_UNMERGED_PR'), true);
});

test('merged PR requires completed Issue and reconciled/released claim', async () => {
  const result = await reconcileSessionLifecycle(options({
    providerClient: {
      findSourceForRepository: async () => ({ name: sourceName, githubRepo: { owner: 'owner', repo: 'repo' } }),
      listSessions: async () => [makeSession({ state: 'COMPLETED' })]
    },
    fetchPullRequest: async number => makePullRequest({ number, state: 'closed', merged: true, merged_at: now }),
    fetchIssue: async number => ({ number, state: 'closed', state_reason: 'completed', title: 'Issue #42' })
  }));
  assert.equal(result.success, false);
  assert.equal(result.blockers.some(blocker => blocker.code === 'BLOCK_CLAIM_REQUIRES_RECONCILIATION'), true);
});

test('authoritative empty inventory is clear only with an initialized valid claim ledger', async () => {
  const result = await reconcileSessionLifecycle(options({
    providerClient: {
      findSourceForRepository: async () => ({ name: sourceName, githubRepo: { owner: 'owner', repo: 'repo' } }),
      listSessions: async () => []
    },
    stateAdapter: { readState: async () => ({ head: 'a'.repeat(40), claims: [] }) }
  }));
  assert.equal(result.success, true);
  assert.equal(result.decisionCode, 'RECONCILIATION_CLEAR');
  assert.equal(result.mutated, false);
});

test('unreconciled orphan claim blocks when no provider session matches', async () => {
  const result = await reconcileSessionLifecycle(options({
    providerClient: {
      findSourceForRepository: async () => ({ name: sourceName, githubRepo: { owner: 'owner', repo: 'repo' } }),
      listSessions: async () => []
    }
  }));
  assert.equal(result.success, false);
  assert.equal(result.blockers.some(blocker => blocker.code === 'BLOCK_CLAIM_SESSION_NOT_FOUND'), true);
});

test('foreign repository sessions are ignored only when source identity is explicit', async () => {
  const result = await reconcileSessionLifecycle(options({
    providerClient: {
      findSourceForRepository: async () => ({ name: sourceName, githubRepo: { owner: 'owner', repo: 'repo' } }),
      listSessions: async () => [makeSession({ sourceContext: { source: 'sources/github/elsewhere/project', githubRepoContext: { startingBranch: 'main' } } })]
    },
    stateAdapter: { readState: async () => ({ head: 'a'.repeat(40), claims: [] }) }
  }));
  assert.equal(result.success, true);
});

test('malformed, source-less, and duplicate sessions block', async () => {
  for (const session of [null, makeSession({ sourceContext: { githubRepoContext: { startingBranch: 'main' } } })]) {
    const result = await reconcileSessionLifecycle(options({
      providerClient: {
        findSourceForRepository: async () => ({ name: sourceName, githubRepo: { owner: 'owner', repo: 'repo' } }),
        listSessions: async () => [session]
      },
      stateAdapter: { readState: async () => ({ head: 'a'.repeat(40), claims: [] }) }
    }));
    assert.equal(result.success, false);
  }
  const duplicateResult = await reconcileSessionLifecycle(options({
    providerClient: {
      findSourceForRepository: async () => ({ name: sourceName, githubRepo: { owner: 'owner', repo: 'repo' } }),
      listSessions: async () => [makeSession(), makeSession()]
    }
  }));
  assert.equal(duplicateResult.blockers.some(blocker => blocker.code === 'BLOCK_DUPLICATE_SESSION_ID'), true);
});


test('a malformed or mismatched branch response is not accepted as proof of existence', async () => {
  for (const branchRecord of [{}, { name: 'another-branch' }, null]) {
    const result = await reconcileSessionLifecycle(options({
      fetchBranch: async () => branchRecord
    }));
    assert.equal(result.success, false);
    assert.equal(result.blockers.some(blocker => blocker.code === 'BLOCK_BRANCH_NOT_FOUND'), true);
  }
});

test('a fetched Issue with a mismatching number blocks reconciliation', async () => {
  const result = await reconcileSessionLifecycle(options({
    fetchIssue: async () => ({ number: 99, state: 'open', title: 'wrong Issue' })
  }));
  assert.equal(result.success, false);
  assert.equal(result.blockers.some(blocker => blocker.code === 'BLOCK_ISSUE_IDENTITY_UNVERIFIED'), true);
});

test('a PR that does not identify its governing Issue blocks reconciliation', async () => {
  const result = await reconcileSessionLifecycle(options({
    fetchPullRequest: async number => makePullRequest({ number, title: 'Unrelated change', body: 'No issue linked here' })
  }));
  assert.equal(result.success, false);
  assert.equal(result.blockers.some(blocker => blocker.code === 'BLOCK_PR_ISSUE_LINK_MISSING'), true);
});

test('a valid correlation marker may appear in both the session title and prompt but conflicting markers block', () => {
  assert.equal(extractSessionClaimId({ title: '[claimId: same]', prompt: '[claimId: same]' }), 'same');
  assert.equal(extractSessionClaimId({ title: '[claimId: one]', prompt: '[claimId: two]' }), null);
});

test('a malformed claim record blocks instead of being skipped', async () => {
  const result = await reconcileSessionLifecycle(options({
    providerClient: {
      findSourceForRepository: async () => ({ name: sourceName, githubRepo: { owner: 'owner', repo: 'repo' } }),
      listSessions: async () => []
    },
    stateAdapter: {
      readState: async () => ({ head: 'a'.repeat(40), claims: [{ claimId: 'incomplete' }] })
    }
  }));
  assert.equal(result.success, false);
  assert.equal(result.decisionCode, 'RECONCILIATION_STATE_INVALID');
  assert.equal(result.blockers[0].code, 'BLOCK_MALFORMED_CLAIM');
});
