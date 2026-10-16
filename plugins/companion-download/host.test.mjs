import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { approvalReason, sensitivePath, verifyMountScope } from './host.mjs';
import { DSH_HOME } from '../session/host-paths.mjs';

test('sensitivePath denies credential stores, CLI tokens, keyrings, histories and key containers anywhere', () => {
  const home = '/home/someone';
  for (const path of [
    '/proc/self/environ', '/sys/kernel/x', '/dev/sda', `${home}/.ssh/id_ed25519`, `${home}/.gnupg/private-keys-v1.d/a.key`, `${home}/.dsh/session-companion/grant.key`,
    `${home}/.aws/credentials`, `${home}/.azure/msal_token_cache.json`, `${home}/.claude/.credentials.json`, `${home}/.claude/projects/x/y.jsonl`,
    `${home}/.netrc`, `${home}/_netrc`, `${home}/.git-credentials`, `${home}/.npmrc`, `${home}/.yarnrc.yml`, `${home}/.pypirc`, `${home}/.pgpass`, `${home}/.my.cnf`,
    `${home}/.config/gcloud/application_default_credentials.json`, `${home}/.config/gcloud/configurations/config_default`, `${home}/.config/gh/hosts.yml`,
    `${home}/.docker/config.json`, `${home}/.kube/config`, `${home}/.vault-token`, `${home}/.bash_history`, `${home}/.zsh_history`, `${home}/.python_history`,
    `${home}/.local/share/fish/fish_history`, `${home}/.config/fish/fish_variables`, `${home}/.local/share/keyrings/login.keyring`, `${home}/.password-store/x.gpg`,
    `${home}/.mozilla/firefox/p/logins.json`, `${home}/.config/google-chrome/Default/Login Data`, `${home}/.android/adbkey`,
    `${home}/backup/id_rsa`, `${home}/certs/client.p12`, `${home}/certs/CLIENT.PFX`, `${home}/vault.kdbx`, `${home}/release.jks`, `${home}/app.keystore`, `${home}/putty.ppk`,
    '/etc/shadow', '/etc/gshadow-', '/etc/ssl/private/site.key', '/etc/wireguard/wg0.conf', '/etc/ssh/ssh_host_ed25519_key', `${home}/.thunderbird/p/key4.db`,
    `${home}/.config/sops/age/keys.txt`, `${home}/.config/microsoft-edge/Default/Login Data`, `${home}/vpn/office.ovpn`, `${home}/snap/firefox/common/.mozilla/firefox/x/logins.json`,
    DSH_HOME, `${DSH_HOME}/session-companion/connection.json`,
    `${home}/server.pem`, `${home}/tls.key`, `${home}/project/.env`, `${home}/project/.env.local`, `${home}/project/secrets.yaml`, `${home}/project/my-service-account.json`, `${home}/Cookies`,
  ]) assert.equal(sensitivePath(path), true, path);
  for (const path of [`${home}/doc.txt`, `${home}/id_rsa.pub`, `${home}/notes/key-points.md`, `${home}/photo.jpg`, `${home}/.config/other/settings.json`,
    `${home}/.dockerignore`, `${home}/project/environment.md`, `${home}/history/notes.txt`, `${home}/backup.tar.gpg`, `${home}/project/shadow`, '/etc/ssh/ssh_host_ed25519_key.pub', `${DSH_HOME}-other/x`]) assert.equal(sensitivePath(path), false, path);
});

test('download approval escapes the path and binds it by size and digest', () => {
  const plain = approvalReason('/home/someone/relatório.pdf', 1234);
  assert.match(plain, /^file-share: /);
  assert.ok(plain.includes('File: /home/someone/relatório.pdf'));
  assert.ok(plain.includes(`Path: ${Buffer.byteLength('/home/someone/relatório.pdf')} bytes UTF-8, sha256 ${createHash('sha256').update('/home/someone/relatório.pdf').digest('hex')}`));
  assert.ok(plain.includes('Size: 1234 bytes')); assert.ok(!plain.includes('WARNING'));
  const spoofed = approvalReason('/home/someone/invoice\u202Efdp.exe', undefined);
  assert.ok(!spoofed.includes('\u202E')); assert.ok(spoofed.includes('invoice\\u202efdp.exe'));
  assert.match(spoofed, /WARNING: the path contains 1 invisible/); assert.ok(spoofed.includes('Size: unknown'));
});

test('a transient scope failure refuses only this snapshot; a different mount closes the host', async () => {
  let closed = 0, disposed = 0;
  const mount = { key: 'mount-a' };
  const lease = key => ({ key, async [Symbol.asyncDispose]() { disposed++; } });
  const base = { valid: () => {}, mount, closeHost: () => { closed++; } };
  await verifyMountScope({ ...base, presets: { acquireScope: async () => lease('mount-a') } });
  assert.equal(disposed, 1);
  await assert.rejects(verifyMountScope({ ...base, presets: { acquireScope: async () => { throw new Error('busy'); } } }), { code: 'companion-files/source-changed' });
  assert.equal(closed, 0, 'host stays available after a transient failure');
  await assert.rejects(verifyMountScope({ ...base, presets: { acquireScope: async () => lease('mount-b') } }), { code: 'companion-files/source-changed' });
  assert.equal(closed, 1); assert.equal(disposed, 2);
  await assert.rejects(verifyMountScope({ ...base, valid: () => { throw Object.assign(new Error('actor'), { code: 'companion-files/actor-required' }); }, presets: { acquireScope: async () => lease('mount-a') } }), { code: 'companion-files/actor-required' });
  assert.equal(disposed, 2, 'no scope acquired for a stale actor');
});
