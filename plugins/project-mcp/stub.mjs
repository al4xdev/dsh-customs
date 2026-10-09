// Offline test server: exercises the real native MCP client's stdio transport.
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const log = process.env.PROJECT_MCP_TEST_LOG;
if (log) appendFileSync(log, `start ${process.pid}\n`);
process.on('exit', () => { if (log) appendFileSync(log, `stop ${process.pid}\n`); });
process.on('SIGTERM', () => process.exit(0));
const lines = createInterface({ input: process.stdin });
lines.on('close', () => process.exit(0));
lines.on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result;
  switch (request.method) {
    case 'initialize':
      result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'offline-stub', version: '1' }, instructions: 'Offline fixture only.' };
      break;
    case 'tools/list':
      result = { tools: [{ name: 'where', description: `Fixture in ${process.cwd()}`, inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] };
      break;
    case 'tools/call': result = { content: [{ type: 'text', text: process.cwd() }] }; break;
    case 'ping': result = {}; break;
    default:
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Unsupported fixture method' } }) + '\n');
      return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
});
