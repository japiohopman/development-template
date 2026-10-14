import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateConfig } from '../src/config.mjs';
import { normalizeRepositoryIdentity, validateClaimRecord } from '../src/claims.mjs';
import { reconcileSessionLifecycle } from '../src/reconciliation.mjs';
import { extractGoverningIssueNumber } from '../src/pr-gate.mjs';
import { JulesClient } from '../src/jules.mjs';
import { evaluateReviewRelay } from '../src/review-relay.mjs';

const repositoryValue = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
const eventName = process.env.GITHUB_EVENT_NAME || '';
const eventAction = process.env.GITHUB_EVENT_ACTION || '';
const eventPath = process.env.GITHUB_EVENT_PATH;
const julesApiKey = process.env.JULES_API_KEY;
const stateBranch = process.env.AUTOLOOP_STATE_BRANCH || 'autoloop-state';
const configPath = resolve(process.env.AUTOLOOP_CONFIG_PATH || 'config/autoloop.json');

function emit(report) {
  console.log(JSON.stringify(report, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      '## Development Autoloop review relay\n\n- Decision: ' + report.decisionCode + '\n- PR: #' + (report.pullRequestNumber ?? 'unknown')
      + '\n- Head SHA: ' + (report.headSha || 'unknown') + '\n- State changed: ' + String(report.mutated === true)
      + '\n\n' + (report.reason || 'No additional details.') + '\n\nNext action: ' + (report.nextAction || 'Inspect the JSON report.') + '\n');
  }
}

function fail(decisionCode, reason, nextAction, details = {}) {
  emit({ success: false, mutated: false, requiresWrite: false, decisionCode, reason, nextAction, ...details });
  process.exitCode = 1;
}
function isSha(value) { return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value); }

