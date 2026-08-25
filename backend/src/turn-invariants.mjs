function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function addViolation(violations, { code, severity = 'invalid', message, details = {} }) {
  violations.push({ code, severity, message, details });
}

function validateMemory({ violations, memoryIntent = null, memory = null, memoryWrite = null }) {
  if (!memoryIntent) return;
  const recall = memoryIntent.recall || {};
  if (memory && memory.skipped !== true && recall.mode && recall.mode !== 'recall') {
    addViolation(violations, {
      code: 'memory_recall_ran_when_not_requested',
      severity: 'invalid',
      message: `Memory recall produced a result while MemoryIntent.recall.mode was ${recall.mode}.`,
      details: { mode: recall.mode },
    });
  }
  const writeback = memoryIntent.writeback || {};
  const actualWrite = memoryWrite || null;
  if (actualWrite && Boolean(actualWrite.shouldWrite) !== Boolean(writeback.shouldWrite)) {
    addViolation(violations, {
      code: 'memory_writeback_policy_mismatch',
      severity: 'hard',
      message: 'Memory writeback result disagrees with MemoryIntent.writeback.shouldWrite.',
      details: { intentShouldWrite: Boolean(writeback.shouldWrite), actualShouldWrite: Boolean(actualWrite.shouldWrite) },
    });
  }
  if (actualWrite && Boolean(actualWrite.written) !== Boolean(writeback.written)) {
    addViolation(violations, {
      code: 'memory_writeback_written_mismatch',
      severity: 'hard',
      message: 'Memory writeback result disagrees with MemoryIntent.writeback.written.',
      details: { intentWritten: Boolean(writeback.written), actualWritten: Boolean(actualWrite.written) },
    });
  }
}

function severityFor(violations = []) {
  if (violations.some((violation) => violation.severity === 'hard')) return 'hard';
  if (violations.length) return 'invalid';
  return 'none';
}

export function validateTurnInvariants({ runtimeTurn = null, canonicalTurnEnvelope = null, workResult = null, chatToolLoop = null, memoryIntent = null, memory = null, memoryWrite = null } = {}) {
  const violations = [];
  validateMemory({ violations, memoryIntent, memory, memoryWrite });
  const severity = severityFor(violations);
  return {
    valid: violations.length === 0,
    severity,
    violations,
  };
}

export function assertNoHardTurnInvariantViolations(validation = null) {
  if (validation?.severity !== 'hard') return validation;
  const codes = asArray(validation.violations).map((violation) => violation.code).join(', ');
  throw new Error(`hard_turn_invariant_violation:${codes || 'unknown'}`);
}
