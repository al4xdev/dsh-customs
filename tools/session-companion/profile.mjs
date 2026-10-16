import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { COMPANION_WORKSPACE_ROOT } from '../../plugins/companion-workspace/controller-policy.mjs';
import { DSH_CLI_PACKAGE } from '../../plugins/session/host-paths.mjs';

function loadYaml() {
  for (const base of [import.meta.url, DSH_CLI_PACKAGE, join(homedir(), '.dsh/profiles/package.json')]) {
    try { return createRequire(base)('yaml'); } catch { /* Try the next supported runtime resolver. */ }
  }
  throw new Error('Cannot resolve yaml: install repository dependencies or the DSH runtime');
}
export const YAML = loadYaml();

// Keep this profile out of the machine's global tool overlay. Its native tools
// and approval guard are mounted only in the one declared companion preset.
export function profileFiles(repoRoot, { guardedTransport = false } = {}) {
  if (typeof guardedTransport !== 'boolean') throw new TypeError('guardedTransport must be a boolean');
  const root = resolve(repoRoot);
  const patch = [
    ...['standard', 'minimal', 'ptc', 'cordis'].map(id => ({ id: `preset-${id}`, disabled: true })),
    { id: 'agent-preset-registry', config: { default: 'companion' } },
    { id: 'agent-default-model', config: { provider: 'openai-codex', model: 'gpt-6-sol', reasoningEffort: 'low' } },
    // Pure API model (owner decision 2026-10-16): no harness identity or persona lines;
    // anything the owner wants the model to read lives visibly in AGENTS-Companion.md.
    { id: 'system-prompt', config: { includeHarnessIdentity: false, personaPrefix: '', personaSuffix: '' } },
    // Physical encoding is root-wide, not autodetected per file. The shared host root was verified as Zstd.
    // Restate root because Loader patches replace the entire config rather than merging it with the base.
    { id: 'session-persistence-jsonl', config: { root: join(homedir(), '.dsh/sessions'), compression: 'zstd' } },
    { id: 'approval', config: { policy: 'ask' } },
    { id: 'permission', config: { presets: {
      'read-only': { sandbox: 'read-only', approval: 'ask' },
      'workspace-write': { sandbox: 'workspace-write', approval: 'ask' }
    }, defaultPreset: 'workspace-write' } },
    { id: 'sandbox-policy', config: { mode: 'workspace-write', workspaceRoot: COMPANION_WORKSPACE_ROOT } },
    // Loader patch `name` is an identity assertion, not a replacement. Disable
    // the stock controller and insert the native subclass under its own row.
    { id: 'session-controller', disabled: true },
    { id: 'tool-fs', disabled: true },
    { id: 'tool-bash', disabled: true },
    { id: 'session-title-llm', disabled: true },
    { id: 'web-runtime', config: { openBrowser: false, printUrl: false, surfaceContext: false, trustedHosts: ['dsh.tail37b3d7.ts.net:8443'] } },
    // Prepared migration only: default output and the active profile stay unchanged.
    // Loader replaces config wholesale, so retain the carrier's native gzip keys.
    ...(guardedTransport ? [
      { id: 'webserver', name: join(root, 'plugins/companion-transport/guarded-webserver.mjs'), inject: ['webStartup'], config: {
        host: '127.0.0.1', port: 3081, compression: 'gzip', compressionLevel: 1, compressionThresholdBytes: 1024
      } },
      { id: 'connection', inject: ['webRuntime'], config: {
        // Keep native attachment-envelope compatibility. The guarded HTTP/1
        // carrier enforces the smaller wire budget before invoking native handlers.
        trustedHosts: ['dsh.tail37b3d7.ts.net:8443']
      } }
    ] : []),
    { insert: [{ id: 'alex-research', name: join(root, 'plugins/research/index.mjs') }, { id: 'companion-session-controller', name: join(root, 'plugins/companion-workspace/session-controller.mjs') }, { id: 'companion-oauth', name: join(root, 'frontend/dsh-tui/lib/types/dsh-adapter/oauth/index.js'), inject: ['llm', 'commands'], config: { providers: ['openai-codex'] } }, { id: 'companion-private-link', name: join(root, 'tools/session-companion/connection.mjs') }, { id: 'companion-catalog-api', name: join(root, 'plugins/companion-api/index.mjs'), inject: ['typert', 'sessionPersistence'] }, { id: 'preset-companion', name: '@deepseek-ai/dsh-agent-preset', config: {
      id: 'companion', name: 'Companion', description: 'Leitura do PC; escrita no workspace pessoal; Bash e intervenções exigem aprovação.', order: 0,
      plugins: [
        // No persona row: the root system-prompt keeps identity/persona empty, and
        // capability guards belong to the tool, not to a companion-specific prompt.
        { id: 'companion-session', name: join(root, 'plugins/session/index.mjs'), config: { profile: 'companion' } },
        { id: 'companion-workspace', name: join(root, 'plugins/companion-workspace/index.mjs'), config: { profile: 'companion' } },
        // Web disables host skill discovery and loading. Keep both scoped here;
        // the shared root survives a child project's nearest .git boundary.
        { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem', config: { customSkillDirs: [join(COMPANION_WORKSPACE_ROOT, '.agents/skills')] } },
        { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },
        { id: 'companion-files', name: '@deepseek-ai/dsh-tool-fs' },
        { id: 'agent-instructions', name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65536, dshHome: join(homedir(), '.dsh/Companion') } },
        { id: 'companion-list', name: join(root, 'plugins/list/index.mjs') },
        { id: 'companion-bash', name: '@deepseek-ai/dsh-tool-bash', config: { enableRunInBackground: false, promoteOnTimeout: false } },
        { id: 'compaction', name: 'cordis:group', group: true, isolate: { compaction: true }, config: [{ id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' }] }
      ]
    } }] }
  ];
  return {
    'package.json': `${JSON.stringify({ name: 'dsh-profile-companion', private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], patchReload: 'live' } } }, null, 2)}\n`,
    'cordis.yml': '# Composition lives in the bundle and profile patches.\n[]\n',
    'cordis.patch.yml': '# Dedicated mobile companion; generated by tools/session-companion/profile.mjs.\n' + YAML.stringify(patch)
  };
}

export function serviceFile({ cliPath, nodePath = '/usr/bin/node', repoRoot }) {
  // A separate listener means the existing Web sessions and :443 route stay intact.
  for (const value of [cliPath, nodePath, repoRoot]) {
    if (typeof value !== 'string' || /[\n\r%"\\]/.test(value)) throw new Error('Unsafe systemd path');
  }
  return `[Unit]\nDescription=DSH Mobile session companion\nAfter=network.target\n\n[Service]\nType=simple\nWorkingDirectory=${repoRoot}\nExecStart="${nodePath}" "${cliPath}" --profile companion --port 3081 --no-open --trusted-host dsh.tail37b3d7.ts.net:8443\nRestart=on-failure\nRestartSec=5s\nTimeoutStopSec=15s\nEnvironment=PATH=/usr/local/bin:/usr/bin:/bin\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
}
