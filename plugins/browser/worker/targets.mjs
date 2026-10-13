import { randomUUID } from 'node:crypto';
import { loadRuntime } from '../deps.mjs';
import { fail } from '../errors.mjs';

const roleNames = new Set('alert alertdialog application article banner blockquote button caption cell checkbox code columnheader combobox complementary contentinfo definition deletion dialog directory document emphasis feed figure form generic grid gridcell group heading img insertion link list listbox listitem log main marquee math meter menu menubar menuitem menuitemcheckbox menuitemradio navigation none note option paragraph presentation progressbar radio radiogroup region row rowgroup rowheader scrollbar search searchbox separator slider spinbutton status strong subscript superscript switch tab table tablist tabpanel term textbox time timer toolbar tooltip tree treegrid treeitem'.split(' '));

function roleDescriptor(key) {
  const match = /^([a-z][a-z0-9-]*)(?:\s+("(?:[^"\\]|\\.)*"))?(?:\s+\[[^\]]*\])*$/.exec(key);
  if (!match || !roleNames.has(match[1])) return null;
  let name;
  if (match[2]) { try { name = JSON.parse(match[2]); } catch { return null; } }
  return { role: match[1], ...(name !== undefined ? { name } : {}) };
}

/** Public aria snapshots supply data; owned public element handles supply authority. */
export class TargetRegistry {
  constructor({ config = {}, artifacts }) {
    this.config = config;
    this.artifacts = artifacts;
    this.snapshots = new Map();
  }
  invalidate(record) {
    for (const [id, snapshot] of this.snapshots) if (snapshot.pageRecord === record) {
      this.snapshots.delete(id);
      for (const entry of snapshot.refs.values()) {
        const task = entry.handle.dispose().catch(() => {});
        record.session.pendingActions.add(task);
        task.then(() => record.session.pendingActions.delete(task));
      }
    }
  }
  async snapshot(record, args = {}) {
    const ownerRecord = record.baseRecord ?? record;
    const documentEpoch = ownerRecord.document;
    const generation = record.session.generation;
    const root = record.root ?? record.page;
    const snapshotLocator = args.target ? await this.uniqueLocator(record, args.target) : root.locator('body');
    const source = await snapshotLocator.ariaSnapshot({ timeout: args.timeoutMs ?? this.config.limits?.actionMs ?? 5000 });
    const snapshotId = `bn_${randomUUID()}`;
    const snapshot = { snapshotId, pageRecord: ownerRecord, frameId: record.frameId, generation, documentEpoch, refs: new Map() };
    const artifacts = [];
    const maxBytes = 64 * 1024;
    if (Buffer.byteLength(source) > maxBytes) {
      artifacts.push(await this.artifacts.write({ data: Buffer.from(source), kind: 'snapshot', mime: 'application/yaml', extension: 'yaml', sessionId: record.session.sessionId, pageId: record.pageId, generation }));
      const preview = Buffer.from(source).subarray(0, maxBytes).toString('utf8');
      this.snapshots.set(snapshotId, snapshot);
      return { snapshotId, snapshot: preview.slice(0, preview.lastIndexOf('\n')), format: 'aria-yaml', targets: [], truncated: true, artifacts };
    }
    const yaml = await loadRuntime('yaml');
    const parsed = yaml.parseDocument(source, { uniqueKeys: true });
    if (parsed.errors.length) fail('BACKEND_INVALID_OUTPUT', 'Public aria snapshot could not be parsed safely.');
    let tree;
    try { tree = parsed.toJS({ maxAliasCount: 0, mapAsMap: true }); }
    catch { fail('BACKEND_INVALID_OUTPUT', 'Snapshot aliases are not allowed.'); }
    const descriptors = [];
    let visited = 0;
    const maxDepth = args.depth ?? 8;
    const maxTargets = Math.min(args.limit ?? 128, 256);
    const trim = (value, depth = 0, roleText = false) => {
      if (++visited > 4096 || depth > 20) fail('LIMIT_EXCEEDED', 'Snapshot structure exceeds the observation limit.');
      if (Array.isArray(value)) return depth >= maxDepth ? ['(children omitted)'] : value.map(item => trim(item, depth + 1, true));
      if (value instanceof Map) {
        const next = new Map();
        for (const [key, item] of value) {
          if (typeof key !== 'string') fail('BACKEND_INVALID_OUTPUT', 'Snapshot keys must be text.');
          const descriptor = roleDescriptor(key);
          if (descriptor && descriptors.length < maxTargets) descriptors.push(descriptor);
          next.set(key, depth >= maxDepth && typeof item === 'object' && item !== null ? '(children omitted)' : trim(item, depth + 1));
        }
        return next;
      }
      // A map's scalar value is page text/input data, not another ARIA role declaration.
      if (roleText && typeof value === 'string') {
        const descriptor = roleDescriptor(value);
        if (descriptor && descriptors.length < maxTargets) descriptors.push(descriptor);
      }
      return value;
    };
    const trimmed = trim(tree);
    const targets = [];
    const unique = new Set();
    for (const descriptor of descriptors) {
      const key = JSON.stringify(descriptor);
      if (unique.has(key)) continue;
      unique.add(key);
      const locator = (record.root ?? record.page).getByRole(descriptor.role, descriptor.name !== undefined ? { name: descriptor.name, exact: true } : {});
      if (await locator.count() !== 1) continue;
      const handle = await locator.elementHandle({ timeout: this.config.limits?.actionMs ?? 5000 });
      if (!handle) continue;
      const ref = `be_${randomUUID()}`;
      snapshot.refs.set(ref, { handle, descriptor });
      targets.push({ ref, snapshotId, ...descriptor });
    }
    if (record.page.isClosed() || ownerRecord.document !== documentEpoch || record.session.generation !== generation) {
      for (const entry of snapshot.refs.values()) await entry.handle.dispose().catch(() => {});
      fail('STALE_SNAPSHOT', 'Page document changed while the snapshot was being observed.');
    }
    this.snapshots.set(snapshotId, snapshot);
    // A bounded number of snapshots keeps otherwise-live ElementHandles from accumulating.
    const owned = [...this.snapshots.values()].filter(item => item.pageRecord === ownerRecord);
    for (const previous of owned.slice(0, Math.max(0, owned.length - 8))) {
      this.snapshots.delete(previous.snapshotId);
      await Promise.all([...previous.refs.values()].map(item => item.handle.dispose().catch(() => {})));
    }
    return { snapshotId, snapshot: yaml.stringify(trimmed, { lineWidth: 0 }), format: 'aria-yaml', targets, truncated: visited >= 4096, artifacts };
  }
  reference(record, target) {
    const snapshot = this.snapshots.get(target.snapshotId);
    if (!snapshot || snapshot.pageRecord !== (record.baseRecord ?? record) || snapshot.frameId !== record.frameId || snapshot.generation !== record.session.generation || snapshot.documentEpoch !== (record.baseRecord ?? record).document) fail('STALE_SNAPSHOT', 'Snapshot reference is stale or belongs to a different owned page/document/frame.');
    const entry = snapshot.refs.get(target.ref);
    if (!entry) fail('STALE_HANDLE', 'Owned snapshot element was not found.');
    return entry;
  }
  locatorFor(record, target) {
    if (!target || typeof target !== 'object') fail('INVALID_ARGS', 'A typed target is required.');
    let locator;
    if (target.kind === 'role') {
      if (!roleNames.has(target.role) || (target.name !== undefined && typeof target.name !== 'string')) fail('INVALID_ARGS', 'Role targets require a public ARIA role and a text name.');
      locator = (record.root ?? record.page).getByRole(target.role, { ...(target.name !== undefined ? { name: target.name } : {}), exact: target.exact !== false });
    } else if (target.kind === 'testId') {
      locator = (record.root ?? record.page).getByTestId(target.value);
    } else if (target.kind === 'css') {
      if (!this.config.allowCss) fail('POLICY_DENIED', 'CSS escape-hatch targets are disabled.');
      if (typeof target.value !== 'string' || target.value.includes('>>')) fail('INVALID_ARGS', 'CSS target must be a single bounded CSS selector, not a chained selector expression.');
      locator = (record.root ?? record.page).locator(`css=${target.value}`);
    } else fail('INVALID_ARGS', 'Unknown target kind.');
    return locator;
  }
  async uniqueLocator(record, target) {
    let expected;
    if (target.kind === 'ref') {
      expected = await this.resolve(record, target);
      const descriptor = this.reference(record, target).descriptor;
      target = { kind: 'role', ...descriptor, exact: true };
    }
    const locator = this.locatorFor(record, target);
    const count = await locator.count();
    if (count !== 1) fail(count ? 'AMBIGUOUS_TARGET' : 'TARGET_NOT_FOUND', 'A unique Page-bound Locator is required for this observation/capture decoration.');
    if (expected) {
      const candidate = await locator.elementHandle({ timeout: this.config.limits?.actionMs ?? 5000 });
      try { if (!candidate || !await candidate.evaluate((element, original) => element === original, expected)) fail('STALE_HANDLE', 'Public Locator no longer identifies the snapshot-owned element.'); }
      finally { await candidate?.dispose().catch(() => {}); }
    }
    return locator;
  }
  async wait(record, target, state, timeout) {
    if (target.kind !== 'ref') return this.locatorFor(record, target).waitFor({ state, timeout });
    const { handle } = this.reference(record, target);
    if (state === 'attached') { if (!await handle.evaluate(element => element.isConnected)) fail('STALE_HANDLE', 'Snapshot-owned element detached.'); return; }
    return handle.waitForElementState(state === 'detached' ? 'hidden' : state, { timeout });
  }
  async resolve(record, target) {
    if (target.kind === 'ref') {
      const entry = this.reference(record, target);
      if (record.page.isClosed() || !await entry.handle.evaluate(element => element.isConnected)) fail('STALE_HANDLE', 'Snapshot element is no longer attached to its owned document.');
      return entry.handle;
    }
    const locator = this.locatorFor(record, target);
    const count = await locator.count();
    if (count === 0) fail('TARGET_NOT_FOUND', 'Target was not found in its owned page.');
    if (count !== 1) fail('AMBIGUOUS_TARGET', 'Target matches multiple elements; refine the role/name or use a unique test id.');
    // Resolve once to a Page-bound handle. A document replacement can only invalidate it, never retarget another Page.
    const handle = await locator.elementHandle({ timeout: this.config.limits?.actionMs ?? 5000 });
    if (!handle) fail('TARGET_NOT_FOUND', 'Target disappeared before it could be resolved.');
    return handle;
  }
  async use(record, target, action) {
    const handle = await this.resolve(record, target);
    try { return await action(handle); }
    finally { if (target.kind !== 'ref') await handle.dispose().catch(() => {}); }
  }
}
