import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { YAML } from '../session-companion/profile.mjs';
import { ProfileMigrationError, RESILIENCE_PROFILES, migrateResilienceProfile } from './profile.mjs';

const root = '/verified/repo';
const modulePath = suffix => `${root}/plugins/${suffix}`;
const migrate = (source, profile = 'dsh-tui') => migrateResilienceProfile(source, { repoRoot: root, profile });
const parse = source => { const doc = YAML.parseDocument(source); assert.deepEqual(doc.errors, []); return doc.toJS(); };
const plugins = source => parse(source).flatMap(row => row.insert ?? []);
const find = (source, id) => plugins(source).find(row => row.id === id);
const normal = `        mode: normal
        maxRetries: 9
        backoff:
          initialDelayMs: 5000
          maxDelayMs: 1200000
          jitterRatio: 0.1
`;
const unrelated = `# owner session bridge drift must stay EXACT
    - id: alex-session-bridge
      name: /owner/dirty/session/bridge.mjs # unrelated pointer
      config: { ownerField: 'preserve spacing' }
    - id: alex-other-tool
      name: /owner/tools/keep.mjs
`;
const permissions = `# original permissions + model config, including nonstandard JS tag
- id: agent-default-model
  config: { provider: strata-local, model: "server-discovers-it", maxTokens: 8192 }
- id: sandbox-policy
  config:
    mode: danger-full-access
    workspaceRoot: !!js process.cwd()
`;
const canonical = `# canonical fixture, not a live profile
${permissions}# auth wrapper baseline
- id: dsh-tui-auth
  config:
    retryPolicies:
      openai-codex:
${normal}# keep native disabled
- id: llm-retry
  disabled: true
# owned legacy engine
- insert:
    - id: antigravity-quota-retry
      name: ${modulePath('antigravity-quota-retry/index.mjs')}
      config:
        maxQuotaWaitMs: 86400000
# preserve AGY OAuth/web/quota options
- id: llm-pi-ai-antigravity
  config:
    webSearch: true # keep this comment
    searchModel: gemini-3.8-flash-low
    quotaResetRetry:
      enabled: true
      maxWaitMs: 86400000
    retryPolicy:
${normal.replace(/^  /gm, '')}# owned plugin pointers only
- insert:
    - id: alex-codex-transient-close
      name: ${modulePath('codex-transient-close/index.mjs')}
    - id: alex-agent-self-heal
      name: ${modulePath('agent-self-heal/lib/index-v2-persistence.mjs')}
      config:
        maxCycles: 3
${unrelated}`;

function assertRefuses(source, code) {
  assert.throws(() => migrate(source), error => error instanceof ProfileMigrationError && (!code || error.code === code));
}

test('canonical targeted migration removes known baselines/fork and upgrades exactly one global engine', () => {
  const result = migrate(canonical);
  assert.equal(result.changed, true); assert.equal(result.requiresCompatValidation, true);
  assert.equal(Object.isFrozen(result), true); assert.equal(Object.isFrozen(result.changes), true);
  assert.ok(result.changes.every(Object.isFrozen));
  assert.ok(result.candidate.includes(permissions)); assert.ok(result.candidate.includes(unrelated));
  assert.ok(result.candidate.includes(`    webSearch: true # keep this comment\n    searchModel: gemini-3.8-flash-low\n    quotaResetRetry:\n      enabled: true\n      maxWaitMs: 86400000\n`));
  const rows = parse(result.candidate), inserts = plugins(result.candidate);
  assert.equal(rows.find(row => row.id === 'llm-retry').disabled, true);
  assert.equal(rows.some(row => row.id === 'dsh-tui-auth'), false);
  assert.equal(rows.find(row => row.id === 'llm-pi-ai-antigravity').config.retryPolicy, undefined);
  assert.equal(inserts.filter(row => row.id === 'alex-llm-resilience').length, 1);
  assert.equal(inserts.some(row => row.id === 'antigravity-quota-retry'), false);
  assert.deepEqual(find(result.candidate, 'alex-llm-resilience').config, {});
  assert.equal(find(result.candidate, 'alex-codex-transient-close').name, modulePath('codex-transient-close/index.mjs'));
  assert.equal(find(result.candidate, 'alex-llm-resilience').name, modulePath('llm-resilience/lib/index-v5-unified.mjs'));
  assert.equal(find(result.candidate, 'alex-agent-self-heal').name, modulePath('agent-self-heal/lib/index-v6-unified.mjs'));
  assert.deepEqual(find(result.candidate, 'alex-agent-self-heal').config, { maxCycles: 3 });
});

