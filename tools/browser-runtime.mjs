#!/usr/bin/env node
import { constants } from 'node:fs';
import { access, lstat, readFile, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_CONFIG } from '../plugins/browser/config.mjs';

const checkout = dirname(dirname(fileURLToPath(import.meta.url)));
export const RUNTIME_DIRECTORY = join(checkout, 'plugins', 'browser', 'runtime');
export const PINS = Object.freeze({
  '@modelcontextprotocol/client': '2.3.1', '@modelcontextprotocol/server': '2.3.1',
  ajv: '8.17.1', playwright: '1.64.0', yaml: '2.9.1',
});
const engines = new Set(['chromium', 'firefox', 'webkit']);
const usage = 'node tools/browser-runtime.mjs [--doctor|--install] [--engine chromium|firefox|webkit]';
const runtimeRequire = createRequire(join(RUNTIME_DIRECTORY, 'package.json'));

export function parseArguments(argv) {
  let mode = 'doctor', explicitMode = false;
  const selected = [];
  if (argv.length === 1 && argv[0] === '--help') return { mode: 'help', engines: [] };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--doctor' || argument === '--install') {
      if (explicitMode) throw new Error('Select exactly one doctor/install mode.');
      mode = argument.slice(2); explicitMode = true;
    } else if (argument === '--engine') {
      const engine = argv[++index];
      if (!engines.has(engine) || selected.includes(engine)) throw new Error('Engine must be one unique curated name: chromium, firefox or webkit.');
      selected.push(engine);
    } else throw new Error('Unknown argument. No custom command, path, environment or launch flag is accepted.');
  }
  return { mode, engines: selected.length ? selected : ['chromium'] };
}

export function verifyManifest(document, lock) {
  const actual = document?.dependencies;
  const matched = actual && Object.keys(actual).length === Object.keys(PINS).length && Object.entries(PINS).every(([name, pin]) => actual[name] === pin);
  if (!matched || document.overrides || document.resolutions || document.devDependencies) throw new Error('Owned runtime manifest does not match the exact approved package pins.');
  if (!lock || lock.lockfileVersion !== 3 || !Object.entries(PINS).every(([name, pin]) => lock.packages?.['']?.dependencies?.[name] === pin && lock.packages?.[`node_modules/${name}`]?.version === pin) || lock.packages?.['node_modules/playwright-core']?.version !== PINS.playwright) {
    throw new Error('Owned runtime lock does not match the approved direct pins and Playwright core version.');
  }
}

async function metadata() {
  let manifest, lock;
  try {
    manifest = JSON.parse(await readFile(join(RUNTIME_DIRECTORY, 'package.json'), 'utf8'));
    lock = JSON.parse(await readFile(join(RUNTIME_DIRECTORY, 'package-lock.json'), 'utf8'));
  } catch { throw new Error('Owned runtime manifest/lock could not be read as JSON; no package or browser installation was started.'); }
  verifyManifest(manifest, lock);
  return manifest;
}
async function executable(path) {
  try { await access(path, constants.X_OK); return (await lstat(path)).isFile() || (await lstat(path)).isSymbolicLink(); }
  catch { return false; }
}
async function commandPath(name) {
  // Relative PATH entries would accidentally execute a target-project binary.
  for (const directory of (process.env.PATH ?? '').split(':').filter(isAbsolute)) {
    const candidate = join(directory, name);
    if (await executable(candidate)) return realpath(candidate);
  }
  return null;
}
function childEnvironment() {
  const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: DEFAULT_CONFIG.browserCache };
  delete env.NODE_OPTIONS;
  for (const key of Object.keys(env)) if (/^npm_config_/i.test(key)) delete env[key];
  return env;
}

