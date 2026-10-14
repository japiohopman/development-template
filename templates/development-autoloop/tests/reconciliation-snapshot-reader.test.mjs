import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const runner = await readFile(new URL('../scripts/reconcile-readonly.mjs', import.meta.url), 'utf8');

test('read-only runner reads claims from the exact SHA returned by the state branch ref', () => {
  assert.match(runner, /contents\/claims\.json\?ref=' \+ encodeURIComponent\(head\)/);
  assert.doesNotMatch(runner, /contents\/claims\.json\?ref=' \+ encodeURIComponent\(stateBranch\)/);
});
