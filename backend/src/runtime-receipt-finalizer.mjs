import { appendRuntimeReceipt, compactRuntimeReceipt } from './runtime-result-assembly.mjs';
import { assertNoHardTurnInvariantViolations, validateTurnInvariants } from './turn-invariants.mjs';

export function validateRuntimeInvariantsBeforeSideEffects(invariantInput = {}) {
  const invariantValidation = validateTurnInvariants({
    ...(invariantInput || {}),
    memoryIntent: null,
    memory: null,
    memoryWrite: null,
  });
  assertNoHardTurnInvariantViolations(invariantValidation);
  return invariantValidation;
}

export function validateCompletedRuntimeInvariantsBeforeSideEffects(invariantInput = {}) {
  const invariantValidation = validateTurnInvariants(invariantInput || {});
  assertNoHardTurnInvariantViolations(invariantValidation);
  return invariantValidation;
}

export async function appendValidatedRuntimeReceipt({
  sessionRoot = null,
  dataRoot = null,
  sessionId,
  logger,
  receiptInput,
  invariantInput,
  subjectScope = null,
} = {}) {
  const invariantValidation = validateTurnInvariants(invariantInput || {});
  assertNoHardTurnInvariantViolations(invariantValidation);
  await appendRuntimeReceipt({
    sessionRoot,
    dataRoot,
    sessionId,
    logger,
    receipt: compactRuntimeReceipt({ ...(receiptInput || {}), invariantValidation }),
    subjectScope,
  });
  return invariantValidation;
}
