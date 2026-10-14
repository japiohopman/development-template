import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateReviewRelay,
  isAcknowledgementComment,
  makeReviewEventKey,
  parseEscalationDirective
} from '../src/review-relay.mjs';

const repo = 'example/project';
const head = 'a'.repeat(40);
const oldHead = 'b'.repeat(40);
const trusted = ['trusted-reviewer', 'maintainer-bot'];
const pr = { number: 17, state: 'open', merged: false, draft: false, head: { sha: head } };
const checks = [{ name: 'Template validation', head_sha: head, status: 'completed', conclusion: 'success', id: 1 }];
const review = (id, user, state, commit_id = head, submitted_at = '2026-10-14T12:00:00Z', body = '') => ({
  id, user: { login: user }, state, commit_id, submitted_at, body
});
const existingWork = { verified: true, issueNumber: 12, pullRequestNumber: 17, claimId: 'claim-12-abc', sessionId: 'session-123' };

function evaluate(overrides = {}) {
  return evaluateReviewRelay({
    repositoryFullName: repo,
    pullRequest: pr,
    eventName: 'pull_request_review',
    eventAction: 'submitted',
    eventReview: review(501, 'trusted-reviewer', 'APPROVED'),
    reviews: [review(501, 'trusted-reviewer', 'APPROVED')],
    trustedReviewers: trusted,
    requiredChecks: ['Template validation'],
    checkRuns: checks,
    governingIssueNumber: 12,
    existingWork,
    ...overrides
  });
}

test('untrusted reviewer cannot approve or request a repair', () => {
  const result = evaluate({
    eventReview: review(1, 'random-user', 'CHANGES_REQUESTED'),
    reviews: [review(1, 'random-user', 'CHANGES_REQUESTED')]
  });
  assert.equal(result.decisionCode, 'IGNORED_UNTRUSTED_REVIEWER');
  assert.equal(result.requiresWrite, false);
});

test('approval is accepted only for the exact current head with current required checks', () => {
  const result = evaluate();
  assert.equal(result.decisionCode, 'APPROVED_CURRENT_HEAD');
  assert.equal(result.success, true);
  assert.equal(result.reviewedHeadSha, head);
  assert.deepEqual(result.checkEvidence.map(item => item.name), ['Template validation']);
});

test('approval blocks when required checks are missing, stale, or unsuccessful', () => {
  const stale = evaluate({ checkRuns: [{ ...checks[0], head_sha: oldHead }] });
  assert.equal(stale.decisionCode, 'BLOCK_REQUIRED_CHECKS');
  const failed = evaluate({ checkRuns: [{ ...checks[0], conclusion: 'failure' }] });
  assert.equal(failed.decisionCode, 'BLOCK_REQUIRED_CHECKS');
  const unconfigured = evaluate({ requiredChecks: [] });
  assert.equal(unconfigured.checksStatus, 'not_configured');
});

test('an approval from an older head is invalidated', () => {
  const result = evaluate({
    eventReview: review(77, 'trusted-reviewer', 'APPROVED', oldHead),
    reviews: [review(77, 'trusted-reviewer', 'APPROVED', oldHead)]
  });
  assert.equal(result.decisionCode, 'STALE_REVIEW_IGNORED');
});

test('head synchronization explicitly invalidates approvals for older SHAs', () => {
  const result = evaluate({ eventName: 'pull_request_target', eventAction: 'synchronize' });
  assert.equal(result.decisionCode, 'HEAD_CHANGED_REVIEW_REQUIRED');
  assert.equal(result.previousHeadInvalidated, true);
});

test('latest trusted changes-requested verdict routes to verified existing task, never a new session', () => {
  const request = review(700, 'trusted-reviewer', 'CHANGES_REQUESTED');
  const result = evaluate({ eventReview: request, reviews: [request] });
  assert.equal(result.decisionCode, 'REPAIR_HANDOFF_BLOCKED');
  assert.equal(result.requiresWrite, true);
  assert.equal(result.existingWorkVerified, true);
  assert.match(result.commentBody, /claim-12-abc/);
  assert.match(result.commentBody, /session-123/);
  assert.match(result.commentBody, /never creates a Jules session/i);
});

test('changes requested without unique verified existing context is blocked', () => {
  const request = review(701, 'trusted-reviewer', 'CHANGES_REQUESTED');
  const result = evaluate({ eventReview: request, reviews: [request], existingWork: null });
  assert.equal(result.decisionCode, 'BLOCK_REPAIR_CONTEXT_MISSING');
  assert.equal(result.requiresWrite, false);
});

