import { join, dirname, basename } from 'node:path';
import { lstatSync, realpathSync } from 'node:fs';
import { DEDICATED_ROOT, fail, hash } from './contracts.mjs';
import { directoryFact } from './preflight.mjs';

/** Host-private authority. Neither arguments nor a persisted ID can mint an incarnation proof. */
export class AuthorityRegistry {
  #proofs = new WeakMap();
  #guards = new Set();
  #epoch = 1;
  #active = true;
  constructor({ agents, root = DEDICATED_ROOT }) {
    this.agents = agents;
    this.root = root;
    this.public = Object.freeze({
      attachGuard: options => this.attachGuard(options),
      allows: (exec, policy) => this.allows(exec, policy),
      validate: (exec, policy) => this.validate(exec, policy),
      capabilities: () => Object.freeze({ ready: this.ready, epoch: this.epoch, workspaceRoot: root, revision: 1 }),
    });
  }
  get epoch() { return this.#epoch; }
  get ready() { return this.#active && this.#guards.size > 0; }
  attachGuard({ workspaceRoot, revision } = {}) {
    if (!this.#active || workspaceRoot !== this.root || revision !== 1) fail('authority_guard_mismatch');
    const key = Symbol('trusted companion guard');
    this.#guards.add(key);
    return () => { if (this.#guards.delete(key) && this.#guards.size === 0) this.#epoch += 1; };
  }
  invalidate() { this.#epoch += 1; }
  close() { this.#active = false; this.#epoch += 1; this.#guards.clear(); }
  isProjectCwd(cwd) {
    return typeof cwd === 'string' && dirname(cwd) === join(this.root, 'projects') && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(basename(cwd));
  }
  register(agent, intent) {
    if (!this.ready || intent.authority_epoch !== this.epoch || !this.isProjectCwd(intent.cwd) || !/^[a-f0-9]{64}$/u.test(intent.intent_hash)) fail('authority_unavailable');
    if (agent.id !== intent.session_id || agent.session.header.id !== intent.session_id || agent.session.header.cwd !== intent.cwd || agent.session.header.agentPreset !== 'companion') fail('authority_identity_mismatch');
    if (!intent.directory_fact || intent.directory_fact.path !== intent.cwd || intent.directory_fact.state !== 'directory') fail('authority_path_unavailable');
    this.#proofs.set(agent, Object.freeze({ session: agent.session, header: agent.session.header, cwd: intent.cwd, epoch: this.epoch, hash: intent.intent_hash, facts: [intent.root_fact, intent.projects_fact, intent.directory_fact] }));
  }
  revoke(agent) { this.#proofs.delete(agent); }
  async validate(exec, policy) {
    if (!this.allows(exec, policy)) return false;
    const proof = this.#proofs.get(exec.agent);
    try {
      for (const fact of proof.facts) {
        if (!fact || hash(await directoryFact(fact.path)) !== hash(fact)) { this.revoke(exec.agent); return false; }
        if (!this.allows(exec, policy)) return false;
      }
      return this.allows(exec, policy);
    } catch { this.revoke(exec.agent); return false; }
  }
  allows(exec, policy) {
    if (!this.identityAllows(exec, policy)) return false;
    const proof = this.#proofs.get(exec.agent);
    // ToolGuard is synchronous and runs AFTER Native ASK settles. Fresh bounded
    // metadata checks close the long approval wait fence; a Promise here would be
    // silently wrong. This is still not an fd-pinned defense against hostile OS races.
    try {
      for (const fact of proof.facts) {
        const stat = lstatSync(fact.path);
        if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== fact.dev || stat.ino !== fact.ino || realpathSync(fact.path) !== fact.path) {
          this.revoke(exec.agent); return false;
        }
      }
      return this.identityAllows(exec, policy);
    } catch { this.revoke(exec.agent); return false; }
  }
  identityAllows(exec, policy) {
    if (!this.ready) return false;
    const agent = exec?.agent;
    const proof = agent && this.#proofs.get(agent);
    return Boolean(proof && proof.epoch === this.epoch && this.agents.get(agent.id) === agent &&
      agent.session === proof.session && agent.session.header === proof.header &&
      proof.header.id === agent.id && proof.header.agentPreset === 'companion' && proof.header.cwd === proof.cwd &&
      this.isProjectCwd(proof.cwd) && policy?.mode === 'workspace-write' && policy.workspaceRoot === proof.cwd && !exec.signal?.aborted);
  }
}
