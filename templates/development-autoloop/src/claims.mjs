/**
 * Durable claims, compare-and-swap (CAS) state store transitions,
 * and stale-claim recovery.
 */

export const CLAIM_SCHEMA_VERSION = 1;

export const CLAIM_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE',
  RELEASED: 'RELEASED',
  RECLAIMED: 'RECLAIMED',
  EXPIRED: 'EXPIRED'
});

export const RECONCILIATION_STATUS = Object.freeze({
  PENDING: 'PENDING',
  RECONCILED: 'RECONCILED',
  BLOCKED: 'BLOCKED'
});

export const CLAIM_CODES = Object.freeze({
  CLAIM_ACQUIRED: 'CLAIM_ACQUIRED',
  CLAIM_ALREADY_EXISTS: 'CLAIM_ALREADY_EXISTS',
  CLAIM_BLOCKED_STALE_UNRECONCILED: 'CLAIM_BLOCKED_STALE_UNRECONCILED',
  CAS_CONFLICT_EXHAUSTED: 'CAS_CONFLICT_EXHAUSTED',
  CLAIM_INVALID_STATE: 'CLAIM_INVALID_STATE',
  CLAIM_PERSISTENCE_FAILED: 'CLAIM_PERSISTENCE_FAILED',
  CLAIM_RECOVERY_BLOCKED: 'CLAIM_RECOVERY_BLOCKED',
  CLAIM_RECOVERED: 'CLAIM_RECOVERED',
  CLAIM_NOT_FOUND: 'CLAIM_NOT_FOUND'
});

const VALID_STATUSES = new Set(Object.values(CLAIM_STATUS));
const VALID_RECONCILIATION_STATUSES = new Set(Object.values(RECONCILIATION_STATUS));

