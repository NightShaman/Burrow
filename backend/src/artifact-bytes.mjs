import { constants as fsConstants, promises as fs } from 'node:fs';

// Read at most the configured budget even if a file grows after resolution.
export async function readArtifactBytesBounded(filePath, limit) {
  const budget = Number.isSafeInteger(limit) && limit >= 0 ? limit : 0;
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > budget) return null;
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return bytes.subarray(0, offset);
  } finally { await handle.close(); }
}

