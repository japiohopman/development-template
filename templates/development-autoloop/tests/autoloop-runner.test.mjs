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

const validIssue = {
  number: 1,
  title: 'Implement feature X',
  body: '## Scope\nImplement feature X.\n## Acceptance criteria\n- Feature X works.\n## Dependencies\nNone.\n## Out of scope\nNone.\n## Validation plan\nTests pass.',
  state: 'open',
  labels: [{ name: 'roadmap-ready' }, { name: 'human-ready' }]
};

function mockSource(scenario) {
  return [
    "const scenario = " + JSON.stringify(scenario) + ";",
    "const issue = " + JSON.stringify(validIssue) + ";",
    "function reply(payload, status = 200) { return { ok: status >= 200 && status < 300, status, json: async () => payload }; }",
    "globalThis.fetch = async (input, options = {}) => {",
    "  const url = new URL(String(input));",
    "  const path = url.pathname;",
    "  if (path.startsWith('/v1alpha/sessions')) {",
    "    if (scenario === 'sessions-failure') return reply({ message: 'Provider Error' }, 500);",
    "    return reply({ sessions: [] });",
    "  }",
    "  if (options.method && options.method !== 'GET') throw new Error('Only GET calls are allowed in this mock.');",
    "  if (path.startsWith('/repos/example/project/issues')) {",
    "    if (scenario === 'api-failure') return reply({ message: 'Internal Server Error' }, 500);",
    "    if (scenario === 'open-pr') return reply([issue, { number: 2, title: 'PR', pull_request: {} }]);",
    "    return reply([issue]);",
    "  }",
    "  if (path.startsWith('/repos/example/project/pulls')) {",
    "    if (scenario === 'open-pr') {",
    "      return reply([{ number: 2, state: 'open', body: 'Closes #1', issue_number: 1 }]);",
    "    }",
    "    return reply([]);",
    "  }",
    "  if (path.startsWith('/repos/example/project/git/ref/heads/')) {",
    "    if (scenario === 'missing-state-branch') return reply({ message: 'Not Found' }, 404);",
    "    return reply({ object: { sha: '1234567890123456789012345678901234567890' } });",
    "  }",
    "  if (path.startsWith('/repos/example/project/contents/claims.json')) {",
    "    if (scenario === 'missing-claims-file') return reply({ message: 'Not Found' }, 404);",
    "    let claimsList = [];",
    "    if (scenario === 'active-claim') {",
    "      claimsList = [{",
    "        schemaVersion: 1,",
    "        claimId: 'claim-1-123',",
    "        repository: { owner: 'example', repo: 'project' },",
    "        issueNumber: 1,",
    "        owner: 'autoloop',",
    "        provider: 'jules',",
    "        sessionId: null,",
    "        createdAt: new Date().toISOString(),",
    "        expiresAt: new Date(Date.now() + 3600000).toISOString(),",
    "        status: 'ACTIVE',",
    "        reconciliationStatus: 'PENDING',",
    "        updatedAt: new Date().toISOString(),",
    "        metadata: {}",
    "      }];",
    "    } else if (scenario === 'expired-unreconciled-claim') {",
    "      claimsList = [{",
    "        schemaVersion: 1,",
    "        claimId: 'claim-1-456',",
    "        repository: { owner: 'example', repo: 'project' },",
    "        issueNumber: 1,",
    "        owner: 'autoloop',",
    "        provider: 'jules',",
    "        sessionId: null,",
    "        createdAt: new Date(Date.now() - 7200000).toISOString(),",
    "        expiresAt: new Date(Date.now() - 3600000).toISOString(),",
    "        status: 'EXPIRED',",
    "        reconciliationStatus: 'PENDING',",
    "        updatedAt: new Date(Date.now() - 3600000).toISOString(),",
    "        metadata: {}",
    "      }];",
    "    } else if (scenario === 'released-reconciled-claim') {",
    "      claimsList = [{",
    "        schemaVersion: 1,",
    "        claimId: 'claim-1-789',",
    "        repository: { owner: 'example', repo: 'project' },",
    "        issueNumber: 1,",
    "        owner: 'autoloop',",
    "        provider: 'jules',",
    "        sessionId: 's-123',",
    "        createdAt: new Date(Date.now() - 7200000).toISOString(),",
    "        expiresAt: new Date(Date.now() - 3600000).toISOString(),",
    "        status: 'RELEASED',",
    "        reconciliationStatus: 'RECONCILED',",
    "        updatedAt: new Date().toISOString(),",
    "        metadata: {}",
    "      }];",
    "    } else if (scenario === 'reclaimed-reconciled-claim') {",
    "      claimsList = [{",
    "        schemaVersion: 1,",
    "        claimId: 'claim-1-999',",
    "        repository: { owner: 'example', repo: 'project' },",
    "        issueNumber: 1,",
    "        owner: 'autoloop',",
    "        provider: 'jules',",
    "        sessionId: 's-123',",
    "        createdAt: new Date(Date.now() - 7200000).toISOString(),",
    "        expiresAt: new Date(Date.now() - 3600000).toISOString(),",
    "        status: 'RECLAIMED',",
    "        reconciliationStatus: 'RECONCILED',",
    "        updatedAt: new Date().toISOString(),",
    "        metadata: {}",
    "      }];",
    "    }",
    "    const content = Buffer.from(JSON.stringify({ claims: claimsList })).toString('base64');",
    "    return reply({ encoding: 'base64', content });",
    "  }",
    "  return reply({ message: 'not found' }, 404);",
    "};"
  ].join('\n');
}

