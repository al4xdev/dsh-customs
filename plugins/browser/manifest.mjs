import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { API_VERSION } from './protocol.mjs';
import { DEFAULT_CONFIG } from './config.mjs';
import { fail } from './errors.mjs';

const string = (maxLength = 4096, extra = {}) => ({ type: 'string', maxLength, ...extra });
const integer = (minimum = 1, maximum = 300000) => ({ type: 'integer', minimum, maximum });
const number = (minimum = 0, maximum = 8192) => ({ type: 'number', minimum, maximum });
const boolean = { type: 'boolean' };
const enumeration = values => ({ type: 'string', enum: values });
const array = (items, maxItems = 256) => ({ type: 'array', items, maxItems });
const object = (properties = {}, required = [], extra = {}) => ({ type: 'object', properties, required, additionalProperties: false, ...extra });
const data = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: true });
const id = string(160, { minLength: 1 });
// Curated from the pinned public Playwright getByRole declaration, not a private engine map.
export const SUPPORTED_ROLES = Object.freeze('alert alertdialog application article banner blockquote button caption cell checkbox code columnheader combobox complementary contentinfo definition deletion dialog directory document emphasis feed figure form generic grid gridcell group heading img insertion link list listbox listitem log main marquee math meter menu menubar menuitem menuitemcheckbox menuitemradio navigation none note option paragraph presentation progressbar radio radiogroup region row rowgroup rowheader scrollbar search searchbox separator slider spinbutton status strong subscript superscript switch tab table tablist tabpanel term textbox time timer toolbar tooltip tree treegrid treeitem'.split(' '));
const timeout = integer(1, 300000);
const empty = object();
export const TARGET_SCHEMA = {
  oneOf: [
    object({ kind: { const: 'ref' }, snapshotId: id, ref: id }, ['kind', 'snapshotId', 'ref']),
    object({ kind: { const: 'role' }, role: enumeration(SUPPORTED_ROLES), name: string(4096), exact: boolean }, ['kind', 'role', 'name']),
    object({ kind: { const: 'testId' }, value: string(4096, { minLength: 1 }) }, ['kind', 'value']),
    object({ kind: { const: 'css' }, value: string(4096, { minLength: 1 }) }, ['kind', 'value']),
  ],
};
const point = object({ x: number(), y: number() }, ['x', 'y']);
const size = object({ width: integer(1, 8192), height: integer(1, 8192) }, ['width', 'height']);
const clip = object({ x: number(), y: number(), width: number(0.01, 8192), height: number(0.01, 12000) }, ['x', 'y', 'width', 'height']);
const ready = object({ target: TARGET_SCHEMA, fonts: boolean, images: boolean, timeoutMs: timeout });
const customEmulation = object({
  viewport: size, screen: size, deviceScaleFactor: number(0.1, 8), isMobile: boolean, hasTouch: boolean,
  userAgent: string(2048, { minLength: 1 }), locale: string(64, { minLength: 1 }), timezoneId: string(128, { minLength: 1 }),
  colorScheme: enumeration(['light', 'dark', 'no-preference']), reducedMotion: enumeration(['reduce', 'no-preference']),
}, ['viewport', 'deviceScaleFactor', 'isMobile', 'hasTouch', 'userAgent']);
const emulation = {
  oneOf: [
    object({ device: string(128, { minLength: 1 }), orientation: enumeration(['portrait', 'landscape']) }, ['device']),
    customEmulation,
  ],
};
const sessionArgs = object({ engine: enumeration(['chromium', 'firefox', 'webkit']), headless: boolean, emulation, downloads: boolean });
const sessionData = data({ sessionId: id, generation: integer(), state: string(64), settings: data() }, ['sessionId', 'state']);
const captureData = data({ captureId: id, state: string(64), scope: enumeration(['page', 'context']) }, ['captureId', 'state']);
const targetArgs = extra => object({ target: TARGET_SCHEMA, frameId: id, timeoutMs: timeout, ...extra }, ['target']);
const entriesData = data({ entries: array(data(), 1000), cursor: string(2048), truncated: boolean }, ['entries']);
const capturedStop = object({ captureId: id, inspectFrames: boolean }, ['captureId']);
const paging = { limit: integer(1, 1000), cursor: string(2048), query: string(128) };
function freeze(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
const descriptors = [];
function add(operation, description, inputSchema = empty, outputSchema = data(), options = {}) {
  const branch = operation.includes('.') ? operation.split('.')[0] : 'catalog';
  descriptors.push({
    operation, description, inputSchema, outputSchema,
    effects: options.effects ?? ['observe-page'], defaults: options.defaults ?? {},
    requiresSession: options.requiresSession ?? true, usesPage: options.usesPage ?? false,
    availability: options.availability ?? 'verified', adapter: options.adapter ?? branch,
    sensitive: options.sensitive ?? false, engines: options.engines ?? ['chromium', 'firefox', 'webkit'],
    ...options,
  });
}

add('help', 'List only the immediate catalog children; discover schemas with describe.', object({ query: string(128), limit: integer(1, 30), cursor: string(2048), availability: enumeration(['all', 'verified', 'disabled', 'unsupported']) }), data({ path: string(160), items: array(data(), 30), hasMore: boolean, cursor: string(2048), catalogRevision: string(80) }, ['path', 'items', 'hasMore', 'catalogRevision']), { defaults: { limit: 12, availability: 'all' }, effects: ['discovery'], requiresSession: false });
add('describe', 'Return the exact schema, effects and limits for one operation.', empty, data({ operation: string(160), inputSchema: data(), outputSchema: data(), defaults: data(), effects: array(string(64)), availability: string(32), catalogRevision: string(80) }, ['operation', 'inputSchema', 'outputSchema', 'defaults', 'effects', 'availability', 'catalogRevision']), { effects: ['discovery'], requiresSession: false });
add('capabilities', 'Report local declarations, runtime readiness and current policy without launching a browser.', empty, data(), { effects: ['discovery'], requiresSession: false });

add('session.open', 'Create an isolated owned context, with a real device preset or complete custom mobile identity.', sessionArgs, sessionData, { defaults: { engine: 'chromium', headless: true, downloads: false }, effects: ['write-managed-artifact'], requiresSession: false });
add('session.list', 'List only this Agent’s owned sessions.', empty, data({ sessions: array(data(), 16) }, ['sessions']), { requiresSession: false, effects: ['discovery'] });
add('session.status', 'Inspect an owned session generation and lifecycle state.', empty, sessionData, { effects: ['discovery'] });
add('session.close', 'Close only owned resources; preserve finalized artifacts according to retention.', empty, sessionData, { effects: ['write-managed-artifact'] });
add('session.replace', 'Explicitly replace context identity; invalidate old page/frame/snapshot handles.', object({ ...sessionArgs.properties, finalizeFirst: boolean }), sessionData, { defaults: { engine: 'chromium', headless: true, downloads: false, finalizeFirst: false }, effects: ['write-managed-artifact'] });

add('page.list', 'List stable owned Page ids, never mutable tab indices.', empty, data({ pages: array(data(), 64) }, ['pages']));
add('page.create', 'Create an owned Page with an explicit authorized URL or about:blank.', object({ url: string(8192, { pattern: '^(https?://|about:blank$)' }) }), data({ pageId: id }, ['pageId']), { defaults: { url: 'about:blank' }, effects: ['write-managed-artifact', 'navigate-network'] });
add('page.close', 'Close the concrete owned Page, never a current-tab fallback.', empty, data({ pageId: id, state: string(64) }, ['pageId']), { usesPage: true, effects: ['mutate-page'] });
add('page.navigate', 'Navigate the concrete Page to an authorized HTTP(S) URL.', object({ url: string(8192, { pattern: '^(https?://|about:blank$)' }), waitUntil: enumeration(['commit', 'domcontentloaded', 'load', 'networkidle']), timeoutMs: timeout }, ['url']), data({ url: string(8192) }, ['url']), { defaults: { waitUntil: 'domcontentloaded' }, usesPage: true, effects: ['navigate-network'] });
for (const operation of ['back', 'forward', 'reload']) add(`page.${operation}`, `${operation} on the concrete Page; report the resulting URL.`, object({ waitUntil: enumeration(['commit', 'domcontentloaded', 'load', 'networkidle']), timeoutMs: timeout }), data({ url: string(8192) }, ['url']), { defaults: { waitUntil: 'domcontentloaded' }, usesPage: true, effects: ['navigate-network'] });
add('page.wait', 'Wait for a bounded target state, exact text or page readiness; no unbounded sleep.', object({ target: TARGET_SCHEMA, text: string(4096), state: enumeration(['attached', 'detached', 'visible', 'hidden']), timeoutMs: timeout, fonts: boolean, images: boolean }, [], { anyOf: [{ required: ['target'] }, { required: ['text'] }, { properties: { fonts: { const: true } }, required: ['fonts'] }, { properties: { images: { const: true } }, required: ['images'] }] }), data(), { defaults: { state: 'visible' }, usesPage: true });
add('page.frames', 'List frame ids bound to this Page/document generation.', empty, data({ frames: array(data(), 256) }, ['frames']), { usesPage: true });
add('page.dialog.respond', 'Explicitly accept or dismiss an owned pending dialog; never silently confirm.', object({ action: enumeration(['accept', 'dismiss']), promptText: string(4096) }, ['action']), data({ action: string(32) }, ['action']), { usesPage: true, effects: ['mutate-page'] });

add('observe.snapshot', 'Observe public ARIA YAML and uniquely resolvable Page-bound target refs.', object({ depth: integer(1, 12), limit: integer(1, 256), target: TARGET_SCHEMA, frameId: id, timeoutMs: timeout }), data({ snapshotId: id, snapshot: string(65536), format: string(32), targets: array(data(), 256) }, ['snapshotId', 'snapshot']), { defaults: { depth: 4, limit: 128 }, usesPage: true, effects: ['observe-page', 'write-managed-artifact'] });
add('observe.text', 'Read text from one unambiguous public target.', targetArgs({ maxChars: integer(1, 65536) }), data({ text: string(65536), truncated: boolean }, ['text']), { defaults: { maxChars: 8192 }, usesPage: true });
add('observe.attributes', 'Read only named attributes from a concrete target.', targetArgs({ names: array(string(128, { minLength: 1 }), 32) }), data({ attributes: data() }, ['attributes']), { usesPage: true });
add('observe.geometry', 'Inspect bounds, viewport and scroll/overflow facts without arbitrary JS.', targetArgs(), data(), { usesPage: true });

add('interact.click', 'Click one concrete target; may cause external effects.', targetArgs({ button: enumeration(['left', 'right', 'middle']), clickCount: integer(1, 3) }), data(), { defaults: { button: 'left', clickCount: 1 }, usesPage: true, effects: ['mutate-page'] });
add('interact.fill', 'Fill a concrete field; text is data, not executable code.', object({ ...targetArgs().properties, value: string(32768) }, ['target', 'value']), data(), { usesPage: true, effects: ['mutate-page'] });
add('interact.select', 'Select bounded option values in one target.', object({ ...targetArgs().properties, values: array(string(4096), 64) }, ['target', 'values']), data(), { usesPage: true, effects: ['mutate-page'] });
add('interact.check', 'Set checkbox/radio checked state explicitly.', object({ ...targetArgs().properties, checked: boolean }, ['target', 'checked']), data(), { usesPage: true, effects: ['mutate-page'] });
add('interact.press', 'Press a key combination on one concrete target.', object({ ...targetArgs().properties, key: string(128, { minLength: 1 }) }, ['target', 'key']), data(), { usesPage: true, effects: ['mutate-page'] });
add('interact.hover', 'Hover a concrete target, without current-tab fallback.', targetArgs(), data(), { usesPage: true, effects: ['mutate-page'] });
add('interact.drag', 'Drag between two unambiguous Page-bound targets; this is not a touch swipe.', object({ source: TARGET_SCHEMA, destination: TARGET_SCHEMA, frameId: id, timeoutMs: timeout }, ['source', 'destination']), data(), { usesPage: true, effects: ['mutate-page'] });
add('interact.scroll', 'Scroll this concrete Page using finite deltas; not a trusted touch gesture.', object({ deltaX: number(-65536, 65536), deltaY: number(-65536, 65536) }, [], { anyOf: [{ required: ['deltaX'] }, { required: ['deltaY'] }] }), data(), { defaults: { deltaX: 0, deltaY: 0 }, usesPage: true, effects: ['mutate-page'] });

add('mobile.devices', 'List installed-library device declarations without launching a browser.', object({ query: string(128), limit: integer(1, 100) }), data({ devices: array(data(), 100) }, ['devices']), { defaults: { limit: 30 }, requiresSession: false, effects: ['discovery'] });
add('mobile.tap', 'Dispatch a real touch tap at one target or CSS viewport point, with hasTouch required.', object({ target: TARGET_SCHEMA, point, frameId: id, timeoutMs: timeout }, [], { oneOf: [{ required: ['target'], not: { required: ['point'] } }, { required: ['point'], not: { required: ['target'] } }] }), data(), { usesPage: true, effects: ['mutate-page'] });
add('mobile.swipe', 'Dispatch a trusted bounded Chromium CDP touch gesture; no mouse/synthetic fallback.', object({ from: point, to: point, durationMs: integer(100, 2000), steps: integer(2, 120) }, ['from', 'to']), data(), { defaults: { durationMs: 300, steps: 12 }, usesPage: true, effects: ['mutate-page'], engines: ['chromium'] });

add('emulate.viewport', 'Resize the concrete viewport; this does not change DPR/UA/isMobile/hasTouch.', size, data(), { usesPage: true, effects: ['mutate-page'] });
add('emulate.media', 'Set media preferences through public Page APIs.', object({ colorScheme: enumeration(['light', 'dark', 'no-preference']), reducedMotion: enumeration(['reduce', 'no-preference']), forcedColors: enumeration(['active', 'none']) }, [], { minProperties: 1 }), data(), { usesPage: true, effects: ['mutate-page'] });
add('emulate.offline', 'Set the owned context offline state explicitly.', object({ offline: boolean }, ['offline']), data(), { effects: ['mutate-page'] });

for (const operation of ['console', 'errors', 'requests']) add(`diagnostics.${operation}`, `Read bounded owned ${operation} events, with filters/cursor.`, object({ ...paging, level: string(32) }), entriesData, { defaults: { limit: 100 }, usesPage: true });
add('diagnostics.request', 'Inspect one owned request; bodies/headers are sensitive opt-ins.', object({ requestId: id, includeHeaders: boolean, includeBody: boolean, maxBytes: integer(1, 65536) }, ['requestId']), data({ request: data() }, ['request']), { defaults: { includeHeaders: false, includeBody: false, maxBytes: 8192 }, usesPage: true });

add('media.screenshot', 'Capture viewport/full-page/element with controlled artifacts and native image admission.', object({
  mode: enumeration(['viewport', 'fullPage', 'element']), format: enumeration(['png', 'jpeg', 'webp']), scale: enumeration(['css', 'device']),
  target: TARGET_SCHEMA, clip, maskTargets: array(TARGET_SCHEMA, 32), readiness: ready, quality: integer(1, 100), timeoutMs: timeout,
}, [], { allOf: [
  { if: { properties: { mode: { const: 'element' } }, required: ['mode'] }, then: { required: ['target'] }, else: { not: { required: ['target'] } } },
  { if: { properties: { mode: { enum: ['element', 'fullPage'] } }, required: ['mode'] }, then: { not: { required: ['clip'] } } },
  { if: { required: ['quality'] }, then: { properties: { format: { const: 'jpeg' } }, required: ['format'] } },
] }), data({ mode: enumeration(['viewport', 'fullPage', 'element']), coordinateSpace: string(64) }, ['mode']), { defaults: { mode: 'viewport', format: 'png', scale: 'css' }, usesPage: true, effects: ['observe-page', 'write-managed-artifact'] });
add('media.video.start', 'Start Page-scoped WebM recording with bounded duration; does not recreate context.', object({ scope: { const: 'page' }, size, fps: integer(1, 60), cursorPreset: enumeration(['none', 'pointer']), maxDurationMs: integer(1000, 3600000) }), captureData, { defaults: { scope: 'page', fps: 25, cursorPreset: 'none', maxDurationMs: 60000 }, usesPage: true, effects: ['observe-page', 'write-managed-artifact'] });
add('media.video.status', 'Inspect an owned recording, including partial/failed finalization facts.', object({ captureId: id }, ['captureId']), captureData, { effects: ['discovery'] });
add('media.video.stop', 'Finalize the owned recording and inspect frames by default; no fake completed files.', capturedStop, captureData, { defaults: { inspectFrames: true }, effects: ['write-managed-artifact'] });
add('media.trace.start', 'Start context-scoped trace ZIP recording; may contain sensitive snapshots/network data.', object({ screenshots: boolean, snapshots: boolean, sources: { const: false }, format: { const: 'zip' } }), captureData, { defaults: { screenshots: true, snapshots: true, sources: false, format: 'zip' }, effects: ['observe-page', 'write-managed-artifact'], sensitive: true });
add('media.trace.status', 'Inspect one owned context-scoped trace capture.', object({ captureId: id }, ['captureId']), captureData, { effects: ['discovery'] });
add('media.trace.stop', 'Finalize owned tracing to a verified ZIP, distinct from video.', object({ captureId: id }, ['captureId']), captureData, { effects: ['write-managed-artifact'] });

add('files.upload', 'Authorize and stage bounded host files, then upload only staged paths to a concrete target.', object({ paths: array(string(4096, { minLength: 1 }), 16), target: TARGET_SCHEMA, frameId: id, timeoutMs: timeout }, ['paths', 'target']), data(), { usesPage: true, effects: ['upload-file', 'mutate-page'], sensitive: true });
add('files.downloads.list', 'List owned downloads in an explicitly download-enabled context.', object({ limit: integer(1, 100) }), data({ downloads: array(data(), 100) }, ['downloads']), { defaults: { limit: 100 } });
add('files.downloads.status', 'Inspect one owned download, never a site-selected filesystem path.', object({ downloadId: id }, ['downloadId']), data({ download: data() }, ['download']));
add('artifacts.list', 'List only this Agent’s retained artifact metadata.', object({ ...paging, kind: string(64), state: enumeration(['pending', 'finalized', 'partial', 'failed', 'expired']) }), data({ artifacts: array(data(), 1000), cursor: string(2048) }, ['artifacts']), { defaults: { limit: 100 }, requiresSession: false, effects: ['discovery'] });
add('artifacts.inspect', 'Inspect one owned artifact; live browser state is not required.', object({ artifactId: id }, ['artifactId']), data({ artifact: data() }, ['artifact']), { requiresSession: false, effects: ['discovery'] });
add('artifacts.export', 'Authorize one destination and exclusively publish a finalized owned artifact without overwrite.', object({ artifactId: id, destination: string(4096, { minLength: 1 }) }, ['artifactId', 'destination']), data({ artifact: data(), path: string(4096) }, ['path']), { requiresSession: false, effects: ['export-artifact'], sensitive: true });

for (const [operation, description, input, effects] of [
  ['advanced.pdf', 'PDF is an extra requiring a separately verified public adapter.', empty, ['write-managed-artifact']],
  ['advanced.routes.add', 'Network mocking is disabled until its effects and scope are reviewed.', empty, ['mutate-page']],
  ['advanced.routes.list', 'Route management is disabled in this baseline.', empty, ['discovery']],
  ['advanced.routes.remove', 'Route mutation is disabled in this baseline.', empty, ['mutate-page']],
  ['advanced.actions.start', 'Action recording is not video and is disabled in this baseline.', empty, ['write-managed-artifact']],
  ['advanced.actions.stop', 'Action recording is disabled in this baseline.', empty, ['write-managed-artifact']],
  ['advanced.auth.import', 'Authentication imports require an explicit separate grant; disabled by default.', empty, ['auth-profile']],
  ['advanced.auth.export', 'Authentication export is disabled and never returns credentials to the transcript.', empty, ['auth-profile']],
  ['advanced.session.attach', 'Owner Chrome attachment is disabled; isolation does not import personal profiles.', empty, ['browser-attach']],
  ['advanced.session.detach', 'Owner Chrome attachment is disabled; never close an owner browser as cleanup.', empty, ['browser-attach']],
]) add(operation, description, input, data(), { availability: 'disabled', sensitive: true, effects });

/** Immutable array, intentionally not a mutable Map exposed to other modules. */
export const OPERATIONS = freeze(descriptors);
const lookup = new Map(OPERATIONS.map(descriptor => [descriptor.operation, descriptor]));
const BASE_REVISION = createHash('sha256').update(JSON.stringify({ api: API_VERSION, backend: 'playwright-1.64.0-page-bound', descriptors: OPERATIONS })).digest('hex');
/** Public policy changes invalidate discovery; private cache paths do not enter model-visible hashes. */
export function catalogRevision(config = DEFAULT_CONFIG) {
  return `bc_${createHash('sha256').update(JSON.stringify({ manifest: BASE_REVISION, policy: {
    enabled: config.enabled, allowedEngines: config.allowedEngines, allowCss: config.allowCss, allowDownloads: config.allowDownloads,
    sensitiveOps: config.sensitiveOps, limits: config.limits, rawRetentionMs: config.rawRetentionMs, deliveryRetentionMs: config.deliveryRetentionMs,
  } })).digest('hex').slice(0, 32)}`;
}
export const CATALOG_REVISION = catalogRevision(DEFAULT_CONFIG);
export function getOperation(operation) { return lookup.get(operation); }

export function operationDefaults(descriptor, config = DEFAULT_CONFIG) {
  const defaults = { ...descriptor.defaults };
  if (['session.open', 'session.replace'].includes(descriptor.operation)) defaults.engine = config.allowedEngines[0] ?? 'chromium';
  if (descriptor.operation === 'media.video.start') {
    defaults.fps = Math.min(defaults.fps, config.limits.videoFps);
    defaults.maxDurationMs = Math.min(defaults.maxDurationMs, config.limits.videoDurationMs);
  }
  if (Object.hasOwn(descriptor.inputSchema.properties ?? {}, 'timeoutMs')) defaults.timeoutMs = Math.min(['page.navigate', 'page.back', 'page.forward', 'page.reload'].includes(descriptor.operation) ? config.limits.navigationMs : config.limits.actionMs, config.limits.rootMs);
  return defaults;
}

export function operationAvailability(descriptor, config = DEFAULT_CONFIG) {
  if (descriptor.availability !== 'verified') return { state: descriptor.availability, reason: descriptor.description };
  if (descriptor.effects.every(effect => effect === 'discovery')) return { state: 'verified' };
  if (!config.enabled) return { state: 'disabled', reason: 'Browser is disabled by configuration.' };
  if (descriptor.sensitive && config.sensitiveOps === 'disabled') return { state: 'disabled', reason: 'Sensitive operations are administratively disabled.' };
  if (descriptor.operation.startsWith('files.downloads.') && !config.allowDownloads) return { state: 'disabled', reason: 'Downloads are administratively disabled.' };
  if (descriptor.engines.length && !descriptor.engines.some(engine => config.allowedEngines.includes(engine))) return { state: 'disabled', reason: 'No permitted engine supports this operation.' };
  return { state: 'verified' };
}

const branchSummaries = {
  session: 'Owned isolated browser contexts and lifecycle.', page: 'Concrete Pages, navigation, frames and dialogs.',
  observe: 'Page-bound ARIA/text/attributes/geometry observations.', interact: 'Explicit concrete-target interactions.',
  mobile: 'Device declarations and true touch gestures.', emulate: 'Viewport/media/offline, not implicit device replacement.',
  diagnostics: 'Bounded console/errors/network observations.', media: 'Screenshots, video and context traces.',
  files: 'Authorized staged uploads and controlled downloads.', artifacts: 'Owned files, retention and deliberate export.',
  advanced: 'Extras disabled until reviewed and verified.',
};
const cursorKey = randomBytes(32);
const sign = payload => createHmac('sha256', cursorKey).update(payload).digest();
const ownerHash = owner => createHmac('sha256', cursorKey).update(`owner:${owner}`).digest('hex').slice(0, 24);
function encodeCursor(value) {
  const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${payload}.${sign(payload).toString('base64url')}`;
}
function decodeCursor(cursor) {
  if (typeof cursor !== 'string' || cursor.length > 2048) fail('INVALID_CURSOR', 'Catalog cursor is invalid; request help without a cursor.');
  const pieces = cursor.split('.');
  if (pieces.length !== 2 || pieces.some(value => !/^[A-Za-z0-9_-]+$/.test(value))) fail('INVALID_CURSOR', 'Catalog cursor is invalid; request help without a cursor.');
  const actual = Buffer.from(pieces[1], 'base64url');
  const expected = sign(pieces[0]);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) fail('INVALID_CURSOR', 'Catalog cursor is invalid; request help without a cursor.');
  try { return JSON.parse(Buffer.from(pieces[0], 'base64url').toString('utf8')); }
  catch { fail('INVALID_CURSOR', 'Catalog cursor is invalid; request help without a cursor.'); }
}
function validPath(path) {
  if (typeof path !== 'string' || path.length > 160 || (path !== '' && !/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*$/.test(path))) fail('INVALID_ARGS', 'Catalog path must be an exact branch or operation.');
}

/** Third argument is private host context, never part of the public tool arguments. */
export function helpCatalog({ path = '', query = '', limit = 12, cursor, availability = 'all' } = {}, config = DEFAULT_CONFIG, { ownerId = 'local' } = {}) {
  validPath(path);
  if (typeof query !== 'string' || query.length > 128 || !Number.isInteger(limit) || limit < 1 || limit > 30 || !['all', 'verified', 'disabled', 'unsupported'].includes(availability)) fail('INVALID_ARGS', 'Invalid catalog search, limit or availability filter.');
  const prefix = path ? `${path}.` : '';
  if (path && !OPERATIONS.some(item => item.operation === path || item.operation.startsWith(prefix))) fail('UNKNOWN_OPERATION', 'Catalog branch does not exist.');
  const groups = new Map();
  for (const descriptor of OPERATIONS) {
    if (!descriptor.operation.includes('.') || !descriptor.operation.startsWith(prefix)) continue;
    const rest = descriptor.operation.slice(prefix.length);
    const child = rest.split('.')[0];
    const key = `${prefix}${child}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(descriptor);
  }
  const items = [...groups].map(([operation, children]) => {
    const leaf = lookup.get(operation);
    const states = children.map(child => operationAvailability(child, config).state);
    const state = states.includes('verified') ? 'verified' : states.includes('disabled') ? 'disabled' : 'unsupported';
    return {
      operation, kind: leaf ? 'operation' : 'branch', description: leaf?.description ?? branchSummaries[operation] ?? `${operation.split('.').at(-1)} operations.`,
      availability: state, effects: leaf?.effects ?? [...new Set(children.flatMap(child => child.effects))],
    };
  }).filter(item => (availability === 'all' || item.availability === availability) && (!query || `${item.operation} ${item.description}`.toLowerCase().includes(query.toLowerCase()))).sort((a, b) => a.operation.localeCompare(b.operation));
  let offset = 0;
  const scope = ownerHash(ownerId);
  const revision = catalogRevision(config);
  const policyRevision = createHash('sha256').update(JSON.stringify({ enabled: config.enabled, allowedEngines: config.allowedEngines, sensitiveOps: config.sensitiveOps, allowDownloads: config.allowDownloads })).digest('hex').slice(0, 20);
  if (cursor) {
    const previous = decodeCursor(cursor);
    if (!previous || previous.revision !== revision || previous.policy !== policyRevision || previous.path !== path || previous.query !== query || previous.availability !== availability || previous.owner !== scope || previous.expires < Date.now() || !Number.isSafeInteger(previous.offset) || previous.offset < 0 || previous.offset > items.length) fail('INVALID_CURSOR', 'Catalog cursor is stale or belongs to another query/owner; request help again.');
    offset = previous.offset;
  }
  const page = items.slice(offset, offset + limit);
  const result = { path, items: page, hasMore: offset + page.length < items.length, catalogRevision: revision };
  if (result.hasMore) result.cursor = encodeCursor({ revision, policy: policyRevision, path, query, availability, owner: scope, offset: offset + page.length, expires: Date.now() + 900000 });
  if (Buffer.byteLength(JSON.stringify(result)) > 8192) fail('LIMIT_EXCEEDED', 'Catalog response exceeds its budget; lower limit or narrow the branch.');
  return result;
}

