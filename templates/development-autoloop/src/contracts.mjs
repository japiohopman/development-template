/**
 * Contract validation for Issues and Pull Requests.
 * Validates required sections and metadata against configuration or defaults.
 * Pure and read-only.
 */

export const DEFAULT_REQUIRED_ISSUE_SECTIONS = [
  'Scope',
  'Acceptance criteria',
  'Dependencies',
  'Out of scope',
  'Validation plan',
];

export const DEFAULT_REQUIRED_PR_SECTIONS = [
  'Governing Issue',
  'Summary',
  'Scope boundary',
  'Acceptance criteria evidence',
  'Verification',
  'Risks and blockers',
  'Handoff',
];

/**
 * Extract sections and their text contents from markdown body.
 * Recognizes markdown headings (# Section, ## Section, etc.) and bold standalone titles (**Section** or **Section:**).
 *
 * @param {string} body - Markdown content.
 * @returns {Map<string, string>} Map of normalized section names to content strings.
 */
export function extractMarkdownSections(body) {
  const sections = new Map();
  if (typeof body !== 'string') return sections;

  const lines = body.split(/\r?\n/);
  let currentSection = null;
  let currentContent = [];

  for (const line of lines) {
    const trimmed = line.trim();
    let foundHeading = null;
    let initialInlineContent = null;

    const hashMatch = trimmed.match(/^#{1,6}\s+(.+)$/);
    if (hashMatch) {
      foundHeading = hashMatch[1].trim();
    } else {
      const boldMatch = trimmed.match(/^\*\*(.+?)\*\*:?\s*(.*)$/);
      if (boldMatch) {
        foundHeading = boldMatch[1].trim();
        if (boldMatch[2] && boldMatch[2].trim()) {
          initialInlineContent = boldMatch[2].trim();
        }
      }
    }

    if (foundHeading) {
      if (currentSection) {
        sections.set(currentSection.toLowerCase(), currentContent.join('\n').trim());
      }
      currentSection = foundHeading;
      currentContent = initialInlineContent !== null ? [initialInlineContent] : [];
    } else if (currentSection) {
      currentContent.push(line);
    }
  }

  if (currentSection) {
    sections.set(currentSection.toLowerCase(), currentContent.join('\n').trim());
  }

  return sections;
}

/**
 * Validate governing Issue contract.
 *
 * @param {object|string} issueInput - Issue object or body string.
 * @param {object} [options] - Options or autoloop configuration.
 * @param {string[]} [options.requiredIssueSections] - Array of required section titles.
 * @returns {{ valid: boolean, errors: Array<{ path: string, message: string }> }}
 */
export function validateIssueContract(issueInput, options = {}) {
  const errors = [];

  let body = '';
  if (typeof issueInput === 'string') {
    body = issueInput;
  } else if (issueInput && typeof issueInput === 'object') {
    if (typeof issueInput.body !== 'string') {
      errors.push({ path: 'body', message: 'Issue body must be a string.' });
    } else {
      body = issueInput.body;
    }
  } else {
    return {
      valid: false,
      errors: [{ path: '$', message: 'Issue input must be a string or object with a body property.' }],
    };
  }

  if (typeof body === 'string' && body.trim() === '') {
    errors.push({ path: 'body', message: 'Issue body cannot be empty.' });
  }

  const requiredSections = Array.isArray(options?.requiredIssueSections)
    ? options.requiredIssueSections
    : Array.isArray(options?.config?.requiredIssueSections)
    ? options.config.requiredIssueSections
    : DEFAULT_REQUIRED_ISSUE_SECTIONS;

  if (typeof body === 'string' && body.trim() !== '') {
    const parsedSections = extractMarkdownSections(body);

    for (const sectionName of requiredSections) {
      const normalizedKey = sectionName.toLowerCase();
      if (!parsedSections.has(normalizedKey)) {
        errors.push({
          path: `body.sections.${sectionName}`,
          message: `Missing required section "${sectionName}".`,
        });
      } else {
        const content = parsedSections.get(normalizedKey);
        if (!content || content.trim() === '') {
          errors.push({
            path: `body.sections.${sectionName}`,
            message: `Required section "${sectionName}" is empty.`,
          });
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate implementation Pull Request contract.
 *
 * @param {object|string} prInput - PR object or body string.
 * @param {object} [options] - Options or autoloop configuration.
 * @param {string[]} [options.requiredPRSections] - Array of required section titles.
 * @returns {{ valid: boolean, errors: Array<{ path: string, message: string }> }}
 */
export function validatePullRequestContract(prInput, options = {}) {
  const errors = [];

  let body = '';
  if (typeof prInput === 'string') {
    body = prInput;
  } else if (prInput && typeof prInput === 'object') {
    if (typeof prInput.body !== 'string') {
      errors.push({ path: 'body', message: 'Pull request body must be a string.' });
    } else {
      body = prInput.body;
    }
  } else {
    return {
      valid: false,
      errors: [{ path: '$', message: 'Pull request input must be a string or object with a body property.' }],
    };
  }

  if (typeof body === 'string' && body.trim() === '') {
    errors.push({ path: 'body', message: 'Pull request body cannot be empty.' });
  }

  const requiredSections = Array.isArray(options?.requiredPRSections)
    ? options.requiredPRSections
    : Array.isArray(options?.config?.requiredPRSections)
    ? options.config.requiredPRSections
    : DEFAULT_REQUIRED_PR_SECTIONS;

  if (typeof body === 'string' && body.trim() !== '') {
    const parsedSections = extractMarkdownSections(body);

    for (const sectionName of requiredSections) {
      const normalizedKey = sectionName.toLowerCase();
      if (!parsedSections.has(normalizedKey)) {
        errors.push({
          path: `body.sections.${sectionName}`,
          message: `Missing required section "${sectionName}".`,
        });
      } else {
        const content = parsedSections.get(normalizedKey);
        if (!content || content.trim() === '') {
          errors.push({
            path: `body.sections.${sectionName}`,
            message: `Required section "${sectionName}" is empty.`,
          });
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
