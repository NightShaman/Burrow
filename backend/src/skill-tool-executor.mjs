import { loadEffectiveSkillCatalog, loadSelectedSkillText, skillManifest, selectCatalogSkills } from './skill-catalog.mjs';

// Implementation family only. Review, cancellation, immutable IDs and receipts
// remain in proposal-executor. Publish the result before closing its trace row.
export async function executeSkillTool({ action, skillsWorkspace, agentId, agentRuntime = null, overrides = {}, skillStore = null, traceLogger = null } = {}) {
  const catalog = await loadEffectiveSkillCatalog({ workspaceRoot: skillsWorkspace, agentId: agentId || 'hatchet', agentRuntime, overrides, skillStore });
  const started = await traceLogger?.toolStart?.({ tool: action.tool, skillId: action.skillId || null, catalogCount: catalog.availableSkills.length });
  let result;
  if (action.tool === 'list_skills') {
    result = { tool: 'list_skills', ok: true, skills: catalog.availableSkills.map(skillManifest) };
  } else {
    const choice = selectCatalogSkills({ catalog: catalog.skills, ids: [action.skillId], source: 'agent-requested' });
    if (!choice.selected.length) result = { tool: 'load_skill', ok: false, skillId: action.skillId, error: choice.rejected[0]?.reason || 'skill_not_found' };
    else {
      const loaded = await loadSelectedSkillText(skillsWorkspace, choice.selected);
      const skill = loaded[0];
      result = skill.missing ? { tool: 'load_skill', ok: false, skillId: action.skillId, error: skill.error || 'skill_source_missing' } : { tool: 'load_skill', ok: true, skill: { ...skillManifest(skill), version: skill.version, content: skill.content, contentTruncated: skill.contentTruncated } };
    }
  }
  return { result, finishTrace: () => (traceLogger?.toolEnd || traceLogger?.tool)?.({
    tool: action.tool,
    ...(started?.payload?.activityId ? { activityId: started.payload.activityId } : {}),
    ok: result.ok,
    skillId: action.skillId || null,
    skillName: result.skill?.name || null,
    version: result.skill?.version || null,
    // Preserve discovery cards, but never loaded skill body in trace events.
    skills: action.tool === 'list_skills' ? result.skills.map(({ id, name, description, lifecycle, available, owner, ownership }) => ({ id, name, description, lifecycle, available, owner, ownership: ownership ? { scope: ownership.scope, agentId: ownership.agentId } : null })) : undefined,
    error: result.error || null,
  }) };
}