test('duplicate review event is idempotently ignored when its stable key is already recorded', () => {
  const request = review(702, 'trusted-reviewer', 'CHANGES_REQUESTED');
  const key = makeReviewEventKey({
    repositoryFullName: repo, pullRequestNumber: 17, headSha: head,
    reviewId: request.id, updatedAt: request.submitted_at
  });
  const result = evaluate({ eventReview: request, reviews: [request], existingEventKeys: [key] });
  assert.equal(result.decisionCode, 'DUPLICATE_EVENT_IGNORED');
  assert.equal(result.requiresWrite, false);
});

test('only explicit escalation from a trusted reviewer is recorded', () => {
  assert.deepEqual(parseEscalationDirective('[autoloop:escalate] Needs human decision'), { reason: 'Needs human decision' });
  const untrusted = evaluate({
    eventName: 'issue_comment',
    eventComment: { id: 8, user: { login: 'random-user' }, body: '[autoloop:escalate] do it', created_at: '2026-10-14T12:00:00Z' }
  });
  assert.equal(untrusted.decisionCode, 'IGNORED_UNTRUSTED_ACTOR');
  const trustedResult = evaluate({
    eventName: 'issue_comment',
    eventComment: { id: 9, user: { login: 'trusted-reviewer' }, body: '[autoloop:escalate] Need a person to decide', created_at: '2026-10-14T12:00:00Z' }
  });
  assert.equal(trustedResult.decisionCode, 'ESCALATION_RECORDED');
  assert.match(trustedResult.commentBody, /Need a person to decide/);
  assert.match(trustedResult.commentBody, /No repair task is dispatched/i);
});

test('generic comments and emoji acknowledgements cannot advance the lifecycle', () => {
  assert.equal(isAcknowledgementComment('👀'), true);
  assert.equal(isAcknowledgementComment('Looks good.'), true);
  const result = evaluate({ eventName: 'issue_comment', eventComment: { user: { login: 'trusted-reviewer' }, body: '👀' } });
  assert.equal(result.decisionCode, 'ACKNOWLEDGEMENT_IGNORED');
  assert.equal(result.requiresWrite, false);
});

test('latest unresolved changes-requested review takes precedence over a same-head approval', () => {
  const request = review(800, 'maintainer-bot', 'CHANGES_REQUESTED', head, '2026-10-14T12:02:00Z');
  const approve = review(801, 'trusted-reviewer', 'APPROVED', head, '2026-10-14T12:03:00Z');
  const result = evaluate({ eventReview: approve, reviews: [request, approve] });
  assert.equal(result.decisionCode, 'REPAIR_HANDOFF_BLOCKED');
  assert.match(result.commentBody, /review:800/);
});

test('closed or malformed pull request context blocks closed', () => {
  assert.equal(evaluate({ pullRequest: { ...pr, state: 'closed' } }).decisionCode, 'BLOCK_INVALID_PR_CONTEXT');
  assert.equal(evaluate({ pullRequest: { ...pr, head: { sha: 'bad' } } }).decisionCode, 'BLOCK_INVALID_PR_CONTEXT');
});


test('a repaired PR needs explicit addressed and remaining findings before approval advances', () => {
  const previousRequest = review(810, 'trusted-reviewer', 'CHANGES_REQUESTED', oldHead, '2026-10-14T12:00:00Z', 'Please fix the contract.');
  const newApprovalMissingDisposition = review(811, 'trusted-reviewer', 'APPROVED', head, '2026-10-14T12:03:00Z', 'LGTM');
  const blocked = evaluate({ eventReview: newApprovalMissingDisposition, reviews: [previousRequest, newApprovalMissingDisposition] });
  assert.equal(blocked.decisionCode, 'BLOCK_REPAIR_DISPOSITION_MISSING');

  const newApproval = review(812, 'trusted-reviewer', 'APPROVED', head, '2026-10-14T12:04:00Z',
    'Findings addressed: Updated the contract validation and added regression coverage.\\nFindings remaining: None.');
  const approved = evaluate({ eventReview: newApproval, reviews: [previousRequest, newApproval] });
  assert.equal(approved.decisionCode, 'APPROVED_CURRENT_HEAD');
  assert.equal(approved.repairDisposition.findingsRemaining, 'None.');
  assert.deepEqual(approved.repairDisposition.priorChangeRequestedReviewIds, [810]);
});
