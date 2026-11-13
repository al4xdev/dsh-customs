#!/usr/bin/env node
// Records the exact Anthropic API requests the Claude Code binary sends.
//
// The binary honours ANTHROPIC_BASE_URL, so it speaks plain HTTP to this process and
// this process speaks HTTPS to the real API: no MITM, no certificate, no wrapper.
//
//   node tools/anthropic-proxy/proxy.mjs &
//   ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude
//
// The request is fully assembled and sent before the provider decides anything, so a
// quota or auth error upstream still leaves us the complete payload — that is what
// makes this usable on a spent plan.
//
// One JSON file per exchange under .dumps/anthropic: request body verbatim, response
// body (raw for streams), and a `summary` with the geometry we actually care about —
// system block sizes, tool count, where the cache breakpoints sit, context management
// edits, betas. Credentials are redacted before anything touches disk.
import http from 'node:http';
import https from 'node:https';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const PORT = Number(process.env.ANTHROPIC_PROXY_PORT ?? 8787);
const HOST = process.env.ANTHROPIC_PROXY_HOST ?? '127.0.0.1';
const UPSTREAM = new URL(process.env.ANTHROPIC_PROXY_UPSTREAM ?? 'https://api.anthropic.com');
const OUTPUT = join(process.cwd(), '.dumps/anthropic');
// Only credentials are stripped; everything that describes the request stays.
const SECRET_HEADERS = new Set(['authorization', 'x-api-key', 'proxy-authorization', 'cookie', 'set-cookie']);
// A streamed answer is useful evidence but not worth gigabytes.
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

mkdirSync(OUTPUT, { recursive: true });

const sha = value => createHash('sha256').update(value).digest('hex').slice(0, 12);
const redactValue = value => `<redacted sha256:${sha(String(value))} len:${String(value).length}>`;

function redactHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = SECRET_HEADERS.has(key.toLowerCase()) ? redactValue(Array.isArray(value) ? value.join(',') : value) : value;
  }
  return out;
}

/** Collect cache_control markers with their path, which is how Anthropic addresses them. */
function cacheControlPaths(node, path = [], found = []) {
  if (Array.isArray(node)) {
    node.forEach((item, index) => cacheControlPaths(item, [...path, index], found));
    return found;
  }
  if (node === null || typeof node !== 'object') return found;
  if (node.cache_control !== undefined) found.push({ path: path.join('.'), value: node.cache_control });
  for (const [key, value] of Object.entries(node)) {
    if (key === 'cache_control') continue;
    cacheControlPaths(value, [...path, key], found);
  }
  return found;
}

/**
 * Geometry of one request. Deliberately about shape and size rather than content:
 * this is the part that answers "what does it send, in what order, cached where".
 */
function summarize(body) {
  if (body === undefined) return { parsed: false };
  let payload;
  try { payload = JSON.parse(body); } catch { return { parsed: false, bytes: body.length }; }
  const blocks = value => (Array.isArray(value) ? value : value === undefined ? [] : [value]);
  const textBytes = value => {
    if (typeof value === 'string') return Buffer.byteLength(value);
    if (Array.isArray(value)) return value.reduce((sum, item) => sum + textBytes(item), 0);
    if (value !== null && typeof value === 'object') return textBytes(value.text ?? value.content ?? '');
    return 0;
  };
  return {
    parsed: true,
    bytes: body.length,
    model: payload.model,
    max_tokens: payload.max_tokens,
    stream: payload.stream,
    betas: payload.betas ?? null,
    thinking: payload.thinking ?? null,
    output_config: payload.output_config ?? null,
    context_management: payload.context_management ?? null,
    tool_choice: payload.tool_choice ?? null,
    system: {
      blocks: blocks(payload.system).length,
      bytes: textBytes(payload.system),
      perBlock: blocks(payload.system).map((block, index) => ({
        index,
        type: typeof block === 'string' ? 'string' : block?.type,
        bytes: textBytes(block),
      })),
    },
    tools: blocks(payload.tools).map(tool => ({
      name: tool?.name,
      bytes: textBytes(tool?.description) + Buffer.byteLength(JSON.stringify(tool?.input_schema ?? {})),
      hasCacheControl: tool?.cache_control !== undefined,
    })),
    messages: blocks(payload.messages).map((message, index) => ({
      index,
      role: message?.role,
      parts: blocks(message?.content).map(part => ({
        type: typeof part === 'string' ? 'string' : part?.type,
        bytes: textBytes(part),
      })),
      bytes: textBytes(message?.content),
    })),
    cacheControl: cacheControlPaths({ system: payload.system, tools: payload.tools, messages: payload.messages }),
  };
}

let sequence = 0;

const server = http.createServer((clientReq, clientRes) => {
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${String(sequence += 1).padStart(3, '0')}`;
  const chunks = [];
  let requestBytes = 0;

  clientReq.on('data', chunk => { chunks.push(chunk); requestBytes += chunk.length; });
  clientReq.on('end', () => {
    const body = chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0);
    const headers = { ...clientReq.headers };
    delete headers.host;
    // Content-Length is recomputed by Node from the buffer we forward.
    delete headers['content-length'];

    const upstreamReq = https.request({
      protocol: 'https:',
      hostname: UPSTREAM.hostname,
      port: UPSTREAM.port || 443,
      path: clientReq.url,
      method: clientReq.method,
      headers,
    }, upstreamRes => {
      clientRes.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      const responseChunks = [];
      let responseBytes = 0;
      let truncated = false;
      upstreamRes.on('data', chunk => {
        clientRes.write(chunk);
        responseBytes += chunk.length;
        if (responseBytes <= MAX_RESPONSE_BYTES) responseChunks.push(chunk);
        else truncated = true;
      });
      upstreamRes.on('end', () => {
        clientRes.end();
        writeRecord(id, {
          time: new Date().toISOString(),
          method: clientReq.method,
          path: clientReq.url,
          status: upstreamRes.statusCode,
          requestHeaders: redactHeaders(clientReq.headers),
          requestBytes,
          responseBytes,
          responseTruncated: truncated,
          summary: summarize(body.toString('utf8')),
          request: parseOrRaw(body.toString('utf8')),
          response: parseOrRaw(Buffer.concat(responseChunks).toString('utf8')),
        });
      });
    });

    upstreamReq.on('error', error => {
      clientRes.writeHead(502, { 'content-type': 'application/json' });
      clientRes.end(JSON.stringify({ error: 'proxy upstream failed', message: error.message }));
      writeRecord(id, {
        time: new Date().toISOString(),
        method: clientReq.method,
        path: clientReq.url,
        status: 'upstream-error',
        error: error.message,
        requestHeaders: redactHeaders(clientReq.headers),
        requestBytes,
        summary: summarize(body.toString('utf8')),
        request: parseOrRaw(body.toString('utf8')),
      });
    });

    upstreamReq.end(body);
    process.stdout.write(`${id} ${clientReq.method} ${clientReq.url} → ${UPSTREAM.host}\n`);
  });
});

/** JSON when it parses, verbatim text otherwise: an unparseable body is itself evidence. */
function parseOrRaw(text) {
  if (!text) return { empty: true };
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

function writeRecord(id, record) {
  const file = join(OUTPUT, `${id}.json`);
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  const status = record.status;
  process.stdout.write(`${id} ${status} → ${relative(process.cwd(), file)}\n`);
}

server.listen(PORT, HOST, () => {
  process.stdout.write(`anthropic proxy on http://${HOST}:${PORT} → ${UPSTREAM.origin}\ndumps: ${relative(process.cwd(), OUTPUT)}\n`);
});
