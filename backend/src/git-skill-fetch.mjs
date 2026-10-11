import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const utf8 = new TextDecoder('utf-8', { fatal: true });
const objectId = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const gitEnvironment = () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:GIT_|SSH_ASKPASS$|HOME$)/.test(key)));
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull,
    GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1',
    // Ignore user SSH configuration (including ProxyCommand) and prompt only via configured keys.
    GIT_SSH_COMMAND: 'ssh -F /dev/null -oBatchMode=yes',
  };
};

function fail(message) { throw new Error(message); }

function validateRepository(repository) {
  if (typeof repository !== 'string' || !repository || /[\0\r\n]/.test(repository)) fail('Invalid Git repository');
  if (path.isAbsolute(repository)) return repository;
  if (/^https:\/\//i.test(repository) || /^ssh:\/\//i.test(repository)) {
    let url;
    try { url = new URL(repository); } catch { fail('Invalid Git repository URL'); }
    const authority = /^[^:]+:\/\/([^/?#]*)/.exec(repository)?.[1] || '';
    if (!url.hostname || (url.protocol === 'https:' && url.username) || url.search || url.hash || url.password || (authority.includes('@') && authority.slice(0, authority.lastIndexOf('@')).includes(':')) ||
        !['https:', 'ssh:'].includes(url.protocol)) fail('Invalid or password-bearing Git repository URL');
    return repository;
  }
  // SSH's scp-style transport is common for generic (non-GitHub) Git servers.
  if (/^(?:[A-Za-z0-9_.-]+@)?[A-Za-z0-9_.-]+:[^\0\r\n]+$/.test(repository) && !repository.startsWith('-')) return repository;
  fail('Git repository must be an absolute local path, HTTPS URL, or SSH URL');
}

function validatePath(skillPath) {
  if (skillPath === '.') return skillPath;
  if (typeof skillPath !== 'string' || !skillPath || /[\0\r\n\\]/.test(skillPath) || skillPath.startsWith('/') ||
      skillPath.split('/').some((part) => !part || part === '.' || part === '..' || part === '.git') ||
      /^[A-Za-z]:/.test(skillPath)) fail('Invalid skill path');
  return skillPath;
}

function validateRef(ref) {
  if (typeof ref !== 'string' || !ref || ref.startsWith('-') || /[\0\r\n]/.test(ref) || ref.includes(':')) fail('Invalid Git ref');
  return ref;
}

// One wall-clock deadline covers network fetch AND object extraction, rather than imposing
// arbitrary file/skill size caps. Increase timeoutMs for slow links or large legitimate assets.
function gitRunner(bare, deadline) {
  const flags = ['-c', 'core.hooksPath=/dev/null', '-c', 'uploadpack.packObjectsHook=', '-c', 'credential.helper=',
    '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always',
    '-c', 'protocol.https.allow=always', '-c', 'protocol.ssh.allow=always'];
  return async (...args) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) fail('Git skill fetch timed out');
    return await new Promise((resolve, reject) => {
      const child = spawn('git', [...flags, '--git-dir', bare, ...args], {
        env: gitEnvironment(), stdio: ['ignore', 'pipe', 'ignore'], detached: process.platform !== 'win32',
      });
      const chunks = [];
      let timedOut = false;
      let settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve(result);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch { /* already exited */ }
      }, remaining);
      child.stdout.on('data', (chunk) => chunks.push(chunk));
      child.on('error', () => finish(new Error('Git skill fetch failed')));
      child.on('close', (code) => finish(code === 0 && !timedOut ? null : new Error(timedOut ? 'Git skill fetch timed out' : 'Git skill fetch failed'), Buffer.concat(chunks)));
    });
  };
}

function decode(buffer) {
  try { return utf8.decode(buffer); } catch { fail('Skill contains a non-UTF8 path or SKILL.md'); }
}

function parseTree(data) {
  const entries = [];
  let start = 0;
  while (start < data.length) {
    const end = data.indexOf(0, start);
    if (end < 0) fail('Invalid Git tree');
    const tab = data.indexOf(9, start);
    if (tab < 0 || tab > end) fail('Invalid Git tree');
    const header = data.toString('ascii', start, tab).split(' ');
    if (header.length !== 3 || !objectId.test(header[2])) fail('Invalid Git tree');
    entries.push({ mode: header[0], type: header[1], oid: header[2], name: decode(data.subarray(tab + 1, end)) });
    start = end + 1;
  }
  return entries;
}

function metadata(text, fallback) {
  const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  const fields = {};
  if (front) for (const line of front[1].split(/\r?\n/)) {
    const item = /^([A-Za-z][\w-]*):\s*(.*?)\s*$/.exec(line);
    if (item) fields[item[1]] = item[2].replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_, double, single) => double ?? single);
  }
  return { name: fields.name || fallback, description: fields.description || '' };
}

