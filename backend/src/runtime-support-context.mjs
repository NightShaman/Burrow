// Historical retrieval belongs to explicit agent tools, never pre-turn selection.
// Current transcript, recovery handoffs, Dream and temporary continuity are
// assembled independently of this support surface.
export async function prepareRuntimeSupportContext({ route } = {}) {
  const sessionRecall = null;
  const runEvidence = null;
  return { sessionRecall, runEvidence, contextSupport: {
    selectedSkills: route.promptPlan.promptSkills.map(skill => skill.id),
    sessionRecall, runEvidence,
  } };
}