test('candidate/hash/edit receipt is deterministic, source-recoverable and idempotent', () => {
  const result = migrate(canonical);
  assert.deepEqual(migrate(canonical), result);
  assert.equal(result.sourceSha256, createHash('sha256').update(canonical).digest('hex'));
  assert.equal(result.candidateSha256, createHash('sha256').update(result.candidate).digest('hex'));
  let candidate = '', cursor = 0;
  for (const change of result.changes) { candidate += canonical.slice(cursor, change.start) + change.replacement; cursor = change.end; }
  assert.equal(candidate + canonical.slice(cursor), result.candidate);
  const again = migrate(result.candidate);
  assert.equal(again.changed, false); assert.equal(again.candidate, result.candidate); assert.deepEqual(again.changes, []);
});

test('all five maintained profiles get universal defaults with compatibility explicitly unproven', () => {
  for (const profile of RESILIENCE_PROFILES) {
    const result = migrate(`# ${profile}, no managed entries\n${permissions}`, profile);
    assert.equal(result.profile, profile); assert.equal(result.requiresCompatValidation, true);
    assert.equal(result.candidate.startsWith(`# ${profile}, no managed entries\n${permissions}`), true);
    for (const id of ['alex-llm-resilience', 'alex-codex-transient-close', 'alex-agent-self-heal']) assert.equal(plugins(result.candidate).filter(row => row.id === id).length, 1);
    assert.deepEqual(find(result.candidate, 'alex-llm-resilience').config, {});
    assert.equal(migrate(result.candidate, profile).changed, false);
  }
});

for (const source of ['', '# empty owner patch\n', '# flow empty patch\n[]\n']) test(`empty patch is supported without host or filesystem access: ${JSON.stringify(source)}`, () => {
  const result = migrate(source, 'companion');
  assert.equal(parse(result.candidate).find(row => row.id === 'llm-retry').disabled, true);
  assert.equal(plugins(result.candidate).length, 3);
  assert.equal(migrate(result.candidate, 'companion').changed, false);
});

test('explicit normal optout remains registered and becomes an explicit central sparse exception', () => {
  const source = `# preserve the deliberate adapter optout
- id: dsh-tui-auth
  config:
    providers: [openai-codex] # OAuth untouched
    retryPolicies:
      openai-codex:
        mode: normal
        maxRetries: 0 # optout forever
`;
  const result = migrate(source);
  assert.ok(result.candidate.startsWith(source));
  assert.deepEqual(find(result.candidate, 'alex-llm-resilience').config, { providers: { 'openai-codex': { maxRetries: 0 } } });
  assert.equal(migrate(result.candidate).changed, false);
});

test('explicit normal fields map without filling native defaults or comparing equal resolved defaults', () => {
  const source = `- id: dsh-tui-auth
  config:
    retryPolicies:
      other-explicit-route:
        mode: normal
        maxRetries: 2
        retryableCodes: [SERVER, TRANSPORT]
        backoff:
          initialDelayMs: 5000 # explicit, equal central value is still provenance
- id: llm-pi-ai-antigravity
  config:
    webSearch: true
    retryPolicy:
      mode: normal
      maxRetries: 0
      retryableCodes: [ANTIGRAVITY_QUOTA_RESET, SERVER]
`;
  const result = migrate(source);
  assert.ok(result.candidate.startsWith(source), 'custom registered policies stay intact');
  assert.deepEqual(find(result.candidate, 'alex-llm-resilience').config.providers, {
    'other-explicit-route': { maxRetries: 2, initialDelayMs: 5000, retryableCodes: ['SERVER', 'TRANSPORT'] },
    'google-antigravity': { maxRetries: 0, retryableCodes: ['SERVER'] },
  });
  assert.equal(migrate(result.candidate).changed, false);
});