function readReport(stdout) {
  const start = stdout.indexOf('{\n');
  assert.notEqual(start, -1, 'runner output should include a JSON report; stdout was: ' + stdout);
  return JSON.parse(stdout.slice(start).trim());
}

function runRunner(t, scenario, envOverrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'autoloop-runner-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const exampleConfig = JSON.parse(readFileSync(join(templateRoot, 'config/autoloop.example.json'), 'utf8'));
  const configPath = join(directory, 'autoloop.json');
  const preloadPath = join(directory, 'mock-fetch.mjs');

  if (scenario === 'invalid-config') {
    writeFileSync(configPath, JSON.stringify({ enabled: 'not-a-boolean' }));
  } else {
    writeFileSync(configPath, JSON.stringify(exampleConfig, null, 2));
  }

  writeFileSync(preloadPath, mockSource(scenario));

  const env = {
    ...process.env,
    GITHUB_REPOSITORY: 'example/project',
    GITHUB_TOKEN: 'mock-token-not-a-real-secret',
    CONFIRM_REPOSITORY: 'example/project',
    JULES_API_KEY: 'mock-jules-key-not-a-real-secret',
    AUTOLOOP_CONFIG_PATH: configPath,
    ...envOverrides
  };

  if (envOverrides.JULES_API_KEY === null) {
    delete env.JULES_API_KEY;
  }

  const result = spawnSync(process.execPath, ['--import', preloadPath, 'scripts/autoloop-runner.mjs'], {
    cwd: templateRoot,
    encoding: 'utf8',
    env
  });

  return { ...result, report: readReport(result.stdout) };
}

test('the actual runner selects an eligible candidate in plan-only mode without mutating state', t => {
  const result = runRunner(t, 'pass');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.success, true);
  assert.equal(result.report.mutated, false);
  assert.equal(result.report.runMode, 'plan-only');
  assert.equal(result.report.decisionCode, 'CANDIDATE_SELECTED');
  assert.equal(result.report.selectedCandidate.number, 1);
});

test('unconfirmed repository fails closed before making API requests', t => {
  const result = runRunner(t, 'pass', { CONFIRM_REPOSITORY: 'wrong/repo' });
  assert.notEqual(result.status, 0);
  assert.equal(result.report.success, false);
  assert.equal(result.report.mutated, false);
  assert.equal(result.report.decisionCode, 'BLOCK_REPOSITORY_UNCONFIRMED');
});

test('an API failure during snapshot collection blocks closed with BLOCK_INCOMPLETE_SNAPSHOT', t => {
  const result = runRunner(t, 'api-failure');
  assert.notEqual(result.status, 0);
  assert.equal(result.report.success, false);
  assert.equal(result.report.mutated, false);
  assert.equal(result.report.decisionCode, 'BLOCK_INCOMPLETE_SNAPSHOT');
});

