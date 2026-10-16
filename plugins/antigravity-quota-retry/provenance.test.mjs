import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { resolveHost } from '../common.mjs';

// A changed host engine must be reviewed, not silently mistaken for our baseline.
test('fork equals pinned official source plus the allowlisted quota delta', async () => {
  const source = await readFile(resolveHost('@deepseek-ai/dsh-llm-retry'), 'utf8');
  assert.equal(createHash('sha256').update(source).digest('hex'), 'cbb99f1c5038e4a9167aedf333343cb3e3adfb5c9f45a37ef7562b024429d050');
  const fork = await readFile(new URL('./index.mjs', import.meta.url), 'utf8');
  function replace(text, before, after) {
    assert.equal(text.split(before).length, 2, 'expected one exact upstream delta context');
    return text.replace(before, after);
  }
  let expected = replace(source,
    'import z from "@deepseek-ai/schemastery";\nimport { z as z$1 } from "zod";',
    'import { resolveHost } from "../common.mjs";\nconst { default: z } = await import(resolveHost("@deepseek-ai/schemastery"));\nconst { z: z$1 } = await import(resolveHost("zod"));');
  expected = replace(expected,
    '/** Runtime schema for {@link Config}. */\nconst Config = z.object({});\nfunction validateConfig(config) {\n\tconst [key] = Object.keys(config);\n\tif (key === void 0) return;\n\tif (key === "retryPolicy") throw new Error("llm-retry: retryPolicy belongs under each provider configuration");\n\tthrow new Error(`llm-retry: unknown key "${key}"`);\n}',
    '// Provider opt-in is the stable policy\'s gate code, not a dynamic policy swap.\nconst QUOTA_CODE = "ANTIGRAVITY_QUOTA_RESET";\nconst MAX_QUOTA_WAIT_MS = 86400000;\n/** Runtime schema for the local executor\'s quota-only ceiling. */\nconst Config = z.object({\n\tmaxQuotaWaitMs: z.number().min(1).max(MAX_QUOTA_WAIT_MS).default(MAX_QUOTA_WAIT_MS)\n});\nfunction validateConfig(config) {\n\tfor (const key of Object.keys(config)) {\n\t\tif (key === "maxQuotaWaitMs") continue;\n\t\tif (key === "retryPolicy") throw new Error("llm-retry: retryPolicy belongs under each provider configuration");\n\t\tthrow new Error(`llm-retry: unknown key "${key}"`);\n\t}\n\tconst maxQuotaWaitMs = config.maxQuotaWaitMs === undefined ? MAX_QUOTA_WAIT_MS : config.maxQuotaWaitMs;\n\tif (!Number.isFinite(maxQuotaWaitMs) || maxQuotaWaitMs <= 0 || maxQuotaWaitMs > MAX_QUOTA_WAIT_MS) {\n\t\tthrow new Error("llm-retry: maxQuotaWaitMs must be positive, finite, and no greater than 86400000");\n\t}\n\treturn maxQuotaWaitMs;\n}');
  expected = replace(expected, '\tvalidateConfig(config);', '\tconst maxQuotaWaitMs = validateConfig(config);');
  expected = replace(expected,
    '\t\tconst policyKey = retryPolicyKey(policy);',
    '\t\t// The provider emits this code only after a fresh exact-model quota decision.\n\t\t// Keep the policy/key fixed so quota and transient retries share one budget.\n\t\tconst quotaReset = policy.mode === "normal" && provider === "google-antigravity" && failure.code === QUOTA_CODE;\n\t\tif (quotaReset && (!Number.isFinite(failure.providerRetryAfterMs) || failure.providerRetryAfterMs <= 0 || failure.providerRetryAfterMs > maxQuotaWaitMs)) return;\n\t\tconst policyKey = retryPolicyKey(policy);');
  expected = replace(expected,
    '\t\tif (failure.providerRetryAfterMs !== void 0 && Number.isFinite(failure.providerRetryAfterMs) && failure.providerRetryAfterMs > 0) if (failure.providerRetryAfterMs > policy.maxDelayMs) {',
    '\t\tif (quotaReset) delayMs = failure.providerRetryAfterMs;\n\t\telse if (failure.providerRetryAfterMs !== void 0 && Number.isFinite(failure.providerRetryAfterMs) && failure.providerRetryAfterMs > 0) if (failure.providerRetryAfterMs > policy.maxDelayMs) {');
  assert.equal(fork, expected);
});