test('only two named exact source baselines are removed; other explicit equal policies retain provenance', () => {
  const source = `- id: dsh-tui-auth
  config:
    retryPolicies:
      explicit-other:
${normal}      openai-codex:
${normal}    providers: [openai-codex] # preserve auth sibling
`;
  const result = migrate(source), auth = parse(result.candidate).find(row => row.id === 'dsh-tui-auth');
  assert.equal(auth.config.retryPolicies['openai-codex'], undefined);
  assert.equal(auth.config.retryPolicies['explicit-other'].maxRetries, 9);
  assert.deepEqual(find(result.candidate, 'alex-llm-resilience').config.providers['explicit-other'], { maxRetries: 9, initialDelayMs: 5000, maxDelayMs: 1200000, jitterRatio: .1 });
  assert.ok(result.candidate.includes('    providers: [openai-codex] # preserve auth sibling\n'));
});

test('custom normal baseline-plus-explicit-codes is not misidentified as managed baseline', () => {
  const source = `- id: dsh-tui-auth
  config:
    retryPolicies:
      openai-codex:
${normal}        retryableCodes: [SERVER]
`;
  const result = migrate(source);
  assert.ok(result.candidate.startsWith(source));
  assert.deepEqual(find(result.candidate, 'alex-llm-resilience').config.providers['openai-codex'].retryableCodes, ['SERVER']);
});

for (const cap of [0, 1, 2, 3, 4, 10]) test(`explicit local self-heal cap ${cap} stays local without broadening global defaults`, () => {
  const source = `- insert:
    - id: alex-agent-self-heal
      name: ${modulePath('agent-self-heal/lib/index-v2-persistence.mjs')} # pointer comment
      config: { maxCycles: ${cap} } # cap comment
`;
  const result = migrate(source);
  assert.deepEqual(find(result.candidate, 'alex-agent-self-heal').config, { maxCycles: cap });
  assert.ok(result.candidate.includes(`config: { maxCycles: ${cap} } # cap comment`));
  assert.ok(result.candidate.includes(' # pointer comment'));
  assert.deepEqual(find(result.candidate, 'alex-llm-resilience').config, {});
});

test('owned entry drift and foreign pointers are refused rather than overwritten', () => {
  for (const [id, module] of [['alex-llm-resilience', 'llm-resilience/index.mjs'], ['alex-codex-transient-close', 'codex-transient-close/index.mjs'], ['alex-agent-self-heal', 'agent-self-heal/lib/index-v2-persistence.mjs'], ['antigravity-quota-retry', 'antigravity-quota-retry/index.mjs']]) {
    assertRefuses(`- insert:\n    - id: ${id}\n      name: /foreign/plugins/${module}\n`, 'foreign-owned-module');
    assertRefuses(`- insert:\n    - id: ${id}\n      name: ${modulePath(module)}\n      inject: [foreign]\n`, 'unsupported-explicit-field');
  }
  assertRefuses(`- insert:\n    - id: alex-agent-self-heal\n      name: ${modulePath('agent-self-heal/index.mjs')}\n`, 'foreign-owned-module');
});

test('custom always, unknown codes, unmapped providers and custom quota cap fail for review', () => {
  assertRefuses('- id: dsh-tui-auth\n  config:\n    retryPolicies:\n      openai-codex: { mode: always }\n', 'unsupported-explicit-mode');
  assertRefuses('- id: dsh-tui-auth\n  config:\n    retryPolicies:\n      openai-codex: { mode: normal, retryableCodes: [UNKNOWN_CODE] }\n', 'unsupported-explicit-codes');
  assertRefuses('- id: llm-custom-unknown\n  config:\n    retryPolicy: { mode: normal, maxRetries: 2 }\n', 'unmapped-provider-policy');
  assertRefuses(`- insert:\n    - id: antigravity-quota-retry\n      name: ${modulePath('antigravity-quota-retry/index.mjs')}\n      config: { maxQuotaWaitMs: 5000 }\n`, 'custom-quota-cap-needs-review');
});

test('existing central exception merges are sparse; conflicting authority is refused', () => {
  const source = `- id: dsh-tui-auth
  config:
    retryPolicies:
      explicit: { mode: normal, maxRetries: 2, backoff: { jitterRatio: 0 } }
      another: { mode: normal, maxRetries: 0 }
- insert:
    - id: alex-llm-resilience
      name: ${modulePath('llm-resilience/index.mjs')}
      config:
        auxiliary: { maxChunks: 42 } # controller config kept
        providers:
          explicit:
            maxRetries: 2 # existing field untouched
`;
  const result = migrate(source), config = find(result.candidate, 'alex-llm-resilience').config;
  assert.deepEqual(config.providers, { explicit: { maxRetries: 2, jitterRatio: 0 }, another: { maxRetries: 0 } });
  assert.equal(config.auxiliary.maxChunks, 42);
  assert.ok(result.candidate.includes('maxRetries: 2 # existing field untouched'));
  assert.ok(result.candidate.includes('auxiliary: { maxChunks: 42 } # controller config kept'));
  assert.equal(migrate(result.candidate).changed, false);
  assertRefuses(source.replace('maxRetries: 2 # existing', 'maxRetries: 4 # existing'), 'conflicting-central-provider-policy');
});

