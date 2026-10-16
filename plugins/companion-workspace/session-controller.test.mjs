import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DSH_CLI_PACKAGE } from '../session/host-paths.mjs';
import {
  COMPANION_WORKSPACE_ROOT, CONTROLLER_INPUT_CODE, CONTROLLER_PROFILE_CODE,
  ControllerPolicyError, createCompanionSessionController,
} from './controller-policy.mjs';

function context(name = 'companion') {
  return { get: key => key === 'profileContext' ? { name } : undefined };
}

function fixture() {
  const registrations = [];
  const calls = [];
  const receipt = Object.freeze({ sessionId: 'fixture-new-session', agentPreset: 'companion' });
  const metadata = Symbol('fixture-native-metadata');
  class NativeBase {
    static inject = Object.freeze(['typert', 'agents', 'fs']);
    static Config = Object.freeze({ nativeOpen: 'fixture-schema' });
    static [metadata] = Object.freeze({ namespace: 'session' });
    constructor(...args) { registrations.push(args); }
    async create(request) { calls.push(request); return receipt; }
    page() { return 'fixture-inherited-history'; }
  }
  const Controller = createCompanionSessionController(NativeBase);
  return { registrations, calls, receipt, metadata, NativeBase, Controller };
}

function inputFailure(error) {
  assert.ok(error instanceof ControllerPolicyError);
  assert.equal(error.code, CONTROLLER_INPUT_CODE);
  assert.equal(error.message, 'Companion creation requires only agentPreset: companion.');
  assert.deepEqual(error.details, {});
  return true;
}

test('misplaced profile fails before native constructor registration', () => {
  const f = fixture();
  for (const ctx of [context('web'), context('dsh-tui'), {}, undefined, { get: () => undefined }]) {
    assert.throws(() => new f.Controller(ctx), error => {
      assert.equal(error.code, CONTROLLER_PROFILE_CODE);
      assert.equal(error.message, 'Companion workspace controller requires the companion profile.');
      assert.deepEqual(error.details, {});
      return true;
    });
  }
  assert.equal(f.registrations.length, 0);
});

test('native constructor arguments, static metadata and other methods remain inherited', () => {
  const f = fixture();
  const ctx = context();
  const config = Object.freeze({ nativeOpen: false });
  const internals = Object.freeze({ fixtureOnly: true });
  const cwdBefore = process.cwd();
  const instance = new f.Controller(ctx, config, internals);
  assert.deepEqual(f.registrations, [[ctx, config, internals]]);
  assert.equal(f.Controller.inject, f.NativeBase.inject);
  assert.equal(f.Controller.Config, f.NativeBase.Config);
  assert.equal(f.Controller[f.metadata], f.NativeBase[f.metadata]);
  assert.equal(Object.hasOwn(f.Controller, 'Config'), false);
  assert.equal(Object.hasOwn(f.Controller, 'inject'), false);
  assert.equal(instance.page, f.NativeBase.prototype.page);
  assert.equal(instance.page(), 'fixture-inherited-history');
  assert.equal(process.cwd(), cwdBefore);
});

test('native create receives one fresh fixed-root request and returns its unchanged receipt', async () => {
  const f = fixture();
  const instance = new f.Controller(context());
  const request = Object.freeze({ agentPreset: 'companion' });
  assert.equal(await instance.create(request), f.receipt);
  assert.deepEqual(f.calls, [{ agentPreset: 'companion', cwd: COMPANION_WORKSPACE_ROOT }]);
  assert.notEqual(f.calls[0], request);
  assert.deepEqual(request, { agentPreset: 'companion' });
  assert.equal(Object.hasOwn(f.calls[0], 'sessionId'), false);
  assert.equal(COMPANION_WORKSPACE_ROOT, join(homedir(), 'git/my/dsh-companion-workspace'));
});

