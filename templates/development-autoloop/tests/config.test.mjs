import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateConfig } from '../src/config.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

test('valid autoloop.example.json config passes validation', () => {
  const exampleConfigPath = join(__dirname, '../config/autoloop.example.json');
  const exampleConfigJson = readFileSync(exampleConfigPath, 'utf8');
  const result = validateConfig(exampleConfigJson);

  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
  assert.ok(result.config);
  assert.equal(result.config.schemaVersion, 1);
});

test('malformed JSON string returns path-specific error', () => {
  const result = validateConfig('{ invalid json ');
  assert.equal(result.valid, false);
  assert.equal(result.config, null);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].path, '$');
  assert.match(result.errors[0].message, /Malformed JSON input/);
});

test('non-object input returns path-specific error', () => {
  const result = validateConfig('123');
  assert.equal(result.valid, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].path, '$');
  assert.match(result.errors[0].message, /non-null object/);
});

test('unknown top-level config property returns actionable error', () => {
  const validObj = JSON.parse(
    readFileSync(join(__dirname, '../config/autoloop.example.json'), 'utf8')
  );
  const badObj = { ...validObj, unknownProperty: 'foo' };
  const result = validateConfig(badObj);

  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.path === 'unknownProperty'));
});

test('unsupported schemaVersion produces path-specific error', () => {
  const validObj = JSON.parse(
    readFileSync(join(__dirname, '../config/autoloop.example.json'), 'utf8')
  );

  const badVersion = { ...validObj, schemaVersion: 99 };
  const result1 = validateConfig(badVersion);
  assert.equal(result1.valid, false);
  assert.ok(result1.errors.some(e => e.path === 'schemaVersion' && e.message.includes('Unsupported schemaVersion 99')));

  const missingVersion = { ...validObj };
  delete missingVersion.schemaVersion;
  const result2 = validateConfig(missingVersion);
  assert.equal(result2.valid, false);
  assert.ok(result2.errors.some(e => e.path === 'schemaVersion'));
});

test('invalid runMode produces path-specific error', () => {
  const validObj = JSON.parse(
    readFileSync(join(__dirname, '../config/autoloop.example.json'), 'utf8')
  );
  const badMode = { ...validObj, runMode: 'invalid-mode' };
  const result = validateConfig(badMode);

  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.path === 'runMode'));
});

test('invalid maxConcurrentSessions and staleClaimMinutes produce path-specific errors', () => {
  const validObj = JSON.parse(
    readFileSync(join(__dirname, '../config/autoloop.example.json'), 'utf8')
  );
  const badLimits = { ...validObj, maxConcurrentSessions: 0, staleClaimMinutes: -5 };
  const result = validateConfig(badLimits);

  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.path === 'maxConcurrentSessions'));
  assert.ok(result.errors.some(e => e.path === 'staleClaimMinutes'));
});

test('missing or invalid label properties produce path-specific errors', () => {
  const validObj = JSON.parse(
    readFileSync(join(__dirname, '../config/autoloop.example.json'), 'utf8')
  );
  const badLabels = {
    ...validObj,
    labels: {
      ...validObj.labels,
      proposed: '',
      extraLabel: 'extra',
    },
  };
  delete badLabels.labels.ready;

  const result = validateConfig(badLabels);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.path === 'labels.proposed'));
  assert.ok(result.errors.some(e => e.path === 'labels.ready'));
  assert.ok(result.errors.some(e => e.path === 'labels.extraLabel'));
});

test('non-array or empty string elements in list fields produce path-specific errors', () => {
  const validObj = JSON.parse(
    readFileSync(join(__dirname, '../config/autoloop.example.json'), 'utf8')
  );
  const badLists = {
    ...validObj,
    requiredChecks: 'not-an-array',
    trustedReviewers: ['alice', ''],
  };

  const result = validateConfig(badLists);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.path === 'requiredChecks'));
  assert.ok(result.errors.some(e => e.path === 'trustedReviewers[1]'));
});
