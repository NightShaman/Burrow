// Stable public facade; the SDK runtime, generation owner, and transport own their respective state.
export { createOtelRuntime } from './otel-sdk-runtime.mjs';
export { createReconfigurableOtelRuntime } from './otel-generation-manager.mjs';
export { otelEnvironmentForConfiguration } from './otel-transport.mjs';
import { usageValues, safeOutcome } from './otel-sdk-runtime.mjs';
import { signalEndpoint, positiveInteger, traceExporterOptions, metricExporterOptions } from './otel-transport.mjs';
export const __otelRuntime__ = Object.freeze({ usageValues, safeOutcome, signalEndpoint, positiveInteger, traceExporterOptions, metricExporterOptions });
