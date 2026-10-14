import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const workflow = readFileSync(join(here, '../.github/workflows/pr-contract-gate.yml'), 'utf8');
const runner = readFileSync(join(here, '../scripts/pr-contract-gate.mjs'), 'utf8');

test('the workflow is PR/check-event driven and has no schedule or live dispatcher', () => {
  assert.match(workflow, /pull_request_target:/);
  assert.match(workflow, /check_suite:/);
  assert.doesNotMatch(workflow, /^\s*schedule:/m);
  assert.doesNotMatch(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /JULES_API_KEY|automatic.?dispatch/i);
});
test('privileged workflow checks out only trusted base/default code', () => {
  assert.match(workflow, /github\.event\.pull_request\.base\.sha\s*\|\|\s*github\.event\.repository\.default_branch/);
  assert.match(workflow, /persist-credentials:\s*false/);
  assert.doesNotMatch(workflow, /ref:\s*\$\{\{\s*github\.event\.pull_request\.head\.sha/);
  assert.doesNotMatch(workflow, /npm install|npm ci|pnpm install|yarn install/);
});
test('workflow permissions are read-only', () => {
  assert.match(workflow, /contents:\s*read/);
  assert.match(workflow, /pull-requests:\s*read/);
  assert.match(workflow, /issues:\s*read/);
  assert.match(workflow, /checks:\s*read/);
  assert.doesNotMatch(workflow, /contents:\s*write|pull-requests:\s*write|issues:\s*write|checks:\s*write/i);
});
test('runner uses GET-only GitHub API calls and never mutates or merges', () => {
  assert.match(runner, /method:\s*'GET'/);
  assert.doesNotMatch(runner, /method:\s*'(POST|PATCH|PUT|DELETE)'/);
  assert.doesNotMatch(runner, /createSession|dispatchIssue|acquireClaim|\/merge/);
});
test('runner explains its trust boundary and fail-closed behavior', () => {
  assert.match(runner, /never runs PR-head code/);
  assert.match(runner, /missing data must never count as a pass/);
  assert.match(runner, /does not approve or merge/);
  assert.match(runner, /read-only GitHub snapshot/);
});
