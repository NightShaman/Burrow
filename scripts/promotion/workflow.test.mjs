import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const workflow = readFileSync(new URL('../../.github/workflows/daily-public-promotion.yml', import.meta.url), 'utf8');
test('freeze assembly and component identities from the same checkout', () => {
  assert.match(workflow, /burrow=\$\(git -C orchestrator rev-parse HEAD\)/);
  assert.match(workflow, /backend=\$\(awk .*orchestrator\/SOURCE_VERSIONS\)/);
  assert.doesNotMatch(workflow, /burrow=\$\(gh api .*commits\/main/);
});
test('validation-only dispatch disables publication while retaining tests', () => {
  assert.match(workflow, /inputs.validate_only.*then validation_required=true; publishable=false; fi/);
  assert.match(workflow, /if: needs.stage.outputs.publishable == 'true'/);
});
test('manifest lookup distinguishes missing manifests from request failures', () => {
  assert.match(workflow, /404\) printf 'null/);
  assert.match(workflow, /public manifest HTTP \$status.*exit 1/);
  assert.doesNotMatch(workflow, /output previous.json \|\|/);
});
test('complete validation has a deadline rather than hanging indefinitely', () => {
  assert.match(workflow, /timeout-minutes: 45/);
  assert.match(workflow, /timeout --kill-after=15s 10m npm test/);
});
