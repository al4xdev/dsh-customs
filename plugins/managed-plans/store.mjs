import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const CATEGORIES = ['backlog', 'tasks', 'para-o-dono'];
const DIRS = ['staging', ...CATEGORIES, 'closed', '.state'];
const hashOf = text => createHash('sha256').update(text, 'utf8').digest('hex');
const fail = (code, message) => { const e = new Error(message); e.code = code; throw e; };
const requireText = (value, name) => {
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_INPUT', `${name} must be nonempty text`);
  return value;
};
const integer = (value, name, min = 1) => {
  if (!Number.isSafeInteger(value) || value < min) fail('INVALID_INPUT', `${name} must be an integer >= ${min}`);
  return value;
};
const clone = value => JSON.parse(JSON.stringify(value));
const now = () => new Date().toISOString();
const activeComments = revision => revision.comments.filter(comment => comment.status !== 'deleted');

/**
 * Host boundary: authenticate owner review/comment/cancellation outside this store.
 * No model actor flag is authority. Notifications require authenticated session routing.
 * SQLite commits precede mirror publication; pending intents recover on the next call.
 * This is not atomic with session logs. The host must durably append before acknowledging
 * notifications. Protect .plan from arbitrary external writers: lstat/O_NOFOLLOW and
 * exclusive publication reject normal symlink/collision attacks, but Node lacks openat
 * directory-relative primitives, so hostile concurrent ancestor swaps remain a residual
 * race. The SQLite filename itself also requires a trusted .state directory.
 */
export class PlanStore {
  constructor(initialCwd) {
    if (typeof initialCwd !== 'string' || !path.isAbsolute(initialCwd)) fail('INVALID_INPUT', 'initialCwd must be absolute');
    Object.defineProperty(this, 'root', { value: path.join(path.resolve(initialCwd), '.plan'), enumerable: true });
    Object.defineProperty(this, 'planRoot', { value: this.root, enumerable: true });
    this.db = null;
    this.readOnly = false;
    this.readState = null;
  }

  _check(target, allowMissing = false) {
    // Check all ancestors, including the initial working directory, without resolving symlinks.
    let current = path.parse(target).root;
    for (const part of target.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      try {
        const stat = fs.lstatSync(current);
        if (stat.isSymbolicLink()) fail('UNSAFE_PATH', `Symlink refused: ${current}`);
        if (current !== target && !stat.isDirectory()) fail('UNSAFE_PATH', 'Non-directory ancestor');
      } catch (e) {
        if (e.code === 'ENOENT' && allowMissing && current === target) return false;
        throw e;
      }
    }
    return true;
  }

  _file(relative) {
    if (typeof relative !== 'string' || relative.includes('\\') || relative.split('/').some(p => !p || p === '.' || p === '..')) fail('UNSAFE_PATH', 'Invalid artifact path');
    const target = path.join(this.root, relative);
    const resolved = path.relative(this.root, target);
    if (resolved.startsWith('..') || path.isAbsolute(resolved)) fail('UNSAFE_PATH', 'Path escapes anchored .plan');
    this._check(target, true);
    return target;
  }

