/**
 * Pure, deterministic Issue selection and dependency checks.
 *
 * Evaluates candidate Issues against readiness labels, contracts, human readiness,
 * dependency status, active claims/sessions/PRs, and sequence ordering.
 * Pure decision layer: no network calls, state persistence, or side effects.
 */
import { validateConfig } from './config.mjs';
import { validateIssueContract, extractMarkdownSections } from './contracts.mjs';
import { sessionDisposition } from './preflight.mjs';

function compareText(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function canonicalizeBlockers(blockers) {
  return [...blockers].sort((a, b) => {
    const numA = a.issueNumber ?? -1;
    const numB = b.issueNumber ?? -1;
    if (numA !== numB) return numA - numB;
    return (
      compareText(a.code, b.code) ||
      compareText(a.path ?? '', b.path ?? '') ||
      compareText(a.reason ?? '', b.reason ?? '')
    );
  });
}

function canonicalizeEvaluatedCandidates(evaluated) {
  return [...evaluated].sort((a, b) => {
    const numA = a.number ?? -1;
    const numB = b.number ?? -1;
    if (numA !== numB) return numA - numB;
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    return compareText(JSON.stringify(a.blockers), JSON.stringify(b.blockers));
  });
}

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
  const depIssue = issues.find((item) => item && typeof item === 'object' && Number(item.number) === depNumber);

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

    if (reasonRaw === 'completed') {
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
 * Check if a pull request is merged.
 * @param {object} pr
 * @returns {boolean}
 */
export function isMergedPR(pr) {
  return Boolean(pr && (pr.merged === true || Boolean(pr.merged_at)));
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
  return Array.from(numbers).sort((a, b) => a - b);
}

/**
 * Deterministically order eligible candidate issues.
 * @param {Array<object>} eligible
 * @param {object} config
 * @param {object} snapshot
 * @returns {{ valid: boolean, ordered?: Array<object>, code?: string, reason?: string }}
 */
export function orderCandidates(eligible, config, snapshot) {
  if (eligible.length <= 1) {
    return { valid: true, ordered: eligible };
  }

  if (config?.sequenceSource) {
    const rawSeq = snapshot?.sequence;
    if (!Array.isArray(rawSeq) || rawSeq.length === 0) {
      return {
        valid: false,
        code: 'BLOCK_AMBIGUOUS_CHOICE',
        reason: 'Configured sequenceSource requires a valid non-empty sequence array in snapshot.'
      };
    }

    const sequenceList = [];
    const seen = new Set();
    for (const item of rawSeq) {
      const num = Number(item);
      if (!Number.isInteger(num) || num < 1) {
        return {
          valid: false,
          code: 'BLOCK_AMBIGUOUS_CHOICE',
          reason: 'Snapshot sequence contains an invalid issue identifier (' + item + ').'
        };
      }
      if (seen.has(num)) {
        return {
          valid: false,
          code: 'BLOCK_AMBIGUOUS_CHOICE',
          reason: 'Snapshot sequence contains duplicate issue identifier #' + num + '.'
        };
      }
      seen.add(num);
      sequenceList.push(num);
    }

    const missingInSeq = eligible.filter((cand) => !seen.has(cand.number));
    if (missingInSeq.length > 0) {
      return {
        valid: false,
        code: 'BLOCK_AMBIGUOUS_CHOICE',
        reason: 'Configured sequenceSource does not provide a sequence rank for all eligible candidates (missing #' + missingInSeq.map((c) => c.number).join(', #') + ').'
      };
    }

    const ordered = [...eligible].sort((a, b) => sequenceList.indexOf(a.number) - sequenceList.indexOf(b.number));
    return { valid: true, ordered };
  }

  return {
    valid: false,
    code: 'BLOCK_AMBIGUOUS_CHOICE',
    reason: 'Multiple eligible candidates exist without a configured sequenceSource to establish a safe ordering.'
  };
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

  const pullRequests = snapshot && (Array.isArray(snapshot.pullRequests) ? snapshot.pullRequests : Array.isArray(snapshot.openManagedPullRequests) ? snapshot.openManagedPullRequests : null);
  const sessions = snapshot && Array.isArray(snapshot.sessions) ? snapshot.sessions : null;
  const claims = snapshot && Array.isArray(snapshot.claims) ? snapshot.claims : null;
  const issues = snapshot && Array.isArray(snapshot.issues) ? snapshot.issues : null;

  if (!snapshot || snapshot.snapshotComplete !== true || !issues || !pullRequests || !sessions || !claims) {
    return {
      selectedCandidate: null,
      decisionCode: 'BLOCK_INCOMPLETE_SNAPSHOT',
      reason: 'The API snapshot is incomplete or unverified. Refusing selection.',
      blockers: [{ code: 'INCOMPLETE_SNAPSHOT', message: 'snapshotComplete is not true or required snapshot collections (issues, pullRequests, sessions, claims) are missing or not arrays.' }],
      evaluatedCandidates: [],
      nextAction: 'Re-run snapshot collection until preflight verification succeeds.',
      safeToDispatch: false
    };
  }

  // Validate active-work collections for malformed/unidentifiable records
  const globalActiveWorkBlockers = [];

  for (const pr of pullRequests) {
    if (!pr || typeof pr !== 'object') {
      globalActiveWorkBlockers.push({ issueNumber: null, code: 'BLOCK_AMBIGUOUS_ACTIVE_WORK', reason: 'Snapshot contains a non-object pull request record.' });
      continue;
    }
    if (!isMergedPR(pr)) {
      const prNumber = Number(pr.number);
      const linked = extractPRLinkedIssueNumbers(pr);
      if ((!Number.isInteger(prNumber) || prNumber < 1) && linked.length === 0) {
        globalActiveWorkBlockers.push({ issueNumber: null, code: 'BLOCK_AMBIGUOUS_ACTIVE_WORK', reason: 'Snapshot contains an unidentifiable unresolved pull request record.' });
      }
    }
  }

  for (const s of sessions) {
    if (!s || typeof s !== 'object') {
      globalActiveWorkBlockers.push({ issueNumber: null, code: 'BLOCK_AMBIGUOUS_ACTIVE_WORK', reason: 'Snapshot contains a non-object provider session record.' });
      continue;
    }
    const disp = sessionDisposition(s).disposition;
    if (disp === 'blocking') {
      const sessName = typeof s.name === 'string' && s.name.trim() ? s.name : null;
      const sessIssue = Number(s.issueNumber ?? s.issue_number);
      const prRef = s?.outputs?.find((o) => o?.pullRequest?.url)?.pullRequest;
      if (!sessName && (!Number.isInteger(sessIssue) || sessIssue < 1) && !prRef?.url) {
        globalActiveWorkBlockers.push({ issueNumber: null, code: 'BLOCK_AMBIGUOUS_ACTIVE_WORK', reason: 'Snapshot contains an unidentifiable unresolved provider session record.' });
      }
    }
  }

  for (const c of claims) {
    if (!c || typeof c !== 'object') {
      globalActiveWorkBlockers.push({ issueNumber: null, code: 'BLOCK_AMBIGUOUS_ACTIVE_WORK', reason: 'Snapshot contains a non-object claim record.' });
      continue;
    }
    if (c.reconciled !== true) {
      const claimId = typeof c.claimId === 'string' && c.claimId.trim() ? c.claimId : null;
      const claimIssue = Number(c.issueNumber ?? c.issue_number);
      if (!claimId && (!Number.isInteger(claimIssue) || claimIssue < 1)) {
        globalActiveWorkBlockers.push({ issueNumber: null, code: 'BLOCK_AMBIGUOUS_ACTIVE_WORK', reason: 'Snapshot contains an unidentifiable active claim record.' });
      }
    }
  }

  if (globalActiveWorkBlockers.length > 0) {
    return {
      selectedCandidate: null,
      decisionCode: 'BLOCK_AMBIGUOUS_ACTIVE_WORK',
      reason: 'Snapshot contains malformed or unidentifiable active work records in pullRequests, sessions, or claims.',
      blockers: canonicalizeBlockers(globalActiveWorkBlockers),
      evaluatedCandidates: [],
      nextAction: 'Fix or reconcile malformed active-work records before re-running selection.',
      safeToDispatch: false
    };
  }

  const unresolvedPRs = pullRequests.filter((pr) => pr && typeof pr === 'object' && !isMergedPR(pr));
  const activeSessions = sessions.filter((s) => s && typeof s === 'object' && sessionDisposition(s).disposition === 'blocking');
  const activeClaims = claims.filter((c) => c && typeof c === 'object' && c.reconciled !== true);

  const readyLabel = config.labels.ready;

  const evaluatedCandidates = [];
  const eligibleCandidates = [];
  let malformedIssuesFound = false;

  const seenIssueNumbers = new Set();
  for (const item of issues) {
    if (item && typeof item === 'object' && Number.isInteger(item.number) && item.number > 0) {
      if (seenIssueNumbers.has(item.number)) {
        malformedIssuesFound = true;
        evaluatedCandidates.push({
          number: item.number,
          eligible: false,
          blockers: [{ code: 'BLOCK_AMBIGUOUS_CANDIDATE', reason: 'Snapshot contains duplicate issue records for issue #' + item.number + '.' }]
        });
      } else {
        seenIssueNumbers.add(item.number);
      }
    }
  }

  for (const item of issues) {
    if (!item || typeof item !== 'object') {
      malformedIssuesFound = true;
      evaluatedCandidates.push({
        number: null,
        eligible: false,
        blockers: [{ code: 'BLOCK_AMBIGUOUS_CANDIDATE', reason: 'Snapshot contains a non-object issue entry.' }]
      });
      continue;
    }

    const candidateNumber = item.number;
    if (!Number.isInteger(candidateNumber) || candidateNumber < 1) {
      malformedIssuesFound = true;
      evaluatedCandidates.push({
        number: null,
        eligible: false,
        blockers: [{ code: 'BLOCK_AMBIGUOUS_CANDIDATE', reason: 'Snapshot contains an issue with a missing or invalid issue number.' }]
      });
      continue;
    }

    const stateRaw = String(item.state ?? '').toLowerCase().trim();
    if (!stateRaw || (stateRaw !== 'open' && stateRaw !== 'closed')) {
      malformedIssuesFound = true;
      evaluatedCandidates.push({
        number: candidateNumber,
        eligible: false,
        blockers: [{ code: 'BLOCK_AMBIGUOUS_CANDIDATE', reason: 'Issue #' + candidateNumber + ' has a missing or unknown state (' + (item.state ?? 'unspecified') + ').' }]
      });
      continue;
    }

    if (stateRaw !== 'open') continue;
    if (!hasLabel(item, readyLabel)) continue;

    const candidateBlockers = [];

    const contractResult = validateIssueContract(item, { config });
    if (!contractResult.valid) {
      for (const err of contractResult.errors) {
        candidateBlockers.push({
          code: 'BLOCK_CONTRACT_INVALID',
          path: err.path,
          reason: 'Issue contract violation: ' + err.message
        });
      }
    }

    const humanGate = evaluateHumanReadiness(item, config);
    if (!humanGate.verified) {
      candidateBlockers.push({
        code: 'BLOCK_HUMAN_READINESS_REQUIRED',
        reason: humanGate.reason
      });
    }

    const matchingUnresolvedPR = unresolvedPRs.find((pr) => extractPRLinkedIssueNumbers(pr).includes(candidateNumber));
    if (matchingUnresolvedPR) {
      candidateBlockers.push({
        code: 'WAIT_OPEN_PR',
        reason: 'Candidate Issue #' + candidateNumber + ' is linked to an unresolved pull request #' + (matchingUnresolvedPR.number ?? 'unknown') + '.'
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
        if (prNumMatch && unresolvedPRs.some((pr) => pr.number === Number(prNumMatch[1]) && extractPRLinkedIssueNumbers(pr).includes(candidateNumber))) {
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

    // Deduplicate active work items that do not belong to candidateNumber
    const otherWorkItems = new Set();

    for (const pr of unresolvedPRs) {
      const linked = extractPRLinkedIssueNumbers(pr);
      const otherLinked = linked.filter((num) => num !== candidateNumber);
      if (otherLinked.length > 0) {
        otherLinked.forEach((num) => otherWorkItems.add('issue:' + num));
      } else if (!linked.includes(candidateNumber) && pr.number) {
        otherWorkItems.add('pr:' + pr.number);
      }
    }

    for (const s of activeSessions) {
      const sessionIssue = Number(s?.issueNumber || s?.issue_number);
      if (sessionIssue && sessionIssue !== candidateNumber) {
        otherWorkItems.add('issue:' + sessionIssue);
      } else if (!sessionIssue && s?.name) {
        otherWorkItems.add('session:' + s.name);
      }
    }

    for (const c of activeClaims) {
      const claimIssue = Number(c?.issueNumber || c?.issue_number);
      if (claimIssue && claimIssue !== candidateNumber) {
        otherWorkItems.add('issue:' + claimIssue);
      } else if (!claimIssue && c?.claimId) {
        otherWorkItems.add('claim:' + c.claimId);
      }
    }

    const otherActiveWorkCount = otherWorkItems.size;
    if (otherActiveWorkCount >= maxSessions) {
      candidateBlockers.push({
        code: 'WAIT_CONCURRENCY_LIMIT',
        reason: 'Repository active work count (' + otherActiveWorkCount + ') meets or exceeds maxConcurrentSessions (' + maxSessions + ').'
      });
    }

    const depNumbers = extractDependencyIssueNumbers(item);
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
      eligibleCandidates.push(item);
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

  const canonicalEvaluated = canonicalizeEvaluatedCandidates(evaluatedCandidates);
  const allBlockers = canonicalizeBlockers(
    canonicalEvaluated.flatMap((e) =>
      e.blockers.map((b) => ({ issueNumber: e.number, code: b.code, path: b.path, reason: b.reason }))
    )
  );

  if (malformedIssuesFound) {
    return {
      selectedCandidate: null,
      decisionCode: 'BLOCK_AMBIGUOUS_CANDIDATE',
      reason: 'Snapshot contains malformed or duplicate Issue records.',
      blockers: allBlockers,
      evaluatedCandidates: canonicalEvaluated,
      nextAction: 'Fix malformed or duplicate Issue records before re-running selection.',
      safeToDispatch: false
    };
  }

  if (eligibleCandidates.length === 0) {
    const firstCode = allBlockers[0]?.code;
    const isUniformCode = allBlockers.length > 0 && allBlockers.every((b) => b.code === firstCode);
    const decisionCode = isUniformCode
      ? firstCode
      : 'NO_ELIGIBLE_CANDIDATE';

    return {
      selectedCandidate: null,
      decisionCode,
      reason: allBlockers.length === 0
        ? 'No open Issue has the configured readiness label "' + readyLabel + '".'
        : 'No eligible candidate Issue passed all eligibility, contract, human readiness, and dependency checks.',
      blockers: allBlockers,
      evaluatedCandidates: canonicalEvaluated,
      nextAction: 'Resolve candidate blockers before re-running selection.',
      safeToDispatch: false
    };
  }

  const orderResult = orderCandidates(eligibleCandidates, config, snapshot);
  if (!orderResult.valid) {
    const combinedBlockers = canonicalizeBlockers([
      ...allBlockers,
      { issueNumber: null, code: orderResult.code, reason: orderResult.reason }
    ]);

    return {
      selectedCandidate: null,
      decisionCode: orderResult.code,
      reason: orderResult.reason,
      blockers: combinedBlockers,
      evaluatedCandidates: canonicalEvaluated,
      nextAction: 'Resolve sequence ordering ambiguities before re-running selection.',
      safeToDispatch: false
    };
  }

  const selected = orderResult.ordered[0];

  return {
    selectedCandidate: {
      number: selected.number,
      title: typeof selected.title === 'string' ? selected.title : '',
      labels: extractLabelNames(selected.labels)
    },
    decisionCode: 'CANDIDATE_SELECTED',
    reason: 'Candidate Issue #' + selected.number + ' selected for execution.',
    blockers: [],
    evaluatedCandidates: canonicalEvaluated,
    nextAction: 'Create claim for Issue #' + selected.number + ' and request dispatch confirmation.',
    safeToDispatch: false
  };
}
