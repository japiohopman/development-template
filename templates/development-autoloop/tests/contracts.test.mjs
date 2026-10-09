import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  validateIssueContract,
  validatePullRequestContract,
  extractMarkdownSections,
} from '../src/contracts.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

test('extractMarkdownSections extracts hash headings and bold headings correctly', () => {
  const md = `
# Scope
This is the scope.

## Acceptance criteria
1. Criterion A
2. Criterion B

**Dependencies**
None

**Out of scope**
Other features

### Validation plan
Run unit tests
`;

  const sections = extractMarkdownSections(md);
  assert.equal(sections.get('scope'), 'This is the scope.');
  assert.equal(sections.get('acceptance criteria'), '1. Criterion A\n2. Criterion B');
  assert.equal(sections.get('dependencies'), 'None');
  assert.equal(sections.get('out of scope'), 'Other features');
  assert.equal(sections.get('validation plan'), 'Run unit tests');
});

test('valid issue body passes validation', () => {
  const validIssueBody = `
## Scope
Implement contract validation.

## Acceptance criteria
- [x] Schema is validated.

## Dependencies
None

## Out of scope
Live dispatch.

## Validation plan
npm test
`;

  const result = validateIssueContract(validIssueBody);
  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
});

test('issue missing required section fails with section path', () => {
  const incompleteIssueBody = `
## Scope
Implement contract validation.

## Acceptance criteria
- [x] Schema is validated.

## Dependencies
None

## Validation plan
npm test
`;

  const result = validateIssueContract(incompleteIssueBody);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.path === 'body.sections.Out of scope'));
});

test('issue with empty required section fails', () => {
  const emptySectionBody = `
## Scope
Implement contract validation.

## Acceptance criteria

## Dependencies
None

## Out of scope
Live dispatch.

## Validation plan
npm test
`;

  const result = validateIssueContract(emptySectionBody);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.path === 'body.sections.Acceptance criteria'));
});

test('custom requiredIssueSections override works', () => {
  const customBody = `
## Summary
Short summary.

## Test plan
Run tests.
`;

  const options = { requiredIssueSections: ['Summary', 'Test plan'] };
  const result = validateIssueContract(customBody, options);
  assert.equal(result.valid, true);
});

test('pull request template body passes PR contract validation', () => {
  const prTemplatePath = join(__dirname, '../.github/pull_request_template.md');
  const prTemplateBody = readFileSync(prTemplatePath, 'utf8');

  const result = validatePullRequestContract(prTemplateBody);
  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
});

test('pull request missing required sections fails with detailed errors', () => {
  const badPRBody = `
## Governing Issue
Closes #12

## Summary
Done.
`;

  const result = validatePullRequestContract(badPRBody);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.path === 'body.sections.Scope boundary'));
  assert.ok(result.errors.some(e => e.path === 'body.sections.Acceptance criteria evidence'));
  assert.ok(result.errors.some(e => e.path === 'body.sections.Verification'));
  assert.ok(result.errors.some(e => e.path === 'body.sections.Risks and blockers'));
  assert.ok(result.errors.some(e => e.path === 'body.sections.Handoff'));
});

test('validation functions are pure and execute read-only without mutations or dispatches', () => {
  const issueInput = { body: '## Scope\nTest\n## Acceptance criteria\nTest\n## Dependencies\nNone\n## Out of scope\nNone\n## Validation plan\nTest' };
  const frozenInput = Object.freeze({ ...issueInput });

  const result = validateIssueContract(frozenInput);
  assert.equal(result.valid, true);
});
