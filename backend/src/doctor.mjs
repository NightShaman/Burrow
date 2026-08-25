import { promises as fs } from 'node:fs';
import path from 'node:path';
import { resolveModelConfig, redactModelConfig, resolveRuntimeStateConfig, resolveUiConfig, resolveRetentionConfig, resolveSkillsConfig } from './config.mjs';
import { loadEffectiveSkillCatalog } from './skill-catalog.mjs';
import { runExec } from './harness/exec.mjs';
async function exists(filePath) { try { await fs.access(filePath); return true; } catch { return false; } }
async function writableDir(dirPath) { try { await fs.mkdir(dirPath, { recursive: true }); await fs.access(dirPath, fs.constants.W_OK); return true; } catch { return false; } }
async function commandVersion({ rootDir, command, name }) { const result = await runExec({ rootDir, runId: `doctor-${name}`, command, timeoutMs: 5000, artifactPrefix: `doctor-${name}` }); return { ok: result.ok, name, command, exitCode: result.exitCode, stdout: result.stdout.trim().split('\n')[0] || '', stderr: result.stderr.trim().split('\n')[0] || '' }; }
export async function runDoctor({ rootDir } = {}) {
  if (!rootDir) throw new Error('rootDir is required');
  const sourceRoot = path.resolve(rootDir); const blockers = []; const warnings = [];
  const runtimeState = resolveRuntimeStateConfig({ rootDir: sourceRoot });
  const [modelConfig, uiConfig] = await Promise.all([resolveModelConfig({ agent_id: runtimeState.agentId }), resolveUiConfig()]);
  const skillsConfig = { ...resolveSkillsConfig(), workspaceRoot: runtimeState.workspaceRoot, agentId: runtimeState.agentId };
  const skillIndex = await loadEffectiveSkillCatalog({ workspaceRoot: runtimeState.workspaceRoot, agentId: runtimeState.agentId, overrides: skillsConfig });
  const tools = await Promise.all(['node', 'npm', 'git'].map((name) => commandVersion({ rootDir: runtimeState.cacheRoot, name, command: `${name} --version` })));
  const checks = { rootExists: await exists(sourceRoot), packageJsonExists: await exists(path.join(sourceRoot, 'package.json')), readmeExists: await exists(path.join(sourceRoot, 'README.md')), agentDataRootWritable: await writableDir(runtimeState.agentDataRoot), cacheRootWritable: await writableDir(runtimeState.cacheRoot), effectiveSkillCatalog: skillIndex.skills.length, skillsAvailable: skillIndex.availableSkills.length, tools, model: redactModelConfig(modelConfig), runtime: runtimeState, ui: { host: uiConfig.host || null, port: uiConfig.port || null, authEnabled: uiConfig.authEnabled }, retention: resolveRetentionConfig() };
  if (!checks.rootExists) blockers.push('root_missing'); if (!checks.packageJsonExists) blockers.push('package_json_missing'); if (!checks.agentDataRootWritable) blockers.push('agent_data_root_not_writable'); if (!checks.cacheRootWritable) blockers.push('cache_root_not_writable'); for (const tool of tools) if (!tool.ok) blockers.push(`tool_missing:${tool.name}`);
  if (!modelConfig) warnings.push('model_selection_required');
  return { ok: blockers.length === 0, status: blockers.length ? 'blocked' : warnings.length ? 'degraded' : 'ready', rootDir: sourceRoot, blockers, warnings, checks };
}
if (import.meta.url === `file://${process.argv[1]}`) console.log(JSON.stringify(await runDoctor({ rootDir: process.argv[2] || process.cwd() }), null, 2));
