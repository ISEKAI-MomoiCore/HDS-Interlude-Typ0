import { randomUUID } from 'node:crypto'

export type TraceId = string

/**
 * A host-owned identifier for one inbound message and all of its consequences.
 * It deliberately contains no message content or account secret.
 */
export function createTraceId(prefix = 'msg'): TraceId {
  const safePrefix = String(prefix || 'msg').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 24) || 'msg'
  return `${safePrefix}-${randomUUID()}`
}

/** Keep compatible IDs supplied by an older worker, but repair missing/invalid values. */
export function ensureTraceId(value: unknown, prefix = 'msg'): TraceId {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
    ? value
    : createTraceId(prefix)
}