/** Fixed argv only; timeout joins the owned process group, never a global browser/process kill. */
export function runBounded(command, args, { timeoutMs = 5000, cwd = RUNTIME_DIRECTORY } = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { cwd, env: childEnvironment(), shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', timedOut = false, cancelled = false, escalation;
    const stop = signal => {
      if (!Number.isSafeInteger(child.pid) || child.pid <= 0) return;
      try { if (process.platform === 'win32') child.kill(signal); else process.kill(-child.pid, signal); }
      catch (error) { if (error.code !== 'ESRCH') child.kill(signal); }
    };
    const requestStop = () => { stop('SIGTERM'); clearTimeout(escalation); escalation = setTimeout(() => stop('SIGKILL'), 2000); };
    const onInterrupt = () => { cancelled = true; requestStop(); };
    const timer = setTimeout(() => { timedOut = true; requestStop(); }, timeoutMs);
    process.once('SIGINT', onInterrupt); process.once('SIGTERM', onInterrupt);
    const cleanup = () => { clearTimeout(timer); clearTimeout(escalation); process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onInterrupt); };
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk.toString()).slice(-32768); });
    child.on('error', () => { cleanup(); reject(new Error('Required administrative executable could not start.')); });
    child.on('close', (code, signal) => {
      cleanup();
      if (cancelled || timedOut || code !== 0) reject(new Error(cancelled ? 'Administrative command was cancelled and its owned process group stopped.' : timedOut ? 'Administrative command exceeded its bounded deadline.' : `Administrative command failed (exit ${code ?? 'signal'}, signal ${signal ?? 'none'}).`));
      else resolveResult(output);
    });
  });
}

async function packageChecks() {
  return Promise.all(Object.entries({ ...PINS, 'playwright-core': PINS.playwright }).map(async ([name, expected]) => {
    try {
      const document = JSON.parse(await readFile(join(RUNTIME_DIRECTORY, 'node_modules', name, 'package.json'), 'utf8'));
      const installed = typeof document.version === 'string' && document.version.length <= 160 && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/.test(document.version) ? document.version : null;
      return { name, expected, installed, matched: document.name === name && installed === expected };
    } catch { return { name, expected, installed: null, matched: false }; }
  }));
}
async function managedEncoderCheck(packagesMatched) {
  if (!packagesMatched) return { available: false, path: null, reason: 'Pinned Playwright metadata is unavailable.' };
  try {
    // Read versioned installation metadata as data; never import Playwright registry internals.
    const metadata = JSON.parse(await readFile(join(RUNTIME_DIRECTORY, 'node_modules', 'playwright-core', 'browsers.json'), 'utf8'));
    const encoder = metadata.browsers.find(item => item.name === 'ffmpeg');
    if (!encoder || !/^\d+$/.test(String(encoder.revision))) throw new Error('Invalid encoder revision.');
    const filename = process.platform === 'linux' ? 'ffmpeg-linux' : process.platform === 'darwin' ? 'ffmpeg-mac' : 'ffmpeg-win64.exe';
    const path = join(DEFAULT_CONFIG.browserCache, `ffmpeg-${encoder.revision}`, filename);
    return { available: await executable(path), revision: String(encoder.revision), path };
  } catch { return { available: false, path: null, reason: 'Managed encoder metadata/file could not be verified.' }; }
}
async function mediaCheck(name) {
  const path = await commandPath(name);
  if (!path) return { available: false, path: null, version: null };
  try {
    const output = await runBounded(path, ['-version']);
    const firstLine = output.split(/\r?\n/)[0].replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 256);
    return { available: true, path, version: firstLine };
  } catch { return { available: false, path, version: null, reason: 'Version check failed or exceeded its deadline.' }; }
}

