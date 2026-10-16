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
const claim = {
  schemaVersion: 1, claimId: 'claim-12-test', repository: { owner: 'example', repo: 'project' },
  issueNumber: 12, owner: 'autoloop', provider: 'jules', sessionId: 'session-1',
  createdAt: '2026-10-13T00:00:00Z', expiresAt: '2026-10-13T01:00:00Z',
  status: 'ACTIVE', reconciliationStatus: 'PENDING', updatedAt: '2026-10-13T00:00:00Z'
};
const source = { name: 'sources/github/example/project', githubRepo: { owner: 'example', repo: 'project' } };
const session = {
  id: 'session-1', title: 'Task [claimId: claim-12-test]', state: 'IN_PROGRESS', issueNumber: 12,
  sourceContext: { source: source.name, githubRepoContext: { startingBranch: 'main' } },
  outputs: [{ pullRequest: { url: 'https://github.com/example/project/pull/17' } }]
};

function mockSource(scenario, writesPath) {
  return [
    "import { appendFileSync } from 'node:fs';",
    'const scenario = ' + JSON.stringify(scenario) + ';',
    'const writesPath = ' + JSON.stringify(writesPath) + ';',
    'const pullRequest = ' + JSON.stringify(pr) + ';',
    'const trustedReview = ' + JSON.stringify(trustedReview) + ';',
    'const check = ' + JSON.stringify(check) + ';',
    'const claim = ' + JSON.stringify(claim) + ';',
    'const source = ' + JSON.stringify(source) + ';',
    'const session = ' + JSON.stringify({ ...session, state: ['repair-dispatch-completed', 'repair-dispatch-duplicate-completed'].includes(scenario) ? 'COMPLETED' : scenario === 'repair-dispatch-failed' ? 'FAILED' : 'IN_PROGRESS' }) + ';',
    "const repair = scenario.startsWith('repair-');",
    "const verdict = repair ? { ...trustedReview, state: 'CHANGES_REQUESTED' } : trustedReview;",
    "const comment = { ...trustedReview, id: 502, state: 'COMMENTED', submitted_at: '2026-10-14T12:01:00Z', body: scenario === 'escalation-review' ? '[autoloop:escalate] Need a human decision.' : 'Thanks.' };",
    'let prReads = 0;',
    "function response(payload, status = 200) { return { ok: status >= 200 && status < 300, status, json: async () => payload }; }",
    'globalThis.fetch = async (input, options = {}) => {',
    '  const url = new URL(String(input));',
    "  if (options.method && options.method !== 'GET') appendFileSync(writesPath, JSON.stringify({ path: url.pathname, method: options.method, body: JSON.parse(options.body) }) + '\\n');",
    "  if (url.hostname === 'jules.googleapis.com') {",
    "    if (!repair) throw new Error('Unexpected provider call.');",
    "    if (url.pathname === '/v1alpha/sources') return response({ sources: [source] });",
    "    if (url.pathname === '/v1alpha/' + source.name) return response(source);",
    "    if (url.pathname === '/v1alpha/sessions') return response({ sessions: [session] });",
    "    if (url.pathname === '/v1alpha/sessions/session-1' && (!options.method || options.method === 'GET')) return response(session);",
    "    if (url.pathname === '/v1alpha/sessions/session-1:sendMessage' && options.method === 'POST' && scenario === 'repair-dispatch-timeout') throw new Error('mock timeout after send attempt');",
    "    if (url.pathname === '/v1alpha/sessions/session-1:sendMessage' && options.method === 'POST' && scenario === 'repair-dispatch-enabled') return response({ accepted: true });",
    "    throw new Error('Unexpected provider path.');",
    '  }',
    "  if (url.hostname !== 'api.github.com') throw new Error('Unexpected host.');",
    "  const path = url.pathname.replace('/repos/example/project', '');",
    "  if (path === '/check-runs' && options.method === 'POST') return response({ id: 909 }, 201);",
    "  if (/^\\/check-runs\\/\\d+$/.test(path) && options.method === 'PATCH') return response({ id: Number(path.split('/').pop()) });",
    "  if (path === '/issues/17/comments' && options.method === 'POST') return response({ id: 910 }, 201);",
    "  if (options.method && options.method !== 'GET') throw new Error('Unexpected write in mocked approval path: ' + options.method + ' ' + path);",
    "  if (path === '/pulls/17') {",
    '    prReads += 1;',
    "    if (prReads > 1 && scenario === 'repair-lookup-failed') return response({}, 503);",
    "    if (prReads > 1 && scenario === 'repair-identity-unverified') return response({ ...pullRequest, number: 18 });",
    "    if (prReads > 1 && scenario === 'repair-issue-link-missing') return response({ ...pullRequest, body: 'No Issue link.' });",
    '    return response(pullRequest);',
    '  }',
    "  if (path === '/pulls/17/reviews') {",
    "    if (scenario === 'no-review') return response([]);",
    "    if (scenario === 'dismissed-review') return response([{ ...trustedReview, state: 'DISMISSED' }]);",
    "    if (scenario === 'comment-only') return response([comment]);",
    "    return response(scenario.endsWith('-comment') || scenario === 'escalation-review' ? [verdict, comment] : [verdict]);",
    '  }',
    "  if (path.startsWith('/commits/') && path.endsWith('/check-runs') && url.searchParams.get('check_name')) return response({ check_runs: scenario === 'existing-check' ? [{ id: 888, name: 'Autoloop trusted review relay', external_id: 'autoloop-review-relay:example/project:pr:17', head_sha: pullRequest.head.sha }] : [] });",
    "  if (path.startsWith('/commits/') && path.endsWith('/check-runs')) return response({ check_runs: [scenario === 'failed-check' ? { ...check, conclusion: 'failure' } : check] });",
    "  if (path === '/issues/17/comments' && scenario === 'repair-attempt-head-sync') return response([{ id: 777, body: '<!-- review-relay:v1:example/project:pr:17:head:' + 'b'.repeat(40) + ':review:700:version:2026-10-14T12:00:00Z -->\\n**Repair continuation attempt:** previously recorded' }]);",
    "  if (path === '/issues/17/comments') return response(['repair-duplicate', 'repair-dispatch-duplicate', 'repair-dispatch-duplicate-completed'].includes(scenario) ? [{ body: '<!-- review-relay:v1:example/project:pr:17:head:' + pullRequest.head.sha + ':review:501:version:' + trustedReview.submitted_at + ' -->' + (scenario.startsWith('repair-dispatch-duplicate') ? '\\n**Repair continuation attempt:** previously recorded' : '') }] : []);",
    "  if (path === '/git/ref/heads/autoloop-state') return response({ object: { sha: 'c'.repeat(40) } });",
    "  if (path === '/contents/claims.json') return response({ encoding: 'base64', content: Buffer.from(JSON.stringify({ claims: [claim] })).toString('base64') });",
    "  if (path === '/branches/main') return response({ name: 'main' });",
    "  if (path === '/issues/12') return response({ number: 12, state: 'open' });",
    "  if (path === '/pulls/17/files') return response([{ filename: 'src/example.mjs' }]);",
    "  if (path === '/commits/' + pullRequest.head.sha) return response({ parents: [{ sha: 'b'.repeat(40) }], commit: { tree: { sha: 'd'.repeat(40) } } });",
    "  if (path === '/commits/' + 'b'.repeat(40)) return response({ commit: { tree: { sha: 'e'.repeat(40) } } });",
    "  return response({ message: 'Not Found' }, 404);",
    '};'
  ].join('\n');
}

