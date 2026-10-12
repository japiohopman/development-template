import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dispatchTask,
  validateDispatchPacket,
  DISPATCH_CODES
} from '../src/dispatch.mjs';
import { InMemoryStateAdapter, CLAIM_CODES } from '../src/claims.mjs';
import { JulesClient } from '../src/jules.mjs';

function sampleConfig(overrides = {}) {
  return {
    enabled: true,
    runMode: 'live',
    provider: 'jules',
    confirmation: 'DISPATCH',
    ...overrides
  };
}

function samplePacket(overrides = {}) {
  return {
    repository: 'acme/autoloop',
    issueNumber: 42,
    issueTitle: 'Fix issue 42',
    startingBranch: 'main',
    prompt: 'Fix the bug in auth',
    claimId: 'claim-42-test',
    ...overrides
  };
}

test('validateDispatchPacket validates correct packets and rejects invalid ones', () => {
  assert.equal(validateDispatchPacket(samplePacket()).valid, true);
  assert.equal(validateDispatchPacket(null).valid, false);
  assert.equal(validateDispatchPacket(samplePacket({ issueNumber: -1 })).valid, false);
  assert.equal(validateDispatchPacket(samplePacket({ issueTitle: '' })).valid, false);
  assert.equal(validateDispatchPacket(samplePacket({ startingBranch: '' })).valid, false);
  assert.equal(validateDispatchPacket(samplePacket({ prompt: '' })).valid, false);
});

test('dispatchTask fails when autoloop is disabled', async () => {
  const config = sampleConfig({ enabled: false });
  const packet = samplePacket();
  const stateAdapter = new InMemoryStateAdapter();

  const res = await dispatchTask({ config, packet, confirmation: 'DISPATCH', stateAdapter });
  assert.equal(res.success, false);
  assert.equal(res.decisionCode, DISPATCH_CODES.DISPATCH_DISABLED);
});

test('dispatchTask fails when runMode is dry-run', async () => {
  const config = sampleConfig({ runMode: 'dry-run' });
  const packet = samplePacket();
  const stateAdapter = new InMemoryStateAdapter();

  const res = await dispatchTask({ config, packet, confirmation: 'DISPATCH', stateAdapter });
  assert.equal(res.success, false);
  assert.equal(res.decisionCode, DISPATCH_CODES.DISPATCH_DRY_RUN);
});

test('dispatchTask fails when provider is not jules', async () => {
  const config = sampleConfig({ provider: 'none' });
  const packet = samplePacket();
  const stateAdapter = new InMemoryStateAdapter();

  const res = await dispatchTask({ config, packet, confirmation: 'DISPATCH', stateAdapter });
  assert.equal(res.success, false);
  assert.equal(res.decisionCode, DISPATCH_CODES.DISPATCH_UNSUPPORTED_PROVIDER);
});

test('dispatchTask fails closed on non-exact confirmation string', async () => {
  const config = sampleConfig({ confirmation: 'DISPATCH' });
  const packet = samplePacket();
  const stateAdapter = new InMemoryStateAdapter();

  const confirmations = ['dispatch', 'DISPATCH ', ' DISPATCH', 'DISPATCH\n', 'dispatch_now'];
  for (const c of confirmations) {
    const res = await dispatchTask({ config, packet, confirmation: c, stateAdapter });
    assert.equal(res.success, false);
    assert.equal(res.decisionCode, DISPATCH_CODES.DISPATCH_CONFIRMATION_INVALID);
  }
});

