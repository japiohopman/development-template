import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const testsDir = fileURLToPath(new URL('.', import.meta.url));
const templateRoot = resolve(testsDir, '..');
const head = 'a'.repeat(40);
const trustedReview = {
  id: 501,
  user: { login: 'trusted-reviewer' },
  state: 'APPROVED',
  commit_id: head,
  submitted_at: '2026-10-14T12:00:00Z',
  body: 'Reviewed the exact current head.'
};
const pr = {
  number: 17, state: 'open', merged: false, draft: false,
  head: { sha: head }, body: '## Governing Issue\n#12'
};
const check = { id: 8, name: 'Template validation', head_sha: head, status: 'completed', conclusion: 'success' };

function mockSource(scenario) {
  return [
    'const scenario = ' + JSON.stringify(scenario) + ';',
    'const pullRequest = ' + JSON.stringify(pr) + ';',
    'const trustedReview = ' + JSON.stringify(trustedReview) + ';',
    'const check = ' + JSON.stringify(check) + ';',
    "function response(payload, status = 200) { return { ok: status >= 200 && status < 300, status, json: async () => payload }; }",
    'globalThis.fetch = async (input, options = {}) => {',
    '  const url = new URL(String(input));',
    "  if (url.hostname === 'jules.googleapis.com') throw new Error('Unexpected provider call in approval test.');",
    "  if (url.hostname !== 'api.github.com') throw new Error('Unexpected host.');",
    "  const path = url.pathname.replace('/repos/example/project', '');",
    "  if (path === '/check-runs' && options.method === 'POST') return response({ id: 909 }, 201);",
    "  if (/^\\/check-runs\\/\\d+$/.test(path) && options.method === 'PATCH') return response({ id: Number(path.split('/').pop()) });",
    "  if (options.method && options.method !== 'GET') throw new Error('Unexpected write in mocked approval path: ' + options.method + ' ' + path);",
    "  if (path === '/pulls/17') return response(pullRequest);",
    "  if (path === '/pulls/17/reviews') return response(scenario === 'no-review' ? [] : [scenario === 'dismissed-review' ? { ...trustedReview, state: 'DISMISSED' } : trustedReview]);",
    "  if (path.startsWith('/commits/') && path.endsWith('/check-runs') && url.searchParams.get('check_name')) return response({ check_runs: scenario === 'existing-check' ? [{ id: 888, name: 'Autoloop trusted review relay', external_id: 'autoloop-review-relay:example/project:pr:17', head_sha: pullRequest.head.sha }] : [] });",
    "  if (path.startsWith('/commits/') && path.endsWith('/check-runs')) return response({ check_runs: [scenario === 'failed-check' ? { ...check, conclusion: 'failure' } : check] });",
    "  if (path === '/issues/17/comments') return response([]);",
    "  return response({ message: 'Not Found' }, 404);",
    '};'
  ].join('\n');
}

