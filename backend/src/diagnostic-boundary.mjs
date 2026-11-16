import { safeOperationalError } from './runtime-server-log.mjs';
// Retain only classified metadata across public/storage boundaries, never parser
// messages (which can contain stored values), paths, SQL or provider payloads.
export function boundaryDiagnostic(error, stage, fallback = 'operation_failed') {
  const { errorCode, errorType } = safeOperationalError(error, fallback);
  return { errorCode, errorType, stage };
}
export function boundaryFailure(code, error, stage) {
  const diagnostic = boundaryDiagnostic(error, stage, code);
  return Object.assign(new Error(code, { cause: Object.assign(new Error(diagnostic.errorType), { code: diagnostic.errorCode }) }), { code, diagnostic });
}
export function parseStoredJson(value, code, stage = 'parse') {
  try { return JSON.parse(value); }
  catch (error) { throw boundaryFailure(code, error, stage); }
}
