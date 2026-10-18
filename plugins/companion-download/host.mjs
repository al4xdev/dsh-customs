import { realpathSync } from 'node:fs';
import { isAbsolute, posix } from 'node:path';
import { sdk } from './sdk.mjs';
import { createSnapshotRegistry, MAX_BYTES, refuse } from './registry.mjs';
import { inlineForApproval, literalForApproval } from '../session/approval-text.mjs';
import { DSH_HOME } from '../session/host-paths.mjs';
import { createDownloadRoute } from './route.mjs';
import { pinFiber, fiberCurrent } from './lifetime.mjs';
import DownloadRedactedWebServer from './webserver.mjs';
const [{ Service, symbols }, { scopeOf, scopeChainOf }, { standingMountFor, livePresetMounts }] = await Promise.all([
  sdk('cordis'), sdk('dsh-scope'), sdk('dsh-agent-preset-registry'),
]);
const identity = value => value?.identity ?? value?.[symbols.original] ?? value;
export const PUBLIC_ORIGIN = process.env.DSH_COMPANION_ORIGIN ?? 'https://dsh.tail37b3d7.ts.net:8443';
export const name = 'companion-download-host';
export const inject = ['profileContext', 'connection', 'agents', 'agentPresets', 'approval', 'webServer', 'tools'];
const services = ['connection', 'agents', 'agentPresets', 'approval', 'webServer', 'tools'];
function safePath(path) {
  if (typeof path !== 'string' || !path.length || path.length > 4096 || /[\u0000-\u001f\u007f\\]/u.test(path) || /^[a-z][a-z\d+.-]*:/iu.test(path) || path.startsWith('//')) refuse('invalid-path');
}
// Every file below these directories is a credential store, key ring, private
// profile or browser profile (cookies, saved logins), wherever the home is.
const SENSITIVE_DIRECTORIES = [
  '.ssh', '.gnupg', '.dsh', '.aws', '.azure', '.kube', '.docker', '.claude', '.android', '.terraform.d', '.password-store', '.mozilla', '.thunderbird',
  '.config/gcloud', '.config/gh', '.config/hub', '.config/op', '.config/rclone', '.config/sops', '.config/mozilla', '.config/google-chrome', '.config/chromium',
  '.config/BraveSoftware', '.config/microsoft-edge', '.local/share/keyrings', '.local/share/kwalletd', '.gnome2/keyrings',
  'etc/ssl/private', 'etc/wireguard',
];
// The DSH home holds launch tokens, credentials and the bridge key even when
// DSH_HOME moves it away from ~/.dsh; refuse it by location, symlinks resolved.
const dshHomes = (() => { const homes = [DSH_HOME]; try { homes.push(realpathSync(DSH_HOME)); } catch { /* Not created yet. */ } return [...new Set(homes)]; })();
const sensitiveDirectory = new RegExp(`/(?:${SENSITIVE_DIRECTORIES.map(dir => dir.replace(/[.]/gu, '\\.')).join('|')})(?:/|$)`, 'u');
// Leaf names: dotenv, credential/secret/cookie files, CLI token files (netrc,
// git-credentials, npm/yarn/pypi), database passwords, shell/REPL histories,
// fish universal variables, private keys and key containers. Public keys and
// merely encrypted files stay shareable.
const sensitiveFile = new RegExp('(?:^|/)(?:' + [
  '\\.env(?:\\..*)?', '\\.?credentials?(?:\\.[^/]*)?', '\\.?secrets?(?:\\.[^/]*)?', 'cookies?(?:\\.[^/]*)?', '[^/]*service[-_]?account[^/]*',
  '[._]netrc', '\\.git-credentials', '\\.npmrc', '\\.yarnrc(?:\\.yml)?', '\\.pypirc', '\\.pgpass', '\\.my\\.cnf', '\\.vault-token', '\\.boto', '\\.s3cfg', '\\.htpasswd',
  '[^/]*_history', '\\.history', '\\.lesshst', '\\.viminfo', 'fish_variables', 'adbkey', 'id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?',
  'logins\\.json', 'key[34]\\.db', 'login data', 'ssh_host_[a-z0-9]+_key',
  '[^/]*\\.(?:pem|key|p12|pfx|kdbx|keychain(?:-db)?|jks|keystore|ppk|ovpn)',
].join('|') + ')$', 'iu');
/** Exported for tests. Consent cannot widen this policy, even if the read provider is broader. */
export function sensitivePath(path) {
  return /^\/(?:proc|sys|dev)(?:\/|$)/u.test(path) || /^\/etc\/g?shadow-?$/u.test(path) || sensitiveDirectory.test(path) || sensitiveFile.test(path) ||
    dshHomes.some(home => path === home || path.startsWith(`${home}/`));
}
/**
 * Same mount check for every verification. A transient acquireScope failure
 * refuses only THIS snapshot (its reservation is revoked by the caller); it no
 * longer closes the whole host. A different live mount is a real authority
 * change for this actor and still closes it.
 */