export async function doctor(selectedEngines = ['chromium']) {
  if (!selectedEngines.length || selectedEngines.some(engine => !engines.has(engine))) throw new Error('Doctor requires curated engine names.');
  const report = {
    mode: 'doctor', node: { version: process.version, supported: Number(process.versions.node.split('.')[0]) >= 20 },
    runtimeDirectory: RUNTIME_DIRECTORY, browserCache: DEFAULT_CONFIG.browserCache,
    manifestMatched: false, packages: [], browsers: [], mediaTools: {},
    noBrowserLaunched: true, profilesModified: false, targetProjectModified: false,
  };
  try { await metadata(); report.manifestMatched = true; }
  catch { report.reason = 'Runtime manifest/lock missing or mismatched; no install was attempted.'; }
  report.packages = await packageChecks();
  if (report.node.supported && report.manifestMatched && report.packages.every(item => item.matched)) {
    // This CLI process owns its cache selection. Do not consult project configuration or launch a browser.
    process.env.PLAYWRIGHT_BROWSERS_PATH = DEFAULT_CONFIG.browserCache;
    const library = await import(pathToFileURL(runtimeRequire.resolve('playwright')).href);
    const playwright = library.chromium ? library : library.default;
    for (const engine of selectedEngines) {
      const binaryPath = playwright[engine].executablePath();
      report.browsers.push({ engine, binaryPath, executableExists: await executable(binaryPath) });
    }
  } else report.browsers = selectedEngines.map(engine => ({ engine, binaryPath: null, executableExists: false }));
  report.mediaTools = { ffmpeg: await mediaCheck('ffmpeg'), ffprobe: await mediaCheck('ffprobe'), managedEncoder: await managedEncoderCheck(report.manifestMatched && report.packages.every(item => item.matched)) };
  const core = report.node.supported && report.manifestMatched && report.packages.every(item => item.matched) && report.browsers.every(item => item.executableExists);
  report.ready = { selectedEngines: core, videoRecording: core && report.mediaTools.managedEncoder.available, videoInspection: core && report.mediaTools.ffmpeg.available && report.mediaTools.ffprobe.available };
  report.ok = report.ready.videoRecording && report.ready.videoInspection;
  report.note = 'Metadata/version checks only; executable existence does not prove browser launch, sandbox, host policy, model admission or profile activation. Optional engines also need explicit administrative permission in allowedEngines.';
  return report;
}

export async function install(selectedEngines = ['chromium']) {
  if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('Node 20 or newer is required.');
  if (!selectedEngines.length || selectedEngines.some(engine => !engines.has(engine))) throw new Error('Installation requires curated engine names.');
  await metadata();
  const canonical = await realpath(RUNTIME_DIRECTORY);
  if (canonical !== RUNTIME_DIRECTORY) throw new Error('Refusing an owned runtime directory redirected by a symlink.');
  try { if ((await lstat(join(canonical, 'node_modules'))).isSymbolicLink()) throw new Error('Refusing npm ci against a symlinked node_modules.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!isAbsolute(DEFAULT_CONFIG.browserCache)) throw new Error('Administrative browser cache must be absolute.');
  const npm = await commandPath('npm');
  if (!npm) throw new Error('npm is required for explicit runtime provisioning.');
  // npm ci may replace only this verified, toolkit-owned nested node_modules directory.
  await runBounded(npm, ['--prefix', canonical, 'ci', '--ignore-scripts', '--no-audit', '--no-fund', '--engine-strict', '--workspaces=false'], { timeoutMs: 300000, cwd: canonical });
  const installed = await packageChecks();
  if (installed.some(item => !item.matched)) throw new Error('Installed runtime versions mismatch the approved pins; browser download was not started.');
  const packageFile = runtimeRequire.resolve('playwright/package.json');
  const cli = join(dirname(packageFile), 'cli.js');
  await runBounded(process.execPath, [cli, 'install', ...selectedEngines, 'ffmpeg'], { timeoutMs: 600000, cwd: canonical });
  const report = await doctor(selectedEngines);
  return { ...report, mode: 'install', wroteOnly: ['Owned nested runtime node_modules', 'Administrative browser/encoder cache'], installationDoesNotEnableEnginesOrActivateProfiles: true };
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    const result = options.mode === 'help' ? { usage, default: 'read-only doctor', install: 'Explicitly writes only toolkit-owned runtime/cache; no apt, dependency install in a target project, browser launch, skill or activation.' } : await (options.mode === 'install' ? install(options.engines) : doctor(options.engines));
    console.log(JSON.stringify(result, null, 2));
    if (result.ok === false) process.exitCode = 1;
  } catch (error) {
    console.log(JSON.stringify({ ok: false, code: 'BROWSER_RUNTIME_CHECK_FAILED', message: error.message, usage }, null, 2));
    process.exitCode = 1;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
