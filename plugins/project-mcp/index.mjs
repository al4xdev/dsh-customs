import { nativeMcp } from './host.mjs';
import { projectRoot, readProjectConfig, serverConfigs } from './config.mjs';

export const name = 'alex-project-mcp';
export const inject = ['agents', 'tools'];

export async function loadProject(cwd, mcp) {
  const root = await projectRoot(cwd);
  if (root === null) return [];
  const document = await readProjectConfig(root);
  return document === null ? [] : serverConfigs(document, root, mcp.Config);
}

export async function quiesceFiber(fiber) {
  await Promise.resolve(fiber.dispose());
  // Another structural owner may already have claimed the single-shot disposer.
  while (fiber.inertia !== undefined) await fiber.inertia;
}

/** The injectable loader seam permits offline lifecycle tests, not alternate transports. */
export function install(ctx, mcp, load = loadProject) {
  let stopping = false;
  const records = new Map();
  const pending = new Set();
  const stopRecord = async record => {
    const outcomes = await Promise.allSettled(record.fibers.map(quiesceFiber));
    const failures = outcomes.filter(result => result.status === 'rejected').map(result => result.reason);
    if (failures.length) throw new AggregateError(failures, 'Project MCP cleanup failed');
  };
  ctx.effect(() => async () => {
    stopping = true;
    // Stop transports before joining initialization: startup may be awaiting IO.
    const first = await Promise.allSettled([...records.values()].map(stopRecord));
    await Promise.allSettled([...pending]);
    const last = await Promise.allSettled([...records.values()].map(stopRecord));
    records.clear();
    const failures = [...first, ...last].filter(result => result.status === 'rejected').map(result => result.reason);
    if (failures.length) throw new AggregateError(failures, 'Project MCP wrapper cleanup failed');
  }, 'project-mcp.connections');

  ctx.on('agent/created', async ({ agent, signal }) => {
    if (stopping) throw new Error('Project MCP wrapper is closing');
    if (records.has(agent)) return undefined;
    const record = { fibers: [] };
    records.set(agent, record);
    const initialize = async () => {
      try {
        const configs = await load(agent.session.header.cwd, mcp);
        for (const config of configs) {
          signal?.throwIfAborted();
          if (stopping) throw new Error('Project MCP wrapper closed during initialization');
          // Registration visibility and structural ownership stay on the exact Agent.
          // The wrapper separately holds teardown capabilities for HMR/unload.
          const fiber = agent.ctx.plugin(mcp, config);
          record.fibers.push(fiber);
          await fiber;
        }
        signal?.throwIfAborted();
        if (stopping) throw new Error('Project MCP wrapper closed during initialization');
      } catch (error) {
        try { await stopRecord(record); }
        catch (cleanup) { throw new AggregateError([error, cleanup], 'Project MCP initialization and cleanup failed'); }
        finally { records.delete(agent); }
        throw error;
      }
    };
    const task = initialize();
    pending.add(task);
    try { await task; }
    finally { pending.delete(task); }
    return undefined;
  });
  ctx.on('agent/disposed', ({ agent }) => {
    // Native AgentLoop has already drained the driver and unwound the scope.
    records.delete(agent);
  });
}

export async function apply(ctx) {
  install(ctx, await nativeMcp());
}