function pointer(segments) {
  if (!segments || segments.length === 0) return '/';
  return '/' + segments.map((part) => String(part).replace(/~/g, '~0').replace(/\//g, '~1')).join('/');
}

function diagnostic(path, code, message) {
  return { path: pointer(path), code, message };
}

function compareText(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function sortDiagnostics(errors) {
  return errors.sort((a, b) =>
    compareText(a.path, b.path) ||
    compareText(a.code, b.code) ||
    compareText(a.message, b.message)
  );
}

function isValidIsoTimestamp(str) {
  if (typeof str !== 'string' || !str.trim()) return false;
  const time = Date.parse(str);
  return Number.isFinite(time);
}

/**
 * Validate repository identity structure.
 * Accepts { owner: string, repo: string } or string 'owner/repo'.
 * @param {*} repoInput
 * @returns {{ valid: boolean, repository: { owner: string, repo: string }|null, error?: object }}
 */
export function normalizeRepositoryIdentity(repoInput) {
  if (typeof repoInput === 'string' && repoInput.trim()) {
    const parts = repoInput.trim().split('/');
    if (parts.length === 2 && parts[0].trim() && parts[1].trim()) {
      return {
        valid: true,
        repository: { owner: parts[0].trim().toLowerCase(), repo: parts[1].trim().toLowerCase() }
      };
    }
  } else if (repoInput && typeof repoInput === 'object' && !Array.isArray(repoInput)) {
    const owner = typeof repoInput.owner === 'string' ? repoInput.owner.trim().toLowerCase() : '';
    const repo = typeof repoInput.repo === 'string' ? repoInput.repo.trim().toLowerCase() : '';
    if (owner && repo) {
      return { valid: true, repository: { owner, repo } };
    }
  }
  return { valid: false, repository: null };
}

/**
 * Validate a versioned Claim record.
 * Fails closed on missing fields, invalid types, invalid timestamps, or unknown enum values.
 *
 * @param {*} record
 * @returns {{ valid: boolean, errors: Array<{ path: string, code: string, message: string }> }}
 */
export function validateClaimRecord(record) {
  const errors = [];

  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return {
      valid: false,
      errors: [diagnostic([], 'INVALID_CLAIM_RECORD', 'Claim record must be a non-null object.')]
    };
  }

  if (record.schemaVersion !== CLAIM_SCHEMA_VERSION) {
    errors.push(diagnostic(['schemaVersion'], 'INVALID_SCHEMA_VERSION', 'schemaVersion must be ' + CLAIM_SCHEMA_VERSION + '.'));
  }

  if (typeof record.claimId !== 'string' || !record.claimId.trim()) {
    errors.push(diagnostic(['claimId'], 'INVALID_CLAIM_ID', 'claimId must be a non-empty string.'));
  }

  const repoCheck = normalizeRepositoryIdentity(record.repository);
  if (!repoCheck.valid) {
    errors.push(diagnostic(['repository'], 'INVALID_REPOSITORY_IDENTITY', 'repository must specify valid owner and repo strings.'));
  }

  const issueNum = Number(record.issueNumber);
  if (!Number.isInteger(issueNum) || issueNum < 1) {
    errors.push(diagnostic(['issueNumber'], 'INVALID_ISSUE_NUMBER', 'issueNumber must be a positive integer.'));
  }

  if (typeof record.owner !== 'string' || !record.owner.trim()) {
    errors.push(diagnostic(['owner'], 'INVALID_OWNER', 'owner must be a non-empty string.'));
  }

  if (typeof record.provider !== 'string' || !record.provider.trim()) {
    errors.push(diagnostic(['provider'], 'INVALID_PROVIDER', 'provider must be a non-empty string.'));
  }

  if (record.sessionId !== null && record.sessionId !== undefined && (typeof record.sessionId !== 'string' || !record.sessionId.trim())) {
    errors.push(diagnostic(['sessionId'], 'INVALID_SESSION_ID', 'sessionId must be null or a non-empty string.'));
  }

  if (!isValidIsoTimestamp(record.createdAt)) {
    errors.push(diagnostic(['createdAt'], 'INVALID_TIMESTAMP', 'createdAt must be a valid ISO timestamp string.'));
  }

  if (!isValidIsoTimestamp(record.expiresAt)) {
    errors.push(diagnostic(['expiresAt'], 'INVALID_TIMESTAMP', 'expiresAt must be a valid ISO timestamp string.'));
  }

  if (isValidIsoTimestamp(record.createdAt) && isValidIsoTimestamp(record.expiresAt)) {
    if (Date.parse(record.expiresAt) < Date.parse(record.createdAt)) {
      errors.push(diagnostic(['expiresAt'], 'EXPIRES_BEFORE_CREATED', 'expiresAt cannot be earlier than createdAt.'));
    }
  }

  if (!VALID_STATUSES.has(record.status)) {
    errors.push(diagnostic(['status'], 'UNKNOWN_STATUS', 'status must be one of: ' + Array.from(VALID_STATUSES).join(', ') + '.'));
  }

  if (!VALID_RECONCILIATION_STATUSES.has(record.reconciliationStatus)) {
    errors.push(diagnostic(['reconciliationStatus'], 'UNKNOWN_RECONCILIATION_STATUS', 'reconciliationStatus must be one of: ' + Array.from(VALID_RECONCILIATION_STATUSES).join(', ') + '.'));
  }

  if (!isValidIsoTimestamp(record.updatedAt)) {
    errors.push(diagnostic(['updatedAt'], 'INVALID_TIMESTAMP', 'updatedAt must be a valid ISO timestamp string.'));
  }

  if (record.metadata !== undefined && record.metadata !== null && (typeof record.metadata !== 'object' || Array.isArray(record.metadata))) {
    errors.push(diagnostic(['metadata'], 'INVALID_METADATA', 'metadata must be an object if provided.'));
  }

  const sorted = sortDiagnostics(errors);
  return { valid: sorted.length === 0, errors: sorted };
}

/**
 * Check if a claim record represents an active lock for an issue at a given time.
 * A claim is active if status === ACTIVE and reconciliationStatus !== RECONCILED.
 *
 * @param {object} claim
 * @param {Date|string|number} [now]
 * @returns {{ active: boolean, expired: boolean, reason?: string }}
 */
export function isClaimActive(claim, now = new Date()) {
  const check = validateClaimRecord(claim);
  if (!check.valid) {
    return { active: true, expired: false, reason: 'Claim record is invalid/malformed.' };
  }

  if (claim.status !== CLAIM_STATUS.ACTIVE) {
    return { active: false, expired: false };
  }

  if (claim.reconciliationStatus === RECONCILIATION_STATUS.RECONCILED) {
    return { active: false, expired: false };
  }

  const nowMs = new Date(now).getTime();
  const expiresAtMs = Date.parse(claim.expiresAt);
  const expired = nowMs >= expiresAtMs;

  return {
    active: true,
    expired,
    reason: expired
      ? 'Claim expired at ' + claim.expiresAt + ' but has not been reconciled.'
      : 'Claim is active until ' + claim.expiresAt + '.'
  };
}

/**
 * In-memory Compare-And-Swap State Store Adapter for testing.
 * Implements atomic compare-and-swap state store operations.
 */
export class InMemoryStateAdapter {
  constructor({ claims = [], head = 'v0' } = {}) {
    this.claims = [...claims];
    this.head = head;
    this.readCount = 0;
    this.commitCount = 0;
    this.injectedConflictOnce = false;
    this.injectedAmbiguousWriteOnce = false;
    this.injectedWriteFailureOnce = false;
  }

  async readState() {
    this.readCount++;
    return {
      head: this.head,
      claims: this.claims.map((c) => JSON.parse(JSON.stringify(c)))
    };
  }

  async commitStateChange(expectedHead, newClaims) {
    this.commitCount++;

    if (this.injectedConflictOnce) {
      this.injectedConflictOnce = false;
      return {
        success: false,
        head: this.head,
        reason: 'CAS_CONFLICT',
        ambiguous: false
      };
    }

    if (this.injectedWriteFailureOnce) {
      this.injectedWriteFailureOnce = false;
      return {
        success: false,
        head: this.head,
        reason: 'STORAGE_WRITE_ERROR',
        ambiguous: false
      };
    }

    if (expectedHead !== this.head) {
      return {
        success: false,
        head: this.head,
        reason: 'CAS_CONFLICT',
        ambiguous: false
      };
    }

    if (this.injectedAmbiguousWriteOnce) {
      this.injectedAmbiguousWriteOnce = false;
      // Write actually succeeded in the backing store, but caller receives an ambiguous error
      this.claims = newClaims.map((c) => JSON.parse(JSON.stringify(c)));
      this.head = 'v' + (parseInt(this.head.replace(/\D/g, '') || '0', 10) + 1);
      return {
        success: false,
        head: null,
        reason: 'AMBIGUOUS_WRITE_TIMEOUT',
        ambiguous: true
      };
    }

    this.claims = newClaims.map((c) => JSON.parse(JSON.stringify(c)));
    const versionNum = parseInt(this.head.replace(/\D/g, '') || '0', 10) + 1;
    this.head = 'v' + versionNum;

    return {
      success: true,
      head: this.head,
      ambiguous: false
    };
  }
}

/**
 * Concrete GitHub State Branch Adapter using Git Ref CAS semantics.
 * Stores state on a dedicated, non-default state branch.
 */
export class GitHubStateBranchAdapter {
  constructor({ octokit, repository, stateBranch = 'autoloop-state', defaultBranch = 'main' }) {
    if (!octokit) throw new TypeError('octokit instance is required.');
    const repoCheck = normalizeRepositoryIdentity(repository);
    if (!repoCheck.valid) throw new TypeError('repository owner and repo are required.');

    this.octokit = octokit;
    this.owner = repoCheck.repository.owner;
    this.repo = repoCheck.repository.repo;
    this.stateBranch = stateBranch.trim();
    this.defaultBranch = defaultBranch.trim();

    if (this.stateBranch === this.defaultBranch) {
      throw new Error('State branch ("' + this.stateBranch + '") cannot be the protected default branch ("' + this.defaultBranch + '").');
    }
  }

  async readState() {
    try {
      const refRes = await this.octokit.request('GET /repos/{owner}/{repo}/git/ref/{ref}', {
        owner: this.owner,
        repo: this.repo,
        ref: 'heads/' + this.stateBranch
      });

      const headSha = refRes.data.object.sha;

      const contentRes = await this.octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
        owner: this.owner,
        repo: this.repo,
        path: 'claims.json',
        ref: this.stateBranch
      });

      const content = Buffer.from(contentRes.data.content, 'base64').toString('utf8');
      const parsed = JSON.parse(content);
      const claims = Array.isArray(parsed?.claims) ? parsed.claims : [];

      return { head: headSha, claims };
    } catch (err) {
      if (err.status === 404) {
        return { head: null, claims: [] };
      }
      throw err;
    }
  }

  async commitStateChange(expectedHead, newClaims) {
    try {
      const contentStr = JSON.stringify({ claims: newClaims }, null, 2) + '\n';
      const contentBase64 = Buffer.from(contentStr, 'utf8').toString('base64');

      if (!expectedHead) {
        // First creation of state branch
        const defaultBranchRef = await this.octokit.request('GET /repos/{owner}/{repo}/git/ref/{ref}', {
          owner: this.owner,
          repo: this.repo,
          ref: 'heads/' + this.defaultBranch
        });
        const parentSha = defaultBranchRef.data.object.sha;

        const blobRes = await this.octokit.request('POST /repos/{owner}/{repo}/git/blobs', {
          owner: this.owner,
          repo: this.repo,
          content: contentStr,
          encoding: 'utf-8'
        });

        const treeRes = await this.octokit.request('POST /repos/{owner}/{repo}/git/trees', {
          owner: this.owner,
          repo: this.repo,
          tree: [{ path: 'claims.json', mode: '100644', type: 'blob', sha: blobRes.data.sha }]
        });

        const commitRes = await this.octokit.request('POST /repos/{owner}/{repo}/git/commits', {
          owner: this.owner,
          repo: this.repo,
          message: 'Initialize autoloop claims state',
          tree: treeRes.data.sha,
          parents: [parentSha]
        });

        await this.octokit.request('POST /repos/{owner}/{repo}/git/refs', {
          owner: this.owner,
          repo: this.repo,
          ref: 'refs/heads/' + this.stateBranch,
          sha: commitRes.data.sha
        });

        return { success: true, head: commitRes.data.sha, ambiguous: false };
      }

      // Updating existing state branch using CAS commit
      const currentRef = await this.octokit.request('GET /repos/{owner}/{repo}/git/ref/{ref}', {
        owner: this.owner,
        repo: this.repo,
        ref: 'heads/' + this.stateBranch
      });

      if (currentRef.data.object.sha !== expectedHead) {
        return { success: false, head: currentRef.data.object.sha, reason: 'CAS_CONFLICT', ambiguous: false };
      }

      const blobRes = await this.octokit.request('POST /repos/{owner}/{repo}/git/blobs', {
        owner: this.owner,
        repo: this.repo,
        content: contentStr,
        encoding: 'utf-8'
      });

      const treeRes = await this.octokit.request('POST /repos/{owner}/{repo}/git/trees', {
        owner: this.owner,
        repo: this.repo,
        base_tree: expectedHead,
        tree: [{ path: 'claims.json', mode: '100644', type: 'blob', sha: blobRes.data.sha }]
      });

      const commitRes = await this.octokit.request('POST /repos/{owner}/{repo}/git/commits', {
        owner: this.owner,
        repo: this.repo,
        message: 'Update autoloop claims state',
        tree: treeRes.data.sha,
        parents: [expectedHead]
      });

      await this.octokit.request('PATCH /repos/{owner}/{repo}/git/refs/{ref}', {
        owner: this.owner,
        repo: this.repo,
        ref: 'heads/' + this.stateBranch,
        sha: commitRes.data.sha,
        force: false
      });

      return { success: true, head: commitRes.data.sha, ambiguous: false };
    } catch (err) {
      if (err.status === 422 || err.status === 409) {
        return { success: false, head: null, reason: 'CAS_CONFLICT', ambiguous: false };
      }
      return { success: false, head: null, reason: 'STORAGE_WRITE_ERROR', ambiguous: true };
    }
  }
}

