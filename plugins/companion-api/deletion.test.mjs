import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveHost } from '../common.mjs';
import { createDeletion, deletionCodecs } from './deletion.mjs';
const [{ Context }, { default: Backend }, sessions] = await Promise.all([
  import(resolveHost('@deepseek-ai/cordis')), import(resolveHost('@deepseek-ai/dsh-session-persistence-jsonl')), import(resolveHost('@deepseek-ai/dsh-session')),
]);
const signal = () => new AbortController().signal;
const command = (id, createdAt = 1) => ({ id, createdAt, confirmation: 'delete-companion-chat' });
const code = value => error => error.code === `companion/${value}`;
async function fixture(t) {
  await mkdir('.dumps/session-tests', { recursive: true });
  const dir = await mkdtemp(join(process.cwd(), '.dumps/session-tests/delete-'));
  const root = join(dir, 'sessions');
  const trashRoot = join(dir, 'trash');
  const ctx = new Context(); t.after(() => ctx.fiber.dispose());
  await ctx.plugin(Backend, { root, compression: 'none' });
  async function create(id, agentPreset = 'companion') {
    const handle = await ctx.sessionPersistence.create({ version: sessions.SESSION_FORMAT_VERSION, id: sessions.SessionId(id), cwd: dir, agentPreset, createdAt: 1, isSeeded: false });
    await handle.flush();
    return handle;
  }
  return { ctx, root, trashRoot, create, remove: createDeletion(ctx.sessionPersistence, { trashRoot }) };
}

test('actual native JSONL: live writer prevents removal; closed synthetic chat moves out of corpus recoverably', async t => {
  const f = await fixture(t);
  const handle = await f.create('owned-fixture');
  await assert.rejects(f.remove(command('owned-fixture'), signal()), code('delete-busy'));
  assert.ok(await f.ctx.sessionPersistence.stat(sessions.SessionId('owned-fixture')));
  await handle.close();
  const result = await f.remove(command('owned-fixture'), signal());
  assert.deepEqual(result, { profile: 'companion', id: 'owned-fixture', deleted: true, recoverable: true });
  assert.equal(await f.ctx.sessionPersistence.stat(sessions.SessionId('owned-fixture')), undefined);
  assert.equal((await f.ctx.sessionPersistence.list()).length, 0);
  const archived = await readdir(f.trashRoot);
  assert.equal(archived.length, 1);
  assert.ok((await stat(join(f.trashRoot, archived[0]))).isDirectory());
  const members = await readdir(join(f.trashRoot, archived[0]));
  assert.ok(members.includes('session.lock'));
  assert.ok(members.length > 1);
  await assert.rejects(f.remove(command('owned-fixture'), signal()), code('foreign-session'));
});

test('actual native JSONL: foreign preset and stale creation identity never move a directory', async t => {
  const f = await fixture(t);
  const foreign = await f.create('foreign-fixture', 'ordinary'); await foreign.close();
  const owned = await f.create('owned-fixture'); await owned.close();
  await assert.rejects(f.remove(command('foreign-fixture'), signal()), code('foreign-session'));
  await assert.rejects(f.remove(command('owned-fixture', 2), signal()), code('foreign-session'));
  assert.equal((await f.ctx.sessionPersistence.list()).length, 2);
});

test('request rejects paths, missing confirmation and accessor objects before capabilities are read', async () => {
  const source = new Proxy({}, { get: () => assert.fail('unvalidated capability access') });
  const remove = createDeletion(source);
  for (const input of [{ id: '../outside', createdAt: 1, confirmation: 'delete-companion-chat' }, { id: 'chat', createdAt: 1 }, { ...command('chat'), path: '/outside' }, Object.defineProperty({}, 'id', { get: () => assert.fail('accessor evaluated') })]) {
    await assert.rejects(remove(input, signal()));
  }
});

test('unsupported persistence and aborted request fail before any filesystem operation', async () => {
  await assert.rejects(createDeletion({ name: 'memory' })(command('chat'), signal()), code('delete-unsupported'));
  const abort = new AbortController(); abort.abort();
  await assert.rejects(createDeletion({})(command('chat'), abort.signal));
});

test('trash cannot be inside the real session corpus', async t => {
  const f = await fixture(t);
  const handle = await f.create('owned-fixture'); await handle.close();
  await assert.rejects(createDeletion(f.ctx.sessionPersistence, { trashRoot: join(f.root, 'trash') })(command('owned-fixture'), signal()), code('delete-unavailable'));
  assert.ok(await f.ctx.sessionPersistence.stat(sessions.SessionId('owned-fixture')));
});

test('strict response requires matching delete semantics and no filesystem path disclosure', () => {
  const parse = deletionCodecs.output.create().parse;
  assert.deepEqual(parse({ profile: 'companion', id: 'chat', deleted: true, recoverable: true }), { profile: 'companion', id: 'chat', deleted: true, recoverable: true });
  for (const input of [{ profile: 'companion', id: 'chat', deleted: false, recoverable: true }, { profile: 'companion', id: 'chat', deleted: true, recoverable: true, path: '/private' }]) assert.throws(() => parse(input));
});
