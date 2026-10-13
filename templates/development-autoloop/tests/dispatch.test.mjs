import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dispatchTask,
  validateDispatchPacket,
  DISPATCH_CODES
} from '../src/dispatch.mjs';
import { InMemoryStateAdapter } from '../src/claims.mjs';
import { JulesClient } from '../src/jules.mjs';
import { validateConfig } from '../src/config.mjs';

function sampleConfig(overrides = {}) {
  return {
    schemaVersion: 1,
    enabled: true,
    defaultBranch: 'main',
    runMode: 'live',
    workProvider: 'jules',
    reviewProvider: 'manual',
    maxConcurrentSessions: 1,
    humanReadinessRequired: false,
    automaticMerge: false,
    scheduleEnabled: false,
    requiredConfirmation: 'DISPATCH',
    staleClaimMinutes: 45,
    labels: {
      proposed: 'proposed',
      ready: 'roadmap-ready',
      claimed: 'automation-claimed',
      inProgress: 'in-progress',
      awaitingReview: 'awaiting-review',
      changesRequested: 'changes-requested',
      approved: 'review-approved',
      blocked: 'automation-blocked',
      escalated: 'needs-human'
    },
    requiredIssueSections: ['Scope'],
    requiredChecks: [],
    trustedReviewers: [],
    sequenceSource: null,
    ...overrides
  };
}

function sampleSnapshot(issueNumber = 42) {
  return {
    repository: { owner: 'acme', repo: 'autoloop' },
    snapshotComplete: true,
    issues: [
      {
        number: issueNumber,
        title: 'Fix issue ' + issueNumber,
        state: 'open',
        labels: ['roadmap-ready'],
        body: '## Scope\nFix issue.'
      }
    ],
    pullRequests: [],
    sessions: [],
    claims: []
  };
}

function samplePacket(overrides = {}) {
  const issueNumber = overrides.issueNumber ?? 42;
  return {
    repository: 'acme/autoloop',
    issueNumber,
    issueTitle: 'Fix issue ' + issueNumber,
    issueBody: '## Scope\nFix issue.',
    startingBranch: 'main',
    prompt: 'Fix the bug in auth',
    claimId: 'claim-' + issueNumber + '-test',
    ...overrides
  };
}

function createDefaultMockFetch(handlers = {}) {
  return async (url, options = {}) => {
    if (url.includes('/v1alpha/sources/github/acme/autoloop')) {
      return {
        ok: true,
        json: async () => ({
          name: 'sources/github/acme/autoloop',
          githubRepo: { owner: 'acme', repo: 'autoloop', branches: ['main'] }
        })
      };
    }
    if (url.includes('/v1alpha/sources')) {
      return {
        ok: true,
        json: async () => ({
          sources: [
            { name: 'sources/github/acme/autoloop', githubRepo: { owner: 'acme', repo: 'autoloop' } }
          ]
        })
      };
    }
    if (typeof handlers.customRoute === 'function') {
      const res = await handlers.customRoute(url, options);
      if (res !== undefined) return res;
    }
    throw new Error('Unexpected route: ' + url + ' [' + (options.method || 'GET') + ']');
  };
}

test('validateDispatchPacket validates the full packet contract and rejects missing bindings', () => {
  assert.equal(validateDispatchPacket(samplePacket()).valid, true);
  assert.equal(validateDispatchPacket(null).valid, false);
  assert.equal(validateDispatchPacket(samplePacket({ issueNumber: -1 })).valid, false);
  assert.equal(validateDispatchPacket(samplePacket({ issueTitle: '' })).valid, false);
  assert.equal(validateDispatchPacket(samplePacket({ startingBranch: '' })).valid, false);
  assert.equal(validateDispatchPacket(samplePacket({ prompt: '' })).valid, false);
  assert.equal(validateDispatchPacket(samplePacket({ claimId: '' })).valid, false);
  const missingClaimId = samplePacket();
  delete missingClaimId.claimId;
  assert.equal(validateDispatchPacket(missingClaimId).valid, false);
  const missingIssueBody = samplePacket();
  delete missingIssueBody.issueBody;
  assert.equal(validateDispatchPacket(missingIssueBody).valid, false);
});

