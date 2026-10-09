/**
 * Configuration schema and validation for development autoloop.
 * Pure and read-only. Invalid or unknown configuration blocks execution.
 */

export const SUPPORTED_SCHEMA_VERSION = 1;

export const VALID_RUN_MODES = new Set(['dry-run', 'live']);

export const REQUIRED_LABEL_KEYS = [
  'proposed',
  'ready',
  'claimed',
  'inProgress',
  'awaitingReview',
  'changesRequested',
  'approved',
  'blocked',
  'escalated',
];

export const KNOWN_CONFIG_KEYS = new Set([
  'schemaVersion',
  'enabled',
  'defaultBranch',
  'runMode',
  'workProvider',
  'reviewProvider',
  'maxConcurrentSessions',
  'humanReadinessRequired',
  'automaticMerge',
  'scheduleEnabled',
  'requiredConfirmation',
  'staleClaimMinutes',
  'labels',
  'requiredIssueSections',
  'requiredChecks',
  'trustedReviewers',
  'sequenceSource',
]);

const KNOWN_LABEL_KEYS = new Set(REQUIRED_LABEL_KEYS);

/**
 * Validate a configuration object or JSON string.
 *
 * @param {object|string} rawInput - Configuration object or JSON string.
 * @returns {{ valid: boolean, config: object|null, errors: Array<{ path: string, message: string }> }}
 */