test('missing state branch fails closed with BLOCK_INCOMPLETE_SNAPSHOT', t => {
  const result = runRunner(t, 'missing-state-branch');
  assert.notEqual(result.status, 0);
  assert.equal(result.report.success, false);
  assert.equal(result.report.mutated, false);
  assert.equal(result.report.decisionCode, 'BLOCK_INCOMPLETE_SNAPSHOT');
  assert.match(result.report.reason, /autoloop-state|Claim state branch/i);
});

test('missing claims.json on state branch fails closed with BLOCK_INCOMPLETE_SNAPSHOT', t => {
  const result = runRunner(t, 'missing-claims-file');
  assert.notEqual(result.status, 0);
  assert.equal(result.report.success, false);
  assert.equal(result.report.mutated, false);
  assert.equal(result.report.decisionCode, 'BLOCK_INCOMPLETE_SNAPSHOT');
  assert.match(result.report.reason, /claims\.json/i);
});

test('absent JULES_API_KEY fails closed with BLOCK_INCOMPLETE_SNAPSHOT', t => {
  const result = runRunner(t, 'pass', { JULES_API_KEY: null });
  assert.notEqual(result.status, 0);
  assert.equal(result.report.success, false);
  assert.equal(result.report.mutated, false);
  assert.equal(result.report.decisionCode, 'BLOCK_INCOMPLETE_SNAPSHOT');
  assert.match(result.report.reason, /JULES_API_KEY/i);
});

test('provider session list failure fails closed with BLOCK_INCOMPLETE_SNAPSHOT', t => {
  const result = runRunner(t, 'sessions-failure');
  assert.notEqual(result.status, 0);
  assert.equal(result.report.success, false);
  assert.equal(result.report.mutated, false);
  assert.equal(result.report.decisionCode, 'BLOCK_INCOMPLETE_SNAPSHOT');
  assert.match(result.report.reason, /Jules API|provider sessions/i);
});

test('invalid configuration blocks before candidate selection', t => {
  const result = runRunner(t, 'invalid-config');
  assert.notEqual(result.status, 0);
  assert.equal(result.report.success, false);
  assert.equal(result.report.mutated, false);
  assert.equal(result.report.decisionCode, 'BLOCK_INVALID_CONFIG');
});

test('candidate with an open linked PR blocks selection', t => {
  const result = runRunner(t, 'open-pr');
  assert.notEqual(result.status, 0);
  assert.equal(result.report.success, false);
  assert.equal(result.report.mutated, false);
  assert.equal(result.report.decisionCode, 'WAIT_OPEN_PR');
});

test('candidate with an active claim blocks selection', t => {
  const result = runRunner(t, 'active-claim');
  assert.notEqual(result.status, 0);
  assert.equal(result.report.success, false);
  assert.equal(result.report.mutated, false);
  assert.equal(result.report.decisionCode, 'BLOCK_ACTIVE_CLAIM');
});

test('candidate with an expired unreconciled claim blocks selection', t => {
  const result = runRunner(t, 'expired-unreconciled-claim');
  assert.notEqual(result.status, 0);
  assert.equal(result.report.success, false);
  assert.equal(result.report.mutated, false);
  assert.equal(result.report.decisionCode, 'BLOCK_ACTIVE_CLAIM');
});

test('candidate with a RELEASED + RECONCILED claim is not blocked', t => {
  const result = runRunner(t, 'released-reconciled-claim');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.success, true);
  assert.equal(result.report.mutated, false);
  assert.equal(result.report.decisionCode, 'CANDIDATE_SELECTED');
  assert.equal(result.report.selectedCandidate.number, 1);
});

test('candidate with a RECLAIMED + RECONCILED claim is not blocked', t => {
  const result = runRunner(t, 'reclaimed-reconciled-claim');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.success, true);
  assert.equal(result.report.mutated, false);
  assert.equal(result.report.decisionCode, 'CANDIDATE_SELECTED');
  assert.equal(result.report.selectedCandidate.number, 1);
});