test('dispatchTask fails when autoloop is disabled', async () => {
  const config = sampleConfig({ enabled: false });
  const packet = samplePacket();
  const stateAdapter = new InMemoryStateAdapter();

  const res = await dispatchTask({ config, packet, confirmation: 'DISPATCH', stateAdapter, snapshot: sampleSnapshot(42) });
  assert.equal(res.success, false);
  assert.equal(res.decisionCode, DISPATCH_CODES.DISPATCH_DISABLED);
});

test('dispatchTask fails when requiredConfirmation is empty or missing', async () => {
  const config = sampleConfig({ requiredConfirmation: '' });
  const packet = samplePacket();
  const stateAdapter = new InMemoryStateAdapter();

  const res = await dispatchTask({ config, packet, confirmation: '', stateAdapter, snapshot: sampleSnapshot(42) });
  assert.equal(res.success, false);
  assert.equal(res.decisionCode, DISPATCH_CODES.DISPATCH_CONFIRMATION_INVALID);
});

test('dispatchTask fails when preflight gate evidence is missing completely', async () => {
  const config = sampleConfig();
  const packet = samplePacket();
  const stateAdapter = new InMemoryStateAdapter();

  const res = await dispatchTask({ config, packet, confirmation: 'DISPATCH', stateAdapter });
  assert.equal(res.success, false);
  assert.equal(res.decisionCode, DISPATCH_CODES.DISPATCH_PREFLIGHT_BLOCKED);
  assert.equal((await stateAdapter.readState()).claims.length, 0);
});

test('dispatchTask fails setup when source is missing and creates zero claim writes', async () => {
  const config = sampleConfig();
  const packet = samplePacket();
  const stateAdapter = new InMemoryStateAdapter();

  const mockFetch = async (url) => {
    if (url.includes('/v1alpha/sources')) {
      return { ok: true, json: async () => ({ sources: [] }) };
    }
    throw new Error('Unexpected route: ' + url);
  };

  const providerClient = new JulesClient({ apiKey: 'my-key', fetchImpl: mockFetch });

  const res = await dispatchTask({
    config,
    packet,
    confirmation: 'DISPATCH',
    stateAdapter,
    snapshot: sampleSnapshot(42),
    providerClient
  });

  assert.equal(res.success, false);
  assert.equal(res.decisionCode, DISPATCH_CODES.DISPATCH_PROVIDER_FAILED);
  assert.equal((await stateAdapter.readState()).claims.length, 0);
});

test('dispatchTask fails when runMode is dry-run', async () => {
  const config = sampleConfig({ runMode: 'dry-run' });
  const packet = samplePacket();
  const stateAdapter = new InMemoryStateAdapter();

  const res = await dispatchTask({ config, packet, confirmation: 'DISPATCH', stateAdapter, snapshot: sampleSnapshot(42) });
  assert.equal(res.success, false);
  assert.equal(res.decisionCode, DISPATCH_CODES.DISPATCH_DRY_RUN);
});

test('dispatchTask fails when provider is not jules', async () => {
  const config = sampleConfig({ workProvider: 'none' });
  const packet = samplePacket();
  const stateAdapter = new InMemoryStateAdapter();

  const res = await dispatchTask({ config, packet, confirmation: 'DISPATCH', stateAdapter, snapshot: sampleSnapshot(42) });
  assert.equal(res.success, false);
  assert.equal(res.decisionCode, DISPATCH_CODES.DISPATCH_UNSUPPORTED_PROVIDER);
});

test('dispatchTask fails closed on non-exact confirmation string', async () => {
  const config = sampleConfig({ requiredConfirmation: 'DISPATCH' });
  const packet = samplePacket();
  const stateAdapter = new InMemoryStateAdapter();

  const confirmations = ['dispatch', 'DISPATCH ', ' DISPATCH', 'DISPATCH\n', 'dispatch_now'];
  for (const c of confirmations) {
    const res = await dispatchTask({ config, packet, confirmation: c, stateAdapter, snapshot: sampleSnapshot(42) });
    assert.equal(res.success, false);
    assert.equal(res.decisionCode, DISPATCH_CODES.DISPATCH_CONFIRMATION_INVALID);
  }
});


