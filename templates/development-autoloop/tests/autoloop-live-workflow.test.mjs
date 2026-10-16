import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const template = new URL('..', import.meta.url);
const live = await readFile(new URL('.github/workflows/autoloop-live-dispatch.yml', template), 'utf8');
const plan = await readFile(new URL('.github/workflows/autoloop-dispatch.yml', template), 'utf8');

test('both consumer workflows are manual-only and verify the default branch', () => {
  for (const [name, workflow] of [['plan', plan], ['live', live]]) {
    assert.match(workflow, /^  workflow_dispatch:/m, name);
    assert.match(workflow, /github\.ref != format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/, name);
    assert.doesNotMatch(workflow, /^\s+(push|pull_request|schedule):/m, name);
  }
});

test('both workflows pin third-party actions to immutable commit SHAs', () => {
  for (const [name, workflow] of [['plan', plan], ['live', live]]) {
    assert.match(workflow, /uses:\s+actions\/checkout@[0-9a-f]{40}/, name + ' checkout must be SHA-pinned');
    assert.match(workflow, /uses:\s+actions\/setup-node@[0-9a-f]{40}/, name + ' setup-node must be SHA-pinned');
    assert.match(workflow, /persist-credentials:\s*false/, name + ' checkout credentials must not persist');
  }
});

test('live dispatch verifies repository, live mode, and exact authorization before exposing Jules secret', () => {
  const authorizationStep = live.indexOf('name: Verify repository and dispatch authorization before exposing provider secrets');
  const secretUse = live.indexOf('JULES_API_KEY: ${{ secrets.JULES_API_KEY }}');
  const dispatchStep = live.indexOf('name: Dispatch exactly one task after all safety gates pass');
  assert.ok(authorizationStep >= 0, 'authorization step must exist');
  assert.ok(dispatchStep > authorizationStep, 'dispatch must follow authorization');
  assert.ok(secretUse > dispatchStep, 'provider secret must only be present in the dispatch step');
  assert.match(live, /CONFIRM_REPOSITORY !== process\.env\.GITHUB_REPOSITORY/);
  assert.match(live, /config\.enabled !== true \|\| config\.runMode !== 'live'/);
  assert.match(live, /process\.env\.DISPATCH_AUTHORIZATION !== config\.requiredConfirmation/);
});

test('plan workflow validates repository confirmation before exposing the read-only provider secret', () => {
  const confirmationStep = plan.indexOf('name: Verify repository confirmation before exposing provider secrets');
  const secretUse = plan.indexOf('JULES_API_KEY: ${{ secrets.JULES_API_KEY }}');
  const runnerStep = plan.indexOf('name: Run Autoloop plan');
  assert.ok(confirmationStep >= 0, 'repository confirmation step must exist');
  assert.ok(runnerStep > confirmationStep, 'plan runner must follow repository confirmation');
  assert.ok(secretUse > runnerStep, 'provider secret must only be exposed after repository confirmation');
  assert.match(plan, /CONFIRM_REPOSITORY.*inputs\.confirm_repository/);
  assert.match(plan, /if \[ "\\$CONFIRM_REPOSITORY" != "\\$GITHUB_REPOSITORY" \]/);
});

test('live workflow has only the expected minimum GitHub write permission', () => {
  const match = live.match(/^permissions:\n([\s\S]*?)\n\njobs:/m);
  assert.ok(match, 'top-level permissions must be explicit');
  assert.match(match[1], /contents:\s*write/);
  assert.match(match[1], /issues:\s*read/);
  assert.match(match[1], /pull-requests:\s*read/);
  assert.doesNotMatch(match[1], /checks:\s*write|actions:\s*write|administration:\s*write/);
});
