import { resolvePromptSkillPlan } from './prompt-skill-selection.mjs';
import { inferActionObservability } from './route-action-observability.mjs';

function memoryPlanFromTurnPlan(_turnPlan = null) {
  return {
    needsMemory: false,
    reason: 'memory_not_explicitly_requested',
    cues: [],
    projects: [],
    topics: [],
    routingTerms: [],
    query: null,
    global: false,
    maxChars: 4000,
    request: null,
  };
}

export async function routeRequest({
  rootDir,
  message,
  memoryContext = {},
  workspaceContext = {},
  action = null,
  turnPlan = null,
  skillConfig = null,
  availableSkills = null,
} = {}) {
  void memoryContext;
  if (!rootDir) throw new Error('rootDir is required');
  if (!message || typeof message !== 'string') throw new Error('message is required');

  const { skillConfig: resolvedSkillConfig, skills, promptSkills, skillIndex } = await resolvePromptSkillPlan({ rootDir, workspaceContext, skillConfig, availableSkills, turnPlan });
  const memory = memoryPlanFromTurnPlan(turnPlan);
  const actionPlan = inferActionObservability(message, workspaceContext, action, turnPlan);

  // Router output is observability and prompt/context selection only.
  // Runtime validates concrete tool inputs and execution capabilities at the boundary.
  return {
    message,
    memory,
    skills,
    action: actionPlan,
    skillConfig: resolvedSkillConfig,
    skillIndex,
    promptPlan: {
      selectedSkills: skills.selected,
      promptSkills,
      includeMemory: memory.needsMemory,
      includeWorkspace: actionPlan.needsWorkspace,
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rootDir = process.argv[2] || process.cwd();
  const message = process.argv.slice(3).join(' ');
  const result = await routeRequest({ rootDir, message });
  console.log(JSON.stringify(result, null, 2));
}