export function describeOperation(path, config = DEFAULT_CONFIG) {
  validPath(path);
  const descriptor = lookup.get(path);
  if (!descriptor) fail('UNKNOWN_OPERATION', 'Describe requires an exact known operation, not an entire branch.');
  const availability = operationAvailability(descriptor, config);
  const result = {
    apiVersion: API_VERSION, operation: descriptor.operation, description: descriptor.description,
    inputSchema: descriptor.inputSchema, outputSchema: descriptor.outputSchema, schemaDialect: 'https://json-schema.org/draft/2020-12/schema',
    defaults: operationDefaults(descriptor, config), effects: descriptor.effects, requiresSession: descriptor.requiresSession, usesPage: descriptor.usesPage,
    availability: availability.state, ...(availability.reason ? { availabilityReason: availability.reason } : {}),
    catalogRevision: catalogRevision(config), schemaHash: createHash('sha256').update(JSON.stringify({ input: descriptor.inputSchema, output: descriptor.outputSchema })).digest('hex'),
    limits: config.limits,
    example: { operation: descriptor.operation, ...(descriptor.requiresSession ? { sessionId: '<owned-session>' } : {}), ...(descriptor.usesPage ? { pageId: '<owned-page>' } : {}), args: operationDefaults(descriptor, config) },
  };
  if (Buffer.byteLength(JSON.stringify(result)) > 16384) fail('LIMIT_EXCEEDED', 'Operation schema exceeds the describe budget.');
  return result;
}