test('dispatchTask blocks an invalid schema config at the execution boundary', async () => {
  const config = sampleConfig({ maxConcurrentSessions: 0 });
  const packet = samplePacket();
  const stateAdapter = new InMemoryStateAdapter();
  let providerRequests = 0;
  const providerClient = {
    apiKey: 'test-key',
    async findSourceForRepository() { providerRequests++; throw new Error('must not call provider'); }
  };

  const res = await dispatchTask({
    config, packet, confirmation: 'DISPATCH', stateAdapter,
    snapshot: sampleSnapshot(42), providerClient
  });

  assert.equal(res.success, false);
  assert.equal(res.decisionCode, DISPATCH_CODES.DISPATCH_PREFLIGHT_BLOCKED);
  assert.equal(res.reason, 'Configuration failed schema validation.');
  assert.ok(res.blockers.length > 0);
  assert.equal(providerRequests, 0);
  assert.equal((await stateAdapter.readState()).claims.length, 0);
});

test('dispatchTask blocks snapshots from missing or mismatched repositories before provider calls', async () => {
  const snapshots = [
    (() => { const s = sampleSnapshot(42); delete s.repository; return s; })(),
    (() => { const s = sampleSnapshot(42); s.repository.repo = 'wrong-repo'; return s; })(),
    { ...sampleSnapshot(42), repository: { owner: 'someone-else', repo: 'other' } }
  ];

  for (const snapshot of snapshots) {
    const stateAdapter = new InMemoryStateAdapter();
    let providerRequests = 0;
    const providerClient = {
      apiKey: 'test-key',
      async findSourceForRepository() { providerRequests++; throw new Error('must not call provider'); }
    };

    const res = await dispatchTask({
      config: sampleConfig(), packet: samplePacket(), confirmation: 'DISPATCH',
      stateAdapter, snapshot, providerClient
    });

    assert.equal(res.success, false);
    assert.equal(res.decisionCode, DISPATCH_CODES.DISPATCH_PREFLIGHT_BLOCKED);
    assert.match(res.reason, /snapshot repository identity/i);
    assert.equal(providerRequests, 0);
    assert.equal((await stateAdapter.readState()).claims.length, 0);
  }
});

test('dispatchTask blocks Issue title or body drift against authoritative snapshot', async () => {
  for (const packet of [
    samplePacket({ issueTitle: 'Different issue title' }),
    samplePacket({ issueBody: '## Scope\nDifferent issue body' })
  ]) {
    const stateAdapter = new InMemoryStateAdapter();
    let providerRequests = 0;
    const providerClient = {
      apiKey: 'test-key',
      async findSourceForRepository() { providerRequests++; throw new Error('must not call provider'); }
    };

    const res = await dispatchTask({
      config: sampleConfig(), packet, confirmation: 'DISPATCH',
      stateAdapter, snapshot: sampleSnapshot(42), providerClient
    });

    assert.equal(res.success, false);
    assert.equal(res.decisionCode, DISPATCH_CODES.DISPATCH_INVALID_PACKET);
    assert.match(res.reason, /title\/body do not exactly match/i);
    assert.equal(providerRequests, 0);
    assert.equal((await stateAdapter.readState()).claims.length, 0);
  }
});

