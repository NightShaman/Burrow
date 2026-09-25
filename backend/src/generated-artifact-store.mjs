import { constants as fsConstants, promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { normalizeModelOutputArtifact } from './model-output-artifacts.mjs';

const GENERATED_ARTIFACT_DIRECTORY = path.join('artifacts', 'generated');
const MAX_NAME_LENGTH = 160;

function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function contained(root, candidate) {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function safeName(value, fallback = 'artifact.bin') {
  const base = path.basename(text(value) || fallback)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_NAME_LENGTH);
  return base || fallback;
}
async function regularFileWithoutSymlinkAncestors(root, candidate) {
  if (!contained(root, candidate)) return null;
  const parts = path.relative(root, candidate).split(path.sep);
  let current = root;
  try {
    for (let index = 0; index < parts.length; index += 1) {
      current = path.join(current, parts[index]);
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) return null;
      if (index < parts.length - 1 && !stat.isDirectory()) return null;
      if (index === parts.length - 1) return stat.isFile() ? { filePath: candidate, stat } : null;
    }
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error?.code)) return null;
    throw error;
  }
  return null;
}
async function generatedRoot(agentWorkspaceRoot) {
  if (!agentWorkspaceRoot) throw new Error('artifact_workspace_required');
  const workspace = path.resolve(agentWorkspaceRoot);
  const root = path.resolve(workspace, GENERATED_ARTIFACT_DIRECTORY);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const realRoot = await fs.realpath(root);
  if (realRoot !== root) throw new Error('artifact_root_invalid');
  return { workspace, root };
}
function byteSource(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

/**
 * Persist provider-neutral generated artifact bytes in the owning agent workspace.
 * Exactly one of `bytes` or `localSource` is required. A local source must name an
 * explicit allowed root and is never interpreted as a URL or fetched remotely.
 *
 * @param {{agentWorkspaceRoot:string, metadata:object, bytes?:Buffer|Uint8Array,
 * localSource?:{filePath:string, allowedRoot:string}}} options
 * @returns {Promise<object>} normalized artifact metadata including storageReference
 */
export async function persistGeneratedArtifact({ agentWorkspaceRoot, metadata = {}, bytes, localSource } = {}) {
  const inline = byteSource(bytes);
  if (Boolean(inline) === Boolean(localSource)) throw new Error('artifact_source_required');
  const normalized = normalizeModelOutputArtifact(metadata);
  if (!normalized) throw new Error('artifact_metadata_invalid');

  const name = safeName(normalized.name, `${normalized.kind}.bin`);
  const { workspace, root } = await generatedRoot(agentWorkspaceRoot);
  const storageReference = path.join(GENERATED_ARTIFACT_DIRECTORY, `${randomUUID()}-${name}`).split(path.sep).join('/');
  const destination = path.resolve(workspace, storageReference);
  if (!contained(root, destination)) throw new Error('artifact_path_invalid');

  let sourceHandle = null;
  let destinationHandle = null;
  let sizeBytes;
  try {
    destinationHandle = await fs.open(destination, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    if (inline) {
      await destinationHandle.writeFile(inline);
      sizeBytes = inline.byteLength;
    } else {
      const allowedRootInput = text(localSource?.allowedRoot);
      const sourceInput = text(localSource?.filePath);
      if (!allowedRootInput || !sourceInput || /^[a-z][a-z0-9+.-]*:\/\//i.test(sourceInput)) throw new Error('artifact_local_source_invalid');
      const allowedRoot = await fs.realpath(path.resolve(allowedRootInput));
      const sourcePath = path.resolve(allowedRoot, sourceInput);
      const resolved = await regularFileWithoutSymlinkAncestors(allowedRoot, sourcePath);
      if (!resolved) throw new Error('artifact_local_source_invalid');
      sourceHandle = await fs.open(sourcePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const sourceStat = await sourceHandle.stat();
      if (!sourceStat.isFile()) throw new Error('artifact_local_source_invalid');
      sizeBytes = sourceStat.size;
      await pipeline(sourceHandle.createReadStream(), destinationHandle.createWriteStream());
    }
  } catch (error) {
    await fs.rm(destination, { force: true }).catch(() => {});
    throw error;
  } finally {
    await sourceHandle?.close().catch(() => {});
    await destinationHandle?.close().catch(() => {});
  }

  return { ...normalized, name, sizeBytes, storageReference };
}

/** Resolve only runtime-owned generated artifacts beneath the owning agent workspace. */
export async function resolveGeneratedArtifact({ agentWorkspaceRoot, storageReference } = {}) {
  if (!agentWorkspaceRoot || !storageReference) return null;
  const workspace = path.resolve(agentWorkspaceRoot);
  const root = path.resolve(workspace, GENERATED_ARTIFACT_DIRECTORY);
  const candidate = path.resolve(workspace, String(storageReference));
  if (!contained(root, candidate)) return null;
  const resolved = await regularFileWithoutSymlinkAncestors(root, candidate);
  if (!resolved) return null;
  const basename = path.basename(candidate).replace(/^[0-9a-f]{8}-[0-9a-f-]{27}-/i, '');
  return { ...resolved, storageReference: path.relative(workspace, candidate).split(path.sep).join('/'), name: safeName(basename) };
}
