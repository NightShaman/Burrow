import { spawn } from 'node:child_process';
import { preparePostgresStartup } from '../src/postgres-startup.mjs';

const args = process.argv.slice(2);
if (!args.length) throw new Error('PostgreSQL supervisor requires an application command');
const handle = await preparePostgresStartup();
const child = spawn(args[0], args.slice(1), { stdio: 'inherit', env: handle.env });
let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  child.kill(signal);
  // Keep the database alive until the application has drained and exited.
}
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
process.once('SIGINT', () => { void shutdown('SIGINT'); });
child.once('exit', async (code, signal) => {
  await handle.close();
  process.exitCode = signal ? 128 + (signal === 'SIGTERM' ? 15 : 2) : (code ?? 1);
});

child.once('error', async (error) => { console.error('Application launch failed:', error.message); await handle.close(); process.exitCode = 1; });
