/**
 * Pure, read-only Session, Issue, Claim, Branch, and PR lifecycle reconciler.
 * Connects paginated provider session reads and GitHub state without mutating state,
 * creating provider sessions, writing comments/labels, or dispatching work.
 */

import { validateConfig } from './config.mjs';
import { normalizeRepositoryIdentity } from './claims.mjs';
import {
  sessionDisposition,
  isOpenPullRequest,
  isMergedPullRequest,
  extractPullRequestNumber,
  findSessionPullRequest
} from './preflight.mjs';

function parseRepositoryUrl(repositoryUrl) {
  let parsed;
  try {
    parsed = new URL(repositoryUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) return null;

  let segments;
  try {
    segments = parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return null;
  }
  if (segments.length !== 2 || segments.some(segment => !segment)) return null;

  return {
    origin: parsed.origin.toLowerCase(),
    owner: segments[0].toLowerCase(),
    repository: segments[1].toLowerCase()
  };
}

function pullRequestUrlMatchesRepository(pullRequestUrl, expectedRepository) {
  let parsed;
  try {
    parsed = new URL(pullRequestUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' || parsed.origin.toLowerCase() !== expectedRepository.origin) return false;

  let segments;
  try {
    segments = parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return false;
  }
  return segments.length >= 4
    && segments[0].toLowerCase() === expectedRepository.owner
    && segments[1].toLowerCase() === expectedRepository.repository
    && segments[2].toLowerCase() === 'pull'
    && /^\d+$/.test(segments[3]);
}

/**
 * Extract correlation claim ID from session prompt or title if present.
 * Format: [claimId: claim-123-xyz]
 * @param {object} session
 * @returns {string|null}
 */
export function extractSessionClaimId(session) {
  const text = `${session?.prompt ?? ''} ${session?.title ?? ''}`;
  const match = text.match(/\[claimId:\s*([^\s\]]+)\]/i);
  return match ? match[1].trim() : null;
}

/**
 * Execute read-only reconciliation across provider sessions, durable claims, issues, branches, and pull requests.
 * Fails closed on any API error, pagination fault, JSON error, or missing metadata.
 *
 * @param {object} options
 * @param {object} [options.config] Autoloop configuration object
 * @param {*} options.repository Repository identity ({ owner, repo } or string)
 * @param {object} options.providerClient Provider client instance with listSessions()
 * @param {Function} [options.fetchPullRequest] Function(prNumber) => Promise<PR>
 * @param {Function} [options.fetchIssue] Function(issueNumber) => Promise<Issue>
 * @param {Function} [options.fetchBranch] Function(branchName) => Promise<Branch>
 * @param {object} [options.stateAdapter] Durable claim state adapter with readState()
 * @param {Date|string|number} [options.now=new Date()] Current timestamp
 * @returns {Promise<object>} Structured reconciliation report
 */
export async function reconcileSessionLifecycle({
  config = null,
  repository,
  providerClient,
  fetchPullRequest = null,
  fetchIssue = null,
  fetchBranch = null,
  stateAdapter = null,
  now = new Date()
}) {
  const timestamp = new Date(now).toISOString();

  if (config) {
    const configCheck = validateConfig(config);
    if (!configCheck.valid) {
      return {
        success: false,
        decisionCode: 'RECONCILIATION_INVALID_CONFIG',
        timestamp,
        repository: null,
        mutated: false,
        summary: 'Reconciliation failed due to invalid configuration.',
        blockers: configCheck.errors.map(e => ({ path: e.path, code: e.code, reason: e.message })),
        sessionsInspected: 0,
        claimsInspected: 0,
        nextSafeAction: 'Fix configuration validation errors before running reconciliation.'
      };
    }
  }

  const repoCheck = normalizeRepositoryIdentity(repository);
  if (!repoCheck.valid) {
    return {
      success: false,
      decisionCode: 'RECONCILIATION_INVALID_REPOSITORY',
      timestamp,
      repository: null,
      mutated: false,
      summary: 'Reconciliation failed due to invalid repository identity.',
      blockers: [{ code: 'INVALID_REPOSITORY', reason: 'Repository identity is missing or invalid.' }],
      sessionsInspected: 0,
      claimsInspected: 0,
      nextSafeAction: 'Provide a valid owner/repo repository identity.'
    };
  }
  const targetRepo = repoCheck.repository;
  const targetRepoUrl = `https://github.com/${targetRepo.owner}/${targetRepo.repo}`;
  const expectedRepo = parseRepositoryUrl(targetRepoUrl);

  if (!providerClient || typeof providerClient.listSessions !== 'function') {
    return {
      success: false,
      decisionCode: 'RECONCILIATION_PROVIDER_REQUIRED',
      timestamp,
      repository: targetRepo,
      mutated: false,
      summary: 'Provider client with listSessions() is required for reconciliation.',
      blockers: [{ code: 'PROVIDER_CLIENT_REQUIRED', reason: 'A valid providerClient instance with listSessions() is required.' }],
      sessionsInspected: 0,
      claimsInspected: 0,
      nextSafeAction: 'Supply a valid provider client.'
    };
  }

  let sessions = [];
  try {
    sessions = await providerClient.listSessions();
  } catch (err) {
    const safeMessage = String(err?.message || err).replace(/X-Goog-Api-Key:\s*[^\s\r\n]+/gi, 'X-Goog-Api-Key: [REDACTED]');
    return {
      success: false,
      decisionCode: 'RECONCILIATION_PAGINATION_FAILED',
      timestamp,
      repository: targetRepo,
      mutated: false,
      summary: 'Provider sessions list could not be fetched completely: ' + safeMessage,
      blockers: [{
        code: 'PROVIDER_PAGINATION_ERROR',
        reason: 'Provider API failure, malformed JSON, or pagination error during session inventory: ' + safeMessage
      }],
      sessionsInspected: 0,
      claimsInspected: 0,
      nextSafeAction: 'Do not interpret provider API errors as an empty queue. Investigate provider service or pagination faults.'
    };
  }

  if (!Array.isArray(sessions)) {
    return {
      success: false,
      decisionCode: 'RECONCILIATION_PAGINATION_FAILED',
      timestamp,
      repository: targetRepo,
      mutated: false,
      summary: 'Provider session inventory returned non-array response.',
      blockers: [{ code: 'PROVIDER_MALFORMED_RESPONSE', reason: 'Provider listSessions() did not return an array.' }],
      sessionsInspected: 0,
      claimsInspected: 0,
      nextSafeAction: 'Fix provider client response handling.'
    };
  }

  let claims = [];
  if (stateAdapter && typeof stateAdapter.readState === 'function') {
    try {
      const stateSnapshot = await stateAdapter.readState();
      claims = Array.isArray(stateSnapshot?.claims) ? stateSnapshot.claims : [];
    } catch (err) {
      return {
        success: false,
        decisionCode: 'RECONCILIATION_STATE_READ_FAILED',
        timestamp,
        repository: targetRepo,
        mutated: false,
        summary: 'Authoritative claim state store read failed: ' + String(err?.message || err),
        blockers: [{ code: 'STATE_STORE_READ_ERROR', reason: 'Could not read authoritative claim state store: ' + String(err?.message || err) }],
        sessionsInspected: sessions.length,
        claimsInspected: 0,
        nextSafeAction: 'Restore state store access and repair malformed state records.'
      };
    }
  }

  let expectedSourceName = null;
  if (typeof providerClient.findSourceForRepository === 'function') {
    try {
      const src = await providerClient.findSourceForRepository(targetRepo);
      if (src && src.name) expectedSourceName = src.name;
    } catch {
      // If findSourceForRepository fails, fallback to checking session sourceContext directly
    }
  }
  if (!expectedSourceName) {
    expectedSourceName = `sources/github/${targetRepo.owner}/${targetRepo.repo}`;
  }

  const blockers = [];
  const activeSessionsByClaimId = new Map();
  const activeSessionsByIssue = new Map();

  for (const session of sessions) {
    if (!session || typeof session !== 'object' || Array.isArray(session)) {
      blockers.push({
        session: 'unknown',
        code: 'BLOCK_MALFORMED_SESSION',
        reason: 'Provider session inventory contains a non-object record.'
      });
      continue;
    }

    const sessionName = session.name ?? session.id ?? 'unknown';
    const sessionSource = session.sourceContext?.source ?? session.source?.name ?? session.source ?? null;

    if (expectedSourceName && sessionSource && sessionSource !== expectedSourceName) {
      // Belongs to a different repository source; skip safely
      continue;
    }

    const sourceUnknown = !sessionSource;
    const disposition = sessionDisposition(session);
    const prRef = findSessionPullRequest(session);
    let prNumber = null;

    // Branch verification
    const startingBranch = session.sourceContext?.githubRepoContext?.startingBranch ?? session.startingBranch ?? null;
    if (startingBranch && typeof fetchBranch === 'function') {
      try {
        const branchObj = await fetchBranch(startingBranch);
        if (!branchObj) {
          blockers.push({
            session: sessionName,
            branch: startingBranch,
            code: 'BLOCK_BRANCH_NOT_FOUND',
            reason: `Starting branch '${startingBranch}' referenced by session ${sessionName} could not be verified in GitHub.`
          });
        }
      } catch (err) {
        return {
          success: false,
          decisionCode: 'RECONCILIATION_API_FAILED',
          timestamp,
          repository: targetRepo,
          mutated: false,
          summary: `API error verifying branch '${startingBranch}': ` + String(err?.message || err),
          blockers: [{
            session: sessionName,
            branch: startingBranch,
            code: 'BLOCK_API_ERROR',
            reason: `API error verifying branch '${startingBranch}': ` + String(err?.message || err)
          }],
          sessionsInspected: sessions.length,
          claimsInspected: claims.length,
          nextSafeAction: 'Resolve GitHub API connectivity/lookup failure before re-running reconciliation.'
        };
      }
    }

    if (prRef?.url) {
      if (!pullRequestUrlMatchesRepository(prRef.url, expectedRepo)) {
        blockers.push({
          session: sessionName,
          state: disposition.state,
          pullRequest: extractPullRequestNumber(prRef.url),
          code: 'BLOCK_INVALID_PR_URL',
          reason: 'Associated PR URL is malformed or does not belong to target repository ' + targetRepo.owner + '/' + targetRepo.repo + '.'
        });
        continue;
      }
      prNumber = extractPullRequestNumber(prRef.url);
      if (prNumber === null) {
        blockers.push({
          session: sessionName,
          state: disposition.state,
          pullRequest: null,
          code: 'BLOCK_INVALID_PR_NUMBER',
          reason: 'Associated PR URL has no valid pull request number.'
        });
        continue;
      }
    }

    if (prNumber !== null) {
      if (typeof fetchPullRequest !== 'function') {
        blockers.push({
          session: sessionName,
          state: disposition.state,
          pullRequest: prNumber,
          code: 'BLOCK_PR_FETCH_REQUIRED',
          reason: 'Associated PR #' + prNumber + ' requires fetchPullRequest verification function to resolve.'
        });
        continue;
      }

      let pullRequest = null;
      try {
        pullRequest = await fetchPullRequest(prNumber);
      } catch (err) {
        return {
          success: false,
          decisionCode: 'RECONCILIATION_API_FAILED',
          timestamp,
          repository: targetRepo,
          mutated: false,
          summary: 'API lookup error verifying PR #' + prNumber + ': ' + String(err?.message || err),
          blockers: [{
            session: sessionName,
            pullRequest: prNumber,
            code: 'BLOCK_API_ERROR',
            reason: 'API lookup error verifying PR #' + prNumber + ': ' + String(err?.message || err)
          }],
          sessionsInspected: sessions.length,
          claimsInspected: claims.length,
          nextSafeAction: 'Resolve GitHub API connectivity/lookup failure before re-running reconciliation.'
        };
      }

      if (!pullRequest) {
        blockers.push({
          session: sessionName,
          state: disposition.state,
          pullRequest: prNumber,
          code: 'BLOCK_PR_LOOKUP_FAILED',
          reason: 'Associated PR #' + prNumber + ' could not be verified in GitHub.'
        });
        continue;
      }

      if (isMergedPullRequest(pullRequest)) {
        if (sourceUnknown) {
          blockers.push({
            session: sessionName,
            state: disposition.state,
            pullRequest: prNumber,
            code: 'BLOCK_MERGED_PR_MISSING_SOURCE',
            reason: 'The PR is merged, but session source metadata is missing; repository ownership cannot be verified safely.'
          });
          continue;
        }
        // Verified merged PR with matching repository source! Session cleared.
        continue;
      }

      const prState = String(pullRequest.state ?? '').toLowerCase();
      if (isOpenPullRequest(pullRequest) || prState === 'closed') {
        blockers.push({
          session: sessionName,
          state: disposition.state,
          pullRequest: prNumber,
          code: prState === 'closed' ? 'BLOCK_CLOSED_UNMERGED_PR' : 'BLOCK_OPEN_PR',
          reason: prState === 'closed'
            ? 'Associated PR #' + prNumber + ' is closed but unmerged; human classification is required.'
            : 'Associated PR #' + prNumber + ' is open; work remains active.'
        });
        continue;
      }

      blockers.push({
        session: sessionName,
        state: disposition.state,
        pullRequest: prNumber,
        code: 'BLOCK_UNKNOWN_PR_STATE',
        reason: 'Associated PR #' + prNumber + ' has an unknown state (' + prState + ').'
      });
      continue;
    }

    if (sourceUnknown || disposition.disposition === 'blocking') {
      blockers.push({
        session: sessionName,
        state: disposition.state,
        pullRequest: null,
        code: sourceUnknown ? 'BLOCK_MISSING_SESSION_SOURCE' : 'BLOCK_ACTIVE_SESSION',
        reason: sourceUnknown
          ? 'Session source is missing; repository ownership cannot be verified safely.'
          : disposition.reason
      });
    }

    const claimId = extractSessionClaimId(session);
    if (claimId && disposition.disposition === 'blocking') {
      if (!activeSessionsByClaimId.has(claimId)) {
        activeSessionsByClaimId.set(claimId, []);
      }
      activeSessionsByClaimId.get(claimId).push(sessionName);

      if (stateAdapter) {
        const matchingClaim = claims.find(c => c.claimId === claimId);
        if (!matchingClaim) {
          blockers.push({
            session: sessionName,
            claimId,
            code: 'BLOCK_SESSION_CLAIM_NOT_FOUND',
            reason: `Session ${sessionName} references claimId ${claimId}, but no matching claim exists in state store.`
          });
        } else {
          const sessionIssue = Number(session.issueNumber ?? session.issue_number);
          if (Number.isInteger(sessionIssue) && sessionIssue > 0 && matchingClaim.issueNumber !== sessionIssue) {
            blockers.push({
              session: sessionName,
              claimId,
              code: 'BLOCK_SESSION_CLAIM_MISMATCH',
              reason: `Session ${sessionName} issue number #${sessionIssue} does not match claim ${claimId} issue number #${matchingClaim.issueNumber}.`
            });
          }
        }
      }
    }

    const issueNum = Number(session.issueNumber ?? session.issue_number);
    if (Number.isInteger(issueNum) && issueNum > 0 && disposition.disposition === 'blocking') {
      if (!activeSessionsByIssue.has(issueNum)) {
        activeSessionsByIssue.set(issueNum, []);
      }
      activeSessionsByIssue.get(issueNum).push(sessionName);
    }
  }

  for (const [claimId, sessionList] of activeSessionsByClaimId.entries()) {
    if (sessionList.length > 1) {
      blockers.push({
        claimId,
        code: 'BLOCK_MULTIPLE_ACTIVE_SESSIONS',
        reason: `Multiple active provider sessions (${sessionList.join(', ')}) are associated with claimId ${claimId}.`
      });
    }
  }

  for (const [issueNum, sessionList] of activeSessionsByIssue.entries()) {
    if (sessionList.length > 1) {
      blockers.push({
        issueNumber: issueNum,
        code: 'BLOCK_MULTIPLE_ACTIVE_SESSIONS',
        reason: `Multiple active provider sessions (${sessionList.join(', ')}) are associated with Issue #${issueNum}.`
      });
    }
  }

  for (const claim of claims) {
    if (!claim || typeof claim !== 'object' || claim.reconciled === true) continue;

    const claimIssue = Number(claim.issueNumber ?? claim.issue_number);
    if (typeof fetchIssue === 'function' && Number.isInteger(claimIssue) && claimIssue > 0) {
      try {
        const issueObj = await fetchIssue(claimIssue);
        if (issueObj && String(issueObj.state).toLowerCase() === 'closed') {
          const reasonRaw = String(issueObj.state_reason ?? '').toLowerCase();
          if (reasonRaw !== 'completed') {
            blockers.push({
              claimId: claim.claimId,
              issueNumber: claimIssue,
              code: 'BLOCK_CLOSED_ISSUE_UNRECONCILED',
              reason: `Governing Issue #${claimIssue} was closed (${reasonRaw || 'unspecified'}), but claim ${claim.claimId} remains active/unreconciled.`
            });
          }
        }
      } catch (err) {
        return {
          success: false,
          decisionCode: 'RECONCILIATION_API_FAILED',
          timestamp,
          repository: targetRepo,
          mutated: false,
          summary: `API error verifying governing Issue #${claimIssue}: ` + String(err?.message || err),
          blockers: [{
            claimId: claim.claimId,
            issueNumber: claimIssue,
            code: 'BLOCK_API_ERROR',
            reason: `API error verifying governing Issue #${claimIssue}: ` + String(err?.message || err)
          }],
          sessionsInspected: sessions.length,
          claimsInspected: claims.length,
          nextSafeAction: 'Resolve GitHub API connectivity/lookup failure before re-running reconciliation.'
        };
      }
    }
  }

  const success = blockers.length === 0;

  return {
    success,
    decisionCode: success ? 'RECONCILIATION_CLEAR' : 'RECONCILIATION_BLOCKED',
    timestamp,
    repository: targetRepo,
    mutated: false,
    summary: success
      ? 'Session, Issue, claim, branch, and PR lifecycle reconciliation is clear.'
      : `${blockers.length} lifecycle reconciliation blocker(s) detected.`,
    blockers,
    sessionsInspected: sessions.length,
    claimsInspected: claims.length,
    nextSafeAction: success
      ? 'Reconciliation clear. Safe to proceed with preflight and candidate selection.'
      : 'Resolve reconciliation blockers manually before attempting dispatch or new session creation.'
  };
}
