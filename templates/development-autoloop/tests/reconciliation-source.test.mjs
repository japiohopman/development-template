import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileSessionLifecycle } from '../src/reconciliation.mjs';

test('an unrecognized source string cannot silently disappear from the target inventory', async () => {
  const result = await reconcileSessionLifecycle({
    repository: 'owner/repo',
    providerClient: {
      findSourceForRepository: async () => ({ name: 'sources/github/owner/repo', githubRepo: { owner: 'owner', repo: 'repo' } }),
      listSessions: async () => [{
        id: 's-1',
        name: 'sessions/s-1',
        title: 'Unknown source',
        prompt: 'Unknown source',
        state: 'IN_PROGRESS',
        sourceContext: { source: 'unknown-source' }
      }]
    },
    stateAdapter: { readState: async () => ({ head: 'a'.repeat(40), claims: [] }) },
    fetchIssue: async () => null,
    fetchBranch: async () => null,
    fetchPullRequest: async () => null
  });
  assert.equal(result.success, false);
  assert.ok(result.blockers.some(item => item.code === 'BLOCK_UNRECOGNIZED_SESSION_SOURCE'));
});
