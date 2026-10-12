import assert from 'node:assert/strict';
import { apply, bridgeKey } from '../../plugins/grammar-fix/index.mjs';

const requests = [];
const ctx = {
  llm: {
    async resolveModelInfo(provider, model) {
      requests.push({ kind: 'resolve', provider, model });
      return { reasoning: false };
    },
    async *stream(options) {
      requests.push({ kind: 'stream', provider: options.provider, model: options.model, system: options.system });
      yield { type: 'text-delta', text: 'Corrected draft.' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  },
  effect(register) { this.dispose = register(); },
};

apply(ctx, { model: 'budget-provider/cheap-model', language: 'Brazilian Portuguese (pt-BR)' });
const bridge = globalThis[bridgeKey];
assert.equal(await bridge.fix('draft', { provider: 'premium-provider', model: 'expensive-model' }), 'Corrected draft.');
assert.deepEqual(requests.map(({ kind, provider, model }) => ({ kind, provider, model })), [
  { kind: 'resolve', provider: 'budget-provider', model: 'cheap-model' },
  { kind: 'stream', provider: 'budget-provider', model: 'cheap-model' },
]);
assert.match(requests[1].system, /Write the corrected text in Brazilian Portuguese \(pt-BR\)/);
ctx.dispose();
assert.equal(globalThis[bridgeKey], undefined);

requests.length = 0;
apply(ctx);
assert.equal(await globalThis[bridgeKey].fix('draft', { provider: 'session-provider', model: 'session-model' }), 'Corrected draft.');
assert.deepEqual(requests.map(({ kind, provider, model }) => ({ kind, provider, model })), [
  { kind: 'resolve', provider: 'session-provider', model: 'session-model' },
  { kind: 'stream', provider: 'session-provider', model: 'session-model' },
]);
assert.match(requests[1].system, /Preserve the original language of the text/);
ctx.dispose();
assert.equal(globalThis[bridgeKey], undefined);

assert.throws(() => apply({ ...ctx, effect() {} }, { model: 'not-a-provider-model' }), /provider\/model/);
assert.throws(() => apply({ ...ctx, effect() {} }, { language: 'two\nlines' }), /language must be/);
console.log('PASS: grammar-fix honors configured model/language, defaults to session model/original language, and rejects malformed config.');