test('sparse caps are validated against the explicit existing central base, not native defaults', () => {
  const source = `- id: dsh-tui-auth\n  config:\n    retryPolicies:\n      local: { mode: normal, backoff: { maxDelayMs: 500 } }\n- insert:\n    - id: alex-llm-resilience\n      name: ${modulePath('llm-resilience/index.mjs')}\n      config:\n        policy: { initialDelayMs: 100, maxDelayMs: 1000 }\n`;
  const result = migrate(source), config = find(result.candidate, 'alex-llm-resilience').config;
  assert.deepEqual(config.policy, { initialDelayMs: 100, maxDelayMs: 1000 });
  assert.deepEqual(config.providers.local, { maxDelayMs: 500 });
  assert.equal(migrate(result.candidate).changed, false);
});

test('flow owned config appends preserve preexisting source bytes', () => {
  const source = `- id: dsh-tui-auth
  config:
    retryPolicies:
      local: { mode: normal, maxRetries: 0 }
- insert:
    - id: alex-llm-resilience
      name: ${modulePath('llm-resilience/index.mjs')}
      config: { auxiliary: { maxChunks: 10 } } # original inline config
`;
  const result = migrate(source);
  assert.deepEqual(find(result.candidate, 'alex-llm-resilience').config.providers, { local: { maxRetries: 0 } });
  assert.ok(result.candidate.includes('auxiliary: { maxChunks: 10 }'));
  assert.ok(result.candidate.includes(' # original inline config'));
  assert.equal(migrate(result.candidate).changed, false);
});

test('native false is toggled minimally and missing disabled field is appended safely', () => {
  const source = '- id: llm-retry\n  disabled: false # keep diagnostic\n# unrelated comment\n- id: other\n  config: { x: 1 }\n';
  const result = migrate(source);
  assert.ok(result.candidate.startsWith(source.replace('disabled: false', 'disabled: true')));
  const missing = migrate('- id: llm-retry\n# following comment\n- id: other\n  config: true\n');
  assert.equal(parse(missing.candidate)[0].disabled, true);
  assert.ok(missing.candidate.includes('# following comment\n- id: other\n  config: true\n'));
});

test('fork removal among unrelated entries leaves their complete original bytes unchanged', () => {
  const before = `- insert:
    - id: first
      name: /owner/first.mjs
# the legacy fork follows
    - id: antigravity-quota-retry
      name: ${modulePath('antigravity-quota-retry/index.mjs')}
# keep the next entry comment
${unrelated}`;
  const result = migrate(before);
  assert.ok(result.candidate.includes('    - id: first\n      name: /owner/first.mjs\n'));
  assert.ok(result.candidate.includes(`# keep the next entry comment\n${unrelated}`));
  assert.equal(plugins(result.candidate).some(row => row.id === 'antigravity-quota-retry'), false);
});

test('CRLF and trailing-no-newline profiles retain original bytes outside edits', () => {
  for (const source of [canonical.replaceAll('\n', '\r\n'), '- id: other\n  config: { untouched: true }']) {
    const result = migrate(source);
    parse(result.candidate);
    assert.equal(migrate(result.candidate).changed, false);
    if (source.includes('\r\n')) assert.equal(/(?<!\r)\n/.test(result.candidate), false);
    else assert.ok(result.candidate.startsWith(source));
  }
});

test('prototype-shaped provider IDs and Unicode source offsets never lose explicit exceptions', () => {
  const source = `# João 🐋 — preserve UTF-8 bytes, receipt offsets use JS UTF-16\n- id: dsh-tui-auth\n  config:\n    retryPolicies:\n      __proto__: { mode: normal, maxRetries: 0 }\n      constructor: { mode: normal, maxRetries: 2 }\n`;
  const result = migrate(source);
  assert.equal(result.offsetEncoding, 'utf16'); assert.ok(result.candidate.startsWith(source));
  const providers = find(result.candidate, 'alex-llm-resilience').config.providers;
  assert.deepEqual(Object.keys(providers).sort(), ['__proto__', 'constructor']);
  assert.equal(providers.__proto__.maxRetries, 0); assert.equal(providers.constructor.maxRetries, 2);
  assert.equal(migrate(result.candidate).changed, false);
});

