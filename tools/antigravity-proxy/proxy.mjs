#!/usr/bin/env node
// Records the exact Anti Gravity (Cloud Code Assist) requests, so a new model can be
// read from the wire instead of inferred from behaviour.
//
// The plugin prepends `ANTIGRAVITY_BASE_URL` to its endpoint list and keeps the real
// hosts behind it, so this only has to answer:
//
//   node tools/antigravity-proxy/proxy.mjs &
//   set -x ANTIGRAVITY_BASE_URL http://127.0.0.1:8788
//
// With the proxy down, the first connect fails and the plugin falls through to the
// provider, so the variable is safe to leave set.
//
// One JSON file per exchange under .dumps/antigravity: request body verbatim, response
// body (raw for SSE), headers with credentials redacted, and a summary of the geometry
// that matters for a Gemini-family request — model, contents, systemInstruction size,
// tool count, generationConfig, and the safety/thinking shape.
import http from 'node:http';
import https from 'node:https';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const PORT = Number(process.env.ANTIGRAVITY_PROXY_PORT ?? 8788);
const HOST = process.env.ANTIGRAVITY_PROXY_HOST ?? '127.0.0.1';
const UPSTREAM = new URL(process.env.ANTIGRAVITY_PROXY_UPSTREAM ?? 'https://daily-cloudcode-pa.googleapis.com');
const OUTPUT = join(process.cwd(), '.dumps/antigravity');
const SECRET_HEADERS = new Set(['authorization', 'x-api-key', 'cookie', 'set-cookie', 'proxy-authorization']);
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

mkdirSync(OUTPUT, { recursive: true });

const sha = value => createHash('sha256').update(value).digest('hex').slice(0, 12);
const redact = value => `<redacted sha256:${sha(String(value))} len:${String(value).length}>`;

function redactHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = SECRET_HEADERS.has(key.toLowerCase()) ? redact(Array.isArray(value) ? value.join(',') : value) : value;
  }
  return out;
}

/** Gemini request geometry: what was sent, in what shape, at what cost. */
function summarize(body) {
  let payload;
  try { payload = JSON.parse(body); } catch { return { parsed: false, bytes: body.length }; }
  const text = value => {
    if (typeof value === 'string') return Buffer.byteLength(value);
    if (Array.isArray(value)) return value.reduce((sum, item) => sum + text(item), 0);
    if (value !== null && typeof value === 'object') return text(value.text ?? value.parts ?? value.content ?? '');
    return 0;
  };
  const parts = value => (Array.isArray(value?.parts) ? value.parts : []);
  return {
    parsed: true,
    bytes: body.length,
    keys: Object.keys(payload),
    model: payload.model ?? payload.request?.model ?? null,
    project: payload.project ? '<set>' : null,
    systemInstruction: {
      present: payload.systemInstruction !== undefined,
      parts: parts(payload.systemInstruction).length,
      bytes: text(payload.systemInstruction),
    },
    generationConfig: payload.generationConfig ?? payload.request?.generationConfig ?? null,
    toolCount: Array.isArray(payload.tools) ? payload.tools.length : (Array.isArray(payload.request?.tools) ? payload.request.tools.length : 0),
    tools: (payload.tools ?? payload.request?.tools ?? []).map(tool => ({
      names: (tool.functionDeclarations ?? []).map(entry => entry?.name).filter(Boolean),
      bytes: text(tool),
    })),
    contents: (payload.contents ?? []).map((entry, index) => ({
      index,
      role: entry.role,
      parts: parts(entry).map(part => ({
        type: part.functionCall ? 'functionCall' : part.functionResponse ? 'functionResponse' : part.inlineData ? 'inlineData' : part.text !== undefined ? 'text' : 'other',
        bytes: text(part),
      })),
      bytes: text(entry),
    })),
    cachedContent: payload.cachedContent ?? null,
  };
}

function parseOrRaw(value) {
  if (!value) return { empty: true };
  try { return JSON.parse(value); } catch { return { raw: value }; }
}

let sequence = 0;

http.createServer((clientReq, clientRes) => {
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${String(sequence += 1).padStart(3, '0')}`;
  const chunks = [];
  clientReq.on('data', chunk => chunks.push(chunk));
  clientReq.on('end', () => {
    const body = Buffer.concat(chunks);
    const headers = { ...clientReq.headers };
    delete headers.host;
    delete headers['content-length'];

    const upstreamReq = https.request({
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
          requestBytes: body.length,
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
        requestBytes: body.length,
        summary: summarize(body.toString('utf8')),
        request: parseOrRaw(body.toString('utf8')),
      });
    });

    upstreamReq.end(body);
    process.stdout.write(`${id} ${clientReq.method} ${clientReq.url} → ${UPSTREAM.host}\n`);
  });
}).listen(PORT, HOST, () => {
  process.stdout.write(`antigravity proxy on http://${HOST}:${PORT} → ${UPSTREAM.origin}\ndumps: ${relative(process.cwd(), OUTPUT)}\n`);
});

function writeRecord(id, record) {
  const file = join(OUTPUT, `${id}.json`);
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  process.stdout.write(`${id} ${record.status} → ${relative(process.cwd(), file)}\n`);
}
