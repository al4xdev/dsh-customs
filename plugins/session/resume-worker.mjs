import * as fs from 'node:fs/promises';
import path from 'node:path';
import { readKey, privateStat, validId, GRANT_TTL } from './bridge-security.mjs';
import { readPrivateJson, verifyPayload, hashValue, profileFingerprint, rootComposition, persistedSnapshot, executionProof, runtimeModules } from './provenance.mjs';
import { assertSnapshot } from './resume-preflight.mjs';

export const name = 'session-companion-resume-worker';
export const inject = ['agents', 'sessions', 'sessionPersistence', 'sessionProjections', 'tools'];
export async function consumeResumeGrant(root, requestPath, { now = Date.now() } = {}) {
  await privateStat(root, 'dir', 0o700);
  await privateStat(path.join(root, 'resume-requests'), 'dir', 0o700);
  if (path.dirname(requestPath) !== path.join(root, 'resume-requests')) throw new Error('Request is outside private worker storage');
  const signed = await readPrivateJson(requestPath), key = await readKey(root);
  if (!verifyPayload(signed, key)) throw new Error('Resume grant signature invalid');
  const grant = signed.payload;
  if (grant.version !== 1 || grant.kind !== 'session-resume-grant' || grant.operation !== 'resume' || !validId(grant.requestId) || !validId(grant.plan?.sessionId) || grant.plan.root !== root || typeof grant.nonce !== 'string' || !/^[a-f0-9]{48}$/.test(grant.nonce) || !Number.isSafeInteger(grant.issuedAt) || !Number.isSafeInteger(grant.expiresAt) || grant.issuedAt > now || grant.expiresAt <= now || grant.expiresAt - grant.issuedAt > GRANT_TTL) throw new Error('Resume grant expired or malformed');
  if (requestPath !== path.join(root, 'resume-requests', `${grant.requestId}.json`)) throw new Error('Request path identity mismatch');
  if (grant.workerHash !== hashValue(await fs.readFile(new URL(import.meta.url), 'utf8'))) throw new Error('Worker code changed after approval');
  const consumed = await fs.open(`${requestPath}.consumed`, 'wx', 0o600);
  try { await consumed.writeFile(JSON.stringify({ nonce: grant.nonce, pid: process.pid, at: now })); await consumed.sync(); }
  finally { await consumed.close(); }
  return grant;
}
export async function runResumeWorker(ctx, config, notify = message => process.send?.(message)) {
  let grant, handle, enteredWriter = false, admitted = false;
  let startupViolation = false;
  const startupFences = [];
  try {
    grant = await consumeResumeGrant(config.root, config.requestPath);
    const { plan } = grant, checkpoint = plan.checkpoint;
    if (hashValue({ checkpoint, current: checkpoint.configFingerprint, text: plan.text }) !== plan.fingerprint) throw new Error('Approved preparation fingerprint mismatch');
    if (ctx.profileContext?.name !== checkpoint.origin.name || ctx.profileContext.dir !== checkpoint.origin.dir || ctx.profileContext.home !== checkpoint.origin.home || ctx.profileContext.installAnchor !== checkpoint.origin.installAnchor || process.cwd() !== checkpoint.cwd) throw new Error('Worker did not boot the original profile/cwd');
    if (hashValue(ctx.profileContext.overlays) !== grant.overlayHash) throw new Error('Worker overlay differs from the approved limited overlay');
    if ((await profileFingerprint(checkpoint.origin)).fingerprint !== checkpoint.configFingerprint) throw new Error('Current profile changed after confirmation');
    const composition = rootComposition(ctx);
    if (composition.hash !== checkpoint.rootComposition.hash) throw new Error('Headless overlay changed model-facing host composition');
    if (ctx.agents.list().length) throw new Error('Worker boot created an unapproved agent');
    const before = await persistedSnapshot(ctx, plan.sessionId);
    assertSnapshot(checkpoint, before);
    const { agents } = await runtimeModules(checkpoint.origin.installAnchor);
    if (checkpoint.execution.preset !== null) {
      const resolved = await ctx.agentPresets?.resolve(checkpoint.execution.preset);
      if (!resolved || resolved.id !== checkpoint.execution.preset || resolved.broken || hashValue((await ctx.agentPresets.readDocument(resolved.id)).content) !== checkpoint.execution.presetHash) throw new Error('Recorded preset unavailable or changed');
    } else if (ctx.get('agentPresets')) throw new Error('No preset fallback is permitted');
    // Core resume owns the kernel writer lock. A setup failure may follow core
    // housekeeping appends, so after this boundary failure is unknown, not none.
    enteredWriter = true;
    handle = await ctx.agents.resume({ resumeSessionId: plan.sessionId, agentOptions: checkpoint.execution.model, setup: async (agentCtx, agent) => {
      if (agent.session.header.cwd !== checkpoint.cwd || agent.session.header.id !== plan.sessionId) throw new Error('Locked destination identity changed');
      // Publication hooks must not run an autonomous request or tool before
      // the single owner-approved literal is admitted. Fences disappear before
      // that send, leaving the original preset, prompt and policies intact.
      startupFences.push(agentCtx.on('agent/request', () => { startupViolation = true; throw new Error('Unapproved startup model request'); }));
      startupFences.push(agentCtx.tools.guard(() => { startupViolation = true; return 'Unapproved startup tool execution'; }));
      agents.installModelSelection(agentCtx, { current: checkpoint.execution.model, assembled: undefined });
      if (checkpoint.execution.preset !== null) await ctx.agentPresets.mount(agentCtx, checkpoint.execution.preset);
      const locked = await persistedSnapshot(ctx, plan.sessionId);
      assertSnapshot(checkpoint, locked, { allowResumeSeed: true });
      const proof = await executionProof(ctx, agent, locked);
      if (hashValue(proof) !== hashValue(checkpoint.execution)) throw new Error('Locked catalog, model or policy proof differs from checkpoint');
      if ((await profileFingerprint(checkpoint.origin)).fingerprint !== checkpoint.configFingerprint || rootComposition(ctx).hash !== checkpoint.rootComposition.hash) throw new Error('Profile or current module hashes changed during worker setup');
    } });
    const agent = handle.agent;
    const pending = ctx.sessionProjections.stateOf(agent.session, 'inbox');
    if (startupViolation || agent.status !== 'idle' || !pending || Object.values(pending).some(value => Array.isArray(value) && value.length)) throw new Error('Publication created unapproved execution or pending inbox');
    const goals = agent.ctx.get('goals') ?? ctx.get('goals');
    if (typeof goals?.get !== 'function') throw new Error('Goal activation owner unavailable');
    const goal = goals.get(agent);
    if (goal && goal.activation !== 'disarmed') throw new Error('Unexpected armed goal; continuation is not authorized');
    for (const dispose of startupFences.splice(0)) dispose();
    agent.send({ id: grant.requestId, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: plan.text }] }, 'next-turn', true);
    admitted = true;
    await ctx.sessions.flush(agent.session);
    notify({ ok: true, requestId: grant.requestId, sessionId: plan.sessionId, ack: { requestId: grant.requestId, sessionId: plan.sessionId, accepted: true, boundary: 'next-turn' }, effect: 'admitted' });
    await agent.whenIdle();
    await ctx.sessions.flush(agent.session);
    return { ok: true, admitted: true };
  } catch (error) {
    const writerHeld = error.name === 'SessionAlreadyOwnedError';
    const effect = enteredWriter && !writerHeld ? 'unknown' : 'none';
    notify({ ok: false, requestId: grant?.requestId, sessionId: grant?.plan?.sessionId, error: { code: writerHeld ? 'writer_held' : 'resume_unavailable', message: error.message }, effect, admitted });
    return { ok: false, admitted, effect };
  } finally {
    for (const dispose of startupFences.splice(0)) dispose();
    await handle?.dispose();
  }
}
export function apply(ctx, config) {
  const ready = ctx.get('appReady'), exit = ctx.get('appExit');
  if (!ready?.onReady || !exit) throw new Error('Worker requires the official profile launcher readiness and exit lifecycle');
  ctx.effect(() => ready.onReady(() => {
    const finish = code => {
      exit(code);
      // Some adapter libraries retain keep-alive handles after Cordis disposal.
      // This bounded exit belongs ONLY to this worker, after its Agent handle
      // was disposed and its durable writes flushed, never to an observed PID.
      setTimeout(() => process.exit(code), 5_000).unref();
    };
    runResumeWorker(ctx, config).then(result => finish(result.ok ? 0 : 1)).catch(() => finish(1));
  }));
}
