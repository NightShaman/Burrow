// The host and the conversation pager use the same serialized UTF-8 envelope.
export const MOD_CAPABILITY_RESULT_MAX_BYTES = 256_000;
export function modCapabilityResultBytes(value) { return Buffer.byteLength(JSON.stringify(value)); }
