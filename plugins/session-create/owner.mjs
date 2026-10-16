import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveHost } from '../common.mjs';
import { DEDICATED_ROOT } from './contracts.mjs';
import { AuthorityRegistry } from './authority.mjs';
import { OperationStore } from './operation-store.mjs';
import { createProfileController } from './profile-controller.mjs';
const { Service } = await import(resolveHost('@deepseek-ai/cordis'));
const { scopeOf } = await import(resolveHost('@deepseek-ai/dsh-scope'));

/** Mount on the host/root plane only. The caller's tool scope never owns new root handles. */
export default class SessionCreateOwner extends Service {
  static inject = ['agents', 'sessions', 'agentPresets', 'agentDefaultModel', 'sessionProjections', 'sessionPersistence', 'sandboxPolicy', 'approval', 'permissionPresets', 'workspaceRegistry', 'workspaceController', 'sessionController'];
  #controller;
  #lifetime = new AbortController();
  constructor(ctx, config = {}) {
    if (scopeOf(ctx) || ctx.get('profileContext')?.name !== 'companion') throw new Error('session-create owner requires the companion HOST/root context');
    super(ctx, 'sessionCreateOwner');
    const authority = new AuthorityRegistry({ agents: ctx.agents, root: config.workspaceRoot ?? DEDICATED_ROOT });
    this.#controller = createProfileController(ctx, { authority, store: new OperationStore(config.ledgerRoot ?? join(homedir(), '.dsh', 'session-create', 'profile-dsh-tui')), bridgeRoot: config.bridgeRoot });
    // Cordis presents Services through a Context proxy. Bind these closures to the
    // actual owner so private fields are never accessed through that proxy receiver.
    this.capabilities = () => this.#controller.capabilities();
    this.diagnostics = () => this.#controller.diagnostics();
    this.execute = (args, exec) => this.#controller.execute(args, { ...exec, signal: AbortSignal.any([exec.signal, this.#lifetime.signal]) });
    ctx.provide('sessionCreateAuthority', authority.public);
    ctx.effect(() => async () => {
      this.#lifetime.abort(); authority.close();
      await this.#controller.drain();
      // Destination handles belong to the dsh-tui host, not this caller owner.
    });
  }
}
