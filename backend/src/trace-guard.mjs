import { spawn } from 'node:child_process';
// Reuse the retention kernel guard: a permanent sibling inode coordinates
// writers and deletion across processes and survives directory removal.
export async function withTraceGuard(lockPath, operation) {
  const child = spawn('flock', ['-x', `${lockPath}.guard`, process.execPath, '-e',
    "process.stdout.write('ready\\n'); process.stdin.resume(); process.stdin.on('end',()=>process.exit(0));"],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`retention_guard_failed:${code}:${stderr}`)));
    child.stdout.once('data', resolve);
  });
  try { return await operation(); }
  finally {
    await new Promise(resolve => { child.once('exit', resolve); child.stdin.end(); });
  }
}