function runRelay(t, scenario, commentActor = 'trusted-reviewer', trigger = 'issue_comment', overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'review-relay-runner-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = JSON.parse(readFileSync(join(templateRoot, 'config/autoloop.example.json'), 'utf8'));
  config.trustedReviewers = ['trusted-reviewer'];
  config.requiredChecks = ['Template validation'];
  config.workProvider = 'jules';
  if (scenario.startsWith('repair-dispatch-') && scenario !== 'repair-dispatch-duplicate') {
    config.enabled = true;
    config.runMode = 'live';
    config.repairDispatchEnabled = true;
    config.repairPilotApproved = true;
    config.humanReadinessRequired = true;
    config.automaticMerge = false;
    config.scheduleEnabled = false;
  }
  const configPath = join(directory, 'autoloop.json');
  const eventPath = join(directory, 'event.json');
  const preloadPath = join(directory, 'mock-fetch.mjs');
  const writesPath = join(directory, 'writes.jsonl');
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
    : trigger === 'pull_request_target'
      ? { action: 'synchronize', repository: { full_name: 'example/project' }, pull_request: pr }
      : {
        action: 'created',
        repository: { full_name: 'example/project' },
        issue: { number: 17, pull_request: { url: 'https://api.github.com/repos/example/project/pulls/17' } },
        comment: {
          id: 901, user: { login: commentActor }, body: '[autoloop:relay-review]',
          created_at: '2026-10-14T12:30:00Z'
        }
      };
  Object.assign(event, overrides);
  writeFileSync(configPath, JSON.stringify(config));
  writeFileSync(eventPath, JSON.stringify(event));
  writeFileSync(writesPath, '');
  writeFileSync(preloadPath, mockSource(scenario, writesPath));
  const result = spawnSync(process.execPath, ['--import', preloadPath, 'scripts/review-relay.mjs'], {
    cwd: templateRoot, encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_REPOSITORY: 'example/project',
      GITHUB_TOKEN: 'mock-token-not-a-real-secret',
      GITHUB_EVENT_NAME: trigger,
      GITHUB_EVENT_ACTION: event.action,
      GITHUB_EVENT_PATH: eventPath,
      AUTOLOOP_CONFIG_PATH: configPath,
      AUTOLOOP_STATE_BRANCH: 'autoloop-state',
      JULES_API_KEY: 'mock-provider-key-not-a-real-secret',
      GITHUB_STEP_SUMMARY: ''
    }
  });
  const start = result.stdout.indexOf('{');
  assert.notEqual(start, -1, 'runner should return JSON; stdout: ' + result.stdout + '; stderr: ' + result.stderr);
  const writes = readFileSync(writesPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { ...result, report: JSON.parse(result.stdout.slice(start).trim()), writes };
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

for (const action of ['opened', 'reopened', 'edited', 'ready_for_review']) {
  test('PR metadata event ' + action + ' cannot overwrite an existing approval check', t => {
    const result = runRelay(t, 'existing-check', 'trusted-reviewer', 'pull_request_target', { action });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.report.decisionCode, 'WAITING_FOR_TRUSTED_REVIEW');
    assert.equal(result.report.mutated, false);
    assert.deepEqual(result.writes, []);
  });
}

