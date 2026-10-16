import { fail } from './errors.mjs';

export const API_VERSION = '1';
export const ROOT_SCHEMA = {
  type: 'object', properties: {
    operation: { type: 'string', description: 'help/describe/capabilities or exact dotted operation. Navigate with page.navigate, not page.goto. Start with {operation:"help",args:{}}.' },
    path: { type: 'string', description: 'Top-level catalog path: branch for help (e.g. page), exact leaf for describe (e.g. page.navigate). Never an executable operation argument.' },
    sessionId: { type: 'string', description: 'Top-level owned sessionId from session.open refs. Reuse it rather than reopening after an argument error.' },
    pageId: { type: 'string', description: 'Top-level owned pageId from refs; required with multiple Pages. No current-tab fallback.' },
    catalogRevision: { type: 'string', description: 'Optional revision from describe; not an approval token.' },
    args: { type: 'object', additionalProperties: true, description: 'Required object of leaf arguments: e.g. {url:"http://127.0.0.1:8000/"} for page.navigate; {} for describe/session.open. Metadata belongs at top level; applicable nested metadata is safely relocated, conflicting values rejected. Other unknown fields remain forbidden.' },
  }, required: ['operation', 'args'], additionalProperties: false,
};
const imageRef = {
  type: 'object', properties: {
    attachmentId: { type: 'string' }, mediaType: { type: 'string' }, bytes: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' }, name: { type: 'string' },
    originalDimensions: { type: 'object', properties: { width: { type: 'number' }, height: { type: 'number' } }, required: ['width', 'height'], additionalProperties: false },
  }, required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'], additionalProperties: false,
};
export const ARTIFACT_SCHEMA = {
  type: 'object', properties: {
    artifactId: { type: 'string' }, kind: { type: 'string' }, mime: { type: 'string' }, bytes: { type: 'number' }, state: { type: 'string', enum: ['pending', 'finalized', 'partial', 'failed', 'expired'] },
    path: { type: 'string' }, name: { type: 'string' }, sha256: { type: 'string' }, width: { type: 'number' }, height: { type: 'number' }, durationMs: { type: 'number' },
    pageId: { type: 'string' }, sessionId: { type: 'string' }, generation: { type: 'number' }, captureId: { type: 'string' }, frameIndex: { type: 'number' }, createdAt: { type: 'string' }, retentionUntil: { type: 'string' },
  }, required: ['artifactId', 'kind', 'mime', 'bytes', 'state'], additionalProperties: false,
};
export const OUTPUT_SCHEMA = {
  type: 'object', properties: {
    apiVersion: { type: 'string', const: API_VERSION }, operation: { type: 'string' }, callId: { type: 'string' }, catalogRevision: { type: 'string' }, status: { type: 'string', enum: ['completed', 'partial'] },
    refs: { type: 'object', properties: { sessionId: { type: 'string' }, pageId: { type: 'string' }, generation: { type: 'number' }, frameId: { type: 'string' }, snapshotId: { type: 'string' }, captureId: { type: 'string' } }, additionalProperties: false },
    data: { type: 'object', additionalProperties: true }, artifacts: { type: 'array', items: ARTIFACT_SCHEMA },
    effects: { type: 'array', items: { type: 'object', properties: { kind: { type: 'string' }, state: { type: 'string', enum: ['none', 'applied', 'partial', 'unknown'] } }, required: ['kind', 'state'], additionalProperties: false } },
    warnings: { type: 'array', items: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } }, required: ['code', 'message'], additionalProperties: false } },
    imageRefs: { type: 'array', items: imageRef },
  }, required: ['apiVersion', 'operation', 'callId', 'catalogRevision', 'status', 'refs', 'data', 'artifacts', 'effects', 'warnings', 'imageRefs'], additionalProperties: false,
};

function canonical(value, depth = 0) {
  if (depth > 20) fail('BACKEND_INVALID_OUTPUT', 'Browser output is too deeply nested.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(item => canonical(item, depth + 1));
  if (value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, canonical(item, depth + 1)]));
  }
  fail('BACKEND_INVALID_OUTPUT', 'Browser output must be lossless JSON, not engine handles or raw binary.');
}

/** Engine handles and private authority never enter canonical tool values. */
export function response(request, context, result = {}) {
  return canonical({
    apiVersion: API_VERSION, operation: request.operation, callId: context.callId, catalogRevision: context.catalogRevision,
    status: result.status ?? 'completed', refs: result.refs ?? {}, data: result.data ?? {}, artifacts: result.artifacts ?? [], effects: result.effects ?? [], warnings: result.warnings ?? [], imageRefs: [],
  });
}

export const INTERNAL_SCHEMA = {
  type: 'object', properties: {
    request: ROOT_SCHEMA,
    authority: {
      type: 'object', properties: { ownerId: { type: 'string' }, manifestHash: { type: 'string' }, callId: { type: 'string' }, deadlineMs: { type: 'number' } },
      required: ['ownerId', 'manifestHash', 'callId', 'deadlineMs'], additionalProperties: false,
    },
  }, required: ['request', 'authority'], additionalProperties: false,
};
