import { resolve, join } from 'node:path';

/** Source proposal only: importing this module does not load a plugin, mutate a profile or activate anything. */
export function compositionProposal(repoRoot) {
  const root = resolve(repoRoot);
  return Object.freeze({
    rootEntry: Object.freeze({ id: 'session-create-owner', name: join(root, 'plugins/session-create/owner.mjs') }),
    presetChildEntry: Object.freeze({ id: 'companion-session-create', name: join(root, 'plugins/session-create/index.mjs'), config: Object.freeze({ profile: 'companion' }) }),
    instructions: Object.freeze([
      'After a fresh owner-confirmed safe boundary, parent adds rootEntry to HOST/root composition, not inside a preset.',
      'Append presetChildEntry to the CURRENT companion preset child list, preserving all existing rows and saved Settings; Loader replaces whole config.',
      'Keep the specialized Android session controller unchanged and retain scoped companion-workspace guard; its optional public authority injection handles owner mount order.',
      'Do not regenerate model defaults, root policy, credentials, ports or transports from the profile template.',
      'No cold sessions acquire child authority merely by ID or persisted ledger; capability remains false without a fresh live host incarnation proof.',
    ]),
  });
}