for (const [actor, body, expected] of [
  ['trusted-reviewer', 'Thanks.', 'ACKNOWLEDGEMENT_IGNORED'],
  ['untrusted-user', '[autoloop:escalate] Change the check.', 'IGNORED_UNTRUSTED_ACTOR']
]) {
  test(expected + ' cannot write a relay check or audit comment', t => {
    const result = runRelay(t, 'existing-check', actor, 'issue_comment', {
      comment: { id: 901, user: { login: actor }, body, created_at: '2026-10-14T12:30:00Z' }
    });
    assert.equal(result.report.decisionCode, expected);
    assert.equal(result.report.mutated, false);
    assert.deepEqual(result.writes, []);
  });
}

test('head synchronization invalidates the check and reports current-head evidence', t => {
  const result = runRelay(t, 'existing-check', 'trusted-reviewer', 'pull_request_target');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.decisionCode, 'HEAD_CHANGED_REVIEW_REQUIRED');
  assert.equal(result.report.checkConclusion, 'action_required');
  assert.equal(result.report.repairEvidence.currentHeadSha, head);
  assert.equal(result.report.repairEvidence.previousHeadTreeChanged, true);
  assert.equal(result.writes.length, 1);
  assert.equal(result.writes[0].method, 'PATCH');
});

test('new PR head links a prior repair attempt but never assumes provider success', t => {
  const result = runRelay(t, 'repair-attempt-head-sync', 'trusted-reviewer', 'pull_request_target');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.decisionCode, 'HEAD_CHANGED_REVIEW_REQUIRED');
  assert.equal(result.report.checkConclusion, 'action_required');
  assert.equal(result.report.repairEvidence.status, 'REPAIR_HEAD_ADVANCED_AWAITING_RECONCILIATION');
  assert.equal(result.report.repairEvidence.priorRepairAttempts.length, 1);
  assert.equal(result.report.repairEvidence.priorRepairAttempts[0].reviewedHeadSha, 'b'.repeat(40));
  assert.equal(result.report.repairEvidence.priorRepairAttempts[0].providerOutcome, 'UNRECONCILED');
  assert.equal(result.report.repairEvidence.priorRepairAttempts[0].reviewId, '700');
  assert.equal(result.writes.length, 1);
  assert.equal(result.writes[0].method, 'PATCH');
});

test('a trusted escalation writes its audit comment and a blocked check', t => {
  const result = runRelay(t, 'existing-check', 'trusted-reviewer', 'issue_comment', {
    comment: {
      id: 901, user: { login: 'trusted-reviewer' }, body: '[autoloop:escalate] Need a human decision.',
      created_at: '2026-10-14T12:30:00Z'
    }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.decisionCode, 'ESCALATION_RECORDED');
  assert.equal(result.report.checkConclusion, 'action_required');
  assert.deepEqual(result.writes.map(write => write.path), [
    '/repos/example/project/issues/17/comments', '/repos/example/project/check-runs/888'
  ]);
});

for (const trigger of ['workflow_run', 'issue_comment']) {
  test(trigger + ' selects the latest verdict despite a newer COMMENTED review', t => {
    const result = runRelay(t, 'approval-comment', 'trusted-reviewer', trigger);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.report.decisionCode, 'APPROVED_CURRENT_HEAD');
    assert.equal(result.report.checkConclusion, 'success');
  });

  test(trigger + ' preserves changes requested followed by a COMMENTED review', t => {
    const result = runRelay(t, 'repair-comment', 'trusted-reviewer', trigger);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.report.decisionCode, 'REPAIR_HANDOFF_BLOCKED');
    assert.equal(result.report.existingWorkVerified, true);
    assert.equal(result.report.reviewId, trustedReview.id);
    assert.equal(result.report.checkConclusion, 'action_required');
    assert.equal(result.writes.length, 2);
    assert.match(result.writes[0].body.body, /claim-12-test/);
  });
}

