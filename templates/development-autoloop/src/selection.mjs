/**
 * Pure, deterministic Issue selection and dependency checks.
 *
 * Evaluates candidate Issues against readiness labels, contracts, human readiness,
 * dependency status, active claims/sessions/PRs, and sequence ordering.
 * Pure decision layer: no network calls, state persistence, or side effects.
 */
import { validateConfig } from './config.mjs';
import { validateIssueContract, extractMarkdownSections } from './contracts.mjs';
import { isOpenPullRequest, sessionDisposition } from './preflight.mjs';

/**
 * Extract label names from label strings or objects.
 * @param {Array<string|object>} labels
 * @returns {Array<string>}
 */
export function extractLabelNames(labels) {
  if (!Array.isArray(labels)) return [];
  return labels
    .map((item) => {
      if (typeof item === 'string') return item.trim();
      if (item && typeof item === 'object' && typeof item.name === 'string') return item.name.trim();
      return null;
    })
    .filter(Boolean);
}

/**
 * Check if an issue has a specific label.
 * @param {object} issue
 * @param {string} targetLabel
 * @returns {boolean}
 */
export function hasLabel(issue, targetLabel) {
  if (!targetLabel) return false;
  const names = extractLabelNames(issue?.labels);
  return names.some((name) => name.toLowerCase() === String(targetLabel).toLowerCase());
}

/**
 * Extract dependency issue numbers from structured field or body section.
 * @param {object} issue
 * @returns {Array<number>} sorted unique list of issue numbers
 */
