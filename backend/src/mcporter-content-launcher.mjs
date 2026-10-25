// Process-isolated MCP wire result launcher. The CLI's json formatter selects
// structuredContent/JSON text instead of serializing the complete MCP result.
import { realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const [binary, configPath, toolName, argumentsJson, lifecycle] = process.argv.slice(2);
let runtime;
try {
  // Resolve the installed integration, not Burrow's development dependency.
  const entry = path.join(path.dirname(await realpath(binary)), 'index.js');
  const { createRuntime } = await import(pathToFileURL(entry).href);
  // Runtime calls are headless: reject missing/rejected credentials instead of
  // opening an interactive OAuth flow inside a bounded tool subprocess.
  let result;
  if (lifecycle === 'keep_alive') {
    // Daemon recovery derives its executable from argv[1].
    process.argv[1] = await realpath(binary);
    // Use the SAME stable protected config and daemon as the CLI. The public
    // generated-runtime helper would copy credentials to a second config and
    // key a different daemon. This narrow daemon bridge mirrors CLI 0.13.x.
    const { DaemonClient } = await import(pathToFileURL(path.join(path.dirname(entry), 'daemon/client.js')).href);
    result = await new DaemonClient({ configPath, configExplicit: true }).callTool({
      server: 'connection', tool: toolName, args: JSON.parse(argumentsJson), timeoutMs: 30_000, disableOAuth: true,
    });
  } else {
    runtime = await createRuntime({ configPath });
    result = await runtime.callTool('connection', toolName, { args: JSON.parse(argumentsJson), timeoutMs: 30_000, disableOAuth: true });
  }
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  process.stderr.write(String(error?.message || error));
  process.exitCode = 1;
} finally {
  await runtime?.close();
}