/**
 * Acquire a durable claim for an Issue using a bounded read -> validate -> compare-and-swap loop.
 *
 * @param {object} options
 * @param {object} options.stateAdapter
 * @param {*} options.repository
 * @param {number} options.issueNumber
 * @param {string} options.owner
 * @param {string} options.provider
 * @param {string} [options.sessionId=null]
 * @param {number} [options.ttlMinutes=45]
 * @param {string} [options.claimId]
 * @param {number} [options.maxRetries=3]
 * @param {Date|string|number} [options.now=new Date()]
 * @returns {Promise<object>} Outcome report
 */
export async function acquireClaim({
  stateAdapter,
  repository,
  issueNumber,
  owner,
  provider,
  sessionId = null,
  ttlMinutes = 45,
  claimId = null,
  maxRetries = 3,
  now = new Date()
}) {
  if (!stateAdapter || typeof stateAdapter.readState !== 'function' || typeof stateAdapter.commitStateChange !== 'function') {
    return {
      claim: null,
      decisionCode: CLAIM_CODES.CLAIM_INVALID_STATE,
      persistenceConfirmed: false,
      safeToDispatch: false,
      reason: 'A valid stateAdapter with readState and commitStateChange methods is required.',
      nextAction: 'Provide a valid state store adapter.'
    };
  }

  const repoCheck = normalizeRepositoryIdentity(repository);
  if (!repoCheck.valid) {
    return {
      claim: null,
      decisionCode: CLAIM_CODES.CLAIM_INVALID_STATE,
      persistenceConfirmed: false,
      safeToDispatch: false,
      reason: 'Repository identity is missing or invalid.',
      nextAction: 'Fix repository identity options.'
    };
  }

  const targetIssueNum = Number(issueNumber);
  if (!Number.isInteger(targetIssueNum) || targetIssueNum < 1) {
    return {
      claim: null,
      decisionCode: CLAIM_CODES.CLAIM_INVALID_STATE,
      persistenceConfirmed: false,
      safeToDispatch: false,
      reason: 'Issue number must be a positive integer.',
      nextAction: 'Provide a valid Issue number.'
    };
  }

  if (typeof owner !== 'string' || !owner.trim() || typeof provider !== 'string' || !provider.trim()) {
    return {
      claim: null,
      decisionCode: CLAIM_CODES.CLAIM_INVALID_STATE,
      persistenceConfirmed: false,
      safeToDispatch: false,
      reason: 'Owner and provider strings are required.',
      nextAction: 'Provide valid owner and provider identity strings.'
    };
  }

  const currentDate = new Date(now);
  const ttlMs = Math.max(1, Number(ttlMinutes) || 45) * 60 * 1000;
  const expiresAtDate = new Date(currentDate.getTime() + ttlMs);

  const targetClaimId = typeof claimId === 'string' && claimId.trim()
    ? claimId.trim()
    : 'claim-' + targetIssueNum + '-' + currentDate.getTime() + '-' + Math.random().toString(36).substring(2, 8);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const { head, claims } = await stateAdapter.readState();
    const existingClaims = Array.isArray(claims) ? claims : [];

    // Validate all records in state before proceeding
    for (const item of existingClaims) {
      const check = validateClaimRecord(item);
      if (!check.valid) {
        return {
          claim: null,
          decisionCode: CLAIM_CODES.CLAIM_INVALID_STATE,
          persistenceConfirmed: false,
          safeToDispatch: false,
          reason: 'State store contains a malformed claim record (claimId: ' + (item?.claimId ?? 'unknown') + ').',
          nextAction: 'Repair or reconcile invalid claim state records in the state branch.'
        };
      }
    }

    // Search for active/unreconciled claim for target Issue
    const targetRepo = repoCheck.repository;
    const matchingIssueClaims = existingClaims.filter((c) => {
      const cRepo = normalizeRepositoryIdentity(c.repository).repository;
      return cRepo && cRepo.owner === targetRepo.owner && cRepo.repo === targetRepo.repo && Number(c.issueNumber) === targetIssueNum;
    });

    for (const c of matchingIssueClaims) {
      const activeCheck = isClaimActive(c, currentDate);
      if (activeCheck.active) {
        if (activeCheck.expired) {
          return {
            claim: c,
            decisionCode: CLAIM_CODES.CLAIM_BLOCKED_STALE_UNRECONCILED,
            persistenceConfirmed: false,
            safeToDispatch: false,
            reason: 'Issue #' + targetIssueNum + ' has an expired claim ' + c.claimId + ' that has not been reconciled.',
            nextAction: 'Reconcile stale claim ' + c.claimId + ' before attempting a new claim.'
          };
        }
        return {
          claim: c,
          decisionCode: CLAIM_CODES.CLAIM_ALREADY_EXISTS,
          persistenceConfirmed: false,
          safeToDispatch: false,
          reason: 'Issue #' + targetIssueNum + ' is already claimed by active claim ' + c.claimId + '.',
          nextAction: 'Wait for active claim ' + c.claimId + ' to complete or be reconciled.'
        };
      }
    }

    const newClaim = {
      schemaVersion: CLAIM_SCHEMA_VERSION,
      claimId: targetClaimId,
      repository: targetRepo,
      issueNumber: targetIssueNum,
      owner: owner.trim(),
      provider: provider.trim(),
      sessionId: typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : null,
      createdAt: currentDate.toISOString(),
      expiresAt: expiresAtDate.toISOString(),
      status: CLAIM_STATUS.ACTIVE,
      reconciliationStatus: RECONCILIATION_STATUS.PENDING,
      updatedAt: currentDate.toISOString(),
      metadata: {}
    };

    const newClaimCheck = validateClaimRecord(newClaim);
    if (!newClaimCheck.valid) {
      return {
        claim: null,
        decisionCode: CLAIM_CODES.CLAIM_INVALID_STATE,
        persistenceConfirmed: false,
        safeToDispatch: false,
        reason: 'Constructed claim record failed schema validation.',
        nextAction: 'Fix claim parameters.'
      };
    }

    const updatedClaims = [...existingClaims, newClaim];
    const commitResult = await stateAdapter.commitStateChange(head, updatedClaims);

    if (commitResult.success) {
      return {
        claim: newClaim,
        decisionCode: CLAIM_CODES.CLAIM_ACQUIRED,
        persistenceConfirmed: true,
        safeToDispatch: true,
        reason: 'Claim ' + targetClaimId + ' successfully acquired and persisted for Issue #' + targetIssueNum + '.',
        nextAction: 'Proceed with provider session creation.'
      };
    }

    if (commitResult.ambiguous || commitResult.reason === 'STORAGE_WRITE_ERROR') {
      // Ambiguous write or write error: reconcile by exact claimId read-back
      const { claims: freshClaims } = await stateAdapter.readState();
      const found = (Array.isArray(freshClaims) ? freshClaims : []).find((c) => c && c.claimId === targetClaimId);
      if (found && validateClaimRecord(found).valid) {
        return {
          claim: found,
          decisionCode: CLAIM_CODES.CLAIM_ACQUIRED,
          persistenceConfirmed: true,
          safeToDispatch: true,
          reason: 'Claim ' + targetClaimId + ' was confirmed in state store following write response.',
          nextAction: 'Proceed with provider session creation.'
        };
      }

      return {
        claim: null,
        decisionCode: CLAIM_CODES.CLAIM_PERSISTENCE_FAILED,
        persistenceConfirmed: false,
        safeToDispatch: false,
        reason: 'State write failed or was ambiguous and claim ' + targetClaimId + ' was not found on read-back.',
        nextAction: 'Re-evaluate state and retry claim acquisition.'
      };
    }

    // CAS conflict: loop will retry next attempt
  }

  return {
    claim: null,
    decisionCode: CLAIM_CODES.CAS_CONFLICT_EXHAUSTED,
    persistenceConfirmed: false,
    safeToDispatch: false,
    reason: 'Exhausted max CAS retries (' + maxRetries + ') due to concurrent state updates.',
    nextAction: 'Retry claim acquisition after concurrent updates settle.'
  };
}

