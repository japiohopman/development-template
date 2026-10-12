import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLAIM_SCHEMA_VERSION,
  CLAIM_STATUS,
  RECONCILIATION_STATUS,
  CLAIM_CODES,
  normalizeRepositoryIdentity,
  validateClaimRecord,
  isClaimActive,
  InMemoryStateAdapter,
  GitHubStateBranchAdapter,
  acquireClaim,
  inspectClaim,
  validateReconciliationEvidence,
  reconcileAndRecoverClaim
} from '../src/claims.mjs';

function validSampleClaim(overrides = {}) {
  return {
    schemaVersion: CLAIM_SCHEMA_VERSION,
    claimId: 'claim-101-20260331-abc',
    repository: { owner: 'acme', repo: 'autoloop' },
    issueNumber: 101,
    owner: 'workflow-run-1',
    provider: 'jules',
    sessionId: null,
    createdAt: '2026-03-31T10:00:00.000Z',
    expiresAt: '2026-03-31T10:45:00.000Z',
    status: CLAIM_STATUS.ACTIVE,
    reconciliationStatus: RECONCILIATION_STATUS.PENDING,
    updatedAt: '2026-03-31T10:00:00.000Z',
    metadata: {},
    ...overrides
  };
}

test('normalizeRepositoryIdentity handles string and object inputs', () => {
  assert.deepEqual(
    normalizeRepositoryIdentity('Acme/AutoLoop').repository,
    { owner: 'acme', repo: 'autoloop' }
  );
  assert.deepEqual(
    normalizeRepositoryIdentity({ owner: ' Acme ', repo: ' AutoLoop ' }).repository,
    { owner: 'acme', repo: 'autoloop' }
  );
  assert.equal(normalizeRepositoryIdentity('invalid').valid, false);
  assert.equal(normalizeRepositoryIdentity(null).valid, false);
});

test('validateClaimRecord validates valid claims and rejects malformed fields', () => {
  const valid = validSampleClaim();
  assert.equal(validateClaimRecord(valid).valid, true);

  assert.equal(validateClaimRecord(null).valid, false);
  assert.equal(validateClaimRecord({}).valid, false);

  const badVersion = validSampleClaim({ schemaVersion: 99 });
  assert.equal(validateClaimRecord(badVersion).valid, false);

  const badIssue = validSampleClaim({ issueNumber: -1 });
  assert.equal(validateClaimRecord(badIssue).valid, false);

  const badDates = validSampleClaim({
    createdAt: '2026-03-31T10:45:00.000Z',
    expiresAt: '2026-03-31T10:00:00.000Z'
  });
  assert.equal(validateClaimRecord(badDates).valid, false);

  const badStatus = validSampleClaim({ status: 'UNKNOWN_STATUS' });
  assert.equal(validateClaimRecord(badStatus).valid, false);

  const badRecon = validSampleClaim({ reconciliationStatus: 'INVALID' });
  assert.equal(validateClaimRecord(badRecon).valid, false);
});

test('isClaimActive evaluates lease expiry and reconciliation status', () => {
  const now = new Date('2026-03-31T10:15:00.000Z');
  const activeUnexpired = validSampleClaim({
    createdAt: '2026-03-31T10:00:00.000Z',
    expiresAt: '2026-03-31T10:45:00.000Z'
  });
  const res1 = isClaimActive(activeUnexpired, now);
  assert.equal(res1.active, true);
  assert.equal(res1.expired, false);

  const activeExpired = validSampleClaim({
    createdAt: '2026-03-31T09:00:00.000Z',
    expiresAt: '2026-03-31T09:45:00.000Z'
  });
  const res2 = isClaimActive(activeExpired, now);
  assert.equal(res2.active, true);
  assert.equal(res2.expired, true);

  const reconciled = validSampleClaim({
    createdAt: '2026-03-31T09:00:00.000Z',
    expiresAt: '2026-03-31T09:45:00.000Z',
    status: CLAIM_STATUS.RECLAIMED,
    reconciliationStatus: RECONCILIATION_STATUS.RECONCILED
  });
  const res3 = isClaimActive(reconciled, now);
  assert.equal(res3.active, false);
  assert.equal(res3.expired, false);
});