test('dispatchTask succeeds with a valid schema-backed config and preflight gate', async () => {
  const config = sampleConfig();
  const configCheck = validateConfig(config);
  assert.equal(configCheck.valid, true, 'Sample config must pass validateConfig schema checks.');
  const validatedConfig = configCheck.config;

  const packet = samplePacket({ issueNumber: 100 });
  const stateAdapter = new InMemoryStateAdapter();

  const mockFetch = createDefaultMockFetch({
    customRoute: async (url, options) => {
      if (url.includes('/v1alpha/sessions') && options.method === 'POST') {
        return {
          ok: true,
          json: async () => ({
            name: 'sessions/sess-schema-100',
            id: 'sess-schema-100',
            state: 'QUEUED',
            title: 'Fix issue 100 [claimId: claim-100-test]'
          })
        };
      }
    }
  });

  const providerClient = new JulesClient({ apiKey: 'my-key', fetchImpl: mockFetch });

  const res = await dispatchTask({
    config: validatedConfig,
    packet,
    confirmation: 'DISPATCH',
    stateAdapter,
    snapshot: sampleSnapshot(100),
    providerClient
  });

  assert.equal(res.success, true);
  assert.equal(res.decisionCode, DISPATCH_CODES.DISPATCH_SUCCESS);
  assert.equal(res.session.id, 'sess-schema-100');
  assert.ok(res.session.observedAt);
  assert.equal(res.claim.metadata.normalizedProviderStatus, 'QUEUED');
  assert.equal(res.claim.metadata.rawProviderState, 'QUEUED');
  assert.ok(res.claim.metadata.lastObservedAt);
  assert.ok(res.claim.metadata.providerLifecycleReason);
  const persistedClaim = (await stateAdapter.readState()).claims[0];
  assert.deepEqual(persistedClaim.metadata, res.claim.metadata);
});

test('dispatchTask tests ambiguous create timeout before vs after request transmission', async () => {
  const config = sampleConfig();

  // Case A: Timeout before transmission (e.g. AbortError / Connect timeout)
  const packetA = samplePacket({ issueNumber: 210, claimId: 'claim-210-before' });
  const stateAdapterA = new InMemoryStateAdapter();
  let createPostCountA = 0;

  const mockFetchBefore = createDefaultMockFetch({
    customRoute: async (url, options) => {
      if (url.includes('/v1alpha/sessions') && options.method === 'POST') {
        createPostCountA++;
        const err = new Error('Connect timeout before transmission');
        err.name = 'AbortError';
        throw err;
      }
      if (url.includes('/v1alpha/sessions') && options.method === 'GET') {
        return { ok: true, json: async () => ({ sessions: [] }) };
      }
    }
  });

  const clientA = new JulesClient({ apiKey: 'my-key', fetchImpl: mockFetchBefore });
  const resA = await dispatchTask({
    config,
    packet: packetA,
    confirmation: 'DISPATCH',
    stateAdapter: stateAdapterA,
    snapshot: sampleSnapshot(210),
    providerClient: clientA
  });

  assert.equal(resA.success, false);
  assert.equal(resA.decisionCode, DISPATCH_CODES.DISPATCH_AMBIGUOUS_BLOCKED);
  assert.equal(createPostCountA, 1, 'ambiguous create is never automatically retried');

  // Case B: Timeout after transmission (HTTP 504 Gateway Timeout)
  const packetB = samplePacket({ issueNumber: 220, claimId: 'claim-220-after' });
  const stateAdapterB = new InMemoryStateAdapter();
  let createPostCountB = 0;

  const mockFetchAfter = createDefaultMockFetch({
    customRoute: async (url, options) => {
      if (url.includes('/v1alpha/sessions') && options.method === 'POST') {
        createPostCountB++;
        const err = new Error('HTTP 504 Gateway Timeout after request sent');
        err.code = 'JULES_HTTP_ERROR';
        err.status = 504;
        throw err;
      }
      if (url.includes('/v1alpha/sessions') && options.method === 'GET') {
        return { ok: true, json: async () => ({ sessions: [] }) };
      }
    }
  });

  const clientB = new JulesClient({ apiKey: 'my-key', fetchImpl: mockFetchAfter });
  const resB = await dispatchTask({
    config,
    packet: packetB,
    confirmation: 'DISPATCH',
    stateAdapter: stateAdapterB,
    snapshot: sampleSnapshot(220),
    providerClient: clientB
  });

  assert.equal(resB.success, false);
  assert.equal(resB.decisionCode, DISPATCH_CODES.DISPATCH_AMBIGUOUS_BLOCKED);
  assert.equal(createPostCountB, 1, 'ambiguous create is never automatically retried');
});