test('untrusted native create options fail before delegate, mkdir or adoption', async () => {
  const f = fixture();
  const instance = new f.Controller(context());
  const cases = [undefined, null, false, 1, 'companion', [], {},
    { agentPreset: 'standard' }, { agentPreset: null },
    ...['cwd', 'workspaceId', 'sessionId', 'root', 'custommodel', 'config', '__proto__'].map(key => (
      Object.fromEntries([['agentPreset', 'companion'], [key, 'fixture-untrusted-value']])
    )),
    { agentPreset: 'companion', [Symbol('extra')]: true },
    Object.assign(Object.create({ inherited: true }), { agentPreset: 'companion' }),
    Object.create({ agentPreset: 'companion' }),
  ];
  for (const request of cases) await assert.rejects(instance.create(request), inputFailure);
  assert.equal(f.calls.length, 0);
});

test('accessor input is rejected without invoking its getter or native body', async () => {
  const f = fixture();
  let getterCalls = 0;
  const request = Object.defineProperty({}, 'agentPreset', {
    enumerable: true, get() { getterCalls++; return 'companion'; },
  });
  await assert.rejects(new f.Controller(context()).create(request), inputFailure);
  assert.equal(getterCalls, 0);
  assert.equal(f.calls.length, 0);
});

test('a plain null-prototype request still delegates with the fixed root', async () => {
  const f = fixture();
  const request = Object.assign(Object.create(null), { agentPreset: 'companion' });
  assert.equal(await new f.Controller(context()).create(request), f.receipt);
  assert.deepEqual(f.calls, [{ agentPreset: 'companion', cwd: COMPANION_WORKSPACE_ROOT }]);
});

test('native asynchronous failure semantics are not replaced by an alternate lifecycle', async () => {
  const nativeFailure = new Error('fixture native failure');
  let calls = 0;
  class NativeBase {
    async create() { calls++; throw nativeFailure; }
  }
  const Controller = createCompanionSessionController(NativeBase);
  await assert.rejects(new Controller(context()).create({ agentPreset: 'companion' }), error => error === nativeFailure);
  assert.equal(calls, 1);
});

test('public native Remote markers bind inherited methods to the overridden create on a fake receiver', async () => {
  // Only public metadata/error helpers load: no native SessionController, Cordis
  // service, filesystem provider, Agent, session, grant, model or gateway starts.
  const host = createRequire(DSH_CLI_PACKAGE);
  const { Remote, RemoteError, remoteMethods, remoteErrorOf } = await import(host.resolve('@deepseek-ai/dsh-typert-protocol'));
  const initializers = [];
  const calls = [];
  const receipt = Object.freeze({ sessionId: 'fixture-remote', agentPreset: 'companion' });
  class NativeMarkedBase {
    constructor() { for (const initialize of initializers) initialize.call(this); }
    async create(request) { calls.push(request); return receipt; }
    page() { return 'fixture-history'; }
  }
  for (const method of ['create', 'page']) {
    Remote(method)(NativeMarkedBase.prototype[method], {
      kind: 'method', name: method, private: false, static: false,
      addInitializer: initialize => initializers.push(initialize),
    });
  }
  const Controller = createCompanionSessionController(NativeMarkedBase, RemoteError);
  const instance = new Controller(context());
  const markers = remoteMethods(instance);
  assert.deepEqual(markers.map(marker => marker.method), ['create', 'page']);
  const marker = markers.find(marker => (marker.exportName ?? marker.method) === 'create');
  assert.deepEqual(marker.invocation, { kind: 'direct' });
  assert.equal(instance[marker.method], Controller.prototype.create);
  assert.equal(await instance[marker.method]({ agentPreset: 'companion' }), receipt);
  assert.deepEqual(calls, [{ agentPreset: 'companion', cwd: COMPANION_WORKSPACE_ROOT }]);
  await assert.rejects(instance[marker.method]({ agentPreset: 'companion', cwd: '/fixture-forbidden' }), error => {
    assert.ok(error instanceof RemoteError);
    const remote = remoteErrorOf(error);
    assert.equal(remote.code, CONTROLLER_INPUT_CODE);
    assert.equal(remote.message, 'Companion creation requires only agentPreset: companion.');
    assert.ok(!JSON.stringify(remote).includes('/fixture-forbidden'));
    return true;
  });
  assert.equal(calls.length, 1);
  assert.equal(instance.page(), 'fixture-history');
});
