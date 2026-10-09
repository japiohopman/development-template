/**
 * Pure safety and reconciliation functions.
 * No network calls, workflow writes, or provider sessions are created here.
 */
export const DEFAULT_ACTIVE_SESSION_STATES = new Set([
  'QUEUED',
  'PLANNING',
  'AWAITING_PLAN_APPROVAL',
  'AWAITING_USER_FEEDBACK',
  'IN_PROGRESS',
  'PAUSED',
]);

export const DEFAULT_TERMINAL_SESSION_STATES = new Set([
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'CANCELED',
  'EXPIRED',
]);

const normalizeState = value => String(value ?? '').trim().toUpperCase();

export function sessionDisposition(session, {
  activeStates = DEFAULT_ACTIVE_SESSION_STATES,
  terminalStates = DEFAULT_TERMINAL_SESSION_STATES,
} = {}) {
  const state = normalizeState(session?.state);
  if (!state) return { state: 'UNKNOWN', disposition: 'blocking', reason: 'Provider session has no state.' };
  if (terminalStates.has(state)) return { state, disposition: 'terminal', reason: 'Provider session is terminal (' + state + ').' };
  if (activeStates.has(state)) return { state, disposition: 'blocking', reason: 'Provider session is active or waiting for input (' + state + ').' };
  return { state, disposition: 'blocking', reason: 'Unrecognized provider state (' + state + '); manual reconciliation is required.' };
}

export function isOpenPullRequest(pr) {
  return Boolean(pr && String(pr.state).toLowerCase() === 'open' && pr.merged !== true && !pr.merged_at);
}

export function isMergedPullRequest(pr) {
  return Boolean(pr && (pr.merged === true || Boolean(pr.merged_at)));
}

export function extractPullRequestNumber(url) {
  const match = String(url ?? '').match(/\/pull\/(\d+)(?:\D|$)/);
  return match ? Number(match[1]) : null;
}

export function findSessionPullRequest(session) {
  const outputs = Array.isArray(session?.outputs) ? session.outputs : [];
  return outputs.find(output => output?.pullRequest?.url)?.pullRequest ?? null;
}

/**
 * Reconcile provider sessions against their associated PRs.
 * fetchPullRequest must throw on an API failure; callers must not treat a
 * partial or failed response as a complete snapshot.
 */
export async function reconcileSessions(sessions, {
  sourceName,
  fetchPullRequest,
  activeStates = DEFAULT_ACTIVE_SESSION_STATES,
  terminalStates = DEFAULT_TERMINAL_SESSION_STATES,
} = {}) {
  if (!Array.isArray(sessions)) throw new TypeError('sessions must be an array');
  if (typeof fetchPullRequest !== 'function') throw new TypeError('fetchPullRequest must be a function');

  const blockers = [];
  for (const session of sessions) {
    const sessionSource = session?.sourceContext?.source ?? session?.source?.name ?? session?.source;
    if (sourceName && sessionSource && sessionSource !== sourceName) continue;

    const sourceUnknown = !sessionSource;
    const disposition = sessionDisposition(session, { activeStates, terminalStates });
    const prRef = findSessionPullRequest(session);
    const prNumber = extractPullRequestNumber(prRef?.url);

    if (prNumber !== null) {
      const pullRequest = await fetchPullRequest(prNumber);
      if (!pullRequest) {
        blockers.push({
          session: session?.name ?? 'unknown',
          state: disposition.state,
          pullRequest: prNumber,
          reason: 'Associated PR #' + prNumber + ' could not be verified; session remains unresolved.',
        });
        continue;
      }
      if (isMergedPullRequest(pullRequest)) continue;

      const prState = String(pullRequest.state ?? '').toLowerCase();
      if (isOpenPullRequest(pullRequest) || prState === 'closed') {
        blockers.push({
          session: session?.name ?? 'unknown',
          state: disposition.state,
          pullRequest: prNumber,
          reason: 'Associated PR #' + prNumber + ' is not merged; session remains unresolved.',
        });
        continue;
      }

      blockers.push({
        session: session?.name ?? 'unknown',
        state: disposition.state,
        pullRequest: prNumber,
        reason: 'Associated PR #' + prNumber + ' has an unknown state; manual reconciliation is required.',
      });
      continue;
    }

    if (sourceUnknown || disposition.disposition === 'blocking') {
      blockers.push({
        session: session?.name ?? 'unknown',
        state: disposition.state,
        pullRequest: null,
        reason: sourceUnknown
          ? 'Session source is missing; repository ownership cannot be verified safely.'
          : disposition.reason,
      });
    }
  }
  return blockers;
}

/**
 * Decide whether live dispatch may proceed. Pure function: no side effects.
 */
export function evaluatePreflight({
  snapshotComplete,
  issue,
  openManagedPullRequests = [],
  sessionBlockers = [],
  claim = null,
  confirmation = '',
  requiredConfirmation = 'DISPATCH',
  now = new Date(),
}) {
  const result = (action, reason, safeToDispatch = false) => ({
    action,
    reason,
    safeToDispatch,
    dispatchAuthorized: safeToDispatch && confirmation === requiredConfirmation,
  });

  if (snapshotComplete !== true) {
    return result('BLOCK_INCOMPLETE_SNAPSHOT', 'The API snapshot is incomplete or unverified. Refusing to dispatch.');
  }
  if (!issue || !Number.isInteger(Number(issue.number)) || Number(issue.number) < 1 || String(issue.state).toLowerCase() !== 'open') {
    return result('BLOCK_INVALID_ISSUE', 'A valid open governing Issue is required.');
  }
  if (openManagedPullRequests.some(pr => isOpenPullRequest(pr) && Number(pr.issue_number) === Number(issue.number))) {
    return result('WAIT_ISSUE_PR', 'The governing Issue already has an open managed pull request.');
  }
  if (openManagedPullRequests.some(isOpenPullRequest)) {
    return result('WAIT_OPEN_PR', 'An open managed pull request must be reviewed or resolved before another dispatch.');
  }
  if (claim) {
    const expiresAt = Date.parse(claim.expiresAt ?? '');
    if (!Number.isFinite(expiresAt) || expiresAt > new Date(now).getTime()) {
      return result('WAIT_EXISTING_CLAIM', 'A claim is active or cannot be proven expired. Reconcile it before dispatch.');
    }
    if (claim.reconciled !== true) {
      return result('WAIT_EXPIRED_CLAIM_RECONCILIATION', 'The claim expired, but provider sessions and PR state have not been reconciled.');
    }
  }
  if (sessionBlockers.length > 0) {
    return result('WAIT_ACTIVE_SESSION', sessionBlockers.length + ' unresolved provider session(s) block dispatch.');
  }
  if (confirmation !== requiredConfirmation) {
    return result('PLAN_ONLY', 'Preflight is clear, but exact manual confirmation is required for live dispatch.', true);
  }
  return result('DISPATCH_SAFE', 'Preflight is clear and exact manual confirmation was supplied.', true);
}
