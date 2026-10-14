import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePullRequestGate, extractGoverningIssueNumber } from '../src/pr-gate.mjs';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const PARENT = 'c'.repeat(40);
const TREE_HEAD = 'd'.repeat(40);
const TREE_PARENT = 'e'.repeat(40);
const repo = 'example/project';
const changedPath = 'src/pr-gate.mjs';
const issueBody = [
  '## Scope', 'Implement the exact-head PR gate.',
  '## Acceptance criteria', '- The gate blocks stale evidence.',
  '## Dependencies', 'Issue #6 is complete.',
  '## Out of scope', 'Live dispatch and automatic merge.',
  '## Validation plan', 'Run npm test and workflow security checks.'
].join('\n');

function makeBody(overrides = {}) {
  const values = {
    summary: 'Adds a read-only PR contract gate.',
    changedPaths: [changedPath],
    criterion: 'The gate rejects stale head evidence.',
    evidence: 'tests/pr-gate.test.mjs covers a mismatched head SHA.',
    security: 'Read-only metadata; trusted base-branch code only.',
    blockers: 'None known.',
    recovery: 'Disable the copied workflow; it writes no state.',
    reviewer: 'First review pass; no earlier findings.',
    owner: 'Maintainer: review this exact head SHA.',
    commands: 'npm test — passed for this commit.',
    checkText: 'Template validation — success for current HEAD.'
  };
  Object.assign(values, overrides);
  return [
    '## Governing Issue', 'Closes #12', '',
    '## Summary', values.summary, '',
    '## Scope boundary', 'Adds PR evidence checks only; no dispatch, scheduling, or merge.', '',
    '## Acceptance criteria evidence',
    '- [x] Criterion: ' + values.criterion,
    '  - Evidence: ' + values.evidence, '',
    '## Verification',
    '- Changed paths:',
    ...values.changedPaths.map(path => '  - ' + path),
    '- Commands/checks run: ' + values.commands,
    '- Exact head SHA verified: ' + HEAD,
    '- Check results for that SHA: ' + values.checkText, '',
    '## Risks and blockers',
    '- Security/permissions impact: ' + values.security,
    '- Known blockers: ' + values.blockers,
    '- Recovery or rollback: ' + values.recovery, '',
    '## Handoff',
    '- Latest reviewer instructions addressed: ' + values.reviewer,
    '- Next action and owner: ' + values.owner,
    '- [x] No-op commit check completed'
  ].join('\n');
}
function input(overrides = {}) {
  return {
    repositoryFullName: repo,
    pullRequest: {
      number: 17, state: 'open', merged: false, body: makeBody(),
      base: { sha: BASE, repo: { full_name: repo } },
      head: { sha: HEAD, repo: { full_name: repo } }
    },
    eventHeadSha: HEAD,
    confirmedCurrentHeadSha: HEAD,
    issue: { number: 12, state: 'open', body: issueBody },
    requiredIssueSections: ['Scope', 'Acceptance criteria', 'Dependencies', 'Out of scope', 'Validation plan'],
    requiredChecks: ['Template validation'],
    changedFiles: [{ filename: changedPath }],
    checkRuns: [{ id: 1, name: 'Template validation', status: 'completed', conclusion: 'success', head_sha: HEAD, completed_at: '2026-10-14T10:00:00Z' }],
    headCommit: { sha: HEAD, commit: { tree: { sha: TREE_HEAD } }, parents: [{ sha: PARENT }] },
    parentCommit: { sha: PARENT, commit: { tree: { sha: TREE_PARENT } } },
    ...overrides
  };
}