test('InMemoryStateAdapter handles state reads and CAS commits', async () => {
  const adapter = new InMemoryStateAdapter();
  const s1 = await adapter.readState();
  assert.equal(s1.head, 'v0');
  assert.equal(s1.claims.length, 0);

  const c1 = validSampleClaim();
  const commit1 = await adapter.commitStateChange('v0', [c1]);
  assert.equal(commit1.success, true);
  assert.equal(commit1.head, 'v1');

  // Stale expected head fails CAS
  const commitStale = await adapter.commitStateChange('v0', [c1]);
  assert.equal(commitStale.success, false);
  assert.equal(commitStale.reason, 'CAS_CONFLICT');
});

test('GitHubStateBranchAdapter rejects default branch as state branch', () => {
  assert.throws(() => {
    new GitHubStateBranchAdapter({
      octokit: {},
      repository: 'owner/repo',
      stateBranch: 'main',
      defaultBranch: 'main'
    });
  }, /State branch .* cannot be the protected default branch/);
});

test('acquireClaim successfully acquires and persists a new claim', async () => {
  const stateAdapter = new InMemoryStateAdapter();
  const now = new Date('2026-03-31T10:00:00.000Z');

  const result = await acquireClaim({
    stateAdapter,
    repository: 'acme/autoloop',
    issueNumber: 42,
    owner: 'run-1',
    provider: 'jules',
    ttlMinutes: 45,
    now
  });

  assert.equal(result.decisionCode, CLAIM_CODES.CLAIM_ACQUIRED);
  assert.equal(result.persistenceConfirmed, true);
  assert.equal(result.safeToDispatch, true);
  assert.equal(result.claim.issueNumber, 42);

  const s2 = await stateAdapter.readState();
  assert.equal(s2.claims.length, 1);
  assert.equal(s2.claims[0].claimId, result.claim.claimId);
});

test('acquireClaim blocks duplicate claim for an already claimed issue', async () => {
  const stateAdapter = new InMemoryStateAdapter();
  const now = new Date('2026-03-31T10:00:00.000Z');

  const res1 = await acquireClaim({
    stateAdapter,
    repository: 'acme/autoloop',
    issueNumber: 42,
    owner: 'run-1',
    provider: 'jules',
    now
  });
  assert.equal(res1.decisionCode, CLAIM_CODES.CLAIM_ACQUIRED);

  const res2 = await acquireClaim({
    stateAdapter,
    repository: 'acme/autoloop',
    issueNumber: 42,
    owner: 'run-2',
    provider: 'jules',
    now
  });

  assert.equal(res2.decisionCode, CLAIM_CODES.CLAIM_ALREADY_EXISTS);
  assert.equal(res2.persistenceConfirmed, false);
  assert.equal(res2.safeToDispatch, false);
  assert.equal(res2.claim.claimId, res1.claim.claimId);
});

test('acquireClaim blocks expired claim until explicit reconciliation is performed', async () => {
  const expiredClaim = validSampleClaim({
    issueNumber: 50,
    createdAt: '2026-03-31T08:00:00.000Z',
    expiresAt: '2026-03-31T08:45:00.000Z',
    reconciliationStatus: RECONCILIATION_STATUS.PENDING
  });
  const stateAdapter = new InMemoryStateAdapter({ claims: [expiredClaim], head: 'v1' });
  const now = new Date('2026-03-31T10:00:00.000Z');

  const result = await acquireClaim({
    stateAdapter,
    repository: 'acme/autoloop',
    issueNumber: 50,
    owner: 'run-3',
    provider: 'jules',
    now
  });

  assert.equal(result.decisionCode, CLAIM_CODES.CLAIM_BLOCKED_STALE_UNRECONCILED);
  assert.equal(result.persistenceConfirmed, false);
  assert.equal(result.safeToDispatch, false);
  assert.equal(result.claim.claimId, expiredClaim.claimId);
});

test('acquireClaim retries on CAS conflict and exhausts retries if high contention persists', async () => {
  const stateAdapter = new InMemoryStateAdapter();
  stateAdapter.injectedConflictOnce = true;

  const res1 = await acquireClaim({
    stateAdapter,
    repository: 'acme/autoloop',
    issueNumber: 10,
    owner: 'run-1',
    provider: 'jules'
  });
  assert.equal(res1.decisionCode, CLAIM_CODES.CLAIM_ACQUIRED);

  // Always conflict to simulate exhausted retries
  const alwaysConflictAdapter = {
    async readState() {
      return { head: 'v9', claims: [] };
    },
    async commitStateChange() {
      return { success: false, head: 'v10', reason: 'CAS_CONFLICT', ambiguous: false };
    }
  };

  const resExhausted = await acquireClaim({
    stateAdapter: alwaysConflictAdapter,
    repository: 'acme/autoloop',
    issueNumber: 11,
    owner: 'run-1',
    provider: 'jules',
    maxRetries: 2
  });
  assert.equal(resExhausted.decisionCode, CLAIM_CODES.CAS_CONFLICT_EXHAUSTED);
  assert.equal(resExhausted.persistenceConfirmed, false);
});