test('dispatchTask fails preflight gate if snapshot selection is blocked', async () => {
  const config = sampleConfig();
  const packet = samplePacket({ issueNumber: 101 });
  const stateAdapter = new InMemoryStateAdapter();

  const mockSnapshotBlocked = {
    snapshotComplete: true,
    issues: [
      {
        number: 101,
        title: 'Fix issue 101',
        state: 'open',
        labels: ['roadmap-ready'],
        body: '## Scope\nFix issue 101.'
      }
    ],
    pullRequests: [
      { number: 5, state: 'open', body: 'Closes #101' } // Open PR blocks issue 101
    ],
    sessions: [],
    claims: []
  };

  const res = await dispatchTask({
    config,
    packet,
    confirmation: 'DISPATCH',
    stateAdapter,
    snapshot: mockSnapshotBlocked
  });

  assert.equal(res.success, false);
  assert.equal(res.decisionCode, DISPATCH_CODES.DISPATCH_PREFLIGHT_BLOCKED);
});

test('dispatchTask creates a durable claim BEFORE provider session creation and links session ID', async () => {
  const config = sampleConfig();
  const packet = samplePacket({ issueNumber: 100, claimId: 'claim-100-test' });
  const stateAdapter = new InMemoryStateAdapter();

  let claimWasCreatedBeforeSession = false;

  const mockFetch = createDefaultMockFetch({
    customRoute: async (url, options) => {
      if (url.includes('/v1alpha/sessions') && options.method === 'POST') {
        const currentSnapshot = await stateAdapter.readState();
        claimWasCreatedBeforeSession = currentSnapshot.claims.length === 1 && currentSnapshot.claims[0].issueNumber === 100;

        return {
          ok: true,
          json: async () => ({
            name: 'sessions/sess-100',
            id: 'sess-100',
            state: 'QUEUED',
            title: 'Fix issue 100 [claimId: claim-100-test]'
          })
        };
      }
    }
  });

  const providerClient = new JulesClient({ apiKey: 'my-key', fetchImpl: mockFetch });

  const res = await dispatchTask({
    config,
    packet,
    confirmation: 'DISPATCH',
    stateAdapter,
    snapshot: sampleSnapshot(100),
    providerClient
  });

  assert.equal(res.success, true);
  assert.equal(res.decisionCode, DISPATCH_CODES.DISPATCH_SUCCESS);
  assert.equal(claimWasCreatedBeforeSession, true);
  assert.equal(res.session.id, 'sess-100');
  assert.equal(res.claim.sessionId, 'sess-100');

  const finalState = await stateAdapter.readState();
  assert.equal(finalState.claims[0].sessionId, 'sess-100');
});

test('dispatchTask handles timeout during session creation and reconciles 1 match successfully using exact marker', async () => {
  const config = sampleConfig();
  const packet = samplePacket({ issueNumber: 200, claimId: 'claim-200-timeout' });
  const stateAdapter = new InMemoryStateAdapter();

  const mockFetch = createDefaultMockFetch({
    customRoute: async (url, options) => {
      if (url.includes('/v1alpha/sessions') && options.method === 'POST') {
        const err = new Error('Connection timeout');
        err.name = 'TimeoutError';
        throw err;
      }
      if (url.includes('/v1alpha/sessions/') && options.method === 'GET') {
        const id = url.split('/').pop();
        if (id === 'sess-reconciled-200') {
          return {
            ok: true,
            json: async () => ({
              id: 'sess-reconciled-200',
              name: 'sessions/sess-reconciled-200',
              prompt: 'Fix the bug in auth\n\nCorrelation: [claimId: claim-200-timeout]',
              state: 'QUEUED',
              sourceContext: {
                source: 'sources/github/acme/autoloop',
                githubRepoContext: { owner: 'acme', repo: 'autoloop', startingBranch: 'main' }
              }
            })
          };
        }
        return {
          ok: true,
          json: async () => ({
            id: 'sess-foreign-repo',
            name: 'sessions/sess-foreign',
            prompt: 'Fix the bug in auth\n\nCorrelation: [claimId: claim-200-timeout]',
            state: 'QUEUED',
            sourceContext: {
              source: 'sources/github/other/repo',
              githubRepoContext: { owner: 'other', repo: 'repo', startingBranch: 'main' }
            }
          })
        };
      }
      if (url.includes('/v1alpha/sessions') && options.method === 'GET') {
        return {
          ok: true,
          json: async () => ({
            sessions: [
              {
                id: 'sess-reconciled-200',
                name: 'sessions/sess-reconciled-200',
                prompt: 'Fix the bug in auth\n\nCorrelation: [claimId: claim-200-timeout]',
                state: 'QUEUED'
              },
              {
                id: 'sess-foreign-repo',
                name: 'sessions/sess-foreign',
                prompt: 'Fix the bug in auth\n\nCorrelation: [claimId: claim-200-timeout]',
                state: 'QUEUED'
              }
            ]
          })
        };
      }
    }
  });

  const providerClient = new JulesClient({ apiKey: 'my-key', fetchImpl: mockFetch });

  const res = await dispatchTask({
    config,
    packet,
    confirmation: 'DISPATCH',
    stateAdapter,
    snapshot: sampleSnapshot(200),
    providerClient
  });

  assert.equal(res.success, true);
  assert.equal(res.decisionCode, DISPATCH_CODES.DISPATCH_AMBIGUOUS_RECONCILED);
  assert.equal(res.session.id, 'sess-reconciled-200');
  assert.equal(res.claim.sessionId, 'sess-reconciled-200');
  assert.ok(res.session.observedAt);
});