test('a COMMENTED review with an explicit escalation remains eligible', t => {
  const result = runRelay(t, 'escalation-review', 'trusted-reviewer', 'workflow_run');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.decisionCode, 'ESCALATION_RECORDED');
  assert.equal(result.report.checkConclusion, 'action_required');
  assert.equal(result.writes.length, 2);
  assert.match(result.writes[0].body.body, /Trusted review ID: 502/);
});

test('ordinary COMMENTED reviews alone do not supply a verdict', t => {
  const result = runRelay(t, 'comment-only', 'trusted-reviewer', 'workflow_run');
  assert.equal(result.report.decisionCode, 'WAITING_FOR_TRUSTED_REVIEW');
  assert.equal(result.report.checkConclusion, 'action_required');
  assert.equal(result.writes.length, 1);
});

for (const scenario of ['repair-lookup-failed', 'repair-identity-unverified', 'repair-issue-link-missing']) {
  test(scenario + ' cannot verify existing work from identifiers alone', t => {
    const result = runRelay(t, scenario, 'trusted-reviewer', 'workflow_run');
    assert.equal(result.status, 1);
    assert.equal(result.report.decisionCode, 'BLOCK_REPAIR_CONTEXT_MISSING');
    assert.equal(result.report.reconciliationDecision, 'RECONCILIATION_BLOCKED');
    assert.equal(result.report.mutated, false);
    assert.deepEqual(result.writes, []);
  });
}

test('a duplicate changes-requested event preserves its audit marker without a new handoff', t => {
  const result = runRelay(t, 'repair-duplicate', 'trusted-reviewer', 'workflow_run');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.decisionCode, 'DUPLICATE_EVENT_IGNORED');
  assert.equal(result.writes.length, 1);
  assert.equal(result.writes[0].path, '/repos/example/project/check-runs');
});


test('enabled repair continuation sends one follow-up to the verified existing session and stays action-required', t => {
  const result = runRelay(t, 'repair-dispatch-enabled', 'trusted-reviewer', 'workflow_run');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.report.decisionCode, 'REPAIR_MESSAGE_ACCEPTED_AWAITING_RECONCILIATION');
  assert.equal(result.report.providerMessageAccepted, true);
  assert.equal(result.report.checkConclusion, 'action_required');
  assert.equal(result.report.success, false);
  assert.equal(result.writes.filter(write => write.path === '/v1alpha/sessions/session-1:sendMessage').length, 1);
  assert.equal(result.writes.filter(write => write.path === '/v1alpha/sessions').length, 0);
  assert.equal(result.writes.filter(write => write.path === '/repos/example/project/issues/17/comments').length, 1);
});

test('repair continuation stays blocked by default and never sends a provider message', t => {
  const result = runRelay(t, 'repair-comment', 'trusted-reviewer', 'workflow_run');
  assert.equal(result.report.decisionCode, 'REPAIR_HANDOFF_BLOCKED');
  assert.equal(result.report.continuationGate.allowed, false);
  assert.ok(result.report.continuationGate.failedGates.includes('enabled'));
  assert.equal(result.writes.some(write => String(write.path).includes(':sendMessage')), false);
});


test('a repeated repair event reconciles the existing active session without sending again', t => {
  const result = runRelay(t, 'repair-dispatch-duplicate', 'trusted-reviewer', 'workflow_run');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.report.decisionCode, 'REPAIR_PROVIDER_STILL_ACTIVE');
  assert.equal(result.report.providerState, 'ACTIVE');
  assert.equal(result.writes.some(write => String(write.path).includes(':sendMessage')), false);
});

test('a completed session with no new PR head is not reported as a successful repair', t => {
  const result = runRelay(t, 'repair-dispatch-duplicate-completed', 'trusted-reviewer', 'workflow_run');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.report.decisionCode, 'BLOCK_REPAIR_COMPLETED_WITHOUT_NEW_HEAD');
  assert.equal(result.report.success, false);
});


test('an uncertain provider send is recorded and never blindly retried', t => {
  const result = runRelay(t, 'repair-dispatch-timeout', 'trusted-reviewer', 'workflow_run');
  assert.equal(result.status, 1);
  assert.equal(result.report.decisionCode, 'BLOCK_REPAIR_MESSAGE_OUTCOME_UNKNOWN');
  assert.equal(result.writes.filter(write => write.path === '/v1alpha/sessions/session-1:sendMessage').length, 1);
  assert.equal(result.writes.filter(write => write.path === '/repos/example/project/issues/17/comments').length, 1);
});