test('acquireClaim reconciles ambiguous write outcome by exact claimId read-back', async () => {
  const stateAdapter = new InMemoryStateAdapter();
  stateAdapter.injectedAmbiguousWriteOnce = true;

  const result = await acquireClaim({
    stateAdapter,
    repository: 'acme/autoloop',
    issueNumber: 77,
    owner: 'run-ambiguous',
    provider: 'jules',
    claimId: 'claim-exact-77'
  });

  assert.equal(result.decisionCode, CLAIM_CODES.CLAIM_ACQUIRED);
  assert.equal(result.persistenceConfirmed, true);
  assert.equal(result.claim.claimId, 'claim-exact-77');
});

test('concurrency / race test: two simultaneous acquisition attempts for the same issue allow exactly one winner', async () => {
  const stateAdapter = new InMemoryStateAdapter();
  const now = new Date('2026-03-31T10:00:00.000Z');

  // Both read initial state 'v0'
  const read0 = await stateAdapter.readState();
  assert.equal(read0.head, 'v0');

  // Attempt 1 and Attempt 2 compete for issue 99
  const p1 = acquireClaim({
    stateAdapter,
    repository: 'acme/autoloop',
    issueNumber: 99,
    owner: 'runner-A',
    provider: 'jules',
    now
  });

  const p2 = acquireClaim({
    stateAdapter,
    repository: 'acme/autoloop',
    issueNumber: 99,
    owner: 'runner-B',
    provider: 'jules',
    now
  });

  const [resA, resB] = await Promise.all([p1, p2]);

  const outcomes = [resA.decisionCode, resB.decisionCode].sort();
  assert.deepEqual(outcomes, [CLAIM_CODES.CLAIM_ACQUIRED, CLAIM_CODES.CLAIM_ALREADY_EXISTS]);

  const finalState = await stateAdapter.readState();
  assert.equal(finalState.claims.length, 1);
  assert.equal(finalState.claims[0].issueNumber, 99);
});

test('validateReconciliationEvidence enforces complete evidence across sessions, branches, and PRs', () => {
  assert.equal(validateReconciliationEvidence(null).verified, false);
  assert.equal(validateReconciliationEvidence({ verified: false }).verified, false);

  const missingBranch = {
    verified: true,
    sessions: { status: 'terminal' },
    pullRequests: { status: 'merged' }
  };
  assert.equal(validateReconciliationEvidence(missingBranch).verified, false);

  const activeSession = {
    verified: true,
    sessions: { status: 'IN_PROGRESS' },
    branches: { status: 'clean' },
    pullRequests: { status: 'none' }
  };
  assert.equal(validateReconciliationEvidence(activeSession).verified, false);

  const completeEvidence = {
    verified: true,
    sessions: { status: 'terminal' },
    branches: { status: 'clean' },
    pullRequests: { status: 'merged' }
  };
  assert.equal(validateReconciliationEvidence(completeEvidence).verified, true);
});

