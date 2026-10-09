import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  CONFIG_SCHEMA,
  KNOWN_CONFIG_KEYS,
  REQUIRED_LABEL_KEYS,
  SUPPORTED_SCHEMA_VERSION,
  validateConfig
} from '../src/config.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const examplePath = join(__dirname, '../config/autoloop.example.json');
const schemaPath = join(__dirname, '../config/autoloop.schema.v1.json');

function readExample() {
  return JSON.parse(readFileSync(examplePath, 'utf8'));
}

test('valid example config passes the versioned schema', () => {
  const result = validateConfig(readFileSync(examplePath, 'utf8'));
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.config.schemaVersion, SUPPORTED_SCHEMA_VERSION);
});

test('canonical schema and example remain in sync', () => {
  const example = readExample();
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
  assert.equal(schema.properties.schemaVersion.const, 1);
  assert.deepEqual(schema, CONFIG_SCHEMA);
  assert.deepEqual(Object.keys(example).sort(), Object.keys(schema.properties).sort());
  assert.deepEqual([...KNOWN_CONFIG_KEYS].sort(), Object.keys(schema.properties).sort());
  assert.deepEqual(Object.keys(example.labels).sort(), Object.keys(schema.properties.labels.properties).sort());
  assert.deepEqual(REQUIRED_LABEL_KEYS.slice().sort(), Object.keys(schema.properties.labels.properties).sort());
  assert.deepEqual(schema.required.slice().sort(), Object.keys(example).sort());
});

test('malformed JSON returns a stable machine-readable diagnostic', () => {
  const result = validateConfig('{ invalid json ');
  assert.equal(result.valid, false);
  assert.equal(result.config, null);
  assert.deepEqual(result.errors, [
    { path: '/', code: 'INVALID_JSON', message: 'Input is not valid JSON.' }
  ]);
});

test('non-object root is rejected by schema type validation', () => {
  const result = validateConfig('123');
  assert.equal(result.valid, false);
  assert.equal(result.config, null);
  assert.ok(result.errors.some((error) => error.path === '/' && error.code === 'SCHEMA_TYPE'));
});

test('unknown top-level keys are rejected with stable codes and ordering', () => {
  const example = readExample();
  const first = validateConfig({ ...example, zeta: true, alpha: true });
  const second = validateConfig({ alpha: true, zeta: true, ...example });
  assert.deepEqual(first.errors, second.errors);
  assert.deepEqual(first.errors.map((error) => [error.path, error.code]), [
    ['/alpha', 'SCHEMA_ADDITIONAL_PROPERTIES'],
    ['/zeta', 'SCHEMA_ADDITIONAL_PROPERTIES']
  ]);
  assert.ok(first.errors.every((error) => Object.keys(error).sort().join(',') === 'code,message,path'));
});

test('unsupported schema versions are rejected at schemaVersion', () => {
  const result = validateConfig({ ...readExample(), schemaVersion: 99 });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.path === '/schemaVersion' && error.code === 'SCHEMA_CONST'));
});

test('invalid run mode and blank branch name are rejected', () => {
  const result = validateConfig({ ...readExample(), runMode: 'sometimes', defaultBranch: '   ' });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.path === '/runMode' && error.code === 'SCHEMA_ENUM'));
  assert.ok(result.errors.some((error) => error.path === '/defaultBranch' && error.code === 'SCHEMA_MIN_LENGTH'));
});

test('invalid session limits produce deterministic diagnostics', () => {
  const result = validateConfig({ ...readExample(), maxConcurrentSessions: 0, staleClaimMinutes: -5 });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.path === '/maxConcurrentSessions' && error.code === 'SCHEMA_MINIMUM'));
  assert.ok(result.errors.some((error) => error.path === '/staleClaimMinutes' && error.code === 'SCHEMA_MINIMUM'));
});

test('missing, blank, and unknown label fields are rejected', () => {
  const example = readExample();
  const labels = { ...example.labels, proposed: '', extraLabel: 'unexpected' };
  delete labels.ready;
  const result = validateConfig({ ...example, labels });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.path === '/labels/proposed' && error.code === 'SCHEMA_MIN_LENGTH'));
  assert.ok(result.errors.some((error) => error.path === '/labels/ready' && error.code === 'SCHEMA_REQUIRED'));
  assert.ok(result.errors.some((error) => error.path === '/labels/extraLabel' && error.code === 'SCHEMA_ADDITIONAL_PROPERTIES'));
});

test('list items and minimum required Issue sections are validated', () => {
  const example = readExample();
  const result = validateConfig({
    ...example,
    requiredIssueSections: [],
    requiredChecks: [''],
    trustedReviewers: ['alice', '']
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.path === '/requiredIssueSections' && error.code === 'SCHEMA_MIN_ITEMS'));
  assert.ok(result.errors.some((error) => error.path === '/requiredChecks/0' && error.code === 'SCHEMA_MIN_LENGTH'));
  assert.ok(result.errors.some((error) => error.path === '/trustedReviewers/1' && error.code === 'SCHEMA_MIN_LENGTH'));
});

test('sequenceSource accepts null or a non-empty string only', () => {
  assert.equal(validateConfig({ ...readExample(), sequenceSource: null }).valid, true);
  assert.equal(validateConfig({ ...readExample(), sequenceSource: 'docs/roadmap.md' }).valid, true);
  const invalid = validateConfig({ ...readExample(), sequenceSource: '' });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.some((error) => error.path === '/sequenceSource' && error.code === 'SCHEMA_MIN_LENGTH'));
});

test('example keeps all automation safety defaults disabled', () => {
  const example = readExample();
  assert.equal(example.enabled, false);
  assert.equal(example.runMode, 'dry-run');
  assert.equal(example.automaticMerge, false);
  assert.equal(example.scheduleEnabled, false);
});
