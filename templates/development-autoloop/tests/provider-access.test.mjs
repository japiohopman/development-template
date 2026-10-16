import test from 'node:test';
import assert from 'node:assert/strict';
import { repairPilotReady, shouldExposeProviderAccess } from '../scripts/provider-access.mjs';

const oldHead = 'b'.repeat(40);
const currentHead = 'a'.repeat(40);
const readyConfig = {
  enabled: true,
  runMode: 'live',
  repairDispatchEnabled: true,
  repairPilotApproved: true,
  humanReadinessRequired: true,
  automaticMerge: false,
  scheduleEnabled: false,
  trustedReviewers: ['trusted-reviewer']
};
const pr = { number: 17, state: 'open', merged: false, head: { sha: currentHead } };
const priorReview = {
  id: 700,
  user: { login: 'trusted-reviewer' },
  state: 'CHANGES_REQUESTED',
  commit_id: oldHead,
  submitted_at: '2026-10-16T08:00:00Z'
};
const attemptComment = {
  id: 901,
  body: '<!-- review-relay:v1:example/project:pr:17:head:' + oldHead + ':review:700:version:2026-10-16T08:00:00Z -->\n\n**Repair continuation attempt:** Recorded before contacting the existing provider session.'
};

test('pilot readiness requires every explicit safety gate', () => {
  assert.equal(repairPilotReady(readyConfig), true);
  for (const key of ['enabled', 'repairDispatchEnabled', 'repairPilotApproved', 'humanReadinessRequired']) {
    assert.equal(repairPilotReady({ ...readyConfig, [key]: false }), false, key + ' must block');
  }
  assert.equal(repairPilotReady({ ...readyConfig, runMode: 'dry-run' }), false);
  assert.equal(repairPilotReady({ ...readyConfig, automaticMerge: true }), false);
  assert.equal(repairPilotReady({ ...readyConfig, scheduleEnabled: true }), false);
});

test('head synchronization exposes provider access only for a trusted prior repair attempt and a new head', () => {
  const args = {
    eventName: 'pull_request_target',
    event: { action: 'synchronize' },
    config: readyConfig,
    pullRequest: pr,
    reviews: [priorReview],
    comments: [attemptComment]
  };
  assert.equal(shouldExposeProviderAccess(args), true);
  assert.equal(shouldExposeProviderAccess({ ...args, comments: [] }), false);
  assert.equal(shouldExposeProviderAccess({ ...args, reviews: [] }), false);
  assert.equal(shouldExposeProviderAccess({ ...args, pullRequest: { ...pr, head: { sha: oldHead } } }), false);
});

test('an arbitrary reviewer cannot authorize provider access for a prior repair attempt', () => {
  const args = {
    eventName: 'pull_request_target',
    event: { action: 'synchronize' },
    config: readyConfig,
    pullRequest: pr,
    reviews: [{ ...priorReview, user: { login: 'untrusted-user' } }],
    comments: [attemptComment]
  };
  assert.equal(shouldExposeProviderAccess(args), false);
});

test('head synchronization never exposes provider access when any readiness gate is absent', () => {
  const args = {
    eventName: 'pull_request_target',
    event: { action: 'synchronize' },
    config: { ...readyConfig, repairPilotApproved: false },
    pullRequest: pr,
    reviews: [priorReview],
    comments: [attemptComment]
  };
  assert.equal(shouldExposeProviderAccess(args), false);
});

test('observer bridge exposes provider access only for a trusted changes-requested review on current head', () => {
  const currentReview = { ...priorReview, id: 701, commit_id: currentHead };
  const args = {
    eventName: 'workflow_run',
    event: { workflow_run: { name: 'Observe PR review event (unprivileged)' } },
    config: readyConfig,
    pullRequest: pr,
    reviews: [currentReview]
  };
  assert.equal(shouldExposeProviderAccess(args), true);
  assert.equal(shouldExposeProviderAccess({ ...args, reviews: [priorReview] }), false);
  assert.equal(shouldExposeProviderAccess({ ...args, event: { workflow_run: { name: 'other workflow' } } }), false);
});

test('manual retry requires the exact command and a trusted actor', () => {
  const args = {
    eventName: 'issue_comment',
    event: { issue: { pull_request: {} }, comment: { body: '[autoloop:relay-review]', user: { login: 'trusted-reviewer' } } },
    config: readyConfig,
    pullRequest: pr,
    reviews: [{ ...priorReview, commit_id: currentHead }]
  };
  assert.equal(shouldExposeProviderAccess(args), true);
  assert.equal(shouldExposeProviderAccess({ ...args, event: { ...args.event, comment: { ...args.event.comment, body: 'please [autoloop:relay-review]' } } }), false);
  assert.equal(shouldExposeProviderAccess({ ...args, event: { ...args.event, comment: { ...args.event.comment, user: { login: 'untrusted-user' } } } }), false);
});


test('trusted approval exposes provider access only when a prior repair attempt needs reconciliation', () => {
  const currentApproval = { ...priorReview, id: 701, state: 'APPROVED', commit_id: currentHead };
  const args = {
    eventName: 'workflow_run',
    event: { workflow_run: { name: 'Observe PR review event (unprivileged)' } },
    config: readyConfig,
    pullRequest: pr,
    reviews: [priorReview, currentApproval],
    comments: [attemptComment]
  };
  assert.equal(shouldExposeProviderAccess(args), true);
  assert.equal(shouldExposeProviderAccess({ ...args, comments: [] }), false);
  assert.equal(shouldExposeProviderAccess({ ...args, reviews: [currentApproval] }), false);
});
