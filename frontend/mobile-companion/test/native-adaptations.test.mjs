import assert from 'node:assert/strict';
import test from 'node:test';
import { adaptNativeChat } from '../server/native-adaptations.mjs';

const footer = 'onBranch: () => {\n\t\t\t\t\t\tforkAt(data.seq);\n\t\t\t\t\t},';

test('pinned presentation adaptation removes only the native fork footer callback', () => {
  const original = `nativeRendererBefore();\n${footer}\nnativeComposerAfter();`;
  assert.equal(adaptNativeChat(original), 'nativeRendererBefore();\nonBranch: void 0,\nnativeComposerAfter();');
  assert.equal(original.includes(footer), true);
});

test('changed or duplicated native callback fails closed instead of guessing renderer structure', () => {
  assert.throws(() => adaptNativeChat('newRendererWithoutKnownCallback();'), /Unsupported native chat footer/);
  assert.throws(() => adaptNativeChat(`${footer}\n${footer}`), /Unsupported native chat footer/);
});