test('dispatchTask blocks session with UNKNOWN normalized state', async () => {
  const config = sampleConfig();
  const packet = samplePacket({ issueNumber: 250, claimId: 'claim-250-unknown' });
  const stateAdapter = new InMemoryStateAdapter();

  const mockFetch = createDefaultMockFetch({
    customRoute: async (url, options) => {
      if (url.includes('/v1alpha/sessions') && options.method === 'POST') {
        return {
          ok: true,
          json: async () => ({
            name: 'sessions/sess-unknown-state',
            id: 'sess-unknown-state',
            state: 'UNRECOGNIZED_PROVIDER_STATE'
          })
        };
      }
    }
  });

  const providerClient = new JulesClient({ apiKey: 'my-key', fetchImpl: mockFetch });

  const res = await dispatchTask({
    config,
    packet,
    confirmation: 'DISPATCH',
    stateAdapter,
    snapshot: sampleSnapshot(250),
    providerClient
  });

  assert.equal(res.success, false);
  assert.equal(res.decisionCode, DISPATCH_CODES.DISPATCH_PROVIDER_FAILED);
  assert.ok(res.session.observedAt);
  assert.equal(res.claim.sessionId, 'sess-unknown-state');
  assert.match(res.claim.metadata.providerLifecycleReason, /Blocked/);
  const persistedClaim = (await stateAdapter.readState()).claims[0];
  assert.equal(persistedClaim.metadata.normalizedProviderStatus, 'UNKNOWN');
  assert.match(persistedClaim.metadata.providerLifecycleReason, /do not create a replacement session/);
});

test('dispatchTask blocks if full session details do not confirm the exact claim marker', async () => {
  const config = sampleConfig();
  const claimId = 'claim-230-marker-mismatch';
  const packet = samplePacket({ issueNumber: 230, claimId });
  const stateAdapter = new InMemoryStateAdapter();
  let createPostCount = 0;

  const mockFetch = createDefaultMockFetch({
    customRoute: async (url, options) => {
      if (url.includes('/v1alpha/sessions/sess-summary-mismatch') && options.method === 'GET') {
        return {
          ok: true,
          json: async () => ({
            id: 'sess-summary-mismatch',
            name: 'sessions/sess-summary-mismatch',
            prompt: 'A different task without the claim marker',
            state: 'QUEUED',
            sourceContext: {
              source: 'sources/github/acme/autoloop',
              githubRepoContext: { owner: 'acme', repo: 'autoloop', startingBranch: 'main' }
            }
          })
        };
      }
      if (url.includes('/v1alpha/sessions') && options.method === 'POST') {
        createPostCount++;
        const error = new Error('Connection timeout after request transmission');
        error.name = 'TimeoutError';
        throw error;
      }
      if (url.includes('/v1alpha/sessions') && options.method === 'GET') {
        return {
          ok: true,
          json: async () => ({
            sessions: [{
              id: 'sess-summary-mismatch',
              prompt: `Task [claimId: ${claimId}]`,
              state: 'QUEUED'
            }]
          })
        };
      }
    }
  });

  const providerClient = new JulesClient({ apiKey: 'my-key', fetchImpl: mockFetch });
  const result = await dispatchTask({
    config,
    packet,
    confirmation: 'DISPATCH',
    stateAdapter,
    snapshot: sampleSnapshot(230),
    providerClient
  });

  assert.equal(result.success, false);
  assert.equal(result.decisionCode, DISPATCH_CODES.DISPATCH_AMBIGUOUS_BLOCKED);
  assert.equal(createPostCount, 1);
  assert.equal(result.claim.sessionId, null);
});