export async function verifyMountScope({ valid, presets, mount, closeHost }) {
  valid();
  let lease;
  try { lease = await presets.acquireScope('companion'); }
  catch { refuse('source-changed'); }
  try {
    valid();
    if (lease.key !== mount.key) { closeHost(); refuse('source-changed'); }
  } finally { await lease[Symbol.asyncDispose](); }
}
/** Exported for tests. The path is escaped (bidi/invisible names cannot disguise it) and bound by size and digest. */
export function approvalReason(canonical, size) {
  const path = literalForApproval(canonical);
  return [
    'file-share: Create one private browser download snapshot (maximum 20 MiB, expires 5 minutes after it is created) of the file below. This link can be used by anyone who receives it.',
    `File: ${inlineForApproval(canonical)}`,
    ...(path.hidden ? [`WARNING: the path contains ${path.hidden} invisible or control character(s), shown escaped (\\uXXXX).`] : []),
    `Path: ${path.bytes} bytes UTF-8, sha256 ${path.sha256}`,
    `Size: ${Number.isSafeInteger(size) ? `${size} bytes` : 'unknown'}`,
  ].join('\n');
}
export class CompanionFileDownloads extends Service {
  static inject = inject;
  constructor(ctx, config) {
    super(ctx, 'companionFileDownloads');
    const profile = ctx.get('profileContext');
    const profileDirectory = profile?.dir;
    if (profile?.name !== 'companion' || !isAbsolute(profile.dir ?? '') || config?.enabled !== true) refuse('profile-required');
    if (config.origin !== PUBLIC_ORIGIN) refuse('invalid-origin');
    // Configuration intent is not proof that the pre-buffer logging carrier won.
    if (!(identity(ctx.get('webServer')) instanceof DownloadRedactedWebServer)) refuse('redacted-carrier-required');
    const hostPin = pinFiber(ctx.fiber), rootPin = pinFiber(ctx.root.fiber);
    const captured = new Map(services.map(key => {
      const value = identity(ctx.get(key));
      return [key, { value, pin: pinFiber(value?.ctx?.fiber) }];
    }));
    const operator = ctx.get('connection').operator;
    const operatorPin = pinFiber(operator?.ctx?.fiber);
    const ready = ctx.get('appReady');
    if (typeof ready?.onReady !== 'function') refuse('ready-owner-required');
    let armed = false, closed = false, registry;
    const sourceCurrent = () => {
      try {
        return fiberCurrent(hostPin, ctx.fiber) && fiberCurrent(rootPin, ctx.root.fiber) &&
          ctx.get('profileContext') === profile && profile.name === 'companion' && profile.dir === profileDirectory && ctx.get('appReady') === ready &&
          fiberCurrent(operatorPin, operator.ctx.fiber) && operator.ctx.root.fiber === rootPin.fiber && ctx.get('connection')?.operator === operator &&
          services.every(key => {
            const row = captured.get(key), value = identity(ctx.get(key));
            return value === row.value && fiberCurrent(row.pin, value?.ctx?.fiber) && value.ctx.root.fiber === rootPin.fiber;
          });
      } catch { return false; }
    };
    const checkOwner = () => {
      if (closed || !sourceCurrent()) {
        closed = true; registry?.close(); refuse('source-changed');
      }
      if (!armed) refuse('not-ready');
    };
    registry = createSnapshotRegistry({ origin: config.origin, checkOwner });
    const pending = new Set();
    this.status = () => registry.status();
    this.close = async () => { closed = true; await registry.close(); await Promise.allSettled([...pending]); };
    const changes = ['loader/entry-init', 'loader/config-update', 'loader/partial-dispose', 'loader/volatile-update'];
    for (const event of changes) ctx.on(event, () => { if (armed) this.close(); });
    ctx.on('loader/patch-context', (_entry, next) => { if (armed) this.close(); return next(); });
    // No guessed startup timer: activation requires the existing explicit ready owner.
    ctx.effect(() => ready.onReady(() => {
      if (closed) return;
      if (!sourceCurrent()) { this.close(); return; }
      armed = true;
    }), 'file downloads startup fence');
    ctx.effect(() => ctx.get('webServer').register(createDownloadRoute(registry, { origin: config.origin })), 'opaque snapshot route');
    ctx.effect(() => () => this.close(), 'snapshot teardown');
    ctx.on('session/disposed', session => registry.revokeScope(session));
    const prepare = async (toolCtx, exec, path) => {
      checkOwner(); exec.signal.throwIfAborted(); safePath(path);
      const agent = exec.agent;
      const agents = ctx.get('agents'), presets = ctx.get('agentPresets');
      const fs = toolCtx.get('fs'), approval = ctx.get('approval');
      const mount = agent && standingMountFor(agent.ctx);
      const header = agent?.session?.header;
      const createdAt = header?.createdAt, workspace = header?.cwd;
      const ownScope = scopeOf(toolCtx);
      const agentPin = pinFiber(agent?.ctx?.fiber), mountPin = pinFiber(mount?.fiber), toolPin = pinFiber(toolCtx.fiber);
      const fsPin = pinFiber(identity(fs)?.ctx?.fiber);
      const valid = () => {
        checkOwner();
        if (!agent || !fiberCurrent(agentPin, agent.ctx.fiber) || !fiberCurrent(toolPin, toolCtx.fiber) || agent.ctx.root.fiber !== rootPin.fiber || agents.get(agent.id) !== agent || !agents.roots().includes(agent) ||
            agent.session.header !== header || header.createdAt !== createdAt || header.cwd !== workspace || agent.session.id !== agent.id || header.id !== agent.id || header.origin !== undefined || header.isSeeded !== false ||
            header.agentPreset !== 'companion' || presets.composedPreset(agent.ctx) !== 'companion' || !mount || !fiberCurrent(mountPin, mount.fiber) ||
            mount.presetId !== 'companion' || standingMountFor(agent.ctx)?.key !== mount.key || standingMountFor(agent.ctx)?.fiber !== mountPin.fiber || ownScope !== mount.key || scopeOf(toolCtx) !== ownScope ||
            !scopeChainOf(scopeOf(agent.ctx)).includes(mount.key) || !livePresetMounts(ctx.root.fiber).some(row => row.key === mount.key) ||
            identity(agent.ctx.get('fs')) !== identity(fs) || identity(toolCtx.get('fs')) !== identity(fs) || !fiberCurrent(fsPin, identity(fs)?.ctx?.fiber) ||
            identity(agent.ctx.get('approval')) !== identity(approval) || identity(toolCtx.get('companionFileDownloads')) !== identity(this)) refuse('actor-required');
      };
      const verify = () => verifyMountScope({ valid, presets, mount, closeHost: () => this.close() });
      valid();
      const reservation = registry.reserve(valid, verify, agent.session);
      const signal = AbortSignal.any([exec.signal, reservation.signal]);
      let bytes;
      try {
        await verify(); signal.throwIfAborted();
        const cwd = header.cwd;
        const entry = await fs.lstat(path, { cwd }, signal); valid(); signal.throwIfAborted();
        if (entry?.type !== 'file') refuse('regular-file-required');
        const target = await fs.resolve(path, { cwd, signal }); valid(); signal.throwIfAborted();
        const canonical = fs.processPath(target); safePath(canonical);
        const privateProfile = posix.resolve(profileDirectory);
        if (!isAbsolute(canonical) || sensitivePath(canonical) || canonical === privateProfile || canonical.startsWith(`${privateProfile}/`)) refuse('protected-file');
        const before = await fs.stat(target, signal); valid(); signal.throwIfAborted();
        if (before?.type !== 'file') refuse('regular-file-required');
        if (before.size !== undefined && (!Number.isSafeInteger(before.size) || before.size < 0 || before.size > MAX_BYTES)) refuse('too-large');
        await verify(); signal.throwIfAborted();
        // Scoped read access and exporting bytes are separate permissions. Always ask
        // the actual native one-shot approval service; model arguments cannot grant it.
        const outcome = await approval.request({ agent, toolName: 'download_file', callId: exec.callId, reason: approvalReason(canonical, before.size), signal });
        await verify(); signal.throwIfAborted();
        if (outcome !== 'allowed-once') refuse('consent-required');
        bytes = await fs.readBytes(target, signal, MAX_BYTES); valid(); signal.throwIfAborted();
        const after = await fs.stat(target, signal); valid(); signal.throwIfAborted();
        if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_BYTES) refuse('too-large');
        if (after?.type !== 'file' || after.version !== before.version || after.size !== before.size || before.size !== undefined && bytes.byteLength !== before.size) refuse('file-changed');
        toolCtx.emit('fs/observed', target, { kind: 'present', version: after.version }, exec);
        await verify(); signal.throwIfAborted();
        return reservation.commit(bytes, posix.basename(canonical));
      } catch (error) {
        if (bytes instanceof Uint8Array) bytes.fill(0);
        reservation.cancel();
        if (error?.code?.startsWith('companion-files/')) throw error;
        // Neither filesystem diagnostic paths nor provider/server bodies enter model output.
        refuse(signal.aborted ? 'cancelled' : error?.code === 'FS_TOO_LARGE' ? 'too-large' : 'read-refused');
      }
    };
    this.prepare = (...args) => {
      const work = prepare(...args); pending.add(work);
      return work.finally(() => pending.delete(work));
    };
  }
}
export function apply(ctx, config) { ctx.plugin(CompanionFileDownloads, config); }