export function validateConfig(rawInput) {
  const errors = [];

  let configObj = rawInput;
  if (typeof rawInput === 'string') {
    try {
      configObj = JSON.parse(rawInput);
    } catch (err) {
      return {
        valid: false,
        config: null,
        errors: [{ path: '$', message: `Malformed JSON input: ${err.message}` }],
      };
    }
  }

  if (!configObj || typeof configObj !== 'object' || Array.isArray(configObj)) {
    return {
      valid: false,
      config: null,
      errors: [{ path: '$', message: 'Configuration must be a non-null object.' }],
    };
  }

  // Check for unknown top-level keys
  for (const key of Object.keys(configObj)) {
    if (!KNOWN_CONFIG_KEYS.has(key)) {
      errors.push({ path: key, message: `Unknown configuration property "${key}".` });
    }
  }

  // Validate schemaVersion
  if (!('schemaVersion' in configObj)) {
    errors.push({ path: 'schemaVersion', message: 'schemaVersion is required.' });
  } else if (typeof configObj.schemaVersion !== 'number' || !Number.isInteger(configObj.schemaVersion)) {
    errors.push({ path: 'schemaVersion', message: 'schemaVersion must be an integer.' });
  } else if (configObj.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    errors.push({
      path: 'schemaVersion',
      message: `Unsupported schemaVersion ${configObj.schemaVersion}. Expected ${SUPPORTED_SCHEMA_VERSION}.`,
    });
  }

  // Validate enabled
  if (!('enabled' in configObj)) {
    errors.push({ path: 'enabled', message: 'enabled is required.' });
  } else if (typeof configObj.enabled !== 'boolean') {
    errors.push({ path: 'enabled', message: 'enabled must be a boolean.' });
  }

  // Validate defaultBranch
  if (!('defaultBranch' in configObj)) {
    errors.push({ path: 'defaultBranch', message: 'defaultBranch is required.' });
  } else if (typeof configObj.defaultBranch !== 'string' || configObj.defaultBranch.trim() === '') {
    errors.push({ path: 'defaultBranch', message: 'defaultBranch must be a non-empty string.' });
  }

  // Validate runMode
  if (!('runMode' in configObj)) {
    errors.push({ path: 'runMode', message: 'runMode is required.' });
  } else if (typeof configObj.runMode !== 'string' || !VALID_RUN_MODES.has(configObj.runMode)) {
    errors.push({
      path: 'runMode',
      message: `runMode must be one of: ${Array.from(VALID_RUN_MODES).join(', ')}.`,
    });
  }

  // Validate workProvider
  if (!('workProvider' in configObj)) {
    errors.push({ path: 'workProvider', message: 'workProvider is required.' });
  } else if (typeof configObj.workProvider !== 'string' || configObj.workProvider.trim() === '') {
    errors.push({ path: 'workProvider', message: 'workProvider must be a non-empty string.' });
  }

  // Validate reviewProvider
  if (!('reviewProvider' in configObj)) {
    errors.push({ path: 'reviewProvider', message: 'reviewProvider is required.' });
  } else if (typeof configObj.reviewProvider !== 'string' || configObj.reviewProvider.trim() === '') {
    errors.push({ path: 'reviewProvider', message: 'reviewProvider must be a non-empty string.' });
  }

  // Validate maxConcurrentSessions
  if (!('maxConcurrentSessions' in configObj)) {
    errors.push({ path: 'maxConcurrentSessions', message: 'maxConcurrentSessions is required.' });
  } else if (
    typeof configObj.maxConcurrentSessions !== 'number' ||
    !Number.isInteger(configObj.maxConcurrentSessions) ||
    configObj.maxConcurrentSessions < 1
  ) {
    errors.push({
      path: 'maxConcurrentSessions',
      message: 'maxConcurrentSessions must be an integer greater than or equal to 1.',
    });
  }

  // Validate humanReadinessRequired
  if (!('humanReadinessRequired' in configObj)) {
    errors.push({ path: 'humanReadinessRequired', message: 'humanReadinessRequired is required.' });
  } else if (typeof configObj.humanReadinessRequired !== 'boolean') {
    errors.push({ path: 'humanReadinessRequired', message: 'humanReadinessRequired must be a boolean.' });
  }

  // Validate automaticMerge
  if (!('automaticMerge' in configObj)) {
    errors.push({ path: 'automaticMerge', message: 'automaticMerge is required.' });
  } else if (typeof configObj.automaticMerge !== 'boolean') {
    errors.push({ path: 'automaticMerge', message: 'automaticMerge must be a boolean.' });
  }

  // Validate scheduleEnabled
  if (!('scheduleEnabled' in configObj)) {
    errors.push({ path: 'scheduleEnabled', message: 'scheduleEnabled is required.' });
  } else if (typeof configObj.scheduleEnabled !== 'boolean') {
    errors.push({ path: 'scheduleEnabled', message: 'scheduleEnabled must be a boolean.' });
  }

  // Validate requiredConfirmation
  if (!('requiredConfirmation' in configObj)) {
    errors.push({ path: 'requiredConfirmation', message: 'requiredConfirmation is required.' });
  } else if (typeof configObj.requiredConfirmation !== 'string' || configObj.requiredConfirmation.trim() === '') {
    errors.push({ path: 'requiredConfirmation', message: 'requiredConfirmation must be a non-empty string.' });
  }

  // Validate staleClaimMinutes
  if (!('staleClaimMinutes' in configObj)) {
    errors.push({ path: 'staleClaimMinutes', message: 'staleClaimMinutes is required.' });
  } else if (
    typeof configObj.staleClaimMinutes !== 'number' ||
    !Number.isInteger(configObj.staleClaimMinutes) ||
    configObj.staleClaimMinutes < 1
  ) {
    errors.push({
      path: 'staleClaimMinutes',
      message: 'staleClaimMinutes must be an integer greater than or equal to 1.',
    });
  }

  // Validate labels
  if (!('labels' in configObj)) {
    errors.push({ path: 'labels', message: 'labels is required.' });
  } else if (!configObj.labels || typeof configObj.labels !== 'object' || Array.isArray(configObj.labels)) {
    errors.push({ path: 'labels', message: 'labels must be an object.' });
  } else {
    for (const labelKey of Object.keys(configObj.labels)) {
      if (!KNOWN_LABEL_KEYS.has(labelKey)) {
        errors.push({ path: `labels.${labelKey}`, message: `Unknown label property "labels.${labelKey}".` });
      }
    }
    for (const requiredKey of REQUIRED_LABEL_KEYS) {
      const fieldPath = `labels.${requiredKey}`;
      if (!(requiredKey in configObj.labels)) {
        errors.push({ path: fieldPath, message: `${fieldPath} is required.` });
      } else if (
        typeof configObj.labels[requiredKey] !== 'string' ||
        configObj.labels[requiredKey].trim() === ''
      ) {
        errors.push({ path: fieldPath, message: `${fieldPath} must be a non-empty string.` });
      }
    }
  }

  // Validate requiredIssueSections
  validateStringArray(configObj, 'requiredIssueSections', errors);

  // Validate requiredChecks
  validateStringArray(configObj, 'requiredChecks', errors);

  // Validate trustedReviewers
  validateStringArray(configObj, 'trustedReviewers', errors);

  // Validate sequenceSource
  if ('sequenceSource' in configObj && configObj.sequenceSource !== null) {
    if (typeof configObj.sequenceSource !== 'string' || configObj.sequenceSource.trim() === '') {
      errors.push({
        path: 'sequenceSource',
        message: 'sequenceSource must be null or a non-empty string.',
      });
    }
  }

  if (errors.length > 0) {
    return { valid: false, config: null, errors };
  }

  return { valid: true, config: configObj, errors: [] };
}

function validateStringArray(configObj, key, errors) {
  if (!(key in configObj)) {
    errors.push({ path: key, message: `${key} is required.` });
    return;
  }
  const val = configObj[key];
  if (!Array.isArray(val)) {
    errors.push({ path: key, message: `${key} must be an array of strings.` });
    return;
  }
  val.forEach((item, index) => {
    if (typeof item !== 'string' || item.trim() === '') {
      errors.push({
        path: `${key}[${index}]`,
        message: `${key}[${index}] must be a non-empty string.`,
      });
    }
  });
}
