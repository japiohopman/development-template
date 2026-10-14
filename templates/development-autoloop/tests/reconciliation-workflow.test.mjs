import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workflow = await readFile(new URL('../.github/workflows/reconcile-readonly.yml', import.meta.url), 'utf8');
const runner = await readFile(new URL('../scripts/reconcile-readonly.mjs', import.meta.url), 'utf8');

test('reconciliation workflow is manual-only and requires exact repository confirmation', () => {
  assert.match(workflow, /^  workflow_dispatch:/m);
  assert.match(workflow, /confirm_repository:/);
  assert.doesNotMatch(workflow, /^\s+(push|pull_request|schedule):/m);
});

test('reconciliation workflow grants only read permissions', () => {
  const match = workflow.match(/^permissions:\n([\s\S]*?)\n\njobs:/m);
  assert.ok(match, 'top-level permissions must be explicit');
  assert.match(match[1], /contents:\s*read/);
  assert.match(match[1], /issues:\s*read/);
  assert.match(match[1], /pull-requests:\s*read/);
  assert.doesNotMatch(match[1], /\bwrite\b|\bnone\b/);
});

test('workflow passes repository confirmation and secrets only through environment', () => {
  assert.match(workflow, /CONFIRM_REPOSITORY:\s*\$\{\{\s*inputs\.confirm_repository\s*\}\}/);
  assert.match(workflow, /JULES_API_KEY:\s*\$\{\{\s*secrets\.JULES_API_KEY\s*\}\}/);
  assert.doesNotMatch(workflow, /permissions:[\s\S]*?contents:\s*write/);
});

test('runner is strictly GET-only and refuses an unconfirmed repository', () => {
  assert.match(runner, /confirmation !== repositoryValue/);
  assert.match(runner, /method:\s*'GET'/);
  assert.doesNotMatch(runner, /method:\s*'POST'|method:\s*'PATCH'|method:\s*'PUT'|method:\s*'DELETE'/);
  assert.match(runner, /reconcileSessionLifecycle/);
});
