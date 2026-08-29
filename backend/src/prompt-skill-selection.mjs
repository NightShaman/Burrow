import path from 'node:path';
import { buildSkillCapabilitySnapshot, loadEffectiveSkillCatalog, promptEligibleSkills } from './skill-catalog.mjs';
import { resolveSkillsConfig } from './config.mjs';

export async function resolvePromptSkillPlan({ rootDir, workspaceContext = {}, skillConfig = null, availableSkills = null, turnPlan = null } = {}) {
  const resolvedSkillConfig = skillConfig || resolveSkillsConfig({});
  const catalog = availableSkills
    ? availableSkills
    : (await loadEffectiveSkillCatalog({
      workspaceRoot: resolvedSkillConfig.workspaceRoot || workspaceContext.workspaceRoot || path.join(rootDir, 'workspace'),
      agentId: resolvedSkillConfig.agentId || 'hatchet',
      overrides: resolvedSkillConfig,
    })).skills;

  // A planner does not select skills. It may observe a catalog, but only an
  // explicit agent load can put a skill body into a prompt.
  const selected = [];
  const promptSkills = promptEligibleSkills({ catalog, selected });
  const skills = {
    selected,
    catalog: catalog.map((skill) => ({
      id: skill.id,
      name: skill.name || skill.id,
      description: skill.description || '',
      owner: skill.owner,
      lifecycle: skill.lifecycle,
      available: skill.available !== false,
      version: skill.version,
    })),
    rejected: [],
    snapshot: buildSkillCapabilitySnapshot({ selected, catalog, rejected: [] }),
  };

  return {
    skillConfig: resolvedSkillConfig,
    skills,
    promptSkills,
    skillIndex: {
      total: catalog.length,
      available: catalog.filter((skill) => skill.available !== false).length,
      unavailable: catalog.filter((skill) => skill.available === false).length,
    },
  };
}
