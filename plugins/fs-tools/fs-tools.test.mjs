import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apply, isImagePath, mergeRead, READ_DESCRIPTION } from './index.mjs';

const textDef = {
  name: 'read', description: 'stock', parameters: { type: 'object' },
  output: { schema: { type: 'object', properties: { lines: { type: 'array' } } }, render: (_a, v) => [{ type: 'text', text: `lines:${v.lines.length}` }], presentationMeta: () => ({ kind: 'text' }) },
  execute: async args => ({ path: args.file_path, offset: 1, lines: [{ number: 1, text: 'x' }], totalLines: 1 }),
  presentCall: () => ({ card: 'text-call' }),
  presentResult: () => ({ card: 'text-result' }),
};
const imageDef = {
  name: 'read_image',
  output: { schema: {}, render: (_a, v) => [{ type: 'text', text: v.path }, { type: 'image', attachment: v.image.attachmentId }], presentationMeta: (_a, v) => ({ path: v.path, kind: 'image' }) },
  execute: async args => ({ path: args.file_path, image: { attachmentId: 'att', mediaType: 'image/png', bytes: 1, width: 2, height: 3 }, seen: Object.keys(args) }),
  presentResult: () => ({ card: 'image-result' }),
};

test('image paths are recognised by extension, case-insensitively', () => {
  for (const path of ['a.png', 'b.JPG', 'c.jpeg', 'd.webp', 'e.gif']) assert.equal(isImagePath(path), true);
  for (const path of ['a.txt', 'png', 'a.png.txt', undefined]) assert.equal(isImagePath(path), false);
});

test('merged read dispatches text and images to the stock readers', async () => {
  const merged = mergeRead(textDef, () => imageDef);
  assert.equal(merged.name, 'read');
  assert.equal(merged.description, READ_DESCRIPTION);
  assert.equal(merged.output.schema.oneOf.length, 2);
  const text = await merged.execute({ file_path: 'a.txt', offset: 1 });
  assert.deepEqual(merged.output.render({ file_path: 'a.txt' }, text), [{ type: 'text', text: 'lines:1' }]);
  // Only file_path reaches the image reader, whose schema has no offset/limit.
  const image = await merged.execute({ file_path: 'shot.png', offset: 5, limit: 2 });
  assert.deepEqual(image.seen, ['file_path']);
  assert.equal(merged.output.render({ file_path: 'shot.png' }, image)[1].type, 'image');
  assert.deepEqual(merged.output.presentationMeta({ file_path: 'shot.png' }, image), { path: 'shot.png', kind: 'image' });
  assert.deepEqual(merged.presentResult({ file_path: 'shot.png' }, {}), { card: 'image-result' });
  assert.deepEqual(merged.presentResult({ file_path: 'a.txt' }, {}), { card: 'text-result' });
  assert.deepEqual(merged.presentCall({ file_path: 'a.txt' }), { card: 'text-call' });
});

test('without the attachments service an image read fails clearly and text still works', async () => {
  const merged = mergeRead(textDef, () => undefined);
  await assert.rejects(merged.execute({ file_path: 'shot.png' }), /no attachment service is mounted/);
  assert.equal((await merged.execute({ file_path: 'a.txt' })).lines.length, 1);
});

test('the stock plugin, run through the adapter, exposes read/write/edit only and drops the read/edit prose', () => {
  const registered = [], sections = [], effects = [];
  const fakeTools = { register(def) { registered.push(def); return () => {}; }, get: () => undefined };
  const base = {
    tools: fakeTools,
    systemPrompt: { section(s) { sections.push(s.name); return () => {}; }, getSectionOrder: () => 0 },
    fs: {},
    get: () => undefined,
    on: () => () => {}, emit() {}, waterfall: async () => undefined,
    effect(fn) { effects.push(fn); return () => {}; },
    // The attachments-gated callback runs at once, in a child scope, as cordis does on mount.
    inject(_deps, callback) { callback(base); return () => {}; },
  };
  apply(base, { readLimit: 2000, readMaxLineLength: 2000, readMaxBytes: 51200, readStreamMinSize: 1048576 });
  assert.deepEqual(registered.map(d => d.name).sort(), ['edit', 'read', 'write']);
  assert.equal(registered.find(d => d.name === 'read').description, READ_DESCRIPTION);
  assert.ok(!sections.includes('tool:read') && !sections.includes('tool:edit'));
  assert.ok(sections.includes('tool:write'));
});
