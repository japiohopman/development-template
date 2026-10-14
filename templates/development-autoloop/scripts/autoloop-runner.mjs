import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateConfig } from '../src/config.mjs';
import { normalizeRepositoryIdentity, validateClaimRecord } from '../src/claims.mjs';
import { selectCandidateIssue } from '../src/selection.mjs';
import { reconcileSessionLifecycle } from '../src/reconciliation.mjs';
import { JulesClient } from '../src/jules.mjs';

const repositoryValue = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
const confirmation = process.env.CONFIRM_REPOSITORY;
const julesApiKey = process.env.JULES_API_KEY;
const stateBranch = process.env.AUTOLOOP_STATE_BRANCH || 'autoloop-state';
const configPath = resolve(process.env.AUTOLOOP_CONFIG_PATH || 'config/autoloop.json');
const currentRef = process.env.GITHUB_REF || '';

function printReport(report) {
  console.log(JSON.stringify(report, null, 2));
}

function buildReport({
  success = false,
  selectedCandidate = null,
  decisionCode = 'UNKNOWN',
  reason = '',
  blockers = [],
  evaluatedCandidates = [],
  nextAction = ''
} = {}) {
  return {
    success,
    mutated: false,
    runMode: 'plan-only',
    selectedCandidate,
    decisionCode,
    reason,
    blockers,
    evaluatedCandidates,
    nextAction
  };
}

