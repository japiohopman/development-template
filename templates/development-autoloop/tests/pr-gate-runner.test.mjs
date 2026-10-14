import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = new URL('.', import.meta.url);
const testsDir = fileURLToPath(here);
const templateRoot = resolve(testsDir, '..');
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const PARENT = 'c'.repeat(40);
const TREE_HEAD = 'd'.repeat(40);
const TREE_PARENT = 'e'.repeat(40);
const changedPath = 'src/example.js';

const issueBody = [
  '## Scope', 'Implement the exact-head PR gate.',
  '## Acceptance criteria', '- The gate blocks stale evidence.',
  '## Dependencies', 'None for this mocked runner fixture.',
  '## Out of scope', 'Live dispatch and automatic merge.',
  '## Validation plan', 'Run mocked API tests.'
].join('\n');

const prBody = [
  '## Governing Issue', 'Closes #12', '',
  '## Summary', 'Adds a read-only contract gate fixture.', '',
  '## Scope boundary', 'Tests the runner only; no live dispatch.', '',
  '## Acceptance criteria evidence',
  '- [x] Criterion: The gate binds evidence to the current head.',
  '  - Evidence: tests/pr-gate-runner.test.mjs asserts the current head result.', '',
  '## Verification',
  '- Changed paths:',
  '  - ' + changedPath,
  '- Commands/checks run: npm test passed for this commit.',
  '- Exact head SHA verified: ' + HEAD,
  '- Check results for that SHA: Template validation succeeded on this commit.', '',
  '## Risks and blockers',
  '- Security/permissions impact: the mock runner performs GET requests only.',
  '- Known blockers: none known in this fixture.',
  '- Recovery or rollback: the mocked process exits without repository mutations.', '',
  '## Handoff',
  '- Latest reviewer instructions addressed: first mocked runner test.',
  '- Next action and owner: maintainer reviews this exact head.',
  '- [x] No-op commit check completed'
].join('\n');

const pullRequest = {
  number: 17,
  state: 'open',
  merged: false,
  body: prBody,
  base: { sha: BASE, repo: { full_name: 'example/project' } },
  head: { sha: HEAD, repo: { full_name: 'example/project' } }
};
const headCommit = {
  sha: HEAD,
  commit: { tree: { sha: TREE_HEAD } },
  parents: [{ sha: PARENT }]
};
const parentCommit = {
  sha: PARENT,
  commit: { tree: { sha: TREE_PARENT } }
};
const checkRuns = {
  total_count: 1,
  check_runs: [{
    id: 7,
    name: 'Template validation',
    status: 'completed',
    conclusion: 'success',
    head_sha: HEAD,
    completed_at: '2026-10-14T10:00:00Z'
  }]
};

function mockSource(scenario) {
  return [
    "const scenario = " + JSON.stringify(scenario) + ";",
    "const pr = " + JSON.stringify(pullRequest) + ";",
    "const issue = " + JSON.stringify({ number: 12, state: 'open', body: issueBody }) + ";",
    "const headCommit = " + JSON.stringify(headCommit) + ";",
    "const parentCommit = " + JSON.stringify(parentCommit) + ";",
    "const checkRuns = " + JSON.stringify(checkRuns) + ";",
    "function reply(payload, status = 200) { return { ok: status >= 200 && status < 300, status, json: async () => payload }; }",
    "globalThis.fetch = async (input, options = {}) => {",
    "  if (options.method !== 'GET') throw new Error('Only GET calls are allowed in this mock.');",
    "  const url = new URL(String(input));",
    "  const path = url.pathname;",
    "  if (path === '/repos/example/project/pulls/17') return reply(pr);",
    "  if (path === '/repos/example/project/issues/12') {",
    "    if (scenario === 'issue-failure') return reply({ message: 'not found' }, 404);",
    "    return reply(issue);",
    "  }",
    "  if (path === '/repos/example/project/pulls/17/files') return reply([{ filename: " + JSON.stringify(changedPath) + " }]);",
    "  if (path === '/repos/example/project/commits/' + " + JSON.stringify(HEAD) + '/check-runs') return reply(checkRuns);",
    "  if (path === '/repos/example/project/commits/" + HEAD + "') return reply(headCommit);",
    "  if (path === '/repos/example/project/commits/" + PARENT + "') return reply(parentCommit);",
    "  return reply({ message: 'not found' }, 404);",
    "};"
  ].join('\n');
}

function readReport(stdout) {
  const start = stdout.indexOf('{\n');
  assert.notEqual(start, -1, 'runner output should include a JSON report; stdout was: ' + stdout);
  return JSON.parse(stdout.slice(start).trim());
}

function runGate(t, scenario) {
  const directory = mkdtempSync(join(tmpdir(), 'autoloop-pr-gate-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const exampleConfig = JSON.parse(readFileSync(join(templateRoot, 'config/autoloop.example.json'), 'utf8'));
  exampleConfig.requiredChecks = ['Template validation'];
  const configPath = join(directory, 'autoloop.json');
  const eventPath = join(directory, 'event.json');
  const preloadPath = join(directory, 'mock-fetch.mjs');
  writeFileSync(configPath, JSON.stringify(exampleConfig, null, 2));
  writeFileSync(eventPath, JSON.stringify({ pull_request: { number: 17, head: { sha: HEAD } } }));
  writeFileSync(preloadPath, mockSource(scenario));

  const result = spawnSync(process.execPath, ['--import', preloadPath, 'scripts/pr-contract-gate.mjs'], {
    cwd: templateRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_REPOSITORY: 'example/project',
      GITHUB_TOKEN: 'mock-token-not-a-real-secret',
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_EVENT_NAME: 'pull_request_target',
      PR_NUMBER: '17',
      EVENT_HEAD_SHA: HEAD,
      AUTOLOOP_CONFIG_PATH: configPath,
      PR_GATE_MOCK_SCENARIO: scenario
    }
  });
  assert.equal(result.error, undefined, result.error?.message);
  return { ...result, report: readReport(result.stdout) };
}

test('the actual runner accepts complete mocked GitHub evidence without making writes', t => {
  const result = runGate(t, 'pass');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.success, true);
  assert.equal(result.report.mutated, false);
  assert.equal(result.report.ciStatus, 'passed');
  assert.equal(result.report.humanApproval.approved, false);
});

test('a failed governing-Issue API read blocks instead of counting as an empty Issue', t => {
  const result = runGate(t, 'issue-failure');
  assert.notEqual(result.status, 0);
  assert.equal(result.report.success, false);
  assert.equal(result.report.mutated, false);
  assert.ok(result.report.blockers.some(blocker => blocker.code === 'GOVERNING_ISSUE_LOOKUP_FAILED'));
});