/**
 * Inspect state for an exact claim ID.
 *
 * @param {object} options
 * @param {object} options.stateAdapter
 * @param {string} options.claimId
 * @param {Date|string|number} [options.now=new Date()]
 * @returns {Promise<object>}
 */
export async function inspectClaim({ stateAdapter, claimId, now = new Date() }) {
  if (!stateAdapter || typeof stateAdapter.readState !== 'function') {
    return { found: false, valid: false, claim: null, decisionCode: CLAIM_CODES.CLAIM_INVALID_STATE, reason: 'Invalid state adapter.' };
  }

  if (typeof claimId !== 'string' || !claimId.trim()) {
    return { found: false, valid: false, claim: null, decisionCode: CLAIM_CODES.CLAIM_INVALID_STATE, reason: 'claimId must be a non-empty string.' };
  }

  const targetId = claimId.trim();
  const { claims } = await stateAdapter.readState();
  const existingClaims = Array.isArray(claims) ? claims : [];

  const found = existingClaims.find((c) => c && c.claimId === targetId);
  if (!found) {
    return {
      found: false,
      valid: false,
      claim: null,
      decisionCode: CLAIM_CODES.CLAIM_NOT_FOUND,
      reason: 'Claim ID ' + targetId + ' was not found in state store.'
    };
  }

  const check = validateClaimRecord(found);
  if (!check.valid) {
    return {
      found: true,
      valid: false,
      claim: found,
      decisionCode: CLAIM_CODES.CLAIM_INVALID_STATE,
      errors: check.errors,
      reason: 'Claim ID ' + targetId + ' is malformed in state store.'
    };
  }

  const activeState = isClaimActive(found, now);
  return {
    found: true,
    valid: true,
    claim: found,
    activeState
  };
}