test('reconcileAndRecoverClaim requires explicit verified reconciliation evidence and uses CAS', async () => {
  const staleClaim = validSampleClaim({
    claimId: 'stale-claim-99',
    issueNumber: 99,
    createdAt: '2026-03-31T07:00:00.000Z',
    expiresAt: '2026-03-31T07:45:00.000Z',
    status: CLAIM_STATUS.EXPIRED,
    reconciliationStatus: RECONCILIATION_STATUS.PENDING
  });

  const stateAdapter = new InMemoryStateAdapter({ claims: [staleClaim], head: 'v1' });
  const now = new Date('2026-03-31T10:00:00.000Z');

  // Attempt recovery without complete evidence fails closed
  const blockedRes = await reconcileAndRecoverClaim({
    stateAdapter,
    claimId: 'stale-claim-99',
    evidence: { verified: false },
    now
  });
  assert.equal(blockedRes.decisionCode, CLAIM_CODES.CLAIM_RECOVERY_BLOCKED);
  assert.equal(blockedRes.persistenceConfirmed, false);

  // Attempt recovery with complete evidence succeeds via CAS
  const completeEvidence = {
    verified: true,
    sessions: { status: 'terminal' },
    branches: { status: 'deleted' },
    pullRequests: { status: 'merged' },
    summary: 'PR #12 merged and session terminal'
  };

  const recoverRes = await reconcileAndRecoverClaim({
    stateAdapter,
    claimId: 'stale-claim-99',
    evidence: completeEvidence,
    targetStatus: CLAIM_STATUS.RECLAIMED,
    now
  });

  assert.equal(recoverRes.decisionCode, CLAIM_CODES.CLAIM_RECOVERED);
  assert.equal(recoverRes.persistenceConfirmed, true);
  assert.equal(recoverRes.claim.reconciliationStatus, RECONCILIATION_STATUS.RECONCILED);
  assert.equal(recoverRes.claim.status, CLAIM_STATUS.RECLAIMED);
  assert.equal(recoverRes.claim.metadata.reconciliationEvidence.verified, true);
  assert.equal(recoverRes.claim.metadata.reconciliationEvidence.sessions.status, 'terminal');
  assert.equal(recoverRes.claim.metadata.reconciliationEvidence.branches.status, 'deleted');
  assert.equal(recoverRes.claim.metadata.reconciliationEvidence.pullRequests.status, 'merged');

  // Verify inspection
  const inspected = await inspectClaim({ stateAdapter, claimId: 'stale-claim-99', now });
  assert.equal(inspected.found, true);
  assert.equal(inspected.activeState.active, false);
});

test('fixture: crash-after-claim prevents second claim attempt for same issue', async () => {
  const stateAdapter = new InMemoryStateAdapter();
  const now = new Date('2026-03-31T10:00:00.000Z');

  // Step 1: Claim acquired (e.g., process crashes before creating provider session)
  const c1 = await acquireClaim({
    stateAdapter,
    repository: 'acme/autoloop',
    issueNumber: 300,
    owner: 'run-crash-test',
    provider: 'jules',
    sessionId: null,
    now
  });
  assert.equal(c1.decisionCode, CLAIM_CODES.CLAIM_ACQUIRED);
  assert.equal(c1.claim.sessionId, null);

  // Step 2: Next run tries to claim issue 300 while claim is still active
  const c2 = await acquireClaim({
    stateAdapter,
    repository: 'acme/autoloop',
    issueNumber: 300,
    owner: 'run-crash-test-2',
    provider: 'jules',
    now: new Date('2026-03-31T10:10:00.000Z')
  });

  assert.equal(c2.decisionCode, CLAIM_CODES.CLAIM_ALREADY_EXISTS);
  assert.equal(c2.persistenceConfirmed, false);
});

test('fixture: crash-before-provider-call stale claim requires evidence reconciliation before re-claiming', async () => {
  const stateAdapter = new InMemoryStateAdapter();
  const t0 = new Date('2026-03-31T10:00:00.000Z');

  // Run 1 acquires claim for issue 301
  const c1 = await acquireClaim({
    stateAdapter,
    repository: 'acme/autoloop',
    issueNumber: 301,
    owner: 'run-1',
    provider: 'jules',
    ttlMinutes: 30,
    now: t0
  });
  assert.equal(c1.decisionCode, CLAIM_CODES.CLAIM_ACQUIRED);

  // Time passes past lease expiry (t1 = t0 + 40 mins)
  const t1 = new Date('2026-03-31T10:40:00.000Z');

  // Run 2 attempts to claim issue 301 - blocked because stale claim is unreconciled
  const c2 = await acquireClaim({
    stateAdapter,
    repository: 'acme/autoloop',
    issueNumber: 301,
    owner: 'run-2',
    provider: 'jules',
    now: t1
  });
  assert.equal(c2.decisionCode, CLAIM_CODES.CLAIM_BLOCKED_STALE_UNRECONCILED);

  // Reconcile stale claim with verified evidence confirming no session/branch/PR was left orphaned
  const rec = await reconcileAndRecoverClaim({
    stateAdapter,
    claimId: c1.claim.claimId,
    evidence: {
      verified: true,
      sessions: { status: 'none' },
      branches: { status: 'none' },
      pullRequests: { status: 'none' },
      summary: 'Verified crash before provider call; no artifacts created'
    },
    targetStatus: CLAIM_STATUS.RECLAIMED,
    now: t1
  });
  assert.equal(rec.decisionCode, CLAIM_CODES.CLAIM_RECOVERED);

  // Run 3 can now safely acquire claim for issue 301!
  const c3 = await acquireClaim({
    stateAdapter,
    repository: 'acme/autoloop',
    issueNumber: 301,
    owner: 'run-3',
    provider: 'jules',
    now: t1
  });
  assert.equal(c3.decisionCode, CLAIM_CODES.CLAIM_ACQUIRED);
  assert.notEqual(c3.claim.claimId, c1.claim.claimId);
});