test('mode-only explicit normal policies do not manufacture per-provider defaults', () => {
  const source = '- id: dsh-tui-auth\n  config:\n    retryPolicies:\n      future-route: { mode: normal }\n';
  const result = migrate(source);
  assert.ok(result.candidate.startsWith(source));
  assert.deepEqual(find(result.candidate, 'alex-llm-resilience').config, {});
});

test('renamed bridges/self-heal and nested or inserted native engines require review', () => {
  for (const module of ['codex-transient-close/index.mjs', 'agent-self-heal/lib/index-v2-persistence.mjs', 'agent-self-heal/lib/index-v3-resilience.mjs']) assertRefuses(`- insert:\n    - id: renamed-owned-plugin\n      name: ${modulePath(module)}\n`, 'foreign-owned-plugin-id');
  assertRefuses('- insert:\n    - id: llm-retry\n      name: "@deepseek-ai/dsh-llm-retry"\n', 'inserted-native-engine-needs-review');
  assertRefuses('- insert:\n    - id: preset\n      config:\n        plugins:\n          - id: llm-retry\n            name: "@deepseek-ai/dsh-llm-retry"\n', 'nested-owned-plugin');
});

test('tagged/anchored owned config and deliberately disabled owned plugins refuse', () => {
  assertRefuses('- id: dsh-tui-auth\n  config:\n    retryPolicies:\n      local: &owner { mode: normal, maxRetries: 0 }\n', 'expected-literal-map');
  assertRefuses(`- insert:\n    - id: alex-agent-self-heal\n      name: ${modulePath('agent-self-heal/lib/index-v2-persistence.mjs')}\n      disabled: true\n`, 'owned-plugin-disabled');
  assertRefuses(`- insert:\n    - id: alex-llm-resilience\n      name: ${modulePath('llm-resilience/index.mjs')}\n      config: { selfHeal: { maxCycles: 11 } }\n`, 'unsupported-self-heal-cap');
});

test('duplicates, malformed YAML, nested-owned entries and unsupported profile names refuse', () => {
  assertRefuses('- id: llm-retry\n  disabled: true\n- id: llm-retry\n  disabled: true\n', 'duplicate-owned-id');
  assertRefuses('- config: [\n', 'invalid-yaml');
  assertRefuses(`- insert:\n    - id: preset\n      config:\n        plugins:\n          - id: alex-llm-resilience\n            name: ${modulePath('llm-resilience/index.mjs')}\n`, 'nested-owned-plugin');
  assertRefuses(`- insert:\n    - id: renamed-controller\n      name: ${modulePath('llm-resilience/index.mjs')}\n`, 'foreign-retry-engine-id');
  assert.throws(() => migrateResilienceProfile('[]\n', { repoRoot: root, profile: 'old-npx' }), error => error.code === 'unsupported-profile');
  assert.throws(() => migrateResilienceProfile('[]\n', { repoRoot: '.', profile: 'dsh-tui' }), TypeError);
});

test('current controller source plus immutable v3 upgrade only owned pointers and preserve explicit opt-down source', () => {
  const policy = '      config: { policy: { maxRetries: 2 }, providers: { custom-route: { maxRetries: 0 } }, selfHeal: { maxCycles: 3 } } # deliberate\n';
  const source = permissions + `- id: llm-retry
  disabled: true
- insert:
    - id: alex-llm-resilience
      name: ${modulePath('llm-resilience/index.mjs')}
${policy}    - id: alex-codex-transient-close
      name: ${modulePath('codex-transient-close/index.mjs')}
    - id: alex-agent-self-heal
      name: ${modulePath('agent-self-heal/lib/index-v3-resilience.mjs')}
      config: { maxCycles: 3 } # no new credits
`;
  const result = migrate(source);
  assert.equal(result.recoveryVersion, 2); assert.equal(result.changes.length, 2);
  assert(result.candidate.includes(policy)); assert(result.candidate.includes(permissions));
  assert(result.candidate.includes('config: { maxCycles: 3 } # no new credits'));
  assert.equal(find(result.candidate, 'alex-llm-resilience').name, modulePath('llm-resilience/lib/index-v5-unified.mjs'));
  assert.equal(migrate(result.candidate).changed, false);
});

