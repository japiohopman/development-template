import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  validateIssueContract,
  validatePullRequestContract,
  extractMarkdownSections
} from '../src/contracts.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const validIssueBody = [
  '## Scope',
  'Implement contract validation.',
  '',
  '## Acceptance criteria',
  '- Schema is validated.',
  '',
  '## Dependencies',
  'None',
  '',
  '## Out of scope',
  'Live dispatch.',
  '',
  '## Validation plan',
  'npm test'
].join('\n');

const completePrBody = [
  '## Governing Issue',
  'Closes #123',
  '',
  '## Summary',
  'Adds schema-backed configuration validation.',
  '',
  '## Scope boundary',
  'Validation only; no live dispatch.',
  '',
  '## Acceptance criteria evidence',
  'Schema validation and contract checks are covered by tests.',
  '',
  '## Verification',
  'All tests pass on the exact head SHA.',
  '',
  '## Risks and blockers',
  'No known blockers.',
  '',
  '## Handoff',
  'Human review remains required.'
].join('\n');

test('extractMarkdownSections handles hash and bold headings', () => {
  const markdown = [
    '# Scope',
    'This is the scope.',
    '',
    '## Acceptance criteria',
    'Criterion A',
    'Criterion B',
    '',
    '**Dependencies**',
    'None',
    '',
    '**Out of scope**',
    'Other features',
    '',
    '### Validation plan',
    'Run unit tests'
  ].join('\n');
  const sections = extractMarkdownSections(markdown);
  assert.equal(sections.get('scope'), 'This is the scope.');
  assert.equal(sections.get('acceptance criteria'), 'Criterion A\nCriterion B');
  assert.equal(sections.get('dependencies'), 'None');
  assert.equal(sections.get('out of scope'), 'Other features');
  assert.equal(sections.get('validation plan'), 'Run unit tests');
});

test('complete Issue body passes validation', () => {
  const result = validateIssueContract(validIssueBody);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('Issue missing a required section returns a stable pointer diagnostic', () => {
  const body = [
    '## Scope', 'Implement it.',
    '## Acceptance criteria', 'Test it.',
    '## Dependencies', 'None',
    '## Validation plan', 'npm test'
  ].join('\n');
  const result = validateIssueContract(body);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.path === '/body/sections/Out of scope' && error.code === 'REQUIRED_SECTION_MISSING'));
});

test('empty required Issue section fails', () => {
  const body = [
    '## Scope', 'Implement it.',
    '## Acceptance criteria', '',
    '## Dependencies', 'None',
    '## Out of scope', 'Live dispatch.',
    '## Validation plan', 'npm test'
  ].join('\n');
  const result = validateIssueContract(body);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.path === '/body/sections/Acceptance criteria' && error.code === 'REQUIRED_SECTION_EMPTY'));
});

test('custom required Issue sections override works', () => {
  const body = ['## Summary', 'Short summary.', '## Test plan', 'Run tests.'].join('\n');
  const result = validateIssueContract(body, { requiredIssueSections: ['Summary', 'Test plan'] });
  assert.equal(result.valid, true);
});

test('completed PR fixture with a real governing Issue reference passes', () => {
  const result = validatePullRequestContract(completePrBody);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('the untouched PR template placeholder is not a valid completed PR contract', () => {
  const templatePath = join(__dirname, '../.github/pull_request_template.md');
  const templateBody = readFileSync(templatePath, 'utf8');
  const result = validatePullRequestContract(templateBody);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.path === '/body/sections/Governing Issue' && error.code === 'GOVERNING_ISSUE_REFERENCE_REQUIRED'));
});

test('a valid GitHub Issue URL is accepted in the governing Issue section', () => {
  const body = completePrBody.replace('Closes #123', 'https://github.com/example/project/issues/123');
  assert.equal(validatePullRequestContract(body).valid, true);
});

test('missing PR contract sections fail with precise paths', () => {
  const result = validatePullRequestContract(['## Governing Issue', 'Closes #12', '## Summary', 'Done.'].join('\n'));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.path === '/body/sections/Scope boundary'));
  assert.ok(result.errors.some((error) => error.path === '/body/sections/Acceptance criteria evidence'));
  assert.ok(result.errors.some((error) => error.path === '/body/sections/Verification'));
  assert.ok(result.errors.some((error) => error.path === '/body/sections/Risks and blockers'));
  assert.ok(result.errors.some((error) => error.path === '/body/sections/Handoff'));
});

test('contract diagnostic shape and order are stable', () => {
  const result = validatePullRequestContract(['## Summary', 'Done.'].join('\n'));
  assert.deepEqual(result.errors, result.errors.slice().sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 :
    a.code < b.code ? -1 : a.code > b.code ? 1 :
    a.message < b.message ? -1 : a.message > b.message ? 1 : 0
  ));
  assert.ok(result.errors.every((error) => Object.keys(error).sort().join(',') === 'code,message,path'));
});

test('contract validators reject invalid inputs with stable diagnostics', () => {
  assert.deepEqual(validateIssueContract(null).errors, [{
    path: '/',
    code: 'INVALID_CONTRACT_INPUT',
    message: 'Issue input must be a string or an object with a body property.'
  }]);
});

test('validators remain pure and read-only', () => {
  const input = Object.freeze({ body: validIssueBody });
  const result = validateIssueContract(input);
  assert.equal(result.valid, true);
  assert.equal(input.body, validIssueBody);
});