test('complete handoff passes while human approval remains a separate step', () => {
  const result = evaluatePullRequestGate(input());
  assert.equal(result.success, true);
  assert.equal(result.contractStatus, 'passed');
  assert.equal(result.ciStatus, 'passed');
  assert.equal(result.humanApproval.status, 'separate_human_step');
  assert.equal(result.humanApproval.approved, false);
  assert.equal(result.mutated, false);
});
test('an outdated event head cannot pass', () => {
  const result = evaluatePullRequestGate(input({ eventHeadSha: BASE }));
  assert.ok(result.blockers.some(item => item.code === 'EVENT_HEAD_SHA_STALE'));
});
test('a head that changes during evidence collection cannot pass', () => {
  const result = evaluatePullRequestGate(input({ confirmedCurrentHeadSha: BASE }));
  assert.ok(result.blockers.some(item => item.code === 'HEAD_CHANGED_DURING_GATE'));
});
test('a stale SHA in the PR body cannot pass', () => {
  const scenario = input();
  scenario.pullRequest.body = scenario.pullRequest.body.replace(HEAD, BASE);
  const result = evaluatePullRequestGate(scenario);
  assert.ok(result.blockers.some(item => item.code === 'VERIFICATION_SHA_MISMATCH'));
});
test('an empty required-check list is not successful CI', () => {
  const result = evaluatePullRequestGate(input({ requiredChecks: [] }));
  assert.equal(result.ciStatus, 'not_configured');
  assert.ok(result.blockers.some(item => item.code === 'REQUIRED_CHECKS_NOT_CONFIGURED'));
});
test('a passing check from an older SHA cannot satisfy a required check', () => {
  const result = evaluatePullRequestGate(input({
    checkRuns: [{ name: 'Template validation', status: 'completed', conclusion: 'success', head_sha: BASE }]
  }));
  assert.ok(result.blockers.some(item => item.code === 'REQUIRED_CHECK_MISSING_FOR_HEAD'));
});
test('a failed check for the current SHA blocks the gate', () => {
  const result = evaluatePullRequestGate(input({
    checkRuns: [{ name: 'Template validation', status: 'completed', conclusion: 'failure', head_sha: HEAD }]
  }));
  assert.ok(result.blockers.some(item => item.code === 'REQUIRED_CHECK_FAILED'));
});
test('changed-path evidence must match GitHub exactly', () => {
  const scenario = input();
  scenario.pullRequest.body = scenario.pullRequest.body.replace(changedPath, 'src/other-file.mjs');
  const result = evaluatePullRequestGate(scenario);
  assert.ok(result.blockers.some(item => item.code === 'CHANGED_PATH_EVIDENCE_MISMATCH'));
});
test('missing changed-path evidence blocks the gate', () => {
  const scenario = input();
  scenario.pullRequest.body = scenario.pullRequest.body.replace('  - ' + changedPath, '');
  const result = evaluatePullRequestGate(scenario);
  assert.ok(result.blockers.some(item => item.code === 'CHANGED_PATH_EVIDENCE_MISSING'));
});
test('an empty changed-file response is not proof of success', () => {
  const result = evaluatePullRequestGate(input({ changedFiles: [] }));
  assert.ok(result.blockers.some(item => item.code === 'CHANGED_FILES_UNAVAILABLE_OR_EMPTY'));
});
test('a no-op latest commit cannot pass', () => {
  const scenario = input();
  scenario.parentCommit.commit.tree.sha = TREE_HEAD;
  const result = evaluatePullRequestGate(scenario);
  assert.ok(result.blockers.some(item => item.code === 'NO_OP_HEAD_COMMIT'));
});
test('a governing URL to a different repository is blocked', () => {
  const scenario = input();
  scenario.pullRequest.body = scenario.pullRequest.body.replace('Closes #12', 'https://github.com/other/project/issues/12');
  const result = evaluatePullRequestGate(scenario);
  assert.ok(result.blockers.some(item => item.code === 'GOVERNING_ISSUE_WRONG_REPOSITORY'));
});
test('a closed governing Issue is blocked', () => {
  const result = evaluatePullRequestGate(input({ issue: { number: 12, state: 'closed', body: issueBody } }));
  assert.ok(result.blockers.some(item => item.code === 'GOVERNING_ISSUE_NOT_OPEN'));
});
test('an unchecked acceptance criterion blocks the handoff', () => {
  const scenario = input();
  scenario.pullRequest.body = scenario.pullRequest.body.replace('[x] Criterion:', '[ ] Criterion:');
  const result = evaluatePullRequestGate(scenario);
  assert.ok(result.blockers.some(item => item.code === 'ACCEPTANCE_CRITERION_NOT_CONFIRMED'));
});
test('empty acceptance evidence blocks the handoff', () => {
  const scenario = input();
  scenario.pullRequest.body = scenario.pullRequest.body.replace('Evidence: tests/pr-gate.test.mjs covers a mismatched head SHA.', 'Evidence:');
  const result = evaluatePullRequestGate(scenario);
  assert.ok(result.blockers.some(item => item.code === 'ACCEPTANCE_CRITERION_EVIDENCE_EMPTY'));
});
test('placeholder summary and missing next owner block the handoff', () => {
  const scenario = input();
  scenario.pullRequest.body = scenario.pullRequest.body
    .replace('Adds a read-only PR contract gate.', 'What changed and why?')
    .replace('Maintainer: review this exact head SHA.', '');
  const result = evaluatePullRequestGate(scenario);
  assert.ok(result.blockers.some(item => item.code === 'PR_SUMMARY_EMPTY'));
  assert.ok(result.blockers.some(item => item.code === 'NEXT_ACTION_OWNER_MISSING'));
});
test('a failed Issue lookup is not treated as an empty work queue', () => {
  const result = evaluatePullRequestGate(input({ issue: null, issueFetchError: '404' }));
  assert.ok(result.blockers.some(item => item.code === 'GOVERNING_ISSUE_LOOKUP_FAILED'));
});
test('reports are read-only, actionable, and deterministically sorted', () => {
  const result = evaluatePullRequestGate(input({ requiredChecks: [] }));
  assert.equal(result.mutated, false);
  assert.match(result.nextAction, /Resolve the listed blockers/);
  assert.deepEqual(result.blockers, result.blockers.slice().sort((a, b) =>
    a.category < b.category ? -1 : a.category > b.category ? 1 :
    a.code < b.code ? -1 : a.code > b.code ? 1 :
    a.message < b.message ? -1 : a.message > b.message ? 1 : 0
  ));
});
test('a governing Issue section must identify exactly one Issue', () => {
  assert.deepEqual(extractGoverningIssueNumber('## Governing Issue\nCloses #12 and #13', repo), {
    number: null, error: 'GOVERNING_ISSUE_REFERENCE_AMBIGUOUS', details: [12, 13]
  });
});
