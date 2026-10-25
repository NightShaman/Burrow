import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const workflow = readFileSync(new URL('../../.github/workflows/assemble.yml', import.meta.url), 'utf8');
test('release publication follows image smoke, commit and registry publication', () => {
  const publish = workflow.indexOf('- name: Publish NightShaman release');
  for (const step of ['- name: Smoke development image', '- name: Commit generated assembly', '- name: Publish tested development image']) {
    assert.ok(workflow.indexOf(step) < publish);
  }
});
test('normal latest release targets immutable assembled commit with install payload and checksums', () => {
  const release = workflow.slice(workflow.indexOf('- name: Publish NightShaman release'));
  assert.match(release, /git -C assembled archive[^\n]+"\$ASSEMBLY_COMMIT"/);
  assert.match(release, /sha256sum/);
  assert.match(release, /gh release create "v\$BUILD_VERSION"/);
  assert.match(release, /--target "\$ASSEMBLY_COMMIT"/);
  assert.match(release, /--latest/);
  assert.doesNotMatch(release, /--prerelease|--draft/);
  assert.match(release, /--repo "\$GITHUB_REPOSITORY"/);
});
