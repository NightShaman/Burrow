// Execution, tool history and outcome verification are independent facts.
// Neither missing runEvidence nor failed tool attempts determine execution.
export function archiveRunExecution({ receipt = null, answer = null, continuityHead = null, runId = null } = {}) {
  const decision = typeof receipt?.decision === 'string' ? receipt.decision : '';
  const terminal = receipt?.terminalStatus || answer?.metadata?.terminalStatus;
  const from = receipt ? 'runtime_receipt' : 'assistant_metadata';
  const result = (status, reasonCode, reason, source = from) => ({ status, reasonCode, reason, source });
  if (terminal === 'superseded' || decision === 'superseded') return result('superseded', 'run_superseded', 'The runtime superseded this run.');
  if (terminal === 'cancelled' || ['cancelled', 'canceled'].includes(decision)) return result('cancelled', 'run_cancelled', 'The runtime cancelled this run.');
  if (decision === 'interrupted' || terminal === 'interrupted') return result('interrupted', 'run_interrupted', 'The runtime recorded an interrupted run.');
  if (terminal === 'failed' || ['model_failed', 'failed', 'incomplete', 'blocked'].includes(decision) || answer?.metadata?.decision === 'model_failed') return result('failed', 'run_failed', decision === 'model_failed' ? 'The model did not complete the run.' : 'The runtime recorded a failed or incomplete execution.');
  if (terminal === 'completed' || (receipt && ['answered', 'routed', 'completed'].includes(decision))) return result('completed', 'run_completed', 'The runtime recorded completion. This does not establish that the intended outcome was verified.');
  if (continuityHead?.runId === runId && ['running', 'finalizing'].includes(continuityHead?.state)) return result('running', 'run_active', `The runtime records this exact run as ${continuityHead.state}.`, 'continuity_state');
  if (continuityHead?.runId === runId && continuityHead?.state === 'interrupted') return result('interrupted', 'run_interrupted', 'The runtime recorded an interrupted run.', 'continuity_state');
  return result('not_recorded', answer ? 'terminal_receipt_missing' : 'completion_not_recorded', answer ? 'An agent response is retained, but no terminal runtime state was recorded.' : 'No completion or active execution state is recorded for this run.', 'not_recorded');
}

export function archiveRunStatus(execution, answer = null) {
  return execution.status === 'not_recorded' ? (answer ? 'unverified' : 'incomplete') : execution.status;
}