test('EXPIRED claim with pending reconciliation still blocks duplicate acquisition', async () => {
  const expiredPending = validSampleClaim({
    claimId: 'expired-pending-50',
    issueNumber: 50,
    status: CLAIM_STATUS.EXPIRED,
    reconciliationStatus: RECONCILIATION_STATUS.PENDING,
    createdAt: '2026-03-31T08:00:00.000Z',
    expiresAt: '2026-03-31T08:45:00.000Z'
  });
  const stateAdapter = new InMemoryStateAdapter({ claims: [expiredPending], head: 'v1' });
  const result = await acquireClaim({
    stateAdapter,
    repository: 'acme/autoloop',
    issueNumber: 50,
    owner: 'run-2',
    provider: 'jules',
    now: new Date('2026-03-31T10:00:00.000Z')
  });
  assert.equal(result.decisionCode, CLAIM_CODES.CLAIM_BLOCKED_STALE_UNRECONCILED);
  assert.equal(result.safeToDispatch, false);
  assert.equal((await stateAdapter.readState()).claims.length, 1);
});

test('claimId cannot be reused for a different Issue even when the old claim is terminal', async () => {
  const oldClaim = validSampleClaim({
    claimId: 'globally-unique-claim-id',
    issueNumber: 11,
    status: CLAIM_STATUS.RELEASED,
    reconciliationStatus: RECONCILIATION_STATUS.RECONCILED
  });
  const stateAdapter = new InMemoryStateAdapter({ claims: [oldClaim], head: 'v1' });
  const result = await acquireClaim({
    stateAdapter,
    repository: 'acme/autoloop',
    issueNumber: 12,
    owner: 'run-new',
    provider: 'jules',
    claimId: 'globally-unique-claim-id'
  });
  assert.equal(result.decisionCode, CLAIM_CODES.CLAIM_ALREADY_EXISTS);
  assert.equal(result.safeToDispatch, false);
  assert.equal(result.claim.issueNumber, 11);
  assert.equal((await stateAdapter.readState()).claims.length, 1);
});

test('acquire and recovery reject non-finite, negative, fractional, and oversized retry limits', async () => {
  const retryValues = [Infinity, -1, 1.5, 6];
  for (const maxRetries of retryValues) {
    const stateAdapter = new InMemoryStateAdapter();
    const acquired = await acquireClaim({
      stateAdapter,
      repository: 'acme/autoloop',
      issueNumber: 23,
      owner: 'run-retries',
      provider: 'jules',
      maxRetries
    });
    assert.equal(acquired.decisionCode, CLAIM_CODES.CLAIM_INVALID_STATE);
    assert.equal((await stateAdapter.readState()).claims.length, 0);

    const recovered = await reconcileAndRecoverClaim({
      stateAdapter,
      claimId: 'anything',
      evidence: {
        verified: true,
        sessions: { status: 'none' },
        branches: { status: 'none' },
        pullRequests: { status: 'none' }
      },
      maxRetries
    });
    assert.equal(recovered.decisionCode, CLAIM_CODES.CLAIM_INVALID_STATE);
  }
});

test('recovery cannot release an unexpired active claim', async () => {
  const activeClaim = validSampleClaim({
    claimId: 'still-live-claim',
    issueNumber: 77,
    createdAt: '2026-03-31T10:00:00.000Z',
    expiresAt: '2026-03-31T10:45:00.000Z',
    status: CLAIM_STATUS.ACTIVE,
    reconciliationStatus: RECONCILIATION_STATUS.PENDING
  });
  const stateAdapter = new InMemoryStateAdapter({ claims: [activeClaim], head: 'v1' });
  const result = await reconcileAndRecoverClaim({
    stateAdapter,
    claimId: activeClaim.claimId,
    evidence: {
      verified: true,
      sessions: { status: 'terminal' },
      branches: { status: 'clean' },
      pullRequests: { status: 'merged' }
    },
    targetStatus: CLAIM_STATUS.RELEASED,
    now: new Date('2026-03-31T10:15:00.000Z')
  });
  assert.equal(result.decisionCode, CLAIM_CODES.CLAIM_RECOVERY_BLOCKED);
  assert.equal(result.persistenceConfirmed, true);
  const snapshot = await stateAdapter.readState();
  assert.equal(snapshot.claims[0].status, CLAIM_STATUS.ACTIVE);
  assert.equal(snapshot.claims[0].reconciliationStatus, RECONCILIATION_STATUS.PENDING);
});

