import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workflow = await readFile(new URL('../.github/workflows/review-relay.yml', import.meta.url), 'utf8');
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('review relay listens to PR, review, and comment events but not a schedule', () => {
  assert.match(workflow, /^  pull_request_target:/m);
  assert.match(workflow, /^  pull_request_review:/m);
  assert.match(workflow, /^  issue_comment:/m);
  assert.doesNotMatch(workflow, /^\s+(schedule|push):/m);
});

test('review relay checks out trusted default-branch code and uses the protected Environment', () => {
  assert.match(workflow, /environment:\s*autoloop-dispatch/);
  assert.match(workflow, /ref:\s*\$\{\{\s*github\.event\.repository\.default_branch\s*\}\}/);
  assert.match(workflow, /persist-credentials:\s*false/);
});

test('review relay permissions are minimal except for its one auditable PR comment', () => {
  const permissions = workflow.match(/^permissions:\n([\s\S]*?)\n\nconcurrency:/m)?.[1] || '';
  assert.match(permissions, /contents:\s*read/);
  assert.match(permissions, /issues:\s*write/);
  assert.match(permissions, /pull-requests:\s*read/);
  assert.match(permissions, /checks:\s*read/);
  assert.doesNotMatch(permissions, /contents:\s*write|pull-requests:\s*write/);
  assert.match(workflow, /review-relay\.mjs/);
  assert.doesNotMatch(workflow, /autoloop-runner\.mjs|dispatch\.mjs/);
});

test('template syntax validation covers the review relay module and runner', () => {
  assert.match(packageJson.scripts.check, /src\/review-relay\.mjs/);
  assert.match(packageJson.scripts.check, /scripts\/review-relay\.mjs/);
});
