import { Console } from 'node:console';
import { readdir, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';
import { isInsideDirectory } from '../config.mjs';

// Imported project modules may log; stdout belongs exclusively to the SDK.
globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });

function schemaAdapter(schema, label) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || schema.type !== 'object') {
    throw new Error(`${label} must be a JSON Schema with type: 'object'`);
  }
  // Keep JSON Schema intact. The SDK's own AJV provider performs validation;
  // this adapter only exposes its result through the SDK's Standard Schema API.
  const validate = new AjvJsonSchemaValidator().getValidator(schema);
  return { '~standard': {
    version: 1,
    vendor: 'project-mcp',
    jsonSchema: { input: () => schema, output: () => schema },
    validate(value) {
      const result = validate(value);
      return result.valid ? { value: result.data } : { issues: [{ message: result.errorMessage }] };
    },
  } };
}

function toMcpResult(value) {
  if (value && typeof value === 'object' && !Array.isArray(value) &&
      ['content', 'structuredContent', 'isError'].some(key => Object.hasOwn(value, key))) {
    return { ...value, content: value.content ?? [{ type: 'text', text: value.structuredContent === undefined ? '' : JSON.stringify(value.structuredContent) }] };
  }
  const text = typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value);
  return { content: [{ type: 'text', text }] };
}

async function main() {
  const { values } = parseArgs({ options: {
    'project-root': { type: 'string' },
    'tools-dir': { type: 'string' },
    'server-name': { type: 'string' },
    'tool-call-timeout-ms': { type: 'string' },
  } });
  if (!values['project-root'] || !values['tools-dir'] || !values['server-name']) {
    throw new Error('Required flags: --project-root, --tools-dir, --server-name');
  }
  const root = await realpath(values['project-root']);
  const toolsDir = await realpath(values['tools-dir']);
  const serverName = values['server-name'];
  const timeoutMs = Number(values['tool-call-timeout-ms'] ?? 30000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) {
    throw new Error('tool-call-timeout-ms must be an integer between 1 and 2147483647');
  }
  if (!(await isInsideDirectory(root, toolsDir))) throw new Error('toolsDir resolves outside the project');

  const tools = [];
  const names = new Set();
  for (const file of (await readdir(toolsDir)).sort()) {
    if (!file.endsWith('.mjs')) continue;
    try {
      const path = await realpath(join(toolsDir, file));
      if (!(await isInsideDirectory(root, path))) throw new Error('module resolves outside the project');
      if (!(await stat(path)).isFile()) throw new Error('module must be a regular file');
      const mod = await import(pathToFileURL(path).href);
      if (!Array.isArray(mod.tools)) throw new Error('module must export tools[]');
      for (const tool of mod.tools) {
        if (!tool || typeof tool.name !== 'string' || !/^[A-Za-z0-9_-]+$/.test(tool.name) ||
            typeof tool.description !== 'string' || typeof tool.handler !== 'function') {
          throw new Error('each tool needs a valid name, description and handler');
        }
        if (names.has(tool.name)) throw new Error(`duplicate tool name: ${tool.name}`);
        names.add(tool.name);
        tools.push({ ...tool,
          inputSchema: schemaAdapter(tool.inputSchema, `${tool.name}.inputSchema`),
          outputSchema: tool.outputSchema === undefined ? undefined : schemaAdapter(tool.outputSchema, `${tool.name}.outputSchema`),
        });
      }
    } catch (error) {
      throw new Error(`Cannot load ${file}: ${error.message}`, { cause: error });
    }
  }

  const entry = serveStdio(() => {
    const server = new McpServer({ name: serverName, version: '1.0.0' }, {
      capabilities: { tools: {} },
      instructions: 'Project-local static tools. Handlers are trusted project code, NOT sandboxed.',
    });
    for (const tool of tools) {
      server.registerTool(tool.name, {
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
      }, async (args, request) => {
        // Cancellation is cooperative, not isolation: handlers must honor signal.
        const signal = AbortSignal.any([request.mcpReq.signal, AbortSignal.timeout(timeoutMs)]);
        return toMcpResult(await tool.handler(args, {
          root, cwd: process.cwd(), env: process.env, serverName, signal,
        }));
      });
    }
    return server;
  });
  const shutdown = async () => {
    await entry.close();
    process.exit(0);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  process.stdin.once('end', shutdown);
}

main().catch(error => {
  console.error(`project-mcp(builtin): ${error.message}`);
  process.exit(1);
});