test('dispatchTask creates a durable claim BEFORE provider session creation and links session ID', async () => {
  const config = sampleConfig();
  const packet = samplePacket({ issueNumber: 100 });
  const stateAdapter = new InMemoryStateAdapter();

  let claimWasCreatedBeforeSession = false;

  const mockFetch = async (url, options) => {
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
    if (url.includes('/v1alpha/sessions') && options.method === 'POST') {
      // Check if claim was already persisted in state store!
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
    throw new Error('Unexpected route: ' + url);
  };

  const providerClient = new JulesClient({ apiKey: 'my-key', fetchImpl: mockFetch });

  const res = await dispatchTask({
    config,
    packet: samplePacket({ issueNumber: 100, claimId: 'claim-100-test' }),
    confirmation: 'DISPATCH',
    stateAdapter,
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

test('dispatchTask handles timeout during session creation and reconciles 1 match successfully', async () => {
  const config = sampleConfig();
  const packet = samplePacket({ issueNumber: 200, claimId: 'claim-200-timeout' });
  const stateAdapter = new InMemoryStateAdapter();

  const mockFetch = async (url, options) => {
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
    if (url.includes('/v1alpha/sessions') && options.method === 'POST') {
      const err = new Error('Connection timeout');
      err.name = 'TimeoutError';
      throw err;
    }
    if (url.includes('/v1alpha/sessions') && options.method === 'GET') {
      // Reconcile list sessions: returns 1 matching session
      return {
        ok: true,
        json: async () => ({
          sessions: [
            {
              id: 'sess-reconciled-200',
              name: 'sessions/sess-reconciled-200',
              prompt: 'Fix the bug in auth\n\nCorrelation: [claimId: claim-200-timeout]',
              state: 'QUEUED'
            }
          ]
        })
      };
    }
    throw new Error('Unexpected route: ' + url);
  };

  const providerClient = new JulesClient({ apiKey: 'my-key', fetchImpl: mockFetch });

  const res = await dispatchTask({
    config,
    packet,
    confirmation: 'DISPATCH',
    stateAdapter,
    providerClient
  });

  assert.equal(res.success, true);
  assert.equal(res.decisionCode, DISPATCH_CODES.DISPATCH_AMBIGUOUS_RECONCILED);
  assert.equal(res.session.id, 'sess-reconciled-200');
  assert.equal(res.claim.sessionId, 'sess-reconciled-200');
});

test('dispatchTask handles timeout during session creation and blocks when 0 matches found', async () => {
  const config = sampleConfig();
  const packet = samplePacket({ issueNumber: 300, claimId: 'claim-300-timeout' });
  const stateAdapter = new InMemoryStateAdapter();

  const mockFetch = async (url, options) => {
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
    if (url.includes('/v1alpha/sessions') && options.method === 'POST') {
      throw new Error('504 Gateway Timeout');
    }
    if (url.includes('/v1alpha/sessions') && options.method === 'GET') {
      return {
        ok: true,
        json: async () => ({ sessions: [] })
      };
    }
    throw new Error('Unexpected route: ' + url);
  };

  const providerClient = new JulesClient({ apiKey: 'my-key', fetchImpl: mockFetch });

  const res = await dispatchTask({
    config,
    packet,
    confirmation: 'DISPATCH',
    stateAdapter,
    providerClient
  });

  assert.equal(res.success, false);
  assert.equal(res.decisionCode, DISPATCH_CODES.DISPATCH_AMBIGUOUS_BLOCKED);
  assert.equal(res.claim.sessionId, null); // Session ID not set
});

test('dispatchTask handles timeout during session creation and blocks when multiple matches found', async () => {
  const config = sampleConfig();
  const packet = samplePacket({ issueNumber: 400, claimId: 'claim-400-dup' });
  const stateAdapter = new InMemoryStateAdapter();

  const mockFetch = async (url, options) => {
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
    if (url.includes('/v1alpha/sessions') && options.method === 'POST') {
      throw new Error('500 Internal Error');
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
    throw new Error('Unexpected route: ' + url);
  };

  const providerClient = new JulesClient({ apiKey: 'my-key', fetchImpl: mockFetch });

  const res = await dispatchTask({
    config,
    packet,
    confirmation: 'DISPATCH',
    stateAdapter,
    providerClient
  });

  assert.equal(res.success, false);
  assert.equal(res.decisionCode, DISPATCH_CODES.DISPATCH_AMBIGUOUS_BLOCKED);
  assert.equal(res.reason.includes('multiple (2) matching sessions'), true);
});
