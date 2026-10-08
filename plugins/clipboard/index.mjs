import { readdir, lstat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { defineTool, stringOutput, assertActive } from '../common.mjs';
export const name = 'alex-clipboard';
export const inject = ['tools'];
export async function clipboardEnvironment(env = process.env) {
  const runtime = env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`;
  if (env.WAYLAND_DISPLAY) return { ...env, XDG_RUNTIME_DIR: runtime };
  let entries;
  try { entries = await readdir(runtime); } catch (error) {
    throw new Error(`Cannot read Wayland runtime directory ${runtime} (${error.code ?? error.message})${env.XDG_RUNTIME_DIR ? '' : '; XDG_RUNTIME_DIR is not set'}. Set XDG_RUNTIME_DIR (or WAYLAND_DISPLAY) for the DSH process to the desktop session.`);
  }
  const sockets = [];
  for (const entry of entries.sort()) {
    if (entry.startsWith('wayland-') && !entry.endsWith('.lock') && (await lstat(join(runtime, entry)).catch(() => null))?.isSocket()) sockets.push(entry);
  }
  if (sockets.length === 0) throw new Error(`No Wayland display socket found in ${runtime}; start a Wayland session or set WAYLAND_DISPLAY.`);
  if (sockets.length > 1) throw new Error(`Found ${sockets.length} Wayland displays in ${runtime} (${sockets.join(', ')}); set WAYLAND_DISPLAY to choose one.`);
  return { ...env, XDG_RUNTIME_DIR: runtime, WAYLAND_DISPLAY: sockets[0] };
}
export async function copyText(text, signal, { env, timeoutMs = 5000 } = {}) {
  signal?.throwIfAborted();
  const childEnv = await clipboardEnvironment(env);
  signal?.throwIfAborted();
  await new Promise((resolve, reject) => {
    // wl-copy forks its clipboard server itself; do not request --foreground.
    const child = spawn('wl-copy', text === '' ? ['--clear'] : ['--type', 'text/plain;charset=utf-8'], { env: childEnv, stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '', done = false;
    const finish = (error) => {
      if (done) return;
      done = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); child.stderr?.destroy();
      if (error) reject(error); else resolve();
    };
    const stop = (error) => {
      child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 1000).unref();
      finish(error);
    };
    const onAbort = () => stop(signal.reason);
    const timer = setTimeout(() => stop(new Error(`Clipboard copy timed out after ${timeoutMs} ms; wl-copy was stopped.`)), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2048); });
    child.stdin.on('error', () => {});
    child.on('error', error => finish(new Error(error.code === 'ENOENT' ? 'wl-copy was not found on PATH; install wl-clipboard.' : `Could not start wl-copy: ${error.message}`)));
    // A forked process may retain stderr even on failure: settle on exit, not stream close.
    const onExit = (code, sig) => finish(code === 0 ? undefined : new Error(`Clipboard copy failed: wl-copy ${code === null ? `was killed by ${sig}` : `exited with code ${code}`}${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
    child.on('exit', onExit);
    child.on('close', onExit);
    child.stdin.end(text);
  });
  return text === '' ? 'Clipboard cleared.' : 'Text copied to clipboard.';
}
export function apply(ctx) {
  ctx.tools.register(defineTool({ name: 'clipboard_copy', description: 'Copy text verbatim to the local clipboard. Empty text clears it.',
    parameters: { text: { type: 'string', required: true, description: 'Text to copy, preserving Unicode and newlines.' } },
    output: stringOutput, async execute({ text }, exec) { assertActive(exec); return copyText(text, exec.signal); } }));
}
