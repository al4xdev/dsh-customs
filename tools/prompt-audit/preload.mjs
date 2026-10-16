// Loaded with `node --import` by audit.mjs for the capture child, so worker threads
// (which inherit execArgv and get their own fs/net module instances) run behind the
// same fences as the main thread. Each thread keeps its own report; capture.mjs
// returns the main thread's.
import { installGuards } from './guards.mjs';

globalThis.__promptAuditGuard ??= installGuards({
  protectedRoots: (process.env.PROMPT_AUDIT_PROTECT ?? '').split(':'),
  tempRoot: process.env.PROMPT_AUDIT_TEMP,
});