test('dispatchTask handles timeout during session creation and blocks when 0 matches found', async () => {
  const config = sampleConfig();
  const packet = samplePacket({ issueNumber: 300, claimId: 'claim-300-timeout' });
  const stateAdapter = new InMemoryStateAdapter();

  const mockFetch = createDefaultMockFetch({
    customRoute: async (url, options) => {
      if (url.includes('/v1alpha/sessions') && options.method === 'POST') {
        throw new Error('504 Gateway Timeout');
      }
      if (url.includes('/v1alpha/sessions') && options.method === 'GET') {
        return {
          ok: true,
          json: async () => ({ sessions: [] })
        };
      }
    }
  });

  const providerClient = new JulesClient({ apiKey: 'my-key', fetchImpl: mockFetch });

  const res = await dispatchTask({
    config,
    packet,
    confirmation: 'DISPATCH',
    stateAdapter,
    snapshot: sampleSnapshot(300),
    providerClient
  });

  assert.equal(res.success, false);
  assert.equal(res.decisionCode, DISPATCH_CODES.DISPATCH_AMBIGUOUS_BLOCKED);
  assert.equal(res.claim.sessionId, null);
});

test('dispatchTask handles timeout during session creation and blocks when multiple matches found', async () => {
  const config = sampleConfig();
  const packet = samplePacket({ issueNumber: 400, claimId: 'claim-400-dup' });
  const stateAdapter = new InMemoryStateAdapter();

  const mockFetch = createDefaultMockFetch({
    customRoute: async (url, options) => {
      if (url.includes('/v1alpha/sessions') && options.method === 'POST') {
        throw new Error('500 Internal Error');
      }
      if (url.includes('/v1alpha/sessions/') && options.method === 'GET') {
        const id = url.split('/').pop();
        return {
          ok: true,
          json: async () => ({
            id,
            name: 'sessions/' + id,
            prompt: 'Prompt [claimId: claim-400-dup]',
            state: 'QUEUED',
            sourceContext: {
              source: 'sources/github/acme/autoloop',
              githubRepoContext: { owner: 'acme', repo: 'autoloop', startingBranch: 'main' }
            }
          })
        };
      }
      if (url.includes('/v1alpha/sessions') && options.method === 'GET') {
        return {
          ok: true,
          json: async () => ({
            sessions: [
              { id: 'sess-dup-1', prompt: 'Prompt [claimId: claim-400-dup]', state: 'QUEUED' },
              { id: 'sess-dup-2', prompt: 'Prompt [claimId: claim-400-dup]', state: 'QUEUED' }
            ]
          })
        };
      }
    }
  });

  const providerClient = new JulesClient({ apiKey: 'my-key', fetchImpl: mockFetch });

  const res = await dispatchTask({
    config,
    packet,
    confirmation: 'DISPATCH',
    stateAdapter,
    snapshot: sampleSnapshot(400),
    providerClient
  });

  assert.equal(res.success, false);
  assert.equal(res.decisionCode, DISPATCH_CODES.DISPATCH_AMBIGUOUS_BLOCKED);
  assert.equal(res.reason.includes('multiple (2) matching sessions'), true);
});
