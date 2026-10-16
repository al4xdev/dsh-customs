import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createGoalPush } from './source.mjs';
import { hash, publicConfig } from './contracts.mjs';
import { DSH_CLI_PACKAGE } from '../session/host-paths.mjs';

const require = createRequire(DSH_CLI_PACKAGE);
export const sdk = name => import(require.resolve(`@deepseek-ai/${name}`));
export const { foldGoal } = await sdk('dsh-goal');
export const config = { enabled: true, publicConfig: { projectId: 'authored-fixture-only', senderId: '123456789012',
  appId: '1:123456789012:android:0123456789abcdef', androidPackage: 'dev.alex.dsh.companion' } };
export function root() {
  mkdirSync('.dumps', { recursive: true });
  return mkdtempSync(resolve('.dumps/task101-push-backend-'));
}
export function fixture(options = {}) {
  const directory = options.directory ?? root(), profile = { name: 'companion', dir: directory };
  const scope = {}, operator = { ctx: { fiber: { isDisposed: false } } };
  const connection = { operator }, agents = new Map(), allowed = new Set(['own-session']);
  const presets = { composedPreset: ctx => ctx.preset ?? 'companion' };
  const services = { profileContext: profile, connection,
    agents: { get: id => agents.get(id), roots: () => [...agents.values()] }, goals: { get: agent => agent.goal }, agentPresets: presets };
  const warnings = [], ctx = { get: key => services[key], logger: { warn: message => warnings.push(message) } };
  const sends = []; let clock = 1800000000000;
  const sender = options.sender ?? { ready: () => true, status: () => 'ready', close() {},
    async send(work) { sends.push(work); return options.sendResult ?? { ok: true }; } };
  const helpers = { scopeOf: () => scope, scopeChainOf: () => [scope], foldGoal, identityOf: x => x,
    ownsSession: id => allowed.has(id), now: () => clock, sender, ...options.helpers };
  const selectedConfig = options.config ?? config;
  const source = createGoalPush(ctx, helpers, selectedConfig);
  const request = (overrides = {}) => {
    const token = 'own-authored-not-a-real-fcm-token';
    return { version: 1, deviceId: randomUUID(), token, tokenDigest: hash(token), configDigest: publicConfig(config).configDigest,
      authGeneration: 1, sessionIds: ['own-session'], ...overrides };
  };
  const call = (method, request, peer = operator, signal) => source.dispatch(`goalPush/${method}`, { args: { request } }, signal, peer);
  function completion(sessionId = 'own-session', goalId = 'own-goal', revision = 2) {
    const goal = { id: goalId, revision: 1, phase: 'active', objective: 'PRIVATE OBJECTIVE NOT FOR DELIVERY', maxGoalRounds: 4 };
    const data = (operation, goal, timestamp) => ({ kind: 'goal/change', version: 1, operation, goal, createdAt: clock - 100, updatedAt: timestamp, roundsStarted: 0 });
    const events = [{ type: 'goal/change', data: data('create', goal, clock - 100) }];
    for (let r = 2; r < revision; r++) events.push({ type: 'goal/change', data: data('edit', { ...goal, revision: r }, clock - 50) });
    const complete = { ...goal, revision, phase: 'complete' };
    events.push({ type: 'goal/change', data: data('complete', complete, clock) });
    const agent = { id: sessionId, ctx: {}, goal: complete,
      session: { id: sessionId, header: { id: sessionId, agentPreset: 'companion', isSeeded: false }, snapshotEvents: () => events } };
    agents.set(sessionId, agent);
    return { agent, change: { operation: 'complete', goal: complete, ref: { id: goalId, revision } } };
  }
  return { source, directory, profile, services, ctx, scope, operator, allowed, agents, warnings, sends, helpers,
    advance: ms => { clock += ms; }, request, call, completion,
    state: () => JSON.parse(readFileSync(join(directory, 'companion-push/state-v1.json'), 'utf8')),
    close: () => source.close() };
}
