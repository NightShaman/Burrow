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

  // Ownership/availability determines what reaches the model's stable prompt.
  // A planner selection is only relevance observability; it must never gate
  // otherwise eligible global or agent-owned instructions.
  const selected = turnPlan?.support?.skills?.selected || [];
  const promptSkills = promptEligibleSkills({ catalog, selected });
  const skills = {
    selected,
    catalog: catalog.map((skill) => ({
      id: skill.id,
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