/**
 * Validate reconciliation evidence for provider sessions, branches, and PRs.
 * Missing, partial, failed, or unverified evidence fails closed.
 *
 * @param {*} evidence
 * @returns {{ verified: boolean, reason?: string }}
 */
export function validateReconciliationEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    return { verified: false, reason: 'Reconciliation evidence must be a non-null object.' };
  }

  if (evidence.verified !== true) {
    return { verified: false, reason: 'Reconciliation evidence verified property must be explicitly true.' };
  }

  // Session evidence
  const sessionStatus = String(evidence.sessions?.status ?? evidence.sessions ?? '').toLowerCase().trim();
  const validSessionStatuses = new Set(['terminal', 'none', 'completed', 'failed', 'cancelled', 'canceled', 'expired', 'reconciled']);
  if (!validSessionStatuses.has(sessionStatus)) {
    return {
      verified: false,
      reason: 'Provider session reconciliation evidence is missing, active, or unverified (status: ' + (sessionStatus || 'unspecified') + ').'
    };
  }

  // Branch evidence
  const branchStatus = String(evidence.branches?.status ?? evidence.branches ?? '').toLowerCase().trim();
  const validBranchStatuses = new Set(['clean', 'deleted', 'merged', 'none', 'reconciled']);
  if (!validBranchStatuses.has(branchStatus)) {
    return {
      verified: false,
      reason: 'Branch reconciliation evidence is missing, unpushed, or unverified (status: ' + (branchStatus || 'unspecified') + ').'
    };
  }

  // PR evidence
  const prStatus = String(evidence.pullRequests?.status ?? evidence.pullRequests ?? '').toLowerCase().trim();
  const validPRStatuses = new Set(['merged', 'closed_classified', 'none', 'reconciled']);
  if (!validPRStatuses.has(prStatus)) {
    return {
      verified: false,
      reason: 'Pull request reconciliation evidence is missing, open, or unverified (status: ' + (prStatus || 'unspecified') + ').'
    };
  }

  return { verified: true };
}