async function run() {
  if (!repositoryValue || !token) {
    const report = buildReport({
      success: false,
      decisionCode: 'BLOCK_CONFIGURATION_ERROR',
      reason: 'Required environment variables GITHUB_REPOSITORY and GITHUB_TOKEN must be configured.',
      nextAction: 'Configure GITHUB_REPOSITORY and GITHUB_TOKEN in workflow environment.'
    });
    printReport(report);
    process.exitCode = 1;
    return;
  }

  const repoCheck = normalizeRepositoryIdentity(repositoryValue);
  if (!repoCheck.valid || confirmation !== repositoryValue) {
    const report = buildReport({
      success: false,
      decisionCode: 'BLOCK_REPOSITORY_UNCONFIRMED',
      reason: 'Repository confirmation did not exactly match GITHUB_REPOSITORY. No API requests were made.',
      nextAction: 'Supply exact repository name in confirm_repository input before running autoloop dispatch.'
    });
    printReport(report);
    process.exitCode = 1;
    return;
  }

  let rawConfig;
  try {
    rawConfig = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (err) {
    const report = buildReport({
      success: false,
      decisionCode: 'BLOCK_INVALID_CONFIG',
      reason: 'Failed to read or parse configuration file at ' + configPath + ': ' + (err?.message || String(err)),
      nextAction: 'Ensure config/autoloop.json exists and contains valid JSON formatted according to autoloop.schema.v1.json.'
    });
    printReport(report);
    process.exitCode = 1;
    return;
  }

  const configValidation = validateConfig(rawConfig);
  if (!configValidation.valid) {
    const report = buildReport({
      success: false,
      decisionCode: 'BLOCK_INVALID_CONFIG',
      reason: 'Configuration failed schema validation.',
      blockers: configValidation.errors.map(e => ({ path: e.path, code: e.code, message: e.message })),
      nextAction: 'Fix config/autoloop.json using config/autoloop.example.json as a guide, then rerun.'
    });
    printReport(report);
    process.exitCode = 1;
    return;
  }
  const config = configValidation.config;

  const defaultBranch = config.defaultBranch || 'main';
  if (currentRef && currentRef !== 'refs/heads/' + defaultBranch) {
    const report = buildReport({
      success: false,
      decisionCode: 'BLOCK_UNTRUSTED_REF',
      reason: 'Autoloop dispatch runner executed on ref \'' + currentRef + '\' which does not match configured default branch \'' + defaultBranch + '\'.',
      nextAction: 'Trigger autoloop dispatch from the repository default branch only.'
    });
    printReport(report);
    process.exitCode = 1;
    return;
  }

  const repo = repoCheck.repository;

  const api = async (path, options = {}) => {
    const method = options.method || 'GET';
    if (method !== 'GET') {
      throw new Error('Only GET requests are permitted in plan-only autoloop runner.');
    }
    const response = await fetch('https://api.github.com' + path, {
      method: 'GET',
      redirect: 'error',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: 'Bearer ' + token,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(options.headers || {})
      }
    });
    if (!response.ok) {
      const error = new Error('GitHub API HTTP ' + response.status + ' for ' + path);
      error.status = response.status;
      throw error;
    }
    return response.json();
  };

  const fetchAllGithubPages = async (basePath) => {
    const items = [];
    let page = 1;
    const perPage = 100;
    while (true) {
      const separator = basePath.includes('?') ? '&' : '?';
      const path = `${basePath}${separator}per_page=${perPage}&page=${page}`;
      const data = await api(path);
      if (!Array.isArray(data)) {
        throw new Error('Expected array response from GitHub API at ' + path);
      }
      items.push(...data);
      if (data.length < perPage) break;
      page++;
    }
    return items;
  };

  let snapshot = null;
  let reconciliationReport = null;
  try {
    const defaultBranchData = await api('/repos/' + repo.owner + '/' + repo.repo + '/branches/' + encodeURIComponent(defaultBranch));
    if (!defaultBranchData || typeof defaultBranchData.name !== 'string' || defaultBranchData.name !== defaultBranch) {
      throw new Error('Default branch ' + defaultBranch + ' was not found or returned an invalid response.');
    }

    const rawIssuesAndPRs = await fetchAllGithubPages('/repos/' + repo.owner + '/' + repo.repo + '/issues?state=all');
    const rawOpenPRs = await fetchAllGithubPages('/repos/' + repo.owner + '/' + repo.repo + '/pulls?state=open');

    const issues = rawIssuesAndPRs.filter(item => !item.pull_request);

    const ref = await api('/repos/' + repo.owner + '/' + repo.repo + '/git/ref/heads/' + encodeURIComponent(stateBranch));
    const headSha = ref?.object?.sha;
    if (typeof headSha !== 'string' || !headSha.trim()) {
      throw new Error('Claim state branch ' + stateBranch + ' returned no commit SHA.');
    }
    const file = await api('/repos/' + repo.owner + '/' + repo.repo + '/contents/claims.json?ref=' + encodeURIComponent(headSha));
    if (file?.encoding !== 'base64' || typeof file.content !== 'string') {
      throw new Error('Claim state file claims.json is missing or not base64 encoded on branch ' + stateBranch + '.');
    }
    const parsedClaimsFile = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
    if (!parsedClaimsFile || typeof parsedClaimsFile !== 'object' || !Array.isArray(parsedClaimsFile.claims)) {
      throw new Error('Claim state file claims.json must contain a claims array.');
    }
    for (const c of parsedClaimsFile.claims) {
      const check = validateClaimRecord(c);
      if (!check.valid) {
        throw new Error('Claim state file claims.json contains a malformed claim record (' + (c?.claimId ?? 'unknown') + ').');
      }
    }
    const rawClaims = parsedClaimsFile.claims;
    const claims = rawClaims.map(c => ({
      ...c,
      reconciled: c.reconciliationStatus === 'RECONCILED'
    }));

    if (!julesApiKey) {
      throw new Error('JULES_API_KEY environment variable is required to collect provider session inventory.');
    }
    const providerClient = new JulesClient({ apiKey: julesApiKey });
    const sessions = await providerClient.listSessions();

    const fetchBranch = async (name) => api('/repos/' + repo.owner + '/' + repo.repo + '/branches/' + encodeURIComponent(name));
    const fetchIssue = async (number) => api('/repos/' + repo.owner + '/' + repo.repo + '/issues/' + number);
    const fetchPullRequest = async (number) => api('/repos/' + repo.owner + '/' + repo.repo + '/pulls/' + number);
    const stateAdapter = {
      async readState() {
        return { head: headSha, claims: rawClaims };
      }
    };

    reconciliationReport = await reconcileSessionLifecycle({
      config,
      repository: repo,
      providerClient,
      fetchPullRequest,
      fetchIssue,
      fetchBranch,
      stateAdapter
    });

    if (!reconciliationReport || (!reconciliationReport.success && reconciliationReport.decisionCode !== 'RECONCILIATION_CLEAR' && reconciliationReport.decisionCode !== 'RECONCILIATION_BLOCKED')) {
      throw new Error('Session lifecycle reconciliation failed (' + (reconciliationReport?.decisionCode || 'UNKNOWN') + '): ' + (reconciliationReport?.summary || 'unverified state'));
    }

    snapshot = {
      snapshotComplete: true,
      repository: repo,
      issues,
      pullRequests: rawOpenPRs,
      claims,
      sessions,
      sequence: Array.isArray(rawConfig.sequence) ? rawConfig.sequence : []
    };
  } catch (err) {
    const report = buildReport({
      success: false,
      decisionCode: 'BLOCK_INCOMPLETE_SNAPSHOT',
      reason: 'Failed to assemble complete API snapshot: ' + (err?.message || String(err)),
      blockers: [{ code: 'INCOMPLETE_SNAPSHOT', message: err?.message || String(err) }],
      nextAction: 'Re-run snapshot collection after checking GitHub and provider API permissions.'
    });
    printReport(report);
    process.exitCode = 1;
    return;
  }

  const selectionResult = selectCandidateIssue(snapshot, config);

  const combinedBlockers = [
    ...(reconciliationReport?.blockers || []),
    ...(selectionResult.blockers || [])
  ];

  const isCleanOutcome = selectionResult.decisionCode === 'CANDIDATE_SELECTED' || selectionResult.decisionCode === 'NO_ELIGIBLE_CANDIDATE';
  const isReconciliationClear = reconciliationReport?.success === true;

  const finalSuccess = isCleanOutcome && isReconciliationClear;

  const report = buildReport({
    success: finalSuccess,
    selectedCandidate: finalSuccess ? selectionResult.selectedCandidate : null,
    decisionCode: !isReconciliationClear
      ? 'RECONCILIATION_BLOCKED'
      : selectionResult.decisionCode,
    reason: !isReconciliationClear
      ? (reconciliationReport.summary || 'Lifecycle reconciliation detected active work or evidence gaps.')
      : selectionResult.reason,
    blockers: combinedBlockers,
    evaluatedCandidates: selectionResult.evaluatedCandidates || [],
    nextAction: finalSuccess
      ? selectionResult.nextAction
      : 'Resolve lifecycle reconciliation and candidate blockers before re-running autoloop dispatch.'
  });

  printReport(report);

  if (!finalSuccess) {
    process.exitCode = 1;
  }
}

run().catch((err) => {
  const report = buildReport({
    success: false,
    decisionCode: 'BLOCK_UNHANDLED_ERROR',
    reason: 'Unhandled exception during autoloop runner execution: ' + (err?.message || String(err)),
    nextAction: 'Inspect runner logs and fix unhandled exception.'
  });
  printReport(report);
  process.exitCode = 1;
});
