import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { executableModes, verifyExecutableModes } from './executable-modes.mjs';

const script = fileURLToPath(new URL('./publish-snapshot.sh', import.meta.url));
const gitBinary = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();

function command(program, args, options = {}) {
  const result = spawnSync(program, args, { encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  return result;
}
function git(args, options = {}) {
  const result = command(gitBinary, args, options);
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-snapshot-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bare = path.join(root, 'Fixture.git');
  const seed = path.join(root, 'seed');
  const source = path.join(root, 'source');
  fs.mkdirSync(source);
  git(['init', '-q', '--bare', bare]);
  git(['init', '-q', '-b', 'main', seed]);
  git(['-C', seed, 'config', 'user.name', 'Test']);
  git(['-C', seed, 'config', 'user.email', 'test@example.invalid']);
  git(['-C', seed, 'remote', 'add', 'origin', bare]);
  const config = path.join(root, 'gitconfig');
  fs.writeFileSync(config, `[url "file://${root}/"]\n\tinsteadOf = https://github.com/GoblinKing-Burrow/\n`);
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const wrapper = path.join(bin, 'git');
  fs.writeFileSync(wrapper, `#!/bin/sh\ncase " $* " in\n  *" ls-remote "*)\n    case " $* " in\n      *" --heads "*) [ "\${FAKE_LS_REMOTE_FAIL:-}" = main ] && exit 128 ;;\n      *" --tags "*) [ "\${FAKE_LS_REMOTE_FAIL:-}" = tag ] && exit 128 ;;\n    esac ;;\nesac\nexec "${gitBinary}" "$@"\n`);
  fs.chmodSync(wrapper, 0o755);
  const env = { ...process.env, HOME: root, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', PUBLIC_GITHUB_TOKEN: 'test-secret-never-print', PATH: `${bin}:${process.env.PATH}` };
  const ref = name => {
    const result = command(gitBinary, ['--git-dir', bare, 'rev-parse', '--verify', name]);
    return result.status === 0 ? result.stdout.trim() : null;
  };
  const seedCommit = (content, tag) => {
    fs.writeFileSync(path.join(seed, 'snapshot.txt'), content);
    git(['-C', seed, 'add', '-A']);
    git(['-C', seed, 'commit', '-q', '-m', 'seed']);
    const commit = git(['-C', seed, 'rev-parse', 'HEAD']);
    git(['-C', seed, 'push', '-q', 'origin', 'HEAD:main']);
    if (tag) {
      git(['-C', seed, 'tag', tag]);
      git(['-C', seed, 'push', '-q', 'origin', tag]);
    }
    return commit;
  };
  const publish = (content, version = '1', extraEnv = {}) => {
    fs.writeFileSync(path.join(source, 'snapshot.txt'), content);
    return command('sh', [script, 'Fixture', source, version, 'snapshot publication'], { env: { ...env, ...extraEnv } });
  };
  return { root, bare, source, env, ref, seedCommit, publish };
}

function successful(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, /test-secret-never-print/);
}

test('publishes an empty repository and an existing main, then is idempotent', t => {
  const f = fixture(t);
  const first = f.publish('one');
  successful(first);
  assert.equal(f.ref('refs/heads/main'), first.stdout.trim());
  assert.equal(f.ref('refs/tags/v1'), first.stdout.trim());
  const repeat = f.publish('one');
  successful(repeat);
  assert.equal(repeat.stdout, first.stdout);
  const second = f.publish('two', '2');
  successful(second);
  assert.equal(f.ref('refs/heads/main'), second.stdout.trim());
  assert.equal(f.ref('refs/tags/v2'), second.stdout.trim());
});

test('conflicting immutable tag rejects candidate before modifying main or tag', t => {
  const f = fixture(t);
  const original = f.seedCommit('old', 'v1');
  const result = f.publish('different');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /immutable tag v1 already points elsewhere/);
  assert.equal(f.ref('refs/heads/main'), original);
  assert.equal(f.ref('refs/tags/v1'), original);
});

test('same tree in existing tag succeeds without rolling back advanced main', t => {
  const f = fixture(t);
  const tagged = f.seedCommit('release', 'v1');
  const advanced = f.seedCommit('later');
  const result = f.publish('release');
  successful(result);
  assert.equal(result.stdout.trim(), tagged);
  assert.equal(f.ref('refs/heads/main'), advanced);
  assert.equal(f.ref('refs/tags/v1'), tagged);
});

for (const failedRef of ['main', 'tag']) {
  test(`ls-remote ${failedRef} error is not mistaken for an absent ref`, t => {
    const f = fixture(t);
    const original = f.seedCommit('old');
    const result = f.publish('new', '1', { FAKE_LS_REMOTE_FAIL: failedRef });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`unable to inspect ${failedRef}`));
    assert.equal(f.ref('refs/heads/main'), original);
    assert.equal(f.ref('refs/tags/v1'), null);
    assert.doesNotMatch(result.stdout + result.stderr, /test-secret-never-print/);
  });
}


test('tar-restored executable and non-executable modes survive publication and the downstream source archive', t => {
  const f = fixture(t);
  const staged = path.join(f.root, 'stage/staged/Burrow');
  fs.mkdirSync(path.join(staged, 'backend/bin'), { recursive: true });
  for (const [name, mode] of [['install.sh', 0o755], ['backend/bin/worker', 0o755], ['README.md', 0o644]]) {
    const file = path.join(staged, name);
    fs.writeFileSync(file, `payload ${name}\n`);
    fs.chmodSync(file, mode);
  }
  const modes = executableModes(path.join(f.root, 'stage/staged'));
  const tarball = path.join(f.root, 'promotion.tar');
  assert.equal(command('tar', ['-cpf', tarball, '-C', path.join(f.root, 'stage'), 'staged']).status, 0);
  fs.chmodSync(tarball, 0o644);
  const download = path.join(f.root, 'download');
  fs.mkdirSync(download);
  assert.equal(command('tar', ['-xpf', tarball, '-C', download]).status, 0);
  verifyExecutableModes(path.join(download, 'staged'), modes);
  const result = command('sh', [script, 'Fixture', path.join(download, 'staged/Burrow'), '1', 'mode-preserving promotion'], { env: f.env });
  successful(result);
  const tree = git(['--git-dir', f.bare, 'ls-tree', '-r', 'refs/tags/v1']);
  assert.match(tree, /100755 blob [^\n]+\tinstall\.sh/);
  assert.match(tree, /100755 blob [^\n]+\tbackend\/bin\/worker/);
  assert.match(tree, /100644 blob [^\n]+\tREADME\.md/);
  const publicTar = path.join(f.root, 'public-source.tar');
  git(['--git-dir', f.bare, 'archive', '--format=tar', `--output=${publicTar}`, 'refs/tags/v1']);
  const extracted = path.join(f.root, 'installed-source');
  fs.mkdirSync(extracted);
  assert.equal(command('tar', ['-xpf', publicTar, '-C', extracted]).status, 0);
  assert.ok(fs.statSync(path.join(extracted, 'install.sh')).mode & 0o111);
  assert.ok(fs.statSync(path.join(extracted, 'backend/bin/worker')).mode & 0o111);
  assert.equal(fs.statSync(path.join(extracted, 'README.md')).mode & 0o111, 0);
});
