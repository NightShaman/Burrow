import { context, createTraceState, trace } from '@opentelemetry/api';

const TRACEPARENT = /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/;
const MAX_TRACESTATE_CHARS = 512;

export function normalizeTraceContextCarrier(value = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const traceparent = String(value.traceparent || '').trim().toLowerCase();
  if (!TRACEPARENT.test(traceparent)
      || traceparent.slice(3, 35) === '0'.repeat(32)
      || traceparent.slice(36, 52) === '0'.repeat(16)) return null;
  const tracestate = value.tracestate == null ? null : String(value.tracestate).trim();
  if (tracestate && (tracestate.length > MAX_TRACESTATE_CHARS || /[\r\n]/.test(tracestate))) return null;
  return Object.freeze({ traceparent, ...(tracestate ? { tracestate } : {}) });
}

export function injectTraceContextCarrier(sourceContext = context.active()) {
  const spanContext = trace.getSpanContext(sourceContext);
  if (!spanContext?.traceId || !spanContext?.spanId) return null;
  const flags = Number(spanContext.traceFlags || 0).toString(16).padStart(2, '0');
  return normalizeTraceContextCarrier({
    traceparent: `00-${spanContext.traceId}-${spanContext.spanId}-${flags}`,
    ...(spanContext.traceState ? { tracestate: spanContext.traceState.serialize() } : {}),
  });
}

export function extractTraceContext(value, parentContext = context.active()) {
  const carrier = normalizeTraceContextCarrier(value);
  if (!carrier) return parentContext;
  const [, traceId, spanId, flags] = carrier.traceparent.split('-');
  return trace.setSpanContext(parentContext, {
    traceId,
    spanId,
    traceFlags: Number.parseInt(flags, 16),
    isRemote: true,
    ...(carrier.tracestate ? { traceState: createTraceState(carrier.tracestate) } : {}),
  });
}

export function traceContextFromSpan(span) {
  if (!span) return null;
  return injectTraceContextCarrier(trace.setSpan(context.active(), span));
}

export const __otelContext__ = Object.freeze({ TRACEPARENT, MAX_TRACESTATE_CHARS });
