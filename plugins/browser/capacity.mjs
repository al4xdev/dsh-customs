import { fail } from './errors.mjs';

const DEFAULTS = Object.freeze({ workers: 4, contexts: 8, ownerBytes: 2147483648 });
const KEYS = Object.keys(DEFAULTS);

function object(value, label) {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    fail('BROWSER_CONFIG_INVALID', `${label} must be a plain object.`);
  }
  return value;
}

function data(value, key, label) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
    fail('BROWSER_CONFIG_INVALID', `${label}.${key} must be an own data field.`);
  }
  return descriptor.value;
}

function positive(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail('BROWSER_CONFIG_INVALID', `${label} must be a positive safe integer.`);
  }
  return value;
}

/**
 * One registry per nativeBrowserBroker host lifetime, shared across its Agents.
 * Constructor limits are trusted administrative inputs, never model overrides;
 * optional overrides may only narrow the curated ceilings. Reserve immediately
 * before bootstrap/resolve/spawn, and release only after owned processes have
 * joined/closed (or cancellation before any process handles exist).
 *
 * Bytes reserve the prospective active owner's budget, not an OS filesystem
 * quota. Retained RAW archives and other DSH processes/global OS usage are not
 * covered; the parent must track retained bytes separately when needed.
 */
export class HostCapacity {
  #max;
  #reserved = { workers: 0, contexts: 0, ownerBytes: 0 };
  #tokens = new Map();

  constructor(trustedLimits = {}) {
    object(trustedLimits, 'Host capacity');
    const max = { ...DEFAULTS };
    for (const key of Reflect.ownKeys(trustedLimits)) {
      if (!KEYS.includes(key)) fail('BROWSER_CONFIG_INVALID', 'Unknown host capacity field.');
      const value = positive(data(trustedLimits, key, 'Host capacity'), `Host capacity.${key}`);
      if (value > DEFAULTS[key]) fail('BROWSER_CONFIG_INVALID', `Host capacity.${key} exceeds its curated ceiling.`);
      max[key] = value;
    }
    this.#max = Object.freeze(max);
  }

  reserve(config) {
    object(config, 'Browser config');
    const limits = object(data(config, 'limits', 'Browser config'), 'Browser config.limits');
    const requested = {
      workers: 1,
      contexts: positive(data(limits, 'sessions', 'Browser config.limits'), 'Browser config.limits.sessions'),
      ownerBytes: positive(data(limits, 'ownerBytes', 'Browser config.limits'), 'Browser config.limits.ownerBytes'),
    };
    // Check every dimension before changing any state; subtraction avoids overflow.
    for (const key of KEYS) {
      if (requested[key] > this.#max[key] - this.#reserved[key]) {
        fail('LIMIT_EXCEEDED', `Native browser host ${key} capacity is exhausted.`, { resource: key });
      }
    }
    const token = Object.freeze(Object.create(null));
    this.#tokens.set(token, requested);
    for (const key of KEYS) this.#reserved[key] += requested[key];
    return token;
  }

  release(token) {
    const reservation = this.#tokens.get(token);
    if (!reservation) return false;
    this.#tokens.delete(token);
    for (const key of KEYS) this.#reserved[key] -= reservation[key];
    return true;
  }

  snapshot() {
    return { defaults: { ...DEFAULTS }, max: { ...this.#max }, reserved: { ...this.#reserved } };
  }
}