/**
 * Perform exact-ID claim reconciliation and recovery state transition using Compare-And-Swap.
 * Expiry alone never authorizes recovery; explicit verified evidence is required.
 *
 * @param {object} options
 * @param {object} options.stateAdapter
 * @param {string} options.claimId
 * @param {object} options.evidence
 * @param {string} [options.targetStatus=CLAIM_STATUS.RECLAIMED]
 * @param {number} [options.maxRetries=3]
 * @param {Date|string|number} [options.now=new Date()]
 * @returns {Promise<object>} Outcome report
 */
export async function reconcileAndRecoverClaim({
  stateAdapter,
  claimId,
  evidence,
  targetStatus = CLAIM_STATUS.RECLAIMED,
  maxRetries = 3,
  now = new Date()
}) {
  if (!stateAdapter || typeof stateAdapter.readState !== 'function' || typeof stateAdapter.commitStateChange !== 'function') {
    return {
      claim: null,
      decisionCode: CLAIM_CODES.CLAIM_INVALID_STATE,
      persistenceConfirmed: false,
      safeToDispatch: false,
      reason: 'A valid stateAdapter with readState and commitStateChange methods is required.',
      nextAction: 'Provide a valid state store adapter.'
    };
  }

  if (typeof claimId !== 'string' || !claimId.trim()) {
    return {
      claim: null,
      decisionCode: CLAIM_CODES.CLAIM_INVALID_STATE,
      persistenceConfirmed: false,
      safeToDispatch: false,
      reason: 'claimId must be a non-empty string.',
      nextAction: 'Provide a valid claim ID.'
    };
  }

  const targetId = claimId.trim();

  const evidenceCheck = validateReconciliationEvidence(evidence);
  if (!evidenceCheck.verified) {
    return {
      claim: null,
      decisionCode: CLAIM_CODES.CLAIM_RECOVERY_BLOCKED,
      persistenceConfirmed: false,
      safeToDispatch: false,
      reason: evidenceCheck.reason,
      nextAction: 'Obtain complete verified reconciliation evidence for sessions, branches, and PRs before retrying recovery.'
    };
  }

  if (!VALID_STATUSES.has(targetStatus) || targetStatus === CLAIM_STATUS.ACTIVE) {
    return {
      claim: null,
      decisionCode: CLAIM_CODES.CLAIM_INVALID_STATE,
      persistenceConfirmed: false,
      safeToDispatch: false,
      reason: 'Target recovery status must be RELEASED, RECLAIMED, or EXPIRED.',
      nextAction: 'Specify a valid terminal target status.'
    };
  }

  const currentDate = new Date(now);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const { head, claims } = await stateAdapter.readState();
    const existingClaims = Array.isArray(claims) ? claims : [];

    const foundIndex = existingClaims.findIndex((c) => c && c.claimId === targetId);
    if (foundIndex === -1) {
      return {
        claim: null,
        decisionCode: CLAIM_CODES.CLAIM_NOT_FOUND,
        persistenceConfirmed: false,
        safeToDispatch: false,
        reason: 'Claim ID ' + targetId + ' was not found in state store.',
        nextAction: 'Verify claim ID.'
      };
    }

    const currentClaim = existingClaims[foundIndex];
    const check = validateClaimRecord(currentClaim);
    if (!check.valid) {
      return {
        claim: currentClaim,
        decisionCode: CLAIM_CODES.CLAIM_INVALID_STATE,
        persistenceConfirmed: false,
        safeToDispatch: false,
        reason: 'Claim ID ' + targetId + ' is malformed in state store.',
        nextAction: 'Repair malformed claim record.'
      };
    }

    if (currentClaim.reconciliationStatus === RECONCILIATION_STATUS.RECONCILED && currentClaim.status === targetStatus) {
      return {
        claim: currentClaim,
        decisionCode: CLAIM_CODES.CLAIM_RECOVERED,
        persistenceConfirmed: true,
        safeToDispatch: false,
        reason: 'Claim ID ' + targetId + ' was already reconciled and updated to ' + targetStatus + '.',
        nextAction: 'Claim is reconciled.'
      };
    }

    const updatedClaim = {
      ...currentClaim,
      status: targetStatus,
      reconciliationStatus: RECONCILIATION_STATUS.RECONCILED,
      updatedAt: currentDate.toISOString(),
      metadata: {
        ...(currentClaim.metadata || {}),
        reconciledAt: currentDate.toISOString(),
        reconciliationSummary: evidence?.summary || 'verified'
      }
    };

    const updatedCheck = validateClaimRecord(updatedClaim);
    if (!updatedCheck.valid) {
      return {
        claim: null,
        decisionCode: CLAIM_CODES.CLAIM_INVALID_STATE,
        persistenceConfirmed: false,
        safeToDispatch: false,
        reason: 'Reconciled claim record failed schema validation.',
        nextAction: 'Fix claim parameters.'
      };
    }

    const updatedClaims = [...existingClaims];
    updatedClaims[foundIndex] = updatedClaim;

    const commitResult = await stateAdapter.commitStateChange(head, updatedClaims);

    if (commitResult.success) {
      return {
        claim: updatedClaim,
        decisionCode: CLAIM_CODES.CLAIM_RECOVERED,
        persistenceConfirmed: true,
        safeToDispatch: false,
        reason: 'Claim ' + targetId + ' successfully reconciled and set to ' + targetStatus + '.',
        nextAction: 'Issue is un-claimed and safe for future candidate selection.'
      };
    }

    if (commitResult.ambiguous || commitResult.reason === 'STORAGE_WRITE_ERROR') {
      const { claims: freshClaims } = await stateAdapter.readState();
      const confirmed = (Array.isArray(freshClaims) ? freshClaims : []).find((c) => c && c.claimId === targetId);
      if (confirmed && confirmed.reconciliationStatus === RECONCILIATION_STATUS.RECONCILED && confirmed.status === targetStatus) {
        return {
          claim: confirmed,
          decisionCode: CLAIM_CODES.CLAIM_RECOVERED,
          persistenceConfirmed: true,
          safeToDispatch: false,
          reason: 'Claim ' + targetId + ' reconciliation confirmed in state store following write response.',
          nextAction: 'Issue is un-claimed and safe for future candidate selection.'
        };
      }

      return {
        claim: null,
        decisionCode: CLAIM_CODES.CLAIM_PERSISTENCE_FAILED,
        persistenceConfirmed: false,
        safeToDispatch: false,
        reason: 'Reconciliation write failed or was ambiguous and claim ' + targetId + ' was not confirmed on read-back.',
        nextAction: 'Retry claim reconciliation.'
      };
    }

    // CAS conflict retry
  }

  return {
    claim: null,
    decisionCode: CLAIM_CODES.CAS_CONFLICT_EXHAUSTED,
    persistenceConfirmed: false,
    safeToDispatch: false,
    reason: 'Exhausted max CAS retries (' + maxRetries + ') during claim reconciliation.',
    nextAction: 'Retry claim reconciliation after concurrent state updates settle.'
  };
}