async function run() {
  if (!repositoryValue || !token || !eventPath) {
    fail('BLOCK_CONFIGURATION_ERROR', 'Required GitHub event context or token is missing.',
      'Run this workflow from a GitHub Actions event with the documented permissions.');
    return;
  }
  const parsedRepo = normalizeRepositoryIdentity(repositoryValue);
  if (!parsedRepo.valid) {
    fail('BLOCK_REPOSITORY_INVALID', 'GITHUB_REPOSITORY is missing or malformed.',
      'Run this workflow from the intended owner/repository context.');
    return;
  }
  const repo = parsedRepo.repository;
  let event;
  let rawConfig;
  try {
    event = JSON.parse(readFileSync(eventPath, 'utf8'));
    rawConfig = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    fail('BLOCK_INPUT_INVALID', 'The GitHub event payload or Autoloop configuration could not be read as JSON.',
      'Verify the workflow inputs and config/autoloop.json, then rerun.');
    return;
  }
  const configResult = validateConfig(rawConfig);
  if (!configResult.valid) {
    fail('BLOCK_INVALID_CONFIG', 'Autoloop configuration did not pass schema validation.',
      'Correct config/autoloop.json before trusting review decisions.',
      { blockers: configResult.errors.map(e => ({ path: e.path, code: e.code, message: e.message })) });
    return;
  }
  const config = configResult.config;
  const eventRepository = event?.repository?.full_name;
  if (typeof eventRepository !== 'string' || eventRepository.toLowerCase() !== repositoryValue.toLowerCase()) {
    fail('BLOCK_EVENT_REPOSITORY_MISMATCH', 'The event repository does not match GITHUB_REPOSITORY.',
      'Do not apply review data from a different repository.');
    return;
  }

  const isIssueComment = eventName === 'issue_comment';
  if (isIssueComment && !event?.issue?.pull_request) {
    emit({ success: true, mutated: false, decisionCode: 'IGNORED_NON_PR_COMMENT',
      reason: 'This is an Issue comment, not a pull-request comment.', nextAction: 'No review-relay action is needed.' });
    return;
  }
  const prNumber = Number(event?.pull_request?.number || (isIssueComment ? event?.issue?.number : 0));
  if (!Number.isInteger(prNumber) || prNumber < 1) {
    fail('BLOCK_PR_NUMBER_INVALID', 'The event does not identify a valid pull request number.',
      'Inspect the event type and payload; do not guess the target PR.');
    return;
  }

  const apiBase = 'https://api.github.com/repos/' + repo.owner + '/' + repo.repo;
  const api = async (path, method = 'GET', payload = null) => {
    if (method !== 'GET' && !(method === 'POST' && path === '/issues/' + prNumber + '/comments')) {
      throw new Error('Review relay permits only GitHub GET requests and one auditable PR-comment POST.');
    }
    const response = await fetch(apiBase + path, {
      method, redirect: 'error',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: 'Bearer ' + token,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(payload ? { 'Content-Type': 'application/json' } : {})
      },
      ...(payload ? { body: JSON.stringify(payload) } : {})
    });
    if (!response.ok) {
      const error = new Error('GitHub API HTTP ' + response.status + ' for ' + path);
      error.status = response.status;
      throw error;
    }
    return response.json();
  };

  let pullRequest;
  try {
    pullRequest = await api('/pulls/' + prNumber);
  } catch (error) {
    fail('BLOCK_PR_LOOKUP_FAILED', 'GitHub could not verify the current PR (' + (error?.status ? 'HTTP ' + error.status : 'read failed') + ').',
      'Retry after the PR API is available; do not assume a failed lookup means a review passed.', { pullRequestNumber: prNumber });
    return;
  }
  const currentHead = pullRequest?.head?.sha;
  if (!isSha(currentHead) || Number(pullRequest.number) !== prNumber) {
    fail('BLOCK_PR_IDENTITY_INVALID', 'The current PR response does not contain a verifiable PR number and head SHA.',
      'Refresh the PR metadata before evaluating a review.', { pullRequestNumber: prNumber });
    return;
  }

  const reviewEvent = event?.review || null;
  const commentEvent = event?.comment || null;
  // Untrusted actors and ordinary comments cannot advance the relay or access provider state.
  if (eventName === 'pull_request_review'
    && !config.trustedReviewers.some(login => String(login).toLowerCase() === String(reviewEvent?.user?.login || '').toLowerCase())) {
    const report = evaluateReviewRelay({ repositoryFullName: repositoryValue, pullRequest, eventName, eventAction,
      eventReview: reviewEvent, trustedReviewers: config.trustedReviewers });
    emit(report);
    return;
  }
  if (isIssueComment && !/^\s*(?:\[autoloop:escalate\]|@autoloop\s+escalate)\s*:?\s*[\s\S]+$/i.test(String(commentEvent?.body || ''))) {
    const report = evaluateReviewRelay({ repositoryFullName: repositoryValue, pullRequest, eventName, eventAction,
      eventComment: commentEvent, trustedReviewers: config.trustedReviewers });
    emit(report);
    return;
  }

  const fetchAllPages = async (path, arrayKey = null) => {
    const all = [];
    for (let page = 1; ; page += 1) {
      const data = await api(path + (path.includes('?') ? '&' : '?') + 'per_page=100&page=' + page);
      const items = arrayKey ? data?.[arrayKey] : data;
      if (!Array.isArray(items)) throw new Error('GitHub returned an invalid paginated collection for ' + path + '.');
      all.push(...items);
      if (items.length < 100) return all;
    }
  };

  let reviews = [];
  let checkRuns = [];
  let comments = [];
  try {
    const isHeadSync = eventName === 'pull_request_target' && eventAction === 'synchronize';
    if (eventName === 'pull_request_review' || isHeadSync) {
      reviews = await fetchAllPages('/pulls/' + prNumber + '/reviews');
      if (!reviews.some(item => String(item?.id) === String(reviewEvent?.id)) && reviewEvent) reviews.push(reviewEvent);
    }
    if (eventName === 'pull_request_review' || isHeadSync) {
      checkRuns = await fetchAllPages('/commits/' + encodeURIComponent(currentHead) + '/check-runs', 'check_runs');
    }
  } catch (error) {
    fail('BLOCK_REVIEW_EVIDENCE_FAILED', 'GitHub could not return complete current review/check evidence (' + (error?.status ? 'HTTP ' + error.status : 'read failed') + ').',
      'Retry when review and check APIs can be read completely; missing data is not an approval.', { pullRequestNumber: prNumber, headSha: currentHead });
    return;
  }

  const governing = extractGoverningIssueNumber(pullRequest.body || '', repositoryValue);
  let decision = evaluateReviewRelay({
    repositoryFullName: repositoryValue, pullRequest, eventName, eventAction, eventReview, eventComment: commentEvent,
    reviews, trustedReviewers: config.trustedReviewers, requiredChecks: config.requiredChecks, checkRuns,
    governingIssueNumber: governing.number
  });

  // A pushed repair is evidence, not approval. Report current-head paths/checks
  // and prior trusted findings; the new SHA still requires an explicit review.
  if (eventName === 'pull_request_target' && eventAction === 'synchronize') {
    try {
      const changedFiles = await fetchAllPages('/pulls/' + prNumber + '/files');
      const headCommit = await api('/commits/' + encodeURIComponent(currentHead));
      const parentSha = headCommit?.parents?.[0]?.sha;
      let parentCommit = null;
      if (isSha(parentSha)) parentCommit = await api('/commits/' + encodeURIComponent(parentSha));
      const requiredCheckEvidence = (Array.isArray(config.requiredChecks) ? config.requiredChecks : []).map(name => {
        const matching = checkRuns.filter(run => run && run.name === name && String(run.head_sha || '').toLowerCase() === currentHead.toLowerCase())
          .sort((a, b) => String(b.completed_at || b.started_at || '').localeCompare(String(a.completed_at || a.started_at || '')));
        const check = matching[0];
        return { name, status: check?.status || 'missing', conclusion: check?.conclusion || null,
          headSha: currentHead, passed: Boolean(check && check.status === 'completed' && check.conclusion === 'success') };
      });
      const priorFindings = reviews
        .filter(item => ['CHANGES_REQUESTED', 'DISMISSED'].includes(String(item?.state || '').toUpperCase())
          && config.trustedReviewers.some(login => String(login).toLowerCase() === String(item?.user?.login || '').toLowerCase()))
        .map(item => ({ reviewId: item.id ?? null, reviewer: item.user?.login ?? null, state: item.state,
          reviewedHeadSha: item.commit_id ?? null, body: String(item.body || '').slice(0, 1200) }));
      decision = {
        ...decision,
        repairEvidence: {
          currentHeadSha: currentHead,
          changedPaths: changedFiles.map(item => item?.filename).filter(path => typeof path === 'string').sort(),
          requiredChecks: requiredCheckEvidence,
          previousHeadTreeChanged: Boolean(headCommit?.commit?.tree?.sha && parentCommit?.commit?.tree?.sha
            && headCommit.commit.tree.sha !== parentCommit.commit.tree.sha),
          previousTrustedFindings: priorFindings,
          automaticFindingResolution: false,
          status: 'WAITING_FOR_CURRENT_HEAD_REVIEW',
          note: 'This report proves only what changed and which checks belong to this SHA. A trusted reviewer must explicitly say which findings are fixed or remain; no repair is marked satisfied automatically.'
        }
      };
    } catch {
      decision = {
        ...decision,
        success: false,
        decisionCode: 'BLOCK_REPAIR_EVIDENCE_UNAVAILABLE',
        reason: 'The new head was observed, but its changed paths, parent tree, prior findings, or exact-head checks could not be verified completely.',
        nextAction: 'Retry the read-only evidence collection. Do not mark the repair successful or carry forward the previous approval.',
        repairEvidence: null
      };
    }
    emit(decision);
    return;
  }

  if (decision.decisionCode === 'BLOCK_REPAIR_CONTEXT_MISSING' && governing.number) {
    // Check the durable comment marker before requiring live provider context.
    // This keeps a replay idempotent even after the original task is reconciled.
    try {
      comments = await fetchAllPages('/issues/' + prNumber + '/comments');
      const priorKeys = comments.flatMap(comment => [...String(comment?.body || '').matchAll(/<!-- (review-relay:v1:[^\s]+) -->/g)].map(match => match[1]));
      if (decision.eventKey && priorKeys.includes(decision.eventKey)) {
        emit({ ...decision, decisionCode: 'DUPLICATE_EVENT_IGNORED', success: true, requiresWrite: false,
          commentBody: null, reason: 'This review event already has a durable audit comment. No duplicate handoff was created.' });
        return;
      }
    } catch {
      fail('BLOCK_DEDUPLICATION_LOOKUP_FAILED', 'Existing PR comments could not be read before checking for a duplicate repair handoff.',
        'Retry after GitHub can return the complete comment inventory. No handoff or session was created.',
        { pullRequestNumber: prNumber, headSha: currentHead });
      return;
    }
    if (!julesApiKey) {
      fail('BLOCK_PROVIDER_ACCESS_MISSING', 'JULES_API_KEY is required to verify the existing task before recording a repair handoff.',
        'Configure the protected autoloop-dispatch Environment secret. No repair session was created.',
        { pullRequestNumber: prNumber, headSha: currentHead, governingIssueNumber: governing.number });
      return;
    }
    let reconciliation;
    try {
      const stateAdapter = {
        async readState() {
          const ref = await api('/git/ref/heads/' + encodeURIComponent(stateBranch));
          const head = ref?.object?.sha;
          if (!isSha(head)) throw new Error('Claim state branch has no authoritative commit SHA.');
          const file = await api('/contents/claims.json?ref=' + encodeURIComponent(head));
          if (file?.encoding !== 'base64' || typeof file.content !== 'string') throw new Error('claims.json is missing or malformed.');
          const parsed = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
          if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.claims)) throw new Error('claims.json has no claims array.');
          for (const claim of parsed.claims) {
            const validation = validateClaimRecord(claim);
            if (!validation.valid) throw new Error('Claim ledger contains a malformed claim record.');
          }
          return { head, claims: parsed.claims };
        }
      };
      const providerClient = new JulesClient({ apiKey: julesApiKey });
      reconciliation = await reconcileSessionLifecycle({
        config, repository: repo, providerClient, stateAdapter,
        fetchIssue: number => api('/issues/' + number),
        fetchPullRequest: number => api('/pulls/' + number),
        fetchBranch: name => api('/branches/' + encodeURIComponent(name))
      });
    } catch {
      fail('BLOCK_EXISTING_WORK_RECONCILIATION_FAILED',
        'The existing provider session, claim, Issue, branch, or PR could not be reconciled.',
        'Resolve the read-only reconciliation failure before creating any repair handoff. No session was created.',
        { pullRequestNumber: prNumber, headSha: currentHead, governingIssueNumber: governing.number });
      return;
    }
    const matches = new Map();
    for (const blocker of reconciliation?.blockers || []) {
      if (Number(blocker.pullRequest) !== prNumber || Number(blocker.issueNumber) !== Number(governing.number)
        || !blocker.claimId || !blocker.session) continue;
      const key = String(blocker.claimId) + '|' + String(blocker.session);
      matches.set(key, { claimId: String(blocker.claimId), sessionId: String(blocker.session),
        issueNumber: Number(blocker.issueNumber), pullRequestNumber: prNumber, verified: true });
    }
    const existingWork = matches.size === 1 ? [...matches.values()][0] : null;
    if (!existingWork) {
      fail('BLOCK_REPAIR_CONTEXT_MISSING',
        'Lifecycle reconciliation did not prove exactly one existing session/claim for this PR and governing Issue.',
        'Resolve ambiguous or missing session correlation manually. Do not create a replacement task.',
        { pullRequestNumber: prNumber, headSha: currentHead, governingIssueNumber: governing.number,
          reconciliationDecision: reconciliation?.decisionCode || 'UNKNOWN' });
      return;
    }
    comments = await fetchAllPages('/issues/' + prNumber + '/comments');
    const keys = comments.flatMap(comment => [...String(comment?.body || '').matchAll(/<!-- (review-relay:v1:[^\s]+) -->/g)].map(match => match[1]));
    decision = evaluateReviewRelay({
      repositoryFullName: repositoryValue, pullRequest, eventName, eventAction, eventReview, eventComment: commentEvent,
      reviews, trustedReviewers: config.trustedReviewers, requiredChecks: config.requiredChecks, checkRuns,
      governingIssueNumber: governing.number, existingWork, existingEventKeys: keys
    });
  }

  if (decision.requiresWrite && decision.commentBody) {
    let existingKeys = [];
    try {
      if (!comments.length) comments = await fetchAllPages('/issues/' + prNumber + '/comments');
      existingKeys = comments.flatMap(comment => [...String(comment?.body || '').matchAll(/<!-- (review-relay:v1:[^\s]+) -->/g)].map(match => match[1]));
    } catch (error) {
      fail('BLOCK_DEDUPLICATION_LOOKUP_FAILED', 'The existing audit-comment inventory could not be read completely.',
        'Retry when GitHub can return all PR comments; do not create a handoff without checking for duplicates.',
        { pullRequestNumber: prNumber, headSha: currentHead });
      return;
    }
    if (existingKeys.includes(decision.eventKey)) {
      emit({ ...decision, decisionCode: 'DUPLICATE_EVENT_IGNORED', success: true, requiresWrite: false,
        commentBody: null, reason: 'This review event already has a durable audit comment. No duplicate handoff was created.' });
      return;
    }
    try {
      await api('/issues/' + prNumber + '/comments', 'POST', { body: decision.commentBody });
      emit({ ...decision, mutated: true, requiresWrite: false, commentBody: null,
        reason: decision.reason + ' A deduplicated audit comment was added to the existing PR; no task was dispatched.' });
    } catch (error) {
      fail('BLOCK_AUDIT_COMMENT_WRITE_FAILED',
        'GitHub could not confirm the audit handoff comment was created (' + (error?.status ? 'HTTP ' + error.status : 'write outcome uncertain') + ').',
        'Inspect PR comments for the event marker before retrying. Never create a new session to recover an uncertain comment write.',
        { pullRequestNumber: prNumber, headSha: currentHead, eventKey: decision.eventKey });
    }
    return;
  }
  emit(decision);
}

run().catch(() => {
  fail('BLOCK_UNHANDLED_ERROR', 'The review relay encountered an unexpected error. No dispatch was attempted.',
    'Inspect the Actions run and resolve the failed evidence lookup or decision step.');
});