/**
 * Fetch just the selected skill tree from a Git revision into a temporary bare repository.
 * No checkout, Git hooks or repository code run. timeoutMs (default 120s) is an aggregate
 * technical deadline for network/object operations, NOT a content-size limit.
 * A standalone SKILL.md is PostgreSQL-compatible; directories with assets require filesystem.
 */
export function validateGitSkillSource({repository,ref='HEAD',path:skillPath}={}) { validateRepository(repository); validateRef(ref); validatePath(skillPath); }

export async function fetchGitSkill({ repository, ref = 'HEAD', path: skillPath, timeoutMs = 120_000 } = {}) {
  const source = validateRepository(repository);
  const selected = validatePath(skillPath);
  validateRef(ref);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) fail('Invalid Git fetch timeout');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'burrow-git-skill-'));
  try {
    const bare = path.join(temporary, 'repo.git');
    const template = path.join(temporary, 'empty-template');
    await fs.mkdir(template);
    const git = gitRunner(bare, Date.now() + timeoutMs);
    await git('init', '--bare', '--template=' + template, bare);
    // FETCH_HEAD is exactly the fetched ref, including tags and detached commits.
    await git('fetch', '--no-tags', '--no-recurse-submodules', '--depth=1', '--filter=blob:none', '--', source, ref);
    const revision = (await git('rev-parse', '--verify', 'FETCH_HEAD^{commit}')).toString('ascii').trim();
    if (!objectId.test(revision)) fail('Invalid Git revision');
    let tree = (await git('rev-parse', '--verify', `${revision}^{tree}`)).toString('ascii').trim();
    if (!objectId.test(tree)) fail('Invalid Git tree');
    let selectedEntry = {mode:'040000',type:'tree',oid:tree,name:path.basename(source)};
    const components = selected === '.' ? [] : selected.split('/');
    for (const [index, component] of components.entries()) {
      selectedEntry = parseTree(await git('ls-tree', '-z', tree)).find((entry) => entry.name === component);
      if (!selectedEntry) fail('Skill path not found');
      if (selectedEntry.mode === '120000' || selectedEntry.mode === '160000') fail('Symlinks and gitlinks are not allowed in skills');
      if (index < components.length - 1) {
        if (selectedEntry.mode !== '040000' || selectedEntry.type !== 'tree') fail('Skill path is not a directory');
        tree = selectedEntry.oid;
      }
    }
    const isFile = selectedEntry.type === 'blob';
    if (isFile && (selectedEntry.name !== 'SKILL.md' || !['100644', '100755'].includes(selectedEntry.mode))) fail('A file skill path must be a regular SKILL.md');
    if (!isFile && (selectedEntry.mode !== '040000' || selectedEntry.type !== 'tree')) fail('Skill path is not a directory');
    const entries = isFile ? [{ ...selectedEntry, path: 'SKILL.md' }] : parseTree(await git('ls-tree', '-r', '-z', selectedEntry.oid)).map((entry) => ({ ...entry, path: entry.name }));
    if (!entries.some((entry) => entry.path === 'SKILL.md')) fail('Skill directory must contain SKILL.md');
    const files = [];
    for (const entry of entries) {
      if (entry.mode === '120000' || entry.mode === '160000' || entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) fail('Symlinks and gitlinks are not allowed in skills');
      validatePath(entry.path);
      files.push({ path: entry.path, mode: entry.mode === '100755' ? 0o755 : 0o644, bytes: await git('cat-file', 'blob', entry.oid) });
    }
    files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
    const body = files.find((file) => file.path === 'SKILL.md').bytes;
    const content = decode(body);
    if(files.some(file=>file.bytes.subarray(0,128).toString('utf8').startsWith('version https://git-lfs.github.com/spec/v1'))) fail('Git LFS skill artifacts require materialization; refusing pointer-only import');
    return { revision, contentHash: skillFilesHash(files), content, files,
      storage: files.length === 1 ? 'postgres' : 'filesystem',
      ...metadata(content, isFile ? path.basename(path.dirname(selected)) : selectedEntry.name) };
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

export function skillFilesHash(files) {
    const hash = createHash('sha256').update('skill-files-v1\0');
    for (const file of [...files].sort((a,b)=>Buffer.compare(Buffer.from(a.path),Buffer.from(b.path)))) {
      hash.update(String(file.mode)+'\0');
      const pathname = Buffer.from(file.path, 'utf8');
      for (const value of [pathname, file.bytes]) {
        const length = Buffer.alloc(8);
        length.writeBigUInt64BE(BigInt(value.length));
        hash.update(length).update(value);
      }
    }

 return `sha256:${hash.digest('hex')}`;
}