function runRelay(t, scenario, commentActor = 'trusted-reviewer', trigger = 'issue_comment') {
  const directory = mkdtempSync(join(tmpdir(), 'review-relay-runner-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = JSON.parse(readFileSync(join(templateRoot, 'config/autoloop.example.json'), 'utf8'));
  config.trustedReviewers = ['trusted-reviewer'];
  config.requiredChecks = ['Template validation'];
  config.workProvider = 'jules';
  const configPath = join(directory, 'autoloop.json');
  const eventPath = join(directory, 'event.json');
  const preloadPath = join(directory, 'mock-fetch.mjs');
  const event = trigger === 'workflow_run'
    ? {
        action: 'completed',
        repository: { full_name: 'example/project' },
        workflow_run: {
          name: 'Observe PR review event (unprivileged)',
          event: 'pull_request_review',
          conclusion: 'success',
          pull_requests: [{ number: 17 }]
        }
      }
    : {
        action: 'created',
        repository: { full_name: 'example/project' },
        issue: { number: 17, pull_request: { url: 'https://api.github.com/repos/example/project/pulls/17' } },
        comment: {
          id: 901, user: { login: commentActor }, body: '[autoloop:relay-review]',
          created_at: '2026-10-14T12:30:00Z'
        }
      };
  writeFileSync(configPath, JSON.stringify(config));
  writeFileSync(eventPath, JSON.stringify(event));
  writeFileSync(preloadPath, mockSource(scenario));
  const result = spawnSync(process.execPath, ['--import', preloadPath, 'scripts/review-relay.mjs'], {
    cwd: templateRoot, encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_REPOSITORY: 'example/project',
      GITHUB_TOKEN: 'mock-token-not-a-real-secret',
      GITHUB_EVENT_NAME: trigger,
      GITHUB_EVENT_ACTION: trigger === 'workflow_run' ? 'completed' : 'created',
      GITHUB_EVENT_PATH: eventPath,
      AUTOLOOP_CONFIG_PATH: configPath,
      AUTOLOOP_STATE_BRANCH: 'autoloop-state'
    }
  });
  const start = result.stdout.indexOf('{');
  assert.notEqual(start, -1, 'runner should return JSON; stdout: ' + result.stdout + '; stderr: ' + result.stderr);
  return { ...result, report: JSON.parse(result.stdout.slice(start).trim()) };
}

test('trusted relay command re-reads current-head approval and exact-head required checks', t => {
  const result = runRelay(t, 'approval');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.decisionCode, 'APPROVED_CURRENT_HEAD');
  assert.equal(result.report.reviewedHeadSha, head);
  assert.equal(result.report.mutated, true);
  assert.equal(result.report.decisionCheckName, 'Autoloop trusted review relay');
  assert.equal(result.report.checkConclusion, 'success');
  assert.equal(result.report.requiresWrite, false);
});

test('the secure workflow_run bridge automatically relays a review from the no-secret observer', t => {
  const result = runRelay(t, 'approval', 'trusted-reviewer', 'workflow_run');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.decisionCode, 'APPROVED_CURRENT_HEAD');
  assert.equal(result.report.checkConclusion, 'success');
  assert.equal(result.report.mutated, true);
});

test('a dismissed trusted review leaves the current-head relay check action-required', t => {
  const result = runRelay(t, 'dismissed-review', 'trusted-reviewer', 'workflow_run');
  assert.equal(result.report.decisionCode, 'ACKNOWLEDGEMENT_IGNORED');
  assert.equal(result.report.checkConclusion, 'action_required');
  assert.equal(result.report.mutated, true);
});

test('relay updates its existing managed check run rather than creating duplicates', t => {
  const result = runRelay(t, 'existing-check');
  assert.equal(result.report.decisionCode, 'APPROVED_CURRENT_HEAD');
  assert.equal(result.report.decisionCheckRunId, 888);
  assert.equal(result.report.checkConclusion, 'success');
  assert.equal(result.report.mutated, true);
});

test('relay command blocks when no trusted review is available', t => {
  const result = runRelay(t, 'no-review');
  assert.equal(result.report.decisionCode, 'WAITING_FOR_TRUSTED_REVIEW');
  assert.equal(result.report.mutated, true);
  assert.equal(result.report.checkConclusion, 'action_required');
  assert.equal(result.report.requiresWrite, false);
});

test('relay command blocks when the current-head required check fails', t => {
  const result = runRelay(t, 'failed-check');
  assert.equal(result.report.decisionCode, 'BLOCK_REQUIRED_CHECKS');
  assert.equal(result.report.mutated, true);
  assert.equal(result.report.checkConclusion, 'action_required');
});

test('an untrusted actor cannot request the privileged relay', t => {
  const result = runRelay(t, 'approval', 'untrusted-user');
  assert.equal(result.report.decisionCode, 'IGNORED_UNTRUSTED_ACTOR');
  assert.equal(result.report.mutated, false);
  assert.equal(result.report.requiresWrite, false);
});
