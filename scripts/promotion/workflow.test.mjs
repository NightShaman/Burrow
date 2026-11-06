import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
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
  const bundle = workflow.indexOf('tar -cpf public-promotion.tar staged sources.json plan.json release-notes release-assets executable-modes.json tested-image.json tested-image.tar.gz tested-image.tar.gz.sha256');
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

test('existing Node Goblin release must carry both frozen assets before promotion continues', () => {
  const start = workflow.indexOf('      - name: Publish component releases with coordinated notes');
  const step = workflow.slice(start, workflow.indexOf('      - uses: docker/setup-buildx-action@v3', start));
  const shell = step.slice(step.indexOf('        run: |\n') + '        run: |\n'.length)
    .trimEnd().split('\n').map(line => line.replace(/^          /, '')).join('\n');
  const root = mkdtempSync(join(tmpdir(), 'burrow-release-assets-'));
  try {
    const bin = join(root, 'bin');
    const assets = join(root, 'release-assets/nodeGoblin');
    mkdirSync(bin); mkdirSync(assets, { recursive: true });
    writeFileSync(join(assets, 'node-goblin-2026.11.06.tar.gz'), 'frozen archive');
    writeFileSync(join(assets, 'node-goblin-2026.11.06.tar.gz.sha256'), 'frozen checksum');
    writeFileSync(join(bin, 'gh'), `#!/bin/sh
case "$1 $2" in
  'release view') exit 0 ;;
  'release download')
    pattern=''; destination=''
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --pattern) pattern=$2; shift 2 ;;
        --dir) destination=$2; shift 2 ;;
        *) shift ;;
      esac
    done
    [ "$RELEASE_ASSET_CASE" != missing ] || [ "${'${pattern##*.}'}" = gz ] || exit 1
    if [ "$RELEASE_ASSET_CASE" = wrong ] && [ "${'${pattern##*.}'}" = sha256 ]; then
      printf 'stale checksum' > "$destination/$pattern"
    else
      cp "release-assets/nodeGoblin/$pattern" "$destination/$pattern"
    fi ;;
  *) echo 'unexpected gh invocation' >&2; exit 2 ;;
esac
` , { mode: 0o755 });
    for (const [assetCase, expected] of [['matching', 0], ['missing', 1], ['wrong', 1]]) {
      const result = spawnSync('bash', ['-e', '-c', shell], {
        cwd: root, encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PUBLIC_OWNER: 'GoblinKing-Burrow', VERSION: '2026.11.06', RELEASE_ASSET_CASE: assetCase },
      });
      assert.equal(result.status === 0 ? 0 : 1, expected, `${assetCase}: ${result.stderr}`);
      if (expected) assert.match(result.stderr, /Node Goblin public release asset missing or differs/);
    }
    assert.ok(workflow.indexOf('      - name: Publish Burrow snapshot and coordinated release last') > start);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