export function extractDependencyIssueNumbers(issue) {
  const dependencyNumbers = new Set();

  if (Array.isArray(issue?.dependencies)) {
    for (const item of issue.dependencies) {
      if (typeof item === 'number' && Number.isInteger(item) && item > 0) {
        dependencyNumbers.add(item);
      } else if (typeof item === 'string') {
        const match = item.match(/#?(\d+)/);
        if (match) dependencyNumbers.add(Number(match[1]));
      } else if (item && typeof item === 'object' && Number.isInteger(Number(item.number))) {
        dependencyNumbers.add(Number(item.number));
      }
    }
  }

  if (typeof issue?.body === 'string') {
    const sections = extractMarkdownSections(issue.body);
    const depContent = sections.get('dependencies');

    if (depContent && depContent.trim() !== '') {
      const trimmed = depContent.trim();
      const isNoneText = /^(none|n\/a|no dependencies|nil|0|-)\.?$/i.test(trimmed);

      if (!isNoneText) {
        const matches = trimmed.matchAll(/(?:#(\d+)|https?:\/\/[^\s/]+\/[^\s/]+\/[^\s/]+\/issues\/(\d+))/gi);
        for (const match of matches) {
          const numStr = match[1] || match[2];
          if (numStr) {
            const num = Number(numStr);
            if (Number.isInteger(num) && num > 0 && num !== issue.number) {
              dependencyNumbers.add(num);
            }
          }
        }
      }
    }
  }

  return Array.from(dependencyNumbers).sort((a, b) => a - b);
}

/**
 * Evaluate human readiness gate for a candidate issue.
 * @param {object} issue
 * @param {object} config
 * @returns {{ verified: boolean, reason?: string }}
 */
export function evaluateHumanReadiness(issue, config) {
  if (config?.humanReadinessRequired !== true) {
    return { verified: true };
  }

  if (issue?.humanReadiness === true || issue?.humanReady === true || issue?.humanReadinessVerified === true) {
    return { verified: true };
  }

  if (issue?.humanReadiness && typeof issue.humanReadiness === 'object') {
    if (issue.humanReadiness.verified === true || issue.humanReadiness.ready === true) {
      return { verified: true };
    }
  }

  const names = extractLabelNames(issue?.labels);
  const humanReadyLabel = config?.labels?.humanReady || 'human-ready';
  if (names.some((name) => name.toLowerCase() === humanReadyLabel.toLowerCase() || name.toLowerCase() === 'human-approved')) {
    return { verified: true };
  }

  return {
    verified: false,
    reason: 'Candidate Issue #' + issue?.number + ' lacks explicit human-readiness evidence.'
  };
}

/**
 * Evaluate the completion state of a dependency issue.
 * @param {number} depNumber
 * @param {object} snapshot
 * @returns {{ valid: boolean, code?: string, reason?: string }}
 */
export function evaluateDependencyState(depNumber, snapshot) {
  const issues = Array.isArray(snapshot?.issues) ? snapshot.issues : [];
  const depIssue = issues.find((item) => Number(item?.number) === depNumber);

  if (!depIssue) {
    return {
      valid: false,
      code: 'BLOCK_DEPENDENCY_MISSING',
      reason: 'Dependency Issue #' + depNumber + ' is missing from snapshot.'
    };
  }

  const state = String(depIssue.state ?? '').toLowerCase();
  if (state === 'open') {
    return {
      valid: false,
      code: 'BLOCK_DEPENDENCY_UNSATISFIED',
      reason: 'Dependency Issue #' + depNumber + ' is still open.'
    };
  }

  if (state === 'closed') {
    const reasonRaw = String(depIssue.state_reason ?? depIssue.completionReason ?? '').toLowerCase().trim();

    if (reasonRaw === 'not_planned' || depIssue.not_planned === true) {
      return {
        valid: false,
        code: 'BLOCK_DEPENDENCY_NOT_PLANNED',
        reason: 'Dependency Issue #' + depNumber + ' was closed as not planned.'
      };
    }

    if (reasonRaw === 'duplicate' || depIssue.duplicate === true) {
      return {
        valid: false,
        code: 'BLOCK_DEPENDENCY_DUPLICATE',
        reason: 'Dependency Issue #' + depNumber + ' was closed as duplicate.'
      };
    }

    if (reasonRaw === 'completed' || depIssue.completed === true) {
      return { valid: true };
    }

    return {
      valid: false,
      code: 'BLOCK_DEPENDENCY_UNKNOWN_REASON',
      reason: 'Dependency Issue #' + depNumber + ' has an unverified or unknown closure reason (' + (reasonRaw || 'unspecified') + ').'
    };
  }

  return {
    valid: false,
    code: 'BLOCK_DEPENDENCY_AMBIGUOUS',
    reason: 'Dependency Issue #' + depNumber + ' has an unrecognized state (' + (depIssue.state ?? 'unknown') + ').'
  };
}

/**
 * Extract all issue numbers referenced in a PR body or issue_number field.
 * @param {object} pr
 * @returns {Array<number>}
 */
function extractPRLinkedIssueNumbers(pr) {
  const numbers = new Set();
  if (Number.isInteger(Number(pr?.issue_number)) && Number(pr.issue_number) > 0) {
    numbers.add(Number(pr.issue_number));
  }
  if (Number.isInteger(Number(pr?.issueNumber)) && Number(pr.issueNumber) > 0) {
    numbers.add(Number(pr.issueNumber));
  }

  if (typeof pr?.body === 'string') {
    const matches = pr.body.matchAll(/(?:#(\d+)|https?:\/\/[^\s/]+\/[^\s/]+\/[^\s/]+\/issues\/(\d+))/gi);
    for (const match of matches) {
      const numStr = match[1] || match[2];
      if (numStr) numbers.add(Number(numStr));
    }
  }
  return Array.from(numbers);
}

/**
 * Deterministically order eligible candidate issues.
 * @param {Array<object>} eligible
 * @param {object} config
 * @param {object} snapshot
 * @returns {Array<object>}
 */
export function orderCandidates(eligible, config, snapshot) {
  if (eligible.length <= 1) return eligible;

  let sequenceList = null;
  if (config?.sequenceSource && Array.isArray(snapshot?.sequence)) {
    sequenceList = snapshot.sequence.map(Number).filter((n) => Number.isInteger(n) && n > 0);
  }

  return [...eligible].sort((a, b) => {
    if (sequenceList && sequenceList.length > 0) {
      const indexA = sequenceList.indexOf(a.number);
      const indexB = sequenceList.indexOf(b.number);

      if (indexA !== -1 && indexB !== -1) return indexA - indexB;
      if (indexA !== -1) return -1;
      if (indexB !== -1) return 1;
    }
    return a.number - b.number;
  });
}

/**
 * Select exactly one eligible Issue for automation execution using pure deterministic evaluation.
 *
 * @param {object} snapshot
 * @param {object} configInput
 * @returns {object} decision report
 */
export function selectCandidateIssue(snapshot, configInput) {
  const configCheck = validateConfig(configInput);
  if (!configCheck.valid) {
    return {
      selectedCandidate: null,
      decisionCode: 'BLOCK_INVALID_CONFIG',
      reason: 'Configuration is invalid.',
      blockers: configCheck.errors.map((e) => ({ path: e.path, code: e.code, message: e.message })),
      evaluatedCandidates: [],
      nextAction: 'Fix configuration validation errors.',
      safeToDispatch: false
    };
  }
  const config = configCheck.config;

  if (!snapshot || snapshot.snapshotComplete !== true || !Array.isArray(snapshot.issues)) {
    return {
      selectedCandidate: null,
      decisionCode: 'BLOCK_INCOMPLETE_SNAPSHOT',
      reason: 'The API snapshot is incomplete or unverified. Refusing selection.',
      blockers: [{ code: 'INCOMPLETE_SNAPSHOT', message: 'snapshotComplete is not true or issues array is missing.' }],
      evaluatedCandidates: [],
      nextAction: 'Re-run snapshot collection until preflight verification succeeds.',
      safeToDispatch: false
    };
  }

  const pullRequests = Array.isArray(snapshot.pullRequests)
    ? snapshot.pullRequests
    : Array.isArray(snapshot.openManagedPullRequests)
    ? snapshot.openManagedPullRequests
    : [];
  const openPRs = pullRequests.filter(isOpenPullRequest);

  const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
  const activeSessions = sessions.filter((s) => sessionDisposition(s).disposition === 'blocking');

  const claims = Array.isArray(snapshot.claims) ? snapshot.claims : [];
  const activeClaims = claims.filter((c) => c && c.reconciled !== true);

  const readyLabel = config.labels.ready;
  const issues = snapshot.issues;

  const candidateIssues = issues.filter((issue) => {
    if (!issue || typeof issue !== 'object') return false;
    if (String(issue.state ?? '').toLowerCase() !== 'open') return false;
    return hasLabel(issue, readyLabel);
  });

  if (candidateIssues.length === 0) {
    return {
      selectedCandidate: null,
      decisionCode: 'NO_ELIGIBLE_CANDIDATE',
      reason: 'No open Issue has the configured readiness label "' + readyLabel + '".',
      blockers: [],
      evaluatedCandidates: [],
      nextAction: 'Ensure governing Issues are open, contract-compliant, and marked with "' + readyLabel + '".',
      safeToDispatch: false
    };
  }

  const evaluatedCandidates = [];
  const eligibleCandidates = [];

  for (const candidate of candidateIssues) {
    const candidateNumber = candidate.number;

    if (!Number.isInteger(candidateNumber) || candidateNumber < 1) {
      evaluatedCandidates.push({
        number: candidateNumber ?? null,
        eligible: false,
        blockers: [{ code: 'BLOCK_AMBIGUOUS_CANDIDATE', reason: 'Candidate Issue has no valid issue number.' }]
      });
      continue;
    }

    const candidateBlockers = [];

    const contractResult = validateIssueContract(candidate, { config });
    if (!contractResult.valid) {
      for (const err of contractResult.errors) {
        candidateBlockers.push({
          code: 'BLOCK_CONTRACT_INVALID',
          path: err.path,
          reason: 'Issue contract violation: ' + err.message
        });
      }
    }

    const humanGate = evaluateHumanReadiness(candidate, config);
    if (!humanGate.verified) {
      candidateBlockers.push({
        code: 'BLOCK_HUMAN_READINESS_REQUIRED',
        reason: humanGate.reason
      });
    }

    const matchingPR = openPRs.find((pr) => extractPRLinkedIssueNumbers(pr).includes(candidateNumber));
    if (matchingPR) {
      candidateBlockers.push({
        code: 'WAIT_OPEN_PR',
        reason: 'Candidate Issue #' + candidateNumber + ' already has an open pull request #' + (matchingPR.number ?? 'unknown') + '.'
      });
    }

    const matchingClaim = activeClaims.find((c) => Number(c.issueNumber ?? c.issue_number) === candidateNumber);
    if (matchingClaim) {
      candidateBlockers.push({
        code: 'BLOCK_ACTIVE_CLAIM',
        reason: 'Candidate Issue #' + candidateNumber + ' has an active or un-reconciled claim ID ' + (matchingClaim.claimId ?? 'unknown') + '.'
      });
    }

    const matchingSession = activeSessions.find((s) => {
      const prRef = s?.outputs?.find((o) => o?.pullRequest?.url)?.pullRequest;
      const sessionIssue = s?.issueNumber || s?.issue_number;
      if (Number(sessionIssue) === candidateNumber) return true;
      if (prRef?.url) {
        const prNumMatch = prRef.url.match(/\/pull\/(\d+)/);
        if (prNumMatch && openPRs.some((pr) => pr.number === Number(prNumMatch[1]) && extractPRLinkedIssueNumbers(pr).includes(candidateNumber))) {
          return true;
        }
      }
      return false;
    });

    if (matchingSession) {
      candidateBlockers.push({
        code: 'BLOCK_ACTIVE_SESSION',
        reason: 'Candidate Issue #' + candidateNumber + ' is associated with an active provider session ' + (matchingSession.name ?? 'unknown') + '.'
      });
    }

    const maxSessions = config.maxConcurrentSessions ?? 1;
    const otherOpenPRs = openPRs.filter((pr) => !extractPRLinkedIssueNumbers(pr).includes(candidateNumber));
    const otherActiveSessions = activeSessions.filter((s) => {
      const sessionIssue = s?.issueNumber || s?.issue_number;
      return Number(sessionIssue) !== candidateNumber;
    });
    const otherActiveWorkCount = otherOpenPRs.length + otherActiveSessions.length;

    if (otherActiveWorkCount >= maxSessions) {
      candidateBlockers.push({
        code: 'WAIT_CONCURRENCY_LIMIT',
        reason: 'Repository active work count (' + otherActiveWorkCount + ') meets or exceeds maxConcurrentSessions (' + maxSessions + ').'
      });
    }

    const depNumbers = extractDependencyIssueNumbers(candidate);
    for (const depNum of depNumbers) {
      const depEval = evaluateDependencyState(depNum, snapshot);
      if (!depEval.valid) {
        candidateBlockers.push({
          code: depEval.code,
          reason: depEval.reason
        });
      }
    }

    if (candidateBlockers.length === 0) {
      eligibleCandidates.push(candidate);
      evaluatedCandidates.push({
        number: candidateNumber,
        eligible: true,
        blockers: []
      });
    } else {
      evaluatedCandidates.push({
        number: candidateNumber,
        eligible: false,
        blockers: candidateBlockers
      });
    }
  }

  if (eligibleCandidates.length === 0) {
    const allBlockers = evaluatedCandidates.flatMap((e) =>
      e.blockers.map((b) => ({ issueNumber: e.number, code: b.code, reason: b.reason }))
    );

    const firstCode = allBlockers[0]?.code;
    const isUniformCode = allBlockers.length > 0 && allBlockers.every((b) => b.code === firstCode);
    const decisionCode = isUniformCode ? firstCode : 'NO_ELIGIBLE_CANDIDATE';

    return {
      selectedCandidate: null,
      decisionCode,
      reason: 'No eligible candidate Issue passed all eligibility, contract, human readiness, and dependency checks.',
      blockers: allBlockers,
      evaluatedCandidates,
      nextAction: 'Resolve candidate blockers before re-running selection.',
      safeToDispatch: false
    };
  }

  const ordered = orderCandidates(eligibleCandidates, config, snapshot);
  const selected = ordered[0];

  return {
    selectedCandidate: {
      number: selected.number,
      title: typeof selected.title === 'string' ? selected.title : '',
      labels: extractLabelNames(selected.labels)
    },
    decisionCode: 'CANDIDATE_SELECTED',
    reason: 'Candidate Issue #' + selected.number + ' selected for execution.',
    blockers: [],
    evaluatedCandidates,
    nextAction: 'Create claim for Issue #' + selected.number + ' and request dispatch confirmation.',
    safeToDispatch: false
  };
}
