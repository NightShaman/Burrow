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
test('Node Goblin documentation validates its mounted site including error pages', () => {
  assert.match(workflow, /cd sources\/Node-Goblin && python -m unittest discover -s scripts\/docs -p 'test_\*\.py'/);
  assert.match(workflow, /cd sources\/Node-Goblin[^\n]*python scripts\/docs\/check_site\.py site --base-path \/node-goblin\//);
});
test('complete validation stays bounded and gives serial backend validation room to finish', () => {
  const validation = workflow.slice(
    workflow.indexOf('- name: Run complete frozen-source test suites'),
    workflow.indexOf('- uses: actions/setup-python@v6'),
  );
  assert.match(validation, /BURROW_TEST_TIMEOUT_MS: '3600000'/);
  assert.match(validation, /BURROW_TEST_DISPOSABLE_POSTGRES: '1'/);
  assert.match(validation, /timeout-minutes: 90/);
  assert.match(validation, /cd sources\/Burrow-Backend && npm ci --no-audit --no-fund && npm test/);
  assert.equal(validation.match(/timeout --kill-after=15s 10m npm test/g)?.length, 2);
  assert.doesNotMatch(validation, /BURROW_TEST_CONCURRENCY|--test-concurrency|--test-name-pattern/);
});

test('artifact handoff wraps the validated tree and checks restored executable modes before any publication', () => {
  const bundle = workflow.indexOf('tar -cpf public-promotion.tar staged sources.json plan.json release-notes executable-modes.json');
  const upload = workflow.indexOf('uses: actions/upload-artifact@v4');
  const download = workflow.indexOf('uses: actions/download-artifact@v4');
  const extract = workflow.indexOf('tar -xpf public-promotion.tar');
  const verify = workflow.indexOf('executable-modes.mjs verify staged executable-modes.json');
  const publish = workflow.indexOf('- name: Publish immutable Git snapshots');
  assert.ok(bundle > 0 && bundle < upload && upload < download && download < extract && extract < verify && verify < publish);
  assert.match(workflow.slice(bundle, download), /path: public-promotion\.tar\s+if-no-files-found: error/);
  assert.match(workflow.slice(0, bundle), /executable-modes\.mjs record staged executable-modes\.json/);
  assert.match(workflow.slice(verify, publish), /test -x staged\/Burrow\/install\.sh/);
  assert.match(workflow.slice(verify, publish), /test -x staged\/Node-Goblin\/install\.sh/);
});

test('promotion changes run installer, assembly and promotion regressions on push and PR', () => {
  const installerWorkflow = readFileSync(new URL('../../.github/workflows/native-installer.yml', import.meta.url), 'utf8');
  assert.equal(installerWorkflow.match(/'scripts\/promotion\/\*\*'/g)?.length, 2);
  assert.equal(installerWorkflow.match(/'\.github\/workflows\/daily-public-promotion\.yml'/g)?.length, 2);
  assert.match(installerWorkflow, /node --test scripts\/install\/\*\.test\.mjs scripts\/assembly\/\*\.test\.mjs scripts\/promotion\/\*\.test\.mjs/);
});