test('canonical file URL ownership upgrades without accepting query/hash aliases', () => {
  const source = `- insert:\n    - id: alex-llm-resilience\n      name: file://${modulePath('llm-resilience/index.mjs')}\n    - id: alex-agent-self-heal\n      name: file://${modulePath('agent-self-heal/lib/index-v3-resilience.mjs')}\n`;
  const result = migrate(source); assert.equal(migrate(result.candidate).changed, false);
  assertRefuses(source.replace('index.mjs\n', 'index.mjs?duplicate\n'), 'foreign-owned-module');
});

test('unified code allowlist remains sparse and unknown explicit caps cannot bypass the new hard ceilings', () => {
  const source = '- id: dsh-tui-auth\n  config:\n    retryPolicies:\n      custom: { mode: normal, maxRetries: 2, retryableCodes: [SERVER, PI_AI_ERROR, INVALID_REQUEST] }\n';
  assert.deepEqual(find(migrate(source).candidate, 'alex-llm-resilience').config.providers.custom.retryableCodes, ['SERVER', 'PI_AI_ERROR', 'INVALID_REQUEST']);
  for (const policy of ['maxRetries: 11', 'maxDelayMs: 86400000']) assertRefuses(`- insert:\n    - id: alex-llm-resilience\n      name: ${modulePath('llm-resilience/index.mjs')}\n      config: { policy: { ${policy} } }\n`, 'invalid-central-config');
  assertRefuses(`- insert:\n    - id: alex-llm-resilience\n      name: ${modulePath('llm-resilience/index.mjs')}\n      config: { selfHeal: { initialDelayMs: 5000 } }\n`, 'invalid-central-config');
});

for (const [controller, owner] of [[2, 4], [3, 5], [4, 6]]) test(`historical candidate ${controller}/${owner} pointers upgrade without changing explicit caps`, () => {
  const source = `- insert:\n    - id: alex-llm-resilience\n      name: ${modulePath(`llm-resilience/lib/index-v${controller}-unified.mjs`)}\n      config: { policy: { maxRetries: 2 } }\n    - id: alex-agent-self-heal\n      name: ${modulePath(`agent-self-heal/lib/index-v${owner}-unified.mjs`)}\n      config: { maxCycles: 3 }\n`;
  const result = migrate(source);
  assert.equal(find(result.candidate, 'alex-llm-resilience').name, modulePath('llm-resilience/lib/index-v5-unified.mjs'));
  assert.equal(find(result.candidate, 'alex-agent-self-heal').name, modulePath('agent-self-heal/lib/index-v6-unified.mjs'));
  assert.equal(find(result.candidate, 'alex-llm-resilience').config.policy.maxRetries, 2);
  assert.equal(find(result.candidate, 'alex-agent-self-heal').config.maxCycles, 3);
  assert.equal(migrate(result.candidate).changed, false);
});

for (const prefix of ['', 'file://']) test(`controller4 input ${prefix || 'absolute'} upgrades only its literal pointer with current owner6`, () => {
  const before = permissions + `- id: llm-retry\n  disabled: true\n- insert:\n    - id: alex-llm-resilience\n      name: ${prefix}${modulePath('llm-resilience/lib/index-v4-unified.mjs')} # retained comment\n      config: { policy: { retryableCodes: [] }, auxiliary: { replaySafePurposes: [] } }\n    - id: alex-codex-transient-close\n      name: ${modulePath('codex-transient-close/index.mjs')}\n    - id: alex-agent-self-heal\n      name: ${modulePath('agent-self-heal/lib/index-v6-unified.mjs')}\n      config: {}\n`;
  const result = migrate(before);
  assert.equal(result.changes.length, 1);
  assert.equal(result.candidate, before.replace(`${prefix}${modulePath('llm-resilience/lib/index-v4-unified.mjs')}`, modulePath('llm-resilience/lib/index-v5-unified.mjs')));
  assert.equal(migrate(result.candidate).changed, false);
  assertRefuses(before.replace('index-v4-unified.mjs', 'index-v4-unified.mjs?alias'), 'foreign-owned-module');
  assertRefuses(before.replace('id: alex-llm-resilience', 'id: renamed-controller'), 'foreign-retry-engine-id');
});