test('GitHubStateBranchAdapter update uses the parent commit tree SHA for base_tree', async () => {
  const requests = [];
  const octokit = {
    async request(route, args) {
      requests.push({ route, args });
      switch (route) {
        case 'GET /repos/{owner}/{repo}/git/ref/{ref}':
          return { data: { object: { sha: 'existing-head-commit-sha' } } };
        case 'GET /repos/{owner}/{repo}/git/commits/{commit_sha}':
          assert.equal(args.commit_sha, 'existing-head-commit-sha');
          return { data: { tree: { sha: 'existing-tree-object-sha' } } };
        case 'POST /repos/{owner}/{repo}/git/blobs':
          return { data: { sha: 'new-blob-sha' } };
        case 'POST /repos/{owner}/{repo}/git/trees':
          return { data: { sha: 'new-tree-sha' } };
        case 'POST /repos/{owner}/{repo}/git/commits':
          return { data: { sha: 'new-head-commit-sha' } };
        case 'PATCH /repos/{owner}/{repo}/git/refs/{ref}':
          assert.equal(args.force, false);
          return { data: { object: { sha: 'new-head-commit-sha' } } };
        default:
          throw new Error('Unexpected mocked GitHub route: ' + route);
      }
    }
  };
  const adapter = new GitHubStateBranchAdapter({
    octokit,
    repository: 'acme/autoloop',
    stateBranch: 'autoloop-state',
    defaultBranch: 'main'
  });
  const result = await adapter.commitStateChange('existing-head-commit-sha', [validSampleClaim()]);
  assert.equal(result.success, true);
  const treeRequest = requests.find((request) => request.route === 'POST /repos/{owner}/{repo}/git/trees');
  assert.equal(treeRequest.args.base_tree, 'existing-tree-object-sha');
  assert.notEqual(treeRequest.args.base_tree, 'existing-head-commit-sha');
  const commitRequest = requests.find((request) => request.route === 'POST /repos/{owner}/{repo}/git/commits');
  assert.deepEqual(commitRequest.args.parents, ['existing-head-commit-sha']);
});

test('GitHubStateBranchAdapter rejects malformed persisted state instead of treating it as empty', async () => {
  const octokit = {
    async request(route) {
      if (route === 'GET /repos/{owner}/{repo}/git/ref/{ref}') {
        return { data: { object: { sha: 'existing-head-commit-sha' } } };
      }
      if (route === 'GET /repos/{owner}/{repo}/contents/{path}') {
        return { data: { content: Buffer.from(JSON.stringify({ items: [] }), 'utf8').toString('base64') } };
      }
      throw new Error('Unexpected mocked GitHub route: ' + route);
    }
  };
  const adapter = new GitHubStateBranchAdapter({
    octokit,
    repository: 'acme/autoloop',
    stateBranch: 'autoloop-state',
    defaultBranch: 'main'
  });
  await assert.rejects(
    () => adapter.readState(),
    (error) => error?.code === 'INVALID_STATE_STORE'
  );
});

test('state snapshot with duplicate claim IDs fails closed', async () => {
  const duplicateA = validSampleClaim({ claimId: 'duplicate-id', issueNumber: 1 });
  const duplicateB = validSampleClaim({ claimId: 'duplicate-id', issueNumber: 2 });
  const stateAdapter = new InMemoryStateAdapter({ claims: [duplicateA, duplicateB], head: 'v1' });
  const result = await acquireClaim({
    stateAdapter,
    repository: 'acme/autoloop',
    issueNumber: 3,
    owner: 'run-3',
    provider: 'jules'
  });
  assert.equal(result.decisionCode, CLAIM_CODES.CLAIM_INVALID_STATE);
  assert.equal(result.safeToDispatch, false);
});
