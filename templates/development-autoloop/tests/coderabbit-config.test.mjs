import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const templateRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const repositoryRoot = resolve(templateRoot, '../..');
const rootConfig = readFileSync(resolve(repositoryRoot, '.coderabbit.yaml'), 'utf8');
const consumerConfig = readFileSync(resolve(templateRoot, '.coderabbit.yaml'), 'utf8');

test('catalog and consumer template share the same persistent CodeRabbit defaults', () => {
  assert.equal(consumerConfig, rootConfig);
  for (const config of [rootConfig, consumerConfig]) {
    assert.match(config, /^reviews:\s*$/m);
    assert.match(config, /^  auto_review:\s*$/m);
    assert.match(config, /^    enabled: true\s*$/m);
    assert.match(config, /^    auto_incremental_review: true\s*$/m);
    assert.match(config, /^    drafts: false\s*$/m);
  }
});

test('CodeRabbit configuration explains that app installation is separate', () => {
  assert.match(rootConfig, /must also be installed and authorized/i);
});
