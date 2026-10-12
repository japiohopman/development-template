import test from 'node:test';
import assert from 'node:assert/strict';
import {
  JulesClient,
  normalizeJulesState,
  sanitizeJulesErrorMessage,
  JULES_STATE_NORMALIZED
} from '../src/jules.mjs';

test('normalizeJulesState normalizes documented and unknown states correctly', () => {
  assert.equal(normalizeJulesState('QUEUED'), JULES_STATE_NORMALIZED.QUEUED);
  assert.equal(normalizeJulesState('PLANNING'), JULES_STATE_NORMALIZED.ACTIVE);
  assert.equal(normalizeJulesState('IN_PROGRESS'), JULES_STATE_NORMALIZED.ACTIVE);
  assert.equal(normalizeJulesState('AWAITING_PLAN_APPROVAL'), JULES_STATE_NORMALIZED.AWAITING_INPUT);
  assert.equal(normalizeJulesState('AWAITING_USER_FEEDBACK'), JULES_STATE_NORMALIZED.AWAITING_INPUT);
  assert.equal(normalizeJulesState('PAUSED'), JULES_STATE_NORMALIZED.PAUSED);
  assert.equal(normalizeJulesState('COMPLETED'), JULES_STATE_NORMALIZED.COMPLETED);
  assert.equal(normalizeJulesState('FAILED'), JULES_STATE_NORMALIZED.FAILED);
  assert.equal(normalizeJulesState('UNKNOWN_XYZ'), JULES_STATE_NORMALIZED.UNKNOWN);
  assert.equal(normalizeJulesState(''), JULES_STATE_NORMALIZED.UNKNOWN);
  assert.equal(normalizeJulesState(null), JULES_STATE_NORMALIZED.UNKNOWN);
});

test('sanitizeJulesErrorMessage redacts sensitive API key', () => {
  const secretKey = 'secret-jules-api-key-12345';
  const rawMsg = `HTTP 401 Unauthorized with key ${secretKey} in header X-Goog-Api-Key: ${secretKey}`;
  const sanitized = sanitizeJulesErrorMessage(rawMsg, secretKey);
  assert.equal(sanitized.includes(secretKey), false);
  assert.equal(sanitized.includes('[REDACTED]'), true);
});

test('JulesClient listSources handles pagination', async () => {
  const mockFetch = async (url) => {
    if (url.includes('pageToken=page2')) {
      return {
        ok: true,
        json: async () => ({
          sources: [
            { name: 'sources/github/acme/autoloop', githubRepo: { owner: 'acme', repo: 'autoloop' } }
          ]
        })
      };
    }
    return {
      ok: true,
      json: async () => ({
        sources: [
          { name: 'sources/github/other/repo', githubRepo: { owner: 'other', repo: 'repo' } }
        ],
        nextPageToken: 'page2'
      })
    };
  };

  const client = new JulesClient({ apiKey: 'test-key', fetchImpl: mockFetch });
  const sources = await client.listSources();
  assert.equal(sources.length, 2);
  assert.equal(sources[1].name, 'sources/github/acme/autoloop');

  const match = await client.findSourceForRepository('acme/autoloop');
  assert.equal(match.name, 'sources/github/acme/autoloop');
});

test('JulesClient createSession enforces requirePlanApproval: true', async () => {
  let capturedBody = null;
  let capturedHeaders = null;

  const mockFetch = async (url, options) => {
    capturedHeaders = options.headers;
    capturedBody = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({
        name: 'sessions/123456',
        id: '123456',
        state: 'QUEUED',
        prompt: capturedBody.prompt
      })
    };
  };

  const client = new JulesClient({ apiKey: 'my-api-key', fetchImpl: mockFetch });
  const created = await client.createSession({
    sourceName: 'sources/github/acme/autoloop',
    startingBranch: 'main',
    prompt: 'Implement feature [claimId: claim-123]',
    title: 'Task Title'
  });

  assert.equal(capturedHeaders['X-Goog-Api-Key'], 'my-api-key');
  assert.equal(capturedBody.requirePlanApproval, true);
  assert.equal(capturedBody.sourceContext.source, 'sources/github/acme/autoloop');
  assert.equal(capturedBody.sourceContext.githubRepoContext.startingBranch, 'main');
  assert.equal(created.id, '123456');
  assert.equal(created.normalizedState, JULES_STATE_NORMALIZED.QUEUED);
});

test('JulesClient propagates HTTP errors with sanitized messages', async () => {
  const apiKey = 'secret-api-key-value';
  const mockFetch = async () => {
    return {
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => `Invalid key ${apiKey}`
    };
  };

  const client = new JulesClient({ apiKey, fetchImpl: mockFetch });
  await assert.rejects(
    async () => client.listSources(),
    (err) => {
      assert.equal(err.code, 'JULES_HTTP_ERROR');
      assert.equal(err.status, 401);
      assert.equal(err.message.includes(apiKey), false);
      assert.equal(err.message.includes('[REDACTED]'), true);
      return true;
    }
  );
});
