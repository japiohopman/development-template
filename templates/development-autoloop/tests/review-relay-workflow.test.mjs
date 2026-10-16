import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workflow = await readFile(new URL('../.github/workflows/review-relay.yml', import.meta.url), 'utf8');
const observer = await readFile(new URL('../.github/workflows/review-relay-observer.yml', import.meta.url), 'utf8');
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('privileged review relay listens to trusted PR-target and comment events, not review merge-ref events or schedules', () => {
  assert.match(workflow, /^  pull_request_target:/m);
  assert.doesNotMatch(workflow, /^  pull_request_review:/m);
  assert.match(workflow, /^  issue_comment:/m);
  assert.doesNotMatch(workflow, /^\s+(schedule|push):/m);
});

test('review observer is unprivileged and does not check out or execute repository code', () => {
  assert.match(observer, /^  pull_request_review:/m);
  assert.match(observer, /permissions:\s*\{\}/);
  assert.doesNotMatch(observer, /checkout@|JULES_API_KEY|GITHUB_TOKEN|contents:\s*write|issues:\s*write/i);
  assert.match(workflow, /workflow_run:/);
  assert.match(workflow, /Observe PR review event \(unprivileged\)/);
});

test('review relay checks out trusted default-branch code and uses the protected Environment', () => {
  assert.match(workflow, /environment:\s*autoloop-dispatch/);
  assert.match(workflow, /ref:\s*\$\{\{\s*github\.event\.repository\.default_branch\s*\}\}/);
  assert.match(workflow, /persist-credentials:\s*false/);
  for (const action of ['checkout', 'setup-node']) {
    assert.match(workflow, new RegExp('uses: actions/' + action + '@[0-9a-f]{40} # v4\\.[0-9]+\\.[0-9]+'));
  }
});

test('review relay permissions are minimal for its managed per-head check and audit comments', () => {
  const permissions = workflow.match(/^permissions:\n([\s\S]*?)\n\nconcurrency:/m)?.[1] || '';
  assert.match(permissions, /contents:\s*read/);
  assert.match(permissions, /issues:\s*write/);
  assert.match(permissions, /pull-requests:\s*read/);
  assert.match(permissions, /checks:\s*write/);
  assert.doesNotMatch(permissions, /contents:\s*write|pull-requests:\s*write/);
  assert.match(workflow, /review-relay\.mjs/);
  assert.doesNotMatch(workflow, /autoloop-runner\.mjs|dispatch\.mjs/);
});

test('template syntax validation covers the review relay module and runner', () => {
  assert.match(packageJson.scripts.check, /src\/review-relay\.mjs/);
  assert.match(packageJson.scripts.check, /scripts\/review-relay\.mjs/);
});

test('Jules secret is exposed only after trusted current-head changes-requested classification', () => {
  assert.match(workflow, /Classify whether existing-work verification needs provider access/);
  assert.match(workflow, /trustedReviewers/);
  assert.match(workflow, /review\.commit_id !== pr\.head\.sha/);
  assert.match(workflow, /config\.enabled === true/);
  assert.match(workflow, /config\.runMode === 'live'/);
  assert.match(workflow, /config\.repairDispatchEnabled === true/);
  assert.match(workflow, /config\.repairPilotApproved === true/);
  assert.match(workflow, /config\.humanReadinessRequired === true/);
  assert.match(workflow, /config\.automaticMerge === false/);
  assert.match(workflow, /config\.scheduleEnabled === false/);
  assert.match(workflow, /needs_jules=\x27 \+ String\(needsProvider\)/);
  assert.match(workflow, /steps\.provider-access\.outputs\.needs_jules == \x27true\x27 && secrets\.JULES_API_KEY/);
  assert.doesNotMatch(workflow, /^\s+JULES_API_KEY:\s*\$\{\{\s*secrets\.JULES_API_KEY\s*\}\}/m);
});
