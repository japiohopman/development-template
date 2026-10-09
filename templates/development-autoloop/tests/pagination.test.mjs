import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchAllTokenPages } from '../src/pagination.mjs';

test('fetches and combines all pages in token order', async () => {
  const calls = [];
  const items = await fetchAllTokenPages(async path => {
    calls.push(path);
    if (calls.length === 1) return { rows: [1, 2], nextPageToken: 'next / page' };
    return { rows: [3], nextPageToken: null };
  }, { firstPath: '/sessions', collectionKey: 'rows', pageSize: 2 });

  assert.deepEqual(items, [1, 2, 3]);
  assert.equal(calls.length, 2);
  assert.match(calls[1], /pageToken=next%20%2F%20page/);
});

test('rejects an incomplete API page', async () => {
  await assert.rejects(
    () => fetchAllTokenPages(async () => ({}), { firstPath: '/sessions', collectionKey: 'sessions' }),
    /Incomplete API page/,
  );
});

test('rejects a repeated page token', async () => {
  let calls = 0;
  await assert.rejects(
    () => fetchAllTokenPages(async () => {
      calls += 1;
      return { rows: [], nextPageToken: 'same' };
    }, { firstPath: '/sessions', collectionKey: 'rows' }),
    /Pagination repeated token/,
  );
});

test('rejects invalid page sizes', async () => {
  await assert.rejects(
    () => fetchAllTokenPages(async () => ({ rows: [] }), { firstPath: '/sessions', collectionKey: 'rows', pageSize: 0 }),
    /pageSize must be a positive integer/,
  );
});
