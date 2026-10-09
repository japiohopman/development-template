/**
 * Deterministic Issue selector and dependency checker.
 *
 * Selects at most one eligible work item deterministically from a complete read-only snapshot.
 * Read-only and side-effect free: never persist claims, create provider sessions, or make network calls.
 */

import { validateConfig } from './config.mjs';
import { validateIssueContract, extractMarkdownSections } from './contracts.mjs';
import { isOpenPullRequest, isMergedPullRequest, extractPullRequestNumber, findSessionPullRequest } from './preflight.mjs';

function compareNumbers(a, b) {
  return Number(a) - Number(b);
}

function normalizeIssueNumber(ref) {
  if (typeof ref === 'number' && Number.isInteger(ref) && ref > 0) return ref;
  if (typeof ref === 'string') {
    const match = ref.match(/(?:#|issues\/)(\d+)/i);
    if (match) return Number(match[1]);
    if (/^\d+$/.test(ref.trim())) return Number(ref.trim());
  }
  return null;
}

/**
 * Extract dependency Issue numbers from an Issue body's "Dependencies" section.
 * Ignores self-references and non-issue text ("none", "n/a", etc.).
 *
 * @param {string} body
 * @param {number} currentIssueNumber
 * @returns {number[]} Array of unique dependency issue numbers sorted ascending.
 */
export function extractDependencies(body, currentIssueNumber) {
  if (typeof body !== 'string') return [];
  const sections = extractMarkdownSections(body);
  const depText = sections.get('dependencies');
  if (!depText) return [];

  const lower = depText.toLowerCase();
  if (lower.includes('none') || lower.includes('n/a') || lower.includes('no dependencies')) {
    // Check if there are explicit issue numbers despite "none" text (e.g. "None except #5")
    // If text is just "none." or "n/a", no deps.
  }

  const matches = depText.matchAll(/(?:#|https?:\/\/[^\s\/]+\/[^\s\/]+\/[^\s\/]+\/issues\/)(\d+)\b/gi);
  const depNumbers = new Set();

  for (const match of matches) {
    const num = Number(match[1]);
    if (Number.isInteger(num) && num > 0 && num !== currentIssueNumber) {
      depNumbers.add(num);
    }
  }

  return Array.from(depNumbers).sort(compareNumbers);
}

/**
 * Extract label names from an Issue's `labels` property (supports strings or objects with `name`).
 * @param {Array<string|object>} labels
 * @returns {Set<string>}
 */
function extractLabelNames(labels) {
  const set = new Set();
  if (!Array.isArray(labels)) return set;
  for (const label of labels) {
    if (typeof label === 'string' && label.trim()) {
      set.add(label.trim());
    } else if (label && typeof label === 'object' && typeof label.name === 'string' && label.name.trim()) {
      set.add(label.name.trim());
    }
  }
  return set;
}

/**
 * Determine whether a dependency Issue is successfully completed.
 * A closed dependency marked `duplicate` or `not_planned` is NOT completed.
 *
 * @param {object} depIssue
 * @returns {{ completed: boolean, reason?: string }}
 */
export function isDependencyCompleted(depIssue) {
  if (!depIssue || typeof depIssue !== 'object') {
    return { completed: false, reason: 'Dependency Issue object is missing or invalid.' };
  }

  const state = String(depIssue.state ?? '').toLowerCase();
  if (state !== 'closed') {
    return { completed: false, reason: 'Dependency Issue #' + depIssue.number + ' is still ' + state + '.' };
  }

  const stateReason = String(depIssue.state_reason ?? depIssue.stateReason ?? '').toLowerCase();
  if (stateReason === 'duplicate') {
    return { completed: false, reason: 'Dependency Issue #' + depIssue.number + ' was closed as duplicate.' };
  }
  if (stateReason === 'not_planned' || stateReason === 'not planned') {
    return { completed: false, reason: 'Dependency Issue #' + depIssue.number + ' was closed as not planned.' };
  }

  return { completed: true };
}

/**
 * Determine if an Issue is linked to a Pull Request.
 * Linkage is detected if:
 * - PR `issue_number` or `issueNumber` or `issue.number` equals issue number.
 * - PR body or title references the issue number (e.g. `#123` or `/issues/123`).
 *
 * @param {object} pr
 * @param {number} issueNumber
 * @returns {boolean}
 */
export function isPullRequestLinkedToIssue(pr, issueNumber) {
  if (!pr || typeof pr !== 'object') return false;

  const directNum = normalizeIssueNumber(pr.issue_number ?? pr.issueNumber ?? pr.issue?.number);
  if (directNum === issueNumber) return true;

  const bodyText = typeof pr.body === 'string' ? pr.body : '';
  const titleText = typeof pr.title === 'string' ? pr.title : '';
  const combined = titleText + '\n' + bodyText;

  const pattern = new RegExp('(?:#|/issues/)' + issueNumber + '\\b', 'i');
  return pattern.test(combined);
}

/**
 * Select at most one eligible work item deterministically from a snapshot and config.
 *
 * @param {object} snapshot
 * @param {object} rawConfig
 * @returns {{ selectedCandidate: object|null, decisionCode: string, blockers: Array<object>, nextSafeAction: string }}
 */
export function selectCandidateIssue(snapshot, rawConfig) {
  const result = (selectedCandidate, decisionCode, blockers = [], nextSafeAction = '') => ({
    selectedCandidate: selectedCandidate ? JSON.parse(JSON.stringify(selectedCandidate)) : null,
    decisionCode,
    blockers,
    nextSafeAction
  });

  // 1. Validate Config
  const configValidation = validateConfig(rawConfig);
  if (!configValidation.valid) {
    return result(
      null,
      'INVALID_CONFIG',
      configValidation.errors.map(e => ({ path: e.path, code: e.code, reason: e.message })),
      'Correct configuration errors before attempting candidate selection.'
    );
  }
  const config = configValidation.config;

  // 2. Validate Snapshot Completeness & Collections
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return result(
      null,
      'INCOMPLETE_SNAPSHOT',
      [{ path: '/', code: 'INVALID_SNAPSHOT_OBJECT', reason: 'Snapshot must be a non-null object.' }],
      'Provide a complete, structured snapshot object.'
    );
  }

  if (snapshot.complete !== true) {
    return result(
      null,
      'INCOMPLETE_SNAPSHOT',
      [{ path: '/complete', code: 'SNAPSHOT_INCOMPLETE', reason: 'Snapshot.complete must be explicitly true.' }],
      'Ensure snapshot fetching completes successfully before running selector.'
    );
  }

  const requiredCollections = ['issues', 'pullRequests', 'sessions'];
  for (const col of requiredCollections) {
    if (!Array.isArray(snapshot[col])) {
      return result(
        null,
        'INCOMPLETE_SNAPSHOT',
        [{ path: '/' + col, code: 'MISSING_COLLECTION', reason: 'Required collection "' + col + '" is missing or not an array.' }],
        'Include required collection "' + col + '" in the snapshot.'
      );
    }
  }

  // Check sequence collection if sequenceSource is configured
  let sequenceList = null;
  if (config.sequenceSource) {
    const seqCol = snapshot.sequence ?? snapshot[config.sequenceSource] ?? snapshot.sequenceSource;
    if (!Array.isArray(seqCol)) {
      return result(
        null,
        'INCOMPLETE_SNAPSHOT',
        [{ path: '/sequence', code: 'MISSING_SEQUENCE_COLLECTION', reason: 'Configured sequenceSource "' + config.sequenceSource + '" is missing or not an array in snapshot.' }],
        'Provide valid sequence array in snapshot matching sequenceSource configuration.'
      );
    }
    sequenceList = seqCol;
  }

  // 3. Validate Snapshot Issues & Sort Deterministically by Issue Number
  const rawIssues = snapshot.issues;
  const issuesByNumber = new Map();
  const issueValidationBlockers = [];

  for (let i = 0; i < rawIssues.length; i++) {
    const issue = rawIssues[i];
    if (!issue || typeof issue !== 'object' || Array.isArray(issue)) {
      issueValidationBlockers.push({
        path: '/issues/' + i,
        code: 'MALFORMED_ISSUE',
        reason: 'Issue item at index ' + i + ' is not an object.'
      });
      continue;
    }

    const num = issue.number;
    if (!Number.isInteger(num) || num <= 0) {
      issueValidationBlockers.push({
        path: '/issues/' + i + '/number',
        code: 'MALFORMED_ISSUE',
        reason: 'Issue at index ' + i + ' is missing a valid positive integer number.'
      });
      continue;
    }

    if (issuesByNumber.has(num)) {
      issueValidationBlockers.push({
        path: '/issues/' + i,
        code: 'DUPLICATE_ISSUE_NUMBER',
        reason: 'Duplicate issue #' + num + ' found in snapshot issues collection.'
      });
      continue;
    }

    if (typeof issue.state !== 'string' || !issue.state.trim()) {
      issueValidationBlockers.push({
        path: '/issues/' + i + '/state',
        code: 'MALFORMED_ISSUE',
        reason: 'Issue #' + num + ' is missing a valid state string.'
      });
      continue;
    }

    const contractResult = validateIssueContract(issue, { requiredIssueSections: config.requiredIssueSections });
    if (!contractResult.valid) {
      for (const err of contractResult.errors) {
        issueValidationBlockers.push({
          issueNumber: num,
          path: '/issues/' + i + err.path,
          code: err.code,
          reason: 'Issue #' + num + ' contract error: ' + err.message
        });
      }
      continue;
    }

    issuesByNumber.set(num, issue);
  }

  if (issueValidationBlockers.length > 0) {
    return result(
      null,
      'MALFORMED_ISSUE',
      issueValidationBlockers.sort((a, b) => (a.issueNumber ?? 0) - (b.issueNumber ?? 0) || a.path.localeCompare(b.path)),
      'Fix malformed Issues in repository/snapshot before selection.'
    );
  }

  // Sort issue numbers for deterministic processing
  const sortedIssueNumbers = Array.from(issuesByNumber.keys()).sort(compareNumbers);

  // 4. Validate PRs and Active Sessions in Snapshot
  const pullRequests = snapshot.pullRequests;
  const sessions = snapshot.sessions;

  // Identify unresolved PRs per issue
  const openOrUnmergedPRsByIssue = new Map();
  for (const pr of pullRequests) {
    if (!pr || typeof pr !== 'object') continue;
    const isMerged = isMergedPullRequest(pr);
    // An open or closed-but-unmerged PR remains unresolved.
    if (!isMerged) {
      for (const num of sortedIssueNumbers) {
        if (isPullRequestLinkedToIssue(pr, num)) {
          if (!openOrUnmergedPRsByIssue.has(num)) openOrUnmergedPRsByIssue.set(num, []);
          openOrUnmergedPRsByIssue.get(num).push(pr);
        }
      }
    }
  }

  // Identify unresolved active sessions/claims
  const activeSessionsByIssue = new Map();
  for (const sess of sessions) {
    if (!sess || typeof sess !== 'object') continue;
    const prRef = findSessionPullRequest(sess);
    const issueNum = normalizeIssueNumber(sess.issue_number ?? sess.issueNumber ?? sess.issue?.number ?? prRef?.issueNumber);
    if (issueNum) {
      if (!activeSessionsByIssue.has(issueNum)) activeSessionsByIssue.set(issueNum, []);
      activeSessionsByIssue.get(issueNum).push(sess);
    }
  }

  // 5. Evaluate Candidate Eligibility
  const eligibleCandidates = [];
  const candidateBlockers = [];

  for (const num of sortedIssueNumbers) {
    const issue = issuesByNumber.get(num);

    // Filter: must be open
    if (String(issue.state).toLowerCase() !== 'open') continue;

    // Filter: readiness label
    const labels = extractLabelNames(issue.labels);
    const readyLabel = config.labels.ready;
    if (!labels.has(readyLabel)) {
      // Not a candidate since it lacks readiness label
      continue;
    }

    // Check unresolved PRs
    const unresolvedPRs = openOrUnmergedPRsByIssue.get(num);
    if (unresolvedPRs && unresolvedPRs.length > 0) {
      const prNumber = unresolvedPRs[0].number ?? extractPullRequestNumber(unresolvedPRs[0].url) ?? 'unknown';
      candidateBlockers.push({
        issueNumber: num,
        code: 'UNRESOLVED_PULL_REQUEST',
        reason: 'Issue #' + num + ' is blocked by unresolved PR #' + prNumber + ' (open or closed-but-unmerged).'
      });
      continue;
    }

    // Check unresolved sessions
    const activeSess = activeSessionsByIssue.get(num);
    if (activeSess && activeSess.length > 0) {
      candidateBlockers.push({
        issueNumber: num,
        code: 'ACTIVE_WORK_EXISTS',
        reason: 'Issue #' + num + ' has an active or unresolved provider session.'
      });
      continue;
    }

    // Check dependencies
    const depNumbers = extractDependencies(issue.body, num);
    let depsSatisfied = true;
    for (const depNum of depNumbers) {
      const depIssue = issuesByNumber.get(depNum);
      if (!depIssue) {
        depsSatisfied = false;
        candidateBlockers.push({
          issueNumber: num,
          code: 'UNRESOLVED_DEPENDENCY',
          reason: 'Issue #' + num + ' depends on Issue #' + depNum + ' which is missing from snapshot.'
        });
        break;
      }

      const depCheck = isDependencyCompleted(depIssue);
      if (!depCheck.completed) {
        depsSatisfied = false;
        candidateBlockers.push({
          issueNumber: num,
          code: 'UNRESOLVED_DEPENDENCY',
          reason: 'Issue #' + num + ' depends on Issue #' + depNum + ': ' + depCheck.reason
        });
        break;
      }
    }

    if (depsSatisfied) {
      eligibleCandidates.push(issue);
    }
  }

  // 6. Handle Candidate Selection and Sequence Ordering
  if (eligibleCandidates.length === 0) {
    if (candidateBlockers.length > 0) {
      return result(
        null,
        'CANDIDATES_BLOCKED',
        candidateBlockers,
        'Resolve blockers for ready issues before running selector.'
      );
    }
    return result(
      null,
      'NO_ELIGIBLE_CANDIDATES',
      [],
      'No open issues carry the readiness label "' + config.labels.ready + '" with satisfied dependencies.'
    );
  }

  // Validate sequence if sequenceSource configured
  if (config.sequenceSource) {
    const normalizedSequence = [];
    const seenSeqNumbers = new Set();
    const sequenceBlockers = [];

    for (let i = 0; i < sequenceList.length; i++) {
      const entry = sequenceList[i];
      const seqNum = normalizeIssueNumber(entry);

      if (!seqNum) {
        sequenceBlockers.push({
          path: '/sequence/' + i,
          code: 'INVALID_SEQUENCE_ENTRY',
          reason: 'Sequence entry at index ' + i + ' is not a valid issue reference.'
        });
        continue;
      }

      if (seenSeqNumbers.has(seqNum)) {
        sequenceBlockers.push({
          path: '/sequence/' + i,
          code: 'DUPLICATE_SEQUENCE_ENTRY',
          reason: 'Sequence contains duplicate issue reference #' + seqNum + '.'
        });
        continue;
      }

      seenSeqNumbers.add(seqNum);
      normalizedSequence.push(seqNum);
    }

    if (sequenceBlockers.length > 0) {
      return result(
        null,
        'INVALID_SEQUENCE',
        sequenceBlockers,
        'Fix sequence configuration in snapshot to provide an unambiguous sequence order.'
      );
    }

    // Sort eligible candidates according to sequence index
    const seqIndexMap = new Map();
    normalizedSequence.forEach((num, index) => seqIndexMap.set(num, index));

    const eligibleInSequence = [];
    const eligibleNotInSequence = [];

    for (const cand of eligibleCandidates) {
      if (seqIndexMap.has(cand.number)) {
        eligibleInSequence.push({ candidate: cand, seqIndex: seqIndexMap.get(cand.number) });
      } else {
        eligibleNotInSequence.push(cand);
      }
    }

    if (eligibleInSequence.length > 0) {
      eligibleInSequence.sort((a, b) => a.seqIndex - b.seqIndex);
      const selected = eligibleInSequence[0].candidate;
      return result(
        selected,
        'CANDIDATE_SELECTED',
        [],
        'Candidate Issue #' + selected.number + ' selected using configured sequenceSource.'
      );
    }

    // None of the eligible candidates are listed in sequence source
    if (eligibleCandidates.length === 1) {
      const selected = eligibleCandidates[0];
      return result(
        selected,
        'CANDIDATE_SELECTED',
        [],
        'Single eligible candidate Issue #' + selected.number + ' selected.'
      );
    }

    return result(
      null,
      'AMBIGUOUS_ORDERING',
      [{ code: 'SEQUENCE_EXHAUSTED', reason: 'Multiple eligible candidates exist (' + eligibleCandidates.map(c => '#' + c.number).join(', ') + '), but none are defined in sequenceSource.' }],
      'Add eligible candidate issues to sequenceSource or reduce eligible candidates.'
    );
  }

  // No sequenceSource configured
  if (eligibleCandidates.length === 1) {
    const selected = eligibleCandidates[0];
    return result(
      selected,
      'CANDIDATE_SELECTED',
      [],
      'Single eligible candidate Issue #' + selected.number + ' selected.'
    );
  }

  // Multiple candidates and no sequenceSource -> explicit ambiguous ordering block
  return result(
    null,
    'AMBIGUOUS_ORDERING',
    [{
      code: 'MULTIPLE_ELIGIBLE_CANDIDATES',
      reason: 'Multiple eligible candidates found (' + eligibleCandidates.map(c => '#' + c.number).join(', ') + ') without a sequenceSource configured.'
    }],
    'Configure sequenceSource or resolve/unmark ready issues so exactly one candidate is eligible.'
  );
}
