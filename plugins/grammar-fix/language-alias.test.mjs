import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSystemPrompt, languageLabel } from './prompt.mjs';

test('custom language labels never resolve inherited object properties', () => {
  for (const language of ['__proto__', 'constructor', 'hasOwnProperty', 'toString']) {
    assert.equal(languageLabel(language), language);
    assert.ok(buildSystemPrompt(language).includes(`Write the corrected text in ${language}.`));
  }
});

test('own language aliases retain normalization and friendly labels', () => {
  assert.equal(languageLabel(' PT-BR '), 'Brazilian Portuguese (pt-BR)');
  assert.equal(languageLabel('EN'), 'English');
  assert.equal(languageLabel(' auto '), 'Auto (keep original language)');
  assert.equal(languageLabel(' Custom language '), 'Custom language');
});
