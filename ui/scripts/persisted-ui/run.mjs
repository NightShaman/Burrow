import { runTestSuite } from '../../../Burrow-Backend/scripts/test-runtime.mjs';
import { fileURLToPath } from 'node:url';
const result = await runTestSuite({ argv: [fileURLToPath(new URL('./bridge.mjs', import.meta.url))], disposablePostgres: true,
 baseEnv: { PATH: process.env.PATH || '/usr/bin:/bin', LANG:'C.UTF-8', HOME:'/nonexistent' }, timeoutMs:120000 });
process.exitCode = result.exitCode;