  _readFile(target) {
    this._check(target);
    const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      if (!fs.fstatSync(fd).isFile()) fail('UNSAFE_PATH', 'Artifact must be a regular file');
      return fs.readFileSync(fd, 'utf8');
    } finally { fs.closeSync(fd); }
  }

  _syncDir(directory) {
    const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }

  async initialize({ readOnly = false } = {}) {
    if (this.db || this.readState) return { root: this.root, read_only: this.readOnly };
    this.readOnly = readOnly;
    if (readOnly) {
      const state = { version: 1, next_id: 1, plans: {}, idempotency: {}, notifications: [], mirrors: [], bootstrapped: false };
      if (this._check(this.root, true)) {
        const database = path.join(this.root, '.state', 'store.sqlite');
        const stateDir = path.dirname(database);
        if (this._check(stateDir, true) && this._check(database, true)) {
          for (const suffix of ['-wal', '-shm', '-journal']) this._check(database + suffix, true);
          this.db = new DatabaseSync(database, { readOnly: true });
          this.db.exec('PRAGMA busy_timeout=15000; PRAGMA query_only=ON');
        } else this._bootstrap(state);
      }
      if (!this.db) this.readState = state;
      return { root: this.root, read_only: true };
    }
    const parent = path.dirname(this.root);
    this._check(parent);
    for (const directory of [this.root, ...DIRS.map(d => path.join(this.root, d))]) {
      if (!this._check(directory, true)) {
        try { fs.mkdirSync(directory); } catch (e) { if (e.code !== 'EEXIST') throw e; }
        this._syncDir(path.dirname(directory));
      }
      this._check(directory);
      if (!fs.lstatSync(directory).isDirectory()) fail('UNSAFE_PATH', 'Canonical directory is not a directory');
    }
    const database = path.join(this.root, '.state', 'store.sqlite');
    this._check(database, true);
    // SQLite sidecars must not follow attacker-provided links either.
    for (const suffix of ['-wal', '-shm', '-journal']) this._check(database + suffix, true);
    const db = new DatabaseSync(database);
    this.db = db;
    try {
      db.exec('PRAGMA busy_timeout=15000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS registry (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)');
      this._transaction(state => {
        if (!state.bootstrapped) this._bootstrap(state);
        return { root: this.root };
      });
    } catch (e) { db.close(); this.db = null; throw e; }
    return { root: this.root };
  }

  _bootstrap(state) {
    for (const directory of DIRS.filter(d => d !== '.state')) {
      if (!this._check(path.join(this.root, directory), true)) continue;
      for (const name of fs.readdirSync(path.join(this.root, directory)).sort()) {
        // YYYY-MM-DD... closed records are dates, not numeric plan identities.
        if (directory === 'closed' && /^\d{4}-\d{2}-\d{2}(?:\D|$)/.test(name)) continue;
        const match = /^(\d+)-.+\.md$/i.exec(name);
        if (!match) continue;
        const id = Number(match[1]);
        integer(id, 'imported plan id');
        if (state.plans[id]) fail('ID_COLLISION', `Multiple existing files use plan id ${id}`);
        const relative = `${directory}/${name}`;
        const content = this._readFile(this._file(relative));
        const title = /^#\s+(.+)$/m.exec(content)?.[1] || name.replace(/^\d+-|\.md$/gi, '');
        const category = CATEGORIES.includes(directory) ? directory : 'tasks';
        const revision = { revision: 1, title, content, hash: hashOf(content), category, status: directory === 'staging' ? 'staged' : directory === 'closed' ? 'closed' : 'approved', created_at: now(), origin: null, comments: [], decisions: [], imported: true };
        state.plans[id] = { plan_id: id, current_revision: 1, filename: name, path: relative, revisions: [revision] };
        state.next_id = Math.max(state.next_id, id + 1);
      }
    }
    state.bootstrapped = true;
  }

  _writeAllowed() {
    if (this.readOnly) fail('READ_ONLY', 'Store initialized read-only');
  }

  _transaction(action) {
    if (this.readOnly) {
      const state = this.db ? JSON.parse(this.db.prepare('SELECT value FROM registry WHERE id=1').get().value) : this.readState;
      return clone(action(clone(state)));
    }
    if (!this.db) fail('NOT_INITIALIZED', 'Call initialize first');
    this._check(path.join(this.root, '.state', 'store.sqlite'));
    this.db.exec('BEGIN IMMEDIATE');
    let committed = false;
    try {
      const row = this.db.prepare('SELECT value FROM registry WHERE id=1').get();
      const state = row ? JSON.parse(row.value) : { version: 1, next_id: 1, plans: {}, idempotency: {}, notifications: [], mirrors: [], bootstrapped: false };
      this._reconcile(state);
      const result = action(state);
      this.db.prepare('INSERT INTO registry(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(JSON.stringify(state));
      this.db.exec('COMMIT');
      committed = true;
      // Reacquire the shared writer lock and reconcile the latest committed state, not
      // our stale snapshot: another process may have committed in the tiny gap.
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const latest = JSON.parse(this.db.prepare('SELECT value FROM registry WHERE id=1').get().value);
        this._reconcile(latest);
        this.db.prepare('UPDATE registry SET value=? WHERE id=1').run(JSON.stringify(latest));
        this.db.exec('COMMIT');
      } catch (e) { this.db.exec('ROLLBACK'); throw e; }
      return clone(result);
    } catch (e) {
      if (!committed) this.db.exec('ROLLBACK');
      else { e.committed = true; e.message = `Store committed; mirror reconciliation pending: ${e.message}`; }
      throw e;
    }
  }

  _reconcile(state) {
    for (const intent of state.mirrors) {
      const destination = this._file(intent.to);
      if (this._check(destination, true)) {
        if (this._readFile(destination) !== intent.content) fail('FILE_COLLISION', `Refusing to overwrite ${intent.to}`);
      } else {
        // A same-directory temporary file is synced before exclusive hard-link publication.
        const temp = path.join(path.dirname(destination), `.managed-${randomUUID()}.tmp`);
        const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        try { fs.writeFileSync(fd, intent.content, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        try {
          this._check(destination, true);
          try { fs.linkSync(temp, destination); } catch (e) {
            if (e.code !== 'EEXIST' || this._readFile(destination) !== intent.content) throw e;
          }
          this._syncDir(path.dirname(destination));
        } finally {
          // Only our explicit UUID temporary file is removed; interrupted temps are inert.
          this._check(temp); fs.unlinkSync(temp); this._syncDir(path.dirname(temp));
        }
      }
      if (intent.from && intent.from !== intent.to) {
        const source = this._file(intent.from);
        if (this._check(source, true)) {
          if (this._readFile(source) !== intent.old_content) fail('FILE_CONFLICT', `Externally modified artifact: ${intent.from}`);
          this._check(source); fs.unlinkSync(source); this._syncDir(path.dirname(source));
        }
      }
    }
    state.mirrors = [];
    // Detect edits/deletions of authoritative mirrors rather than silently replacing them.
    for (const plan of Object.values(state.plans)) {
      const revision = plan.revisions.at(-1);
      const target = this._file(plan.path);
      if (!this._check(target, true) || this._readFile(target) !== revision.content) fail('FILE_CONFLICT', `Artifact missing or modified: ${plan.path}`);
    }
  }

  _get(state, planId, revisionNumber) {
    integer(planId, 'plan_id');
    const plan = state.plans[planId];
    if (!plan) fail('NOT_FOUND', `Unknown plan ${planId}`);
    const revision = revisionNumber === undefined ? plan.revisions.at(-1) : plan.revisions.find(r => r.revision === integer(revisionNumber, 'revision'));
    if (!revision) fail('NOT_FOUND', 'Unknown revision');
    return [plan, revision];
  }

  _summary(plan, revision = plan.revisions.at(-1)) {
    return { plan_id: plan.plan_id, revision: revision.revision, hash: revision.hash, title: revision.title, category: revision.category, status: revision.status, path: plan.path, pending_review: revision.revision === plan.current_revision && revision.status === 'staged', execution_authorized: !revision.imported && revision.revision === plan.current_revision && revision.status === 'approved' && revision.category === 'tasks', origin: revision.origin, created_at: revision.created_at, reopening: revision.reopening ?? null };
  }

  _cas(plan, revision, hash) {
    if (plan.current_revision !== revision || plan.revisions.at(-1).hash !== hash) fail('STALE_REVIEW', 'Revision/hash no longer current');
  }

  _mirror(state, plan, oldPath, oldContent) {
    const content = plan.revisions.at(-1).content;
    if (oldPath === plan.path && oldContent === content) return;
    // Never replace an existing revision in place: new revisions use distinct filenames.
    const destination = this._file(plan.path);
    if (this._check(destination, true)) fail('FILE_COLLISION', `Destination exists: ${plan.path}`);
    state.mirrors.push({ from: oldPath, to: plan.path, content, old_content: oldContent });
  }

  async list({ category, status } = {}) {
    if (category !== undefined && ![...CATEGORIES, 'staging', 'closed'].includes(category)) fail('INVALID_INPUT', 'Invalid category');
    return this._transaction(state => Object.values(state.plans).map(p => this._summary(p)).filter(p => (category === undefined || (category === 'staging' ? ['staged', 'rejected'].includes(p.status) : category === 'closed' ? p.status === 'closed' : p.category === category)) && (status === undefined || p.status === status)).sort((a, b) => a.plan_id - b.plan_id));
  }

  async read(planId, { revision, offset = 1, limit } = {}) {
    integer(offset, 'offset');
    if (limit !== undefined) integer(limit, 'limit');
    return this._transaction(state => {
      const [plan, artifact] = this._get(state, planId, revision);
      const lines = artifact.content.split('\n');
      const selected = lines.slice(offset - 1, limit === undefined ? undefined : offset - 1 + limit);
      return { ...this._summary(plan, artifact), current_revision: plan.current_revision, content: selected.join('\n'), offset, line_start: offset, line_end: selected.length ? offset + selected.length - 1 : null, total_lines: lines.length, comments: activeComments(artifact), deleted_comments: artifact.comments.filter(comment => comment.status === 'deleted'), decisions: artifact.decisions, closure: artifact.closure ?? null };
    });
  }

  async history(planId) {
    return this._transaction(state => {
      const [plan] = this._get(state, planId);
      // History is metadata only; opening a row uses the same revision-bound read.
      return plan.revisions.map(revision => ({ ...this._summary(plan, revision),
        current_revision: plan.current_revision, is_current: revision.revision === plan.current_revision,
        comment_count: activeComments(revision).length, deleted_comment_count: revision.comments.length - activeComments(revision).length })).reverse();
    });
  }

  async stage({ title, plan: content, category, plan_id, expected_revision, origin }) {
    this._writeAllowed();
    requireText(title, 'title'); requireText(content, 'plan');
    if (!CATEGORIES.includes(category)) fail('INVALID_INPUT', 'Invalid proposed category');
    requireText(origin?.session_id, 'origin.session_id'); requireText(origin?.call_id, 'origin.call_id');
    const key = JSON.stringify([origin.session_id, origin.call_id]);
    const fingerprint = hashOf(JSON.stringify({ title, content, category, plan_id, expected_revision }));
    return this._transaction(state => {
      if (state.idempotency[key]) {
        if (state.idempotency[key].fingerprint !== fingerprint) fail('IDEMPOTENCY_CONFLICT', 'Origin call reused with different input');
        return state.idempotency[key].result;
      }
      let record, oldPath = null, oldContent = null;
      if (plan_id !== undefined) {
        [record] = this._get(state, plan_id);
        if (expected_revision !== record.current_revision) fail('STALE_REVISION', 'expected_revision required and must match');
        if (record.revisions.at(-1).status === 'closed') fail('INVALID_STATE', 'Closed plan cannot be revised');
        oldPath = record.path; oldContent = record.revisions.at(-1).content;
      } else {
        if (expected_revision !== undefined) fail('INVALID_INPUT', 'expected_revision requires plan_id');
        const id = state.next_id++;
        integer(id, 'allocated id');
        const slug = title.normalize('NFKD').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 72) || 'plan';
        record = { plan_id: id, current_revision: 0, filename: `${id}-${slug}.md`, revisions: [] };
        state.plans[id] = record;
      }
      const revision = ++record.current_revision;
      record.revisions.push({ revision, title, content, hash: hashOf(content), category, status: 'staged', created_at: now(), origin: clone(origin), comments: [], decisions: [] });
      const basename = record.filename.replace(/\.md$/i, '');
      record.path = `staging/${revision === 1 ? record.filename : `${basename}.r${revision}.md`}`;
      this._mirror(state, record, oldPath, oldContent);
      const result = this._summary(record);
      state.idempotency[key] = { fingerprint, result };
      return result;
    });
  }

  async saveComment({ plan_id, revision, hash, line_start, line_end, text, comment_id, owner_session_id }) {
    this._writeAllowed();
    requireText(text, 'text'); requireText(owner_session_id, 'owner_session_id');
    integer(line_start, 'line_start'); integer(line_end, 'line_end');
    return this._transaction(state => {
      const [plan, artifact] = this._get(state, plan_id, revision);
      this._cas(plan, revision, hash);
      if (artifact.status !== 'staged') fail('INVALID_STATE', 'Only staged revisions accept draft comments');
      const lines = artifact.content.split('\n');
      if (line_end < line_start || line_end > lines.length) fail('INVALID_INPUT', 'Comment range outside source');
      const overlaps = c => c.status === 'draft' && c.owner_session_id === owner_session_id && c.line_start <= line_end && line_start <= c.line_end;
      // Repeated c/save on an already annotated line edits its draft, even when a
      // client lost the returned id. Different revisions never share this lookup.
      let comment = comment_id === undefined ? artifact.comments.find(overlaps) : artifact.comments.find(c => c.comment_id === comment_id);
      if (comment_id !== undefined && !comment) fail('NOT_FOUND', 'Unknown comment');
      if (comment && comment.owner_session_id !== owner_session_id) fail('COMMENT_OWNER_MISMATCH', 'Comment belongs to another owner session');
      if (comment && comment.status !== 'draft') fail('INVALID_STATE', 'Only draft comments can be edited; deleted and sent comments are immutable');
      if (artifact.comments.some(c => c !== comment && overlaps(c))) fail('COMMENT_RANGE_CONFLICT', 'This range already contains another comment; edit its original range');
      const values = { plan_id, revision, hash, line_start, line_end, text, quoted_context: lines.slice(line_start - 1, line_end).join('\n'), owner_session_id, status: 'draft', updated_at: now() };
      if (comment) Object.assign(comment, values);
      else { comment = { comment_id: randomUUID(), created_at: now(), ...values }; artifact.comments.push(comment); }
      return comment;
    });
  }

  async deleteComment({ plan_id, revision, hash, comment_id, owner_session_id }) {
    this._writeAllowed();
    requireText(comment_id, 'comment_id'); requireText(owner_session_id, 'owner_session_id');
    return this._transaction(state => {
      const [plan, artifact] = this._get(state, plan_id, revision);
      this._cas(plan, revision, hash);
      if (artifact.status !== 'staged') fail('INVALID_STATE', 'Only current staged revisions accept draft comment deletion');
      const comment = artifact.comments.find(value => value.comment_id === comment_id);
      if (!comment) fail('NOT_FOUND', 'Unknown comment');
      if (comment.owner_session_id !== owner_session_id) fail('COMMENT_OWNER_MISMATCH', 'Comment belongs to another owner session');
      // Retried deletion acknowledges the existing tombstone, never resurrects it.
      if (comment.status === 'deleted') return comment;
      if (comment.status !== 'draft') fail('INVALID_STATE', 'Sent/history comments cannot be deleted');
      comment.status = 'deleted';
      comment.deleted_at = now();
      comment.deleted_by_session_id = owner_session_id;
      return comment;
    });
  }

  async reopen({ plan_id, expected_revision, hash, reason, origin, owner_session_id }) {
    this._writeAllowed();
    integer(expected_revision, 'expected_revision'); requireText(reason, 'reason');
    requireText(origin?.session_id, 'origin.session_id'); requireText(origin?.call_id, 'origin.call_id');
    if (origin.request_id !== undefined) requireText(origin.request_id, 'origin.request_id');
    if (owner_session_id !== undefined) {
      requireText(owner_session_id, 'owner_session_id'); requireText(hash, 'hash');
    }
    // Human request ids survive a UI transport retry; session authority and the
    // actual command id still come from the authenticated host, never the payload.
    const key = JSON.stringify(['reopen', owner_session_id ?? origin.session_id, origin.request_id ?? origin.call_id]);
    const fingerprint = hashOf(JSON.stringify({ plan_id, expected_revision, hash, reason, session_id: origin.session_id, owner_session_id }));
    return this._transaction(state => {
      if (state.idempotency[key]) {
        if (state.idempotency[key].fingerprint !== fingerprint) fail('IDEMPOTENCY_CONFLICT', 'Origin call reused with different input');
        return state.idempotency[key].result;
      }
      const [plan, source] = this._get(state, plan_id);
      if (expected_revision !== plan.current_revision) fail('STALE_REVISION', 'expected_revision must match the current revision');
      if (hash !== undefined) this._cas(plan, expected_revision, hash);
      const reopening = { intent: owner_session_id === undefined ? 'model-proposal' : 'owner-review', reason,
        source_revision: source.revision, source_hash: source.hash, source_status: source.status, source_origin: clone(source.origin),
        requested_by_session_id: owner_session_id ?? origin.session_id, origin: clone(origin), requested_at: now() };
      // Also audit no-op opens without changing the staged revision's immutable
      // source, feedback, or the provenance of its original reopening proposal.
      (plan.reopen_requests ??= []).push(reopening);
      let reopened = false;
      if (source.status !== 'staged') {
        if (!['approved', 'rejected', 'closed'].includes(source.status)) fail('INVALID_STATE', 'Plan cannot be reopened from this state');
        const oldPath = plan.path;
        const revision = ++plan.current_revision;
        plan.revisions.push({ revision, title: source.title, content: source.content, hash: source.hash, category: source.category,
          status: 'staged', created_at: now(), origin: clone(origin), reopening, comments: [], decisions: [] });
        plan.path = `staging/${plan.filename.replace(/\.md$/i, '')}.r${revision}.md`;
        this._mirror(state, plan, oldPath, source.content);
        reopened = true;
      }
      const result = { ...this._summary(plan), reopened };
      state.idempotency[key] = { fingerprint, result };
      return result;
    });
  }

  async decide({ plan_id, revision, hash, decision, owner_session_id }) {
    this._writeAllowed();
    if (!['approve', 'reject'].includes(decision)) fail('INVALID_INPUT', 'Invalid decision');
    requireText(owner_session_id, 'owner_session_id');
    return this._transaction(state => {
      const [plan, artifact] = this._get(state, plan_id, revision);
      this._cas(plan, revision, hash);
      const previous = artifact.decisions.find(d => d.decision === decision && d.owner_session_id === owner_session_id);
      if (previous) return { ...previous.result, execution_authorized: this._summary(plan).execution_authorized };
      if (artifact.status !== 'staged') fail('INVALID_STATE', 'Plan is not pending review');
      artifact.status = decision === 'approve' ? 'approved' : 'rejected';
      if (decision === 'approve') {
        const oldPath = plan.path;
        plan.path = `${artifact.category}/${path.basename(oldPath)}`;
        this._mirror(state, plan, oldPath, artifact.content);
      } else for (const comment of activeComments(artifact)) comment.status = 'sent';
      const result = this._summary(plan);
      const comments = activeComments(artifact);
      const notice = { notification_id: randomUUID(), session_id: artifact.origin?.session_id ?? null, plan_id, revision, hash, decision, category: artifact.category, execution_authorized: result.execution_authorized, action: decision === 'approve' ? (result.execution_authorized ? 'execute' : 'saved') : comments.length ? 'revise' : 'wait', comments: decision === 'reject' ? clone(comments) : [], created_at: now(), acknowledged_at: null };
      if (notice.session_id) state.notifications.push(notice);
      result.notification_id = notice.session_id ? notice.notification_id : null;
      artifact.decisions.push({ decision, owner_session_id, revision, hash, category: artifact.category, created_at: now(), result: clone(result) });
      return result;
    });
  }

  async close({ plan_id, expected_revision, outcome, reason, evidence, owner_cancel_authorized = false }) {
    this._writeAllowed();
    requireText(reason, 'reason');
    if (!['completed', 'decided', 'cancelled'].includes(outcome)) fail('INVALID_INPUT', 'Invalid outcome');
    if (evidence !== undefined && (typeof evidence !== 'string' || !evidence.trim())) fail('INVALID_INPUT', 'evidence must be nonempty text');
    return this._transaction(state => {
      const [plan, artifact] = this._get(state, plan_id);
      if (expected_revision !== plan.current_revision) fail('STALE_REVISION', 'Revision changed');
      if (artifact.status === 'closed') {
        if (artifact.closure?.outcome === outcome && artifact.closure.reason === reason && artifact.closure.evidence === (evidence ?? null)) return this._summary(plan);
        fail('INVALID_STATE', 'Plan already closed');
      }
      if (outcome === 'cancelled') {
        if (owner_cancel_authorized !== true) fail('OWNER_REQUIRED', 'Cancellation requires authenticated owner instruction');
      } else {
        if (artifact.status !== 'approved') fail('INVALID_STATE', 'Only approved plans can be closed without cancellation');
        if (outcome === 'completed' && (artifact.category !== 'tasks' || !evidence)) fail('INVALID_INPUT', 'Completion requires approved tasks and evidence');
        if (outcome === 'decided' && (artifact.category !== 'para-o-dono' || !evidence)) fail('INVALID_INPUT', 'Decision closure requires para-o-dono and answer evidence');
      }
      artifact.status = 'closed';
      artifact.closure = { outcome, reason, evidence: evidence ?? null, closed_at: now() };
      const oldPath = plan.path;
      plan.path = `closed/${path.basename(oldPath)}`;
      this._mirror(state, plan, oldPath, artifact.content);
      return this._summary(plan);
    });
  }

  async pendingNotifications(sessionId) {
    requireText(sessionId, 'sessionId');
    return this._transaction(state => state.notifications.filter(n => n.session_id === sessionId && !n.acknowledged_at).map(notice => {
      const plan = state.plans[notice.plan_id];
      const revision = plan?.revisions.at(-1);
      const is_current = revision?.revision === notice.revision && revision?.hash === notice.hash && revision.status !== 'closed';
      return { ...notice, is_current, action: is_current ? notice.action : 'superseded', execution_authorized: is_current && notice.execution_authorized && revision.status === 'approved' && revision.category === 'tasks' };
    }));
  }

  dispose() {
    this.db?.close();
    this.db = null;
    this.readState = null;
    this.readOnly = false;
  }

  async ackNotification(notificationId) {
    this._writeAllowed();
    requireText(notificationId, 'notificationId');
    return this._transaction(state => {
      const notice = state.notifications.find(n => n.notification_id === notificationId);
      if (!notice) fail('NOT_FOUND', 'Unknown notification');
      notice.acknowledged_at ??= now();
      return { notification_id: notificationId, acknowledged_at: notice.acknowledged_at };
    });
  }
}
