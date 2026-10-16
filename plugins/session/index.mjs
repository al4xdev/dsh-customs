import { resolveHost, defineTool, stringOutput } from '../common.mjs';
import { createController } from './controller.mjs';
import * as bridge from './bridge-client.mjs';
import { preflightResume } from './resume-preflight.mjs';
import { executeResume } from './resume-client.mjs';
import { observeWriterOwnership } from './writer-observation.mjs';
import { LIVE_SCHEMAS, parseLiveDescription, parseRequest, redact } from './contracts.mjs';
import { SESSION_TOOL_DESCRIPTION, SESSION_TOOL_PARAMETERS } from './tool-contract.mjs';
import { FILE_SCHEMAS, isFileRequest, parseFileRequest, parseFileDescription } from './file-contracts.mjs';
const { scopeOf } = await import(resolveHost('@deepseek-ai/dsh-scope'));
const { buildSessionEventRecords } = await import(resolveHost('@deepseek-ai/dsh-session-query'));

export const name = 'alex-session';
export const inject = ['sessionPersistence', 'sessionQuery', 'sessionProjections', 'sessions', 'agents', 'approval', 'tools'];

export function apply(ctx, config = {}) {
  // A global registration would leak discovery into ordinary presets. Reject
  // accidental root mounting even if its config claims to be companion.
  if (config.profile !== 'companion' || !scopeOf(ctx)) throw new Error('session must be mounted inside the companion preset scope with profile: companion');
  const controller = createController(ctx, {
    bridge,
    fileReading: true,
    ...(config.root ? { root: config.root } : {}),
    ...(config.ledgerPath ? { ledgerPath: config.ledgerPath } : {}),
    resume: { preflightResume, executeResume },
    readSide: { allowManagedIndex: config.readSide?.allowManagedIndex === true },
    eventRecords: buildSessionEventRecords,
    // Public service configuration is the only trusted persistence root. The
    // observer refuses unsupported backends/relative roots; never guess a home.
    writerObserver: (snapshots, signal) => observeWriterOwnership(snapshots, {
      root: ctx.sessionPersistence.name === 'session-persistence-jsonl' ? ctx.sessionPersistence.config?.root : undefined,
      backend: ctx.sessionPersistence.name === 'session-persistence-jsonl' ? 'jsonl' : undefined,
      signal,
    }),
  });
  ctx.effect(() => () => controller.clear());
  ctx.tools.register(defineTool({
    name: 'session',
    description: SESSION_TOOL_DESCRIPTION,
    parameters: { ...SESSION_TOOL_PARAMETERS },
    output: stringOutput,
    isConcurrencySafe: args => !['send', 'resume'].includes(args.operation),
    async execute(args, exec) {
      if (exec.agent?.session.header.agentPreset !== 'companion') throw new Error('session is only available to the companion preset');
      if (args.operation==='describe' && Object.hasOwn(LIVE_SCHEMAS,args.targetOperation)) parseLiveDescription(args);
      else if (args.operation==='describe' && Object.hasOwn(FILE_SCHEMAS,args.targetOperation)) parseFileDescription(args);
      else if (isFileRequest(args)) parseFileRequest(args); else parseRequest(args);
      try { return JSON.stringify(await controller.execute(args, exec)); }
      catch (error) {
        if (exec.signal?.aborted) throw error;
        // Backend diagnostics must not bypass preview/byte budgets by dumping
        // a malformed log's raw payload or an unbounded codec exception.
        return JSON.stringify({ operation: args.operation, ...(args.sessionId ? { sessionId: redact(args.sessionId).slice(0, 128) } : {}), observedAt: new Date().toISOString(), untrustedData: true, code: error?.sessionReadError ? error.code : 'session_unavailable', reason: redact(error?.message ?? 'Backend unavailable').slice(0, 128), effect: ['send', 'resume'].includes(args.operation) ? 'unknown' : 'none', retrySafe: false });
      }
    },
  }));
}
