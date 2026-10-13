import { resolveHost } from '../common.mjs';
const { validateStoredEvents } = await import(resolveHost('@deepseek-ai/dsh-session-persistence'));

/** Probe the actual persistence dependency, not a different SDK's mutable catalog. */
export function assertPersistenceCompatible() {
  const header = { version: 4, id: 'self-heal-compatibility-probe', createdAt: 0 };
  const events = [{ type: 'agent/self-heal', seq: 0, time: 0,
    data: { version: 1, action: 'observed', turn: 1, step: 1, state: { lastHealthyTurn: 0 } } }];
  try {
    validateStoredEvents(header, events);
  } catch (cause) {
    throw new Error('agent-self-heal: this DSH persistence build cannot reopen required agent/self-heal events. Install the audited persistence bridge and start a new DSH process before enabling self-heal.', { cause });
  }
}

const ACTIONS = new Set(['observed', 'reserved', 'observation-admitted', 'retry-requested',
  'suspended', 'aborted', 'append-failed', 'recovered', 'manual-resumed']);

/** Never turn an unknown owner protocol into a fresh, unspent recovery budget. */
export function assertAuditReadable(event, stateSchema) {
  if (event.type !== 'agent/self-heal') return;
  const data = event.data;
  if (data?.version !== 1 || !ACTIONS.has(data.action)) {
    throw new Error('agent-self-heal: unsupported required audit version or action; refusing recovery replay.');
  }
  stateSchema.parse(data.state);
}
