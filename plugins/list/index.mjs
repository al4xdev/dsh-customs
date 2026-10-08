import { join } from 'node:path';
import { defineTool, cwdOf, assertActive } from '../common.mjs';

export const name = 'alex-list';
export const inject = ['tools', 'fs', 'systemPrompt'];

// Bounds mirror the read tool's caps: a listing can never flood context, and a
// capped result always reports its truncation rather than looking complete.
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const MAX_DEPTH = 8;
const MAX_BYTES = 64 * 1024;

function parsePositiveInteger(value, name) {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function parseListArgs(args) {
  const rawPath = args.file_path ?? args.path;
  if (typeof rawPath !== 'string' || rawPath.trim().length === 0) throw new Error('file_path or path must be a non-empty string');
  const depth = args.depth === undefined ? 1 : parsePositiveInteger(args.depth, 'depth');
  if (depth > MAX_DEPTH) throw new Error(`depth must be less than or equal to ${MAX_DEPTH}`);
  const limit = args.limit === undefined ? DEFAULT_LIMIT : parsePositiveInteger(args.limit, 'limit');
  if (limit > MAX_LIMIT) throw new Error(`limit must be less than or equal to ${MAX_LIMIT}`);
  return { filePath: rawPath, depth, limit, hidden: args.hidden !== false };
}

// Deterministic ordering: directories first, then files, then other entries,
// each group sorted by name — never modification time.
const typeRank = type => (type === 'directory' ? 0 : type === 'file' ? 1 : 2);

async function collectEntries(ctx, rootTarget, input, signal) {
  const { depth, limit, hidden } = input;
  const entries = [];
  // The backend resolves child targets (following symlinks), so a symlink that
  // points back at an ancestor shares its targetKey. Tracking visited directory
  // identities stops symlink loops and repeated subtrees without extra probes.
  const visited = new Set([String(rootTarget.targetKey)]);
  let total = 0;
  let truncated = false;
  let bytes = 0;

  async function visit(dirTarget, rel, level) {
    const children = await ctx.fs.listDir(dirTarget, signal);
    children.sort((a, b) => typeRank(a.type) - typeRank(b.type) || a.name.localeCompare(b.name));
    for (const child of children) {
      signal?.throwIfAborted();
      if (!hidden && child.name.startsWith('.')) continue;
      const childRel = rel ? join(rel, child.name) : child.name;
      total += 1;
      if (!truncated) {
        const entryBytes = Buffer.byteLength(childRel, 'utf8') + 1;
        if (entries.length >= limit || bytes + entryBytes > MAX_BYTES) truncated = true;
        else {
          entries.push({ name: child.name, type: child.type, path: childRel });
          bytes += entryBytes;
        }
      }
      if (child.type === 'directory' && level < depth) {
        const key = String(child.target.targetKey);
        if (!visited.has(key)) {
          visited.add(key);
          await visit(child.target, childRel, level + 1);
        }
      }
    }
  }

  await visit(rootTarget, '', 1);
  return { entries, total, truncated };
}

function formatListOutput(args, value) {
  const { path, entries, total, truncated } = value;
  const lines = entries.map(entry => (entry.type === 'directory' ? `${entry.path}/` : entry.path));
  let footer;
  if (total === 0) footer = 'Empty directory';
  else if (truncated) footer = `Showing ${entries.length} of ${total} entries (capped); narrow depth or limit to see more.`;
  else footer = `${total} ${total === 1 ? 'entry' : 'entries'}`;
  if (args.hidden === false) footer += '; hidden entries omitted';
  const body = lines.length ? `${lines.join('\n')}\n\n${footer}` : footer;
  return `<path>${path}</path>\n<type>directory</type>\n<content>\n${body}\n</content>`;
}

export function apply(ctx) {
  ctx.systemPrompt.section({
    name: 'tool:list',
    order: ctx.systemPrompt.getSectionOrder('TOOL_READ') + 1,
    text: ({ scope }) => (ctx.tools.get('list', scope) === undefined ? '' : 'Use the list tool — not shell ls or find — to ask what is in a directory at a controlled depth.'),
  });
  ctx.tools.register(defineTool({
    name: 'list',
    description: 'List entries in a directory at a controlled depth. Directories are marked and listed before files; hidden entries (dotfiles/dot-directories) are included by default. Returns names and types only — use read for file contents.',
    parameters: {
      file_path: {
        type: 'string',
        description: 'Path to the directory to list (or use "path").',
      },
      path: {
        type: 'string',
        description: 'Alternative alias for file_path.',
      },
      depth: {
        type: 'number',
        description: 'Maximum directory depth to list. Defaults to 1 (immediate entries only).',
      },
      limit: {
        type: 'number',
        description: `Maximum number of entries to return. Defaults to ${DEFAULT_LIMIT}.`,
      },
      hidden: {
        type: 'boolean',
        description: 'Include hidden entries (dotfiles and dot-directories). Defaults to true.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          entries: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                type: { type: 'string', required: true, enum: ['file', 'directory', 'other'] },
                path: { type: 'string', required: true },
              },
            },
          },
          total: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (args, value) => [{ type: 'text', text: formatListOutput(args, value) }],
      presentationMeta: (_args, value) => ({ path: value.path, entries: value.entries, total: value.total, truncated: value.truncated }),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      assertActive(exec);
      const input = parseListArgs(args);
      const target = await ctx.fs.resolve(input.filePath, { cwd: cwdOf(exec), signal: exec.signal });
      const info = await ctx.fs.stat(target, exec.signal);
      if (info === undefined) throw new Error(`cannot list "${target.displayPath}": not found`);
      if (info.type !== 'directory') throw new Error(`cannot list "${target.displayPath}": not a directory`);
      const collected = await collectEntries(ctx, target, input, exec.signal);
      return { path: target.displayPath, ...collected };
    },
    presentCall(args) {
      const targetPath = args.file_path ?? args.path ?? '';
      return { card: 'generic', title: `List ${targetPath}`, kind: 'read', locations: targetPath ? [{ path: targetPath }] : [] };
    },
  }));
}
