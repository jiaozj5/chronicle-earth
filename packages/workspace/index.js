import { DatabaseSync, backup } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import { DomainError, assert, validateChange, OBJECT_TYPES, titleOf } from '../contracts/index.js';

const SCHEMA_VERSION = 1;
const MAGIC = Buffer.from('CHRONICLE-BACKUP\n');
const MAX_MANIFEST = 64 * 1024 * 1024;
const CHUNK = 1024 * 1024;
const json = value => JSON.stringify(value);
const parse = text => JSON.parse(text);
const sha = value => createHash('sha256').update(value).digest('hex');
const clone = value => parse(json(value));
const canonical = value => json(sortKeys(value));
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])]));
  return value;
}
function storageError(error, details = {}) {
  if (error instanceof DomainError) return error;
  const capacity = error.code === 'ENOSPC' || error.errcode === 13 || /database or disk is full/i.test(error.message);
  return new DomainError(capacity ? 'CAPACITY_EXCEEDED' : 'STORAGE_FAILED', capacity ? '磁盘空间不足，内容尚未确认保存。' : '存储操作失败，请保留当前内容后重试。', { ...details, reason: String(error.message) });
}
function checkedJson(value) {
  try { const result = json(value); assert(typeof result === 'string', '内容无法保存'); return parse(result); }
  catch (error) { if (error instanceof DomainError) throw error; throw new DomainError('INVALID_INPUT', '内容必须可以表示为 JSON。'); }
}
function searchable(data) {
  const values = [];
  const visit = value => { if (typeof value === 'string') values.push(value); else if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value === 'object') Object.values(value).forEach(visit); };
  visit(data);
  return values.join('\n').normalize('NFKC').toLowerCase();
}
function summaryOf(object) {
  const result = clone(object);
  result.data.title ||= titleOf(object);
  result.data.bodyLength = typeof object.data.body === 'string' ? object.data.body.length : 0;
  for (const key of ['body', 'blocks', 'contextSnapshot']) delete result.data[key];
  if(object.objectType==='publication'){result.data.renditionCount=result.data.renditions?.length||0;delete result.data.renditions;delete result.data.attachmentIds;}
  return result;
}
function attachmentRefs(data) {
  const result = new Set();
  const walk = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'attachmentIds' && Array.isArray(child)) child.forEach(id => result.add(id));
      else if (key === 'avatarAttachmentId' && child) result.add(child);
      else if (child && typeof child === 'object') walk(child);
    }
  };
  walk(data); return [...result];
}
function validAttachmentId(id) { return typeof id === 'string' && /^att_[a-f0-9-]{36}$/.test(id); }
async function objectDigest(db, onBatch) {
  const hash = createHash('sha256');
  let count = 0, lastYield = performance.now();
  for (const row of db.prepare('SELECT json FROM revisions ORDER BY object_id, revision').iterate()) {
    hash.update(canonical(parse(row.json))).update('\n');
    count++;
    if (performance.now() - lastYield >= 16) { onBatch?.(count); await new Promise(resolve => setImmediate(resolve)); lastYield = performance.now(); }
  }
  return hash.digest('hex');
}
async function hashFile(filename) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(filename, { highWaterMark: CHUNK })) hash.update(chunk);
  return hash.digest('hex');
}
async function writeAll(handle, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset);
    if (!bytesWritten) throw new DomainError('STORAGE_FAILED', '备份写入未能继续。');
    offset += bytesWritten;
  }
}
async function readExact(handle, count) {
  const result = Buffer.alloc(count); let offset = 0;
  while (offset < count) { const { bytesRead } = await handle.read(result, offset, count - offset); assert(bytesRead > 0, '备份文件不完整。', 'INVALID_BACKUP'); offset += bytesRead; }
  return result;
}

/** Local authority. All mutations are transactional and all methods support await. */
export class Workspace {
  constructor(directory, options = {}) {
    this.directory = path.resolve(directory);
    this.databasePath = path.join(this.directory, 'workspace.sqlite');
    this.attachmentsPath = path.join(this.directory, 'attachments');
    this.listeners = new Set();
    this.options = options;
    this.closed = false;
    this.importing = false;
    this.exporting = 0;
    try { fs.mkdirSync(this.directory, { recursive: true }); this._recoverRestore(); fs.mkdirSync(this.attachmentsPath, { recursive: true }); this._open(); }
    catch (error) { try { this.db?.close(); } catch {} throw storageError(error); }
  }

  _writeRestoreJournal(id, state) {
    const destination = path.join(this.directory, '.restore-journal.json');
    const temp = `${destination}.tmp`;
    const fd = fs.openSync(temp, 'w');
    try { fs.writeFileSync(fd, json({ id, state })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, destination);
  }
  _recoverRestore() {
    const journal = path.join(this.directory, '.restore-journal.json');
    if (!fs.existsSync(journal)) return;
    let entry; try { entry = parse(fs.readFileSync(journal, 'utf8')); } catch { throw new DomainError('STORAGE_FAILED', '恢复日志损坏，已保留工作空间文件。'); }
    assert(/^[a-f0-9-]{36}$/.test(entry.id) && ['pending', 'complete'].includes(entry.state), '恢复日志无效，已保留工作空间文件。', 'STORAGE_FAILED');
    const previous = path.join(this.directory, `.previous-${entry.id}.sqlite`), previousAttachments = path.join(this.directory, `.previous-attachments-${entry.id}`), stage = path.join(this.directory, `.import-${entry.id}`);
    if (entry.state === 'pending') {
      if (fs.existsSync(previous)) {
        for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${this.databasePath}${suffix}`, { force: true });
        fs.renameSync(previous, this.databasePath);
      }
      if (fs.existsSync(previousAttachments)) {
        fs.rmSync(this.attachmentsPath, { recursive: true, force: true });
        fs.renameSync(previousAttachments, this.attachmentsPath);
      }
    } else { fs.rmSync(previous, { force: true }); fs.rmSync(previousAttachments, { recursive: true, force: true }); }
    fs.rmSync(stage, { recursive: true, force: true }); fs.rmSync(journal, { force: true });
  }

  _open() {
    this.db = new DatabaseSync(this.databasePath);
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
    const version = Number(this.db.prepare('PRAGMA user_version').get().user_version);
    assert(version <= SCHEMA_VERSION, '工作空间由更高版本创建，请使用对应版本打开。', 'UNSUPPORTED_VERSION', { version, supported: SCHEMA_VERSION });
    if (version === 0) {
      const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
      assert(!tables.length, '无法识别现有数据库，未改动其中内容。', 'UNSUPPORTED_VERSION');
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.exec(`
          CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE objects (id TEXT PRIMARY KEY, object_type TEXT NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT, json TEXT NOT NULL);
          CREATE INDEX objects_type ON objects(object_type, deleted_at, updated_at DESC, id);
          CREATE TABLE revisions (object_id TEXT NOT NULL, revision INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY(object_id, revision));
          CREATE TABLE commits (request_id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, commit_id TEXT NOT NULL UNIQUE, sequence INTEGER NOT NULL UNIQUE, result TEXT NOT NULL);
          CREATE TABLE events (sequence INTEGER NOT NULL, object_id TEXT NOT NULL, event_type TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(sequence, object_id));
          CREATE TABLE attachments (id TEXT PRIMARY KEY, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL);
          CREATE TABLE object_attachments (object_id TEXT NOT NULL, revision INTEGER NOT NULL, attachment_id TEXT NOT NULL, PRIMARY KEY(object_id, revision, attachment_id), FOREIGN KEY(attachment_id) REFERENCES attachments(id));
          CREATE TABLE search_index (object_id TEXT PRIMARY KEY, content TEXT NOT NULL);
          CREATE VIRTUAL TABLE search_fts USING fts5(object_id UNINDEXED, content, tokenize='trigram');
          PRAGMA user_version=1;
        `);
        const insert = this.db.prepare('INSERT INTO meta(key,value) VALUES (?,?)');
        for (const [key, value] of Object.entries({ workspaceId: randomUUID(), sequence: '0', indexedThroughSequence: '0', indexingPaused: 'false' })) insert.run(key, value);
        this._fault('duringMigration');
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    this.statements = new Map();
  }
  _statement(sql) { let prepared = this.statements.get(sql); if (!prepared) { prepared = this.db.prepare(sql); if (this.statements.size > 100) this.statements.clear(); this.statements.set(sql, prepared); } return prepared; }
  _ensure(writing = false) { assert(!this.closed, '工作空间已经关闭。', 'STORAGE_FAILED'); if (writing) assert(!this.importing, '正在恢复工作空间，请稍后重试。', 'STORAGE_BUSY'); }
  _fault(point, details = {}) { this.options.fault?.(point, details); }
  _meta(key) { return this._statement('SELECT value FROM meta WHERE key=?').get(key)?.value; }
  _setMeta(key, value) { this._statement('INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value)); }
  _index(object) {
    const text = searchable(object.data);
    this._statement('INSERT INTO search_index(object_id,content) VALUES (?,?) ON CONFLICT(object_id) DO UPDATE SET content=excluded.content').run(object.id, text);
    const rowid = this._statement('SELECT rowid FROM search_index WHERE object_id=?').get(object.id).rowid;
    this._statement('DELETE FROM search_fts WHERE rowid=?').run(rowid);
    this._statement('INSERT INTO search_fts(rowid,object_id,content) VALUES (?,?,?)').run(rowid, object.id, text);
  }

  // Application adapters use immutable receipts to reconstruct idempotent calls.
  getCommit(requestId) {
    this._ensure();
    assert(typeof requestId === 'string' && requestId.length > 0 && requestId.length <= 250, '每次保存需要有效的请求标识。');
    const prior = this._statement('SELECT result FROM commits WHERE request_id=?').get(requestId);
    return prior ? parse(prior.result) : null;
  }

  // Lets the application return a durable receipt before revalidating live refs
  // whose source might legitimately have changed after the original commit.
  replayCommit({ requestId, changes } = {}) {
    this._ensure();
    assert(typeof requestId === 'string' && requestId.length > 0 && requestId.length <= 250, '每次保存需要有效的请求标识。');
    assert(Array.isArray(changes) && changes.length > 0 && changes.length <= 100000, '提交需要至少一项变更。');
    const prior = this._statement('SELECT payload_hash,result FROM commits WHERE request_id=?').get(requestId);
    if (!prior) return null;
    assert(prior.payload_hash === sha(canonical(checkedJson(changes))), '这个请求标识已经用于不同内容，请重新提交。', 'IDEMPOTENCY_CONFLICT');
    return parse(prior.result);
  }

  commit({ requestId, changes } = {}) {
    this._ensure(true);
    assert(typeof requestId === 'string' && requestId.length > 0 && requestId.length <= 250, '每次保存需要有效的请求标识。');
    assert(Array.isArray(changes) && changes.length > 0 && changes.length <= 100000, '提交需要至少一项变更。');
    const normalized = checkedJson(changes);
    const seen = new Set();
    for (const change of normalized) { validateChange(change); assert(!seen.has(change.id), '同一提交中不能重复修改同一对象。'); seen.add(change.id); if ('deleted' in change) assert(typeof change.deleted === 'boolean', '删除状态无效。'); }
    const payloadHash = sha(canonical(normalized));
    let committed = false;
    let result;
    const published = [];
    try {
      this._fault('beforeCommit'); this.db.exec('BEGIN IMMEDIATE');
      const prior = this._statement('SELECT payload_hash,result FROM commits WHERE request_id=?').get(requestId);
      if (prior) { assert(prior.payload_hash === payloadHash, '这个请求标识已经用于不同内容，请重新提交。', 'IDEMPOTENCY_CONFLICT'); this.db.exec('COMMIT'); return parse(prior.result); }
      const sequence = Number(this._meta('sequence')) + 1;
      const commitId = `commit_${randomUUID()}`;
      const now = new Date().toISOString();
      const objects = [];
      for (const change of normalized) {
        const row = this._statement('SELECT json FROM objects WHERE id=?').get(change.id);
        const current = row ? parse(row.json) : null;
        assert((current?.revision || 0) === change.expectedRevision, '内容已被其他编辑更新，请保留你的修改并查看最新版本。', 'VERSION_CONFLICT', { id: change.id, expectedRevision: change.expectedRevision, currentRevision: current?.revision || 0, current });
        assert(!current || current.objectType === change.objectType, '不能改变已有内容的类型。');
        const revision = (current?.revision || 0) + 1;
        const deletedAt = change.deleted === true ? (current?.deletedAt || now) : change.deleted === false ? null : (current?.deletedAt || null);
        const object = { id: change.id, objectType: change.objectType, revision, createdAt: current?.createdAt || now, updatedAt: now, deletedAt, data: change.data };
        const encoded = json(object);
        this._statement('INSERT INTO objects(id,object_type,revision,updated_at,deleted_at,json) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,updated_at=excluded.updated_at,deleted_at=excluded.deleted_at,json=excluded.json').run(object.id, object.objectType, revision, now, deletedAt, encoded);
        this._statement('INSERT INTO revisions(object_id,revision,json) VALUES (?,?,?)').run(object.id, revision, encoded);
        for (const attachmentId of attachmentRefs(object.data)) {
          assert(typeof attachmentId === 'string' && this._statement('SELECT id FROM attachments WHERE id=?').get(attachmentId), '引用的附件尚未保存或不可用。', 'REFERENCE_UNAVAILABLE', { attachmentId });
          this._statement('INSERT INTO object_attachments(object_id,revision,attachment_id) VALUES (?,?,?)').run(object.id, revision, attachmentId);
        }
        if (this._meta('indexingPaused') !== 'true') this._index(object);
        const eventType = deletedAt && !current?.deletedAt ? 'ObjectDeleted' : !deletedAt && current?.deletedAt ? 'ObjectRestored' : 'ObjectCommitted';
        const event = { type: eventType, objectId: object.id, objectType: object.objectType, revision, commitId, workspaceSequence: sequence };
        this._statement('INSERT INTO events(sequence,object_id,event_type,json) VALUES (?,?,?,?)').run(sequence, object.id, eventType, json(event));
        published.push(event); objects.push(object);
        this._fault('afterObjectWrite', { id: object.id, index: objects.length - 1 });
      }
      result = { commitId, sequence, objects };
      this._setMeta('sequence', sequence);
      if (this._meta('indexingPaused') !== 'true') this._setMeta('indexedThroughSequence', sequence);
      this._statement('INSERT INTO commits(request_id,payload_hash,commit_id,sequence,result) VALUES (?,?,?,?,?)').run(requestId, payloadHash, commitId, sequence, json(result));
      this._fault('beforeCommitFlush'); this.db.exec('COMMIT'); committed = true;
      this._fault('afterCommit', { commitId, sequence });
    } catch (error) { if (!committed) { try { this.db.exec('ROLLBACK'); } catch {} } throw storageError(error, { committed, requestId }); }
    for (const event of published) for (const listener of this.listeners) { try { listener(event); } catch {} }
    return result;
  }

  get(id, { revision, includeDeleted = false } = {}) {
    this._ensure();
    assert(typeof id === 'string', '内容标识无效。');
    if (revision !== undefined) assert(Number.isInteger(revision) && revision > 0, '版本号无效。');
    try {
      const row = revision === undefined ? this._statement('SELECT json FROM objects WHERE id=?').get(id) : this._statement('SELECT json FROM revisions WHERE object_id=? AND revision=?').get(id, revision);
      assert(row, '找不到该内容或版本。', 'NOT_FOUND', { id, revision });
      const object = parse(row.json);
      assert(!object.deletedAt || includeDeleted, '该内容已在回收站中，可以恢复后继续使用。', 'DELETED', { id, revision: object.revision });
      return object;
    } catch (error) { throw storageError(error); }
  }

  list(options = {}) {
    this._ensure();
    const { objectType, objectTypes, q = '', includeDeleted = false, onlyDeleted = false, ids, summary = false, status, kind, placeIds, unlocated, predicate } = options;
    const limit = options.limit ?? 50, offset = options.offset ?? 0;
    assert(Number.isInteger(limit) && limit >= 0 && limit <= 1000000 && Number.isInteger(offset) && offset >= 0, '分页范围无效。');
    assert(typeof q === 'string', '搜索词无效。');
    assert(!predicate || typeof predicate === 'function', '筛选函数无效。');
    const filters = [], params = [];
    if (onlyDeleted) filters.push('o.deleted_at IS NOT NULL'); else if (!includeDeleted) filters.push('o.deleted_at IS NULL');
    const types = objectTypes || (objectType ? [objectType] : null);
    if (types) { assert(Array.isArray(types) && types.every(type => OBJECT_TYPES.includes(type)), '筛选类型无效。'); filters.push('o.object_type IN (SELECT value FROM json_each(?))'); params.push(json(types)); }
    else if (!options.includeDrafts) filters.push("o.object_type != 'draft'");
    if (ids) { assert(Array.isArray(ids), '标识筛选无效。'); filters.push('o.id IN (SELECT value FROM json_each(?))'); params.push(json(ids)); }
    for (const [field, value] of Object.entries({ status, kind })) if (value !== undefined && value !== null && value !== '') { filters.push(`json_extract(o.json,'$.data.${field}')=?`); params.push(value); }
    if (placeIds?.length) { assert(Array.isArray(placeIds), '地点筛选无效。'); filters.push("EXISTS (SELECT 1 FROM json_each(o.json,'$.data.placeRefs') pr WHERE json_extract(pr.value,'$.placeId') IN (SELECT value FROM json_each(?)))"); params.push(json(placeIds)); }
    if (unlocated) filters.push("(json_array_length(o.json,'$.data.placeRefs') IS NULL OR json_array_length(o.json,'$.data.placeRefs')=0 OR json_extract(o.json,'$.data.occurrenceTime') IS NULL OR json_extract(o.json,'$.data.occurrenceTime.kind')='unknown')");
    const terms = q.trim().normalize('NFKC').toLowerCase().split(/\s+/u).filter(Boolean);
    for (const term of terms) {
      // Trigrams accelerate longer literal searches; short CJK words retain exact substring semantics.
      if ([...term].length >= 3 && !/[%_]/.test(term)) { filters.push('o.id IN (SELECT object_id FROM search_fts WHERE content LIKE ?)'); params.push(`%${term}%`); }
      else { filters.push('EXISTS (SELECT 1 FROM search_index si WHERE si.object_id=o.id AND instr(si.content,?)>0)'); params.push(term); }
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const base = `SELECT o.json FROM objects o ${where} ORDER BY o.updated_at DESC,o.id ASC`;
    try {
      let items, total;
      if (predicate) {
        items = []; total = 0;
        for (const row of this._statement(base).iterate(...params)) { const object = parse(row.json); if (predicate(object)) { if (total >= offset && items.length < limit) items.push(summary ? summaryOf(object) : object); total++; } }
      } else {
        total = Number(this._statement(`SELECT COUNT(*) AS total FROM objects o ${where}`).get(...params).total);
        items = this._statement(`${base} LIMIT ? OFFSET ?`).all(...params, limit, offset).map(row => { const object = parse(row.json); return summary ? summaryOf(object) : object; });
      }
      return { items, total, sequence: Number(this._meta('sequence')), indexedThroughSequence: Number(this._meta('indexedThroughSequence')) };
    } catch (error) { throw storageError(error); }
  }

  history(id) { this._ensure(); const rows = this._statement('SELECT json FROM revisions WHERE object_id=? ORDER BY revision DESC').all(id); assert(rows.length, '找不到该内容。', 'NOT_FOUND', { id }); return rows.map(row => parse(row.json)); }
  searchSourceVersions(sourceRefs, query, { limit = 8 } = {}) {
    this._ensure(); assert(Array.isArray(sourceRefs), '资料范围无效。'); assert(typeof query === 'string' && Number.isInteger(limit) && limit >= 0 && limit <= 1000, '检索条件无效。');
    const terms = query.trim().toLowerCase().split(/\s+/u).filter(Boolean), items = [], seen = new Set();
    for (const ref of sourceRefs) {
      assert(ref && typeof ref.sourceId === 'string' && Number.isInteger(ref.revision) && ref.revision > 0, '资料必须指定准确版本。', 'REFERENCE_UNAVAILABLE');
      const key = `${ref.sourceId}:${ref.revision}`; if (seen.has(key)) continue; seen.add(key);
      let source; try { source = this.get(ref.sourceId, { revision: ref.revision, includeDeleted: true }); } catch { throw new DomainError('REFERENCE_UNAVAILABLE', '指定的资料版本不可用，未扩大检索范围。', ref); }
      assert(source.objectType === 'source', '检索范围包含非资料对象。', 'REFERENCE_UNAVAILABLE', ref);
      if (source.deletedAt || source.data.parseStatus !== 'ready' || typeof source.data.body !== 'string') continue;
      const body = source.data.body, lower = body.toLowerCase();
      let index = 0;
      if (terms.length) { const matches = terms.map(term => lower.indexOf(term)); if (matches.some(value => value < 0)) continue; index = Math.min(...matches); }
      const start = Math.max(0, index - 160), end = Math.min(body.length, Math.max(index + 700, start + 1000));
      items.push({ sourceId: source.id, revision: source.revision, title: titleOf(source), text: body.slice(start, end), locator: { start, end } });
    }
    return { items: items.slice(0, limit), sequence: Number(this._meta('sequence')) };
  }

  putAttachment(buffer, { name = '附件', mime = 'application/octet-stream' } = {}) {
    this._ensure(true); assert(Buffer.isBuffer(buffer) || buffer instanceof Uint8Array, '附件内容无效。');
    assert(typeof name === 'string' && name.length > 0 && name.length <= 1000 && typeof mime === 'string' && mime.length <= 250, '附件信息无效。');
    const id = `att_${randomUUID()}`, temp = path.join(this.attachmentsPath, `${id}.tmp`), target = path.join(this.attachmentsPath, id);
    const metadata = { id, name, mime, size: buffer.length, sha256: sha(buffer) };
    let transaction = false;
    try {
      const fd = fs.openSync(temp, 'wx'); try { fs.writeFileSync(fd, buffer); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      this._fault('beforeAttachmentRename'); fs.renameSync(temp, target);
      this.db.exec('BEGIN IMMEDIATE'); transaction = true;
      this._statement('INSERT INTO attachments(id,name,mime,size,sha256) VALUES (?,?,?,?,?)').run(id, name, mime, buffer.length, metadata.sha256);
      this._fault('beforeAttachmentCommit'); this.db.exec('COMMIT'); transaction = false;
      return metadata;
    } catch (error) { if (transaction) this.db.exec('ROLLBACK'); try { fs.rmSync(temp, { force: true }); fs.rmSync(target, { force: true }); } catch {} throw storageError(error); }
  }
  async putAttachmentFile(filename, { name = '附件', mime = 'application/octet-stream' } = {}) {
    this._ensure(true);
    assert(typeof name === 'string' && name.length > 0 && name.length <= 1000 && typeof mime === 'string' && mime.length <= 250, '附件信息无效。');
    const id = `att_${randomUUID()}`, temp = path.join(this.attachmentsPath, `${id}.tmp`), target = path.join(this.attachmentsPath, id);
    let transaction = false;
    try {
      await fsp.copyFile(filename, temp, fs.constants.COPYFILE_EXCL);
      const handle = await fsp.open(temp, 'r+'); try { await handle.sync(); } finally { await handle.close(); }
      const metadata = { id, name, mime, size: (await fsp.stat(temp)).size, sha256: await hashFile(temp) };
      this._ensure(true); this._fault('beforeAttachmentRename'); fs.renameSync(temp, target);
      this.db.exec('BEGIN IMMEDIATE'); transaction = true;
      this._statement('INSERT INTO attachments(id,name,mime,size,sha256) VALUES (?,?,?,?,?)').run(id, name, mime, metadata.size, metadata.sha256);
      this._fault('beforeAttachmentCommit'); this.db.exec('COMMIT'); transaction = false;
      return metadata;
    } catch (error) { if (transaction) this.db.exec('ROLLBACK'); try { await fsp.rm(temp, { force: true }); await fsp.rm(target, { force: true }); } catch {} throw storageError(error); }
  }
  getAttachmentInfo(id) {
    this._ensure(); assert(validAttachmentId(id), '附件标识无效。');
    const metadata = this._statement('SELECT * FROM attachments WHERE id=?').get(id); assert(metadata, '附件不存在。', 'NOT_FOUND');
    return { ...metadata };
  }
  async getAttachmentFile(id) {
    const metadata = this.getAttachmentInfo(id), filename = path.join(this.attachmentsPath, id);
    try { assert((await fsp.stat(filename)).size === metadata.size && await hashFile(filename) === metadata.sha256, '附件完整性校验失败。', 'ATTACHMENT_CORRUPTED', { id }); return { ...metadata, path: filename }; }
    catch (error) { throw storageError(error, { id }); }
  }
  getAttachment(id) {
    this._ensure(); assert(validAttachmentId(id), '附件标识无效。');
    const metadata = this._statement('SELECT * FROM attachments WHERE id=?').get(id); assert(metadata, '附件不存在。', 'NOT_FOUND');
    try { const buffer = fs.readFileSync(path.join(this.attachmentsPath, id)); assert(buffer.length === metadata.size && sha(buffer) === metadata.sha256, '附件完整性校验失败。', 'ATTACHMENT_CORRUPTED', { id }); return { ...metadata, buffer }; }
    catch (error) { throw storageError(error, { id }); }
  }
  listAttachments() { this._ensure(); return this._statement('SELECT * FROM attachments ORDER BY id').all().map(row => ({ ...row })); }

  stats() {
    this._ensure(); const counts = {};
    for (const row of this._statement('SELECT object_type,COUNT(*) AS count FROM objects WHERE deleted_at IS NULL GROUP BY object_type').all()) counts[row.object_type] = Number(row.count);
    return { sequence: Number(this._meta('sequence')), indexedThroughSequence: Number(this._meta('indexedThroughSequence')), counts, workspaceId: this._meta('workspaceId'), attachments: Number(this._statement('SELECT COUNT(*) AS n FROM attachments').get().n), deleted: Number(this._statement('SELECT COUNT(*) AS n FROM objects WHERE deleted_at IS NOT NULL').get().n) };
  }
  changesSince(sequence = 0, { limit = 10000 } = {}) {
    this._ensure(); assert(Number.isInteger(sequence) && sequence >= 0 && Number.isInteger(limit) && limit > 0 && limit <= 100000, '变更序号或批次大小无效。');
    // A cursor always ends at a whole commit, never in the middle of an atomic change set.
    const items = this._statement('SELECT json FROM events WHERE sequence IN (SELECT DISTINCT sequence FROM events WHERE sequence>? ORDER BY sequence LIMIT ?) ORDER BY sequence,object_id').all(sequence, limit).map(row => parse(row.json));
    return { items, sequence: Number(this._meta('sequence')), nextSequence: items.at(-1)?.workspaceSequence ?? sequence };
  }
  subscribe(listener) { assert(typeof listener === 'function', '监听器无效。'); this.listeners.add(listener); return () => this.listeners.delete(listener); }
  rebuildIndex() {
    this._ensure(true);
    try {
      this.db.exec('BEGIN IMMEDIATE'); this.db.exec('DELETE FROM search_index; DELETE FROM search_fts;');
      for (const row of this._statement('SELECT json FROM objects').iterate()) this._index(parse(row.json));
      this._fault('duringIndexRebuild'); this._setMeta('indexedThroughSequence', this._meta('sequence')); this.db.exec('COMMIT');
      return { indexedThroughSequence: Number(this._meta('indexedThroughSequence')) };
    } catch (error) { try { this.db.exec('ROLLBACK'); } catch {} throw storageError(error); }
  }
  setIndexingPaused(paused) {
    this._ensure(true); assert(typeof paused === 'boolean', '索引状态无效。');
    if (!paused) {
      try {
        this.db.exec('BEGIN IMMEDIATE');
        const since = Number(this._meta('indexedThroughSequence'));
        for (const row of this._statement('SELECT o.json FROM objects o WHERE o.id IN (SELECT object_id FROM events WHERE sequence>?)').iterate(since)) this._index(parse(row.json));
        this._setMeta('indexedThroughSequence', this._meta('sequence')); this._setMeta('indexingPaused', 'false'); this.db.exec('COMMIT');
      } catch (error) { try { this.db.exec('ROLLBACK'); } catch {} throw storageError(error); }
    } else this._setMeta('indexingPaused', 'true');
    return this.stats();
  }

  async exportBackup(destinationFile, { onProgress } = {}) {
    this._ensure(); assert(!this.importing, '正在恢复工作空间。', 'STORAGE_BUSY');
    const target = path.resolve(destinationFile);
    assert(target !== this.databasePath && !target.startsWith(`${this.attachmentsPath}${path.sep}`), '备份不能覆盖工作空间内容。');
    const temp = `${target}.${randomUUID()}.partial`, snapshot = path.join(this.directory, `.snapshot-${randomUUID()}.sqlite`);
    let output, snapshotDb;
    this.exporting++;
    const progress = value => { try { onProgress?.(value); } catch {} };
    try {
      progress({ phase: 'snapshot', completedBytes: 0, totalBytes: null });
      await backup(this.db, snapshot, { rate: 256 });
      snapshotDb = new DatabaseSync(snapshot, { readOnly: true });
      const attachments = snapshotDb.prepare('SELECT * FROM attachments ORDER BY id').all().map(row => ({ ...row }));
      const snapshotStat = await fsp.stat(snapshot);
      const manifest = { format: 'chronicle-workspace', formatVersion: 1, schemaVersion: SCHEMA_VERSION, exportedAt: new Date().toISOString(), workspaceId: snapshotDb.prepare("SELECT value FROM meta WHERE key='workspaceId'").get().value, objects: Number(snapshotDb.prepare('SELECT COUNT(*) AS n FROM objects').get().n), revisions: Number(snapshotDb.prepare('SELECT COUNT(*) AS n FROM revisions').get().n), revisionsDigest: await objectDigest(snapshotDb, count => progress({ phase: 'verify-revisions', completedObjects: count, completedBytes: 0, totalBytes: null })), database: { size: snapshotStat.size, sha256: await hashFile(snapshot) }, attachments };
      snapshotDb.close(); snapshotDb = null;
      const manifestBytes = Buffer.from(json(manifest)); assert(manifestBytes.length <= MAX_MANIFEST, '备份清单过大。', 'CAPACITY_EXCEEDED');
      const header = Buffer.alloc(4); header.writeUInt32BE(manifestBytes.length);
      await fsp.mkdir(path.dirname(target), { recursive: true }); output = await fsp.open(temp, 'wx');
      await writeAll(output, MAGIC); await writeAll(output, header); await writeAll(output, manifestBytes);
      const totalBytes = manifest.database.size + attachments.reduce((sum, item) => sum + item.size, 0); let completedBytes = 0;
      const copy = async (filename, descriptor, phase) => {
        const hash = createHash('sha256'); let copied = 0;
        for await (const chunk of fs.createReadStream(filename, { highWaterMark: CHUNK })) { await writeAll(output, chunk); hash.update(chunk); copied += chunk.length; completedBytes += chunk.length; progress({ phase, completedBytes, totalBytes }); }
        assert(copied === descriptor.size && hash.digest('hex') === descriptor.sha256, '备份时发现文件不完整，未生成成功备份。', 'ATTACHMENT_CORRUPTED', { filename });
      };
      await copy(snapshot, manifest.database, 'database');
      for (const item of attachments) await copy(path.join(this.attachmentsPath, item.id), item, 'attachments');
      await output.sync(); await output.close(); output = null;
      // Refuse replacement so a successful older backup is never lost by a failed retry.
      await fsp.link(temp, target); await fsp.unlink(temp);
      progress({ phase: 'complete', completedBytes, totalBytes });
      return { path: target, objects: manifest.objects, attachments: attachments.length, revisions: manifest.revisions, sha256: manifest.revisionsDigest };
    } catch (error) { throw storageError(error); }
    finally { this.exporting--; try { snapshotDb?.close(); await output?.close(); } catch {} await fsp.rm(snapshot, { force: true }).catch(() => {}); await fsp.rm(temp, { force: true }).catch(() => {}); }
  }

  async importBackup(sourceFile, { onProgress } = {}) {
    this._ensure(true); assert(this.exporting === 0, '备份导出尚未完成，请稍后恢复。', 'STORAGE_BUSY');
    const empty = () => Number(this.db.prepare('SELECT COUNT(*) AS n FROM objects').get().n) === 0 && Number(this.db.prepare('SELECT COUNT(*) AS n FROM attachments').get().n) === 0 && Number(this.db.prepare('SELECT COUNT(*) AS n FROM commits').get().n) === 0;
    assert(empty(), '恢复只能在新的空工作空间中进行，当前数据未被修改。', 'WORKSPACE_NOT_EMPTY');
    this.importing = true;
    const restoreId = randomUUID();
    const stage = path.join(this.directory, `.import-${restoreId}`), stagedDb = path.join(stage, 'workspace.sqlite'), stagedAttachments = path.join(stage, 'attachments');
    let input, candidate, switched = false, oldClosed = false;
    const oldPath = path.join(this.directory, `.previous-${restoreId}.sqlite`), oldAttachments = path.join(this.directory, `.previous-attachments-${restoreId}`);
    const progress = value => { try { onProgress?.(value); } catch {} };
    try {
      await fsp.mkdir(stagedAttachments, { recursive: true }); input = await fsp.open(sourceFile, 'r');
      assert((await readExact(input, MAGIC.length)).equals(MAGIC), '这不是可识别的岁月史书备份。', 'INVALID_BACKUP');
      const length = (await readExact(input, 4)).readUInt32BE(); assert(length > 0 && length <= MAX_MANIFEST, '备份清单长度无效。', 'INVALID_BACKUP');
      let manifest; try { manifest = parse((await readExact(input, length)).toString('utf8')); } catch { throw new DomainError('INVALID_BACKUP', '备份清单无法读取。'); }
      assert(manifest.format === 'chronicle-workspace' && manifest.formatVersion === 1 && manifest.schemaVersion === SCHEMA_VERSION, '备份版本不兼容。', 'UNSUPPORTED_VERSION');
      assert(Array.isArray(manifest.attachments) && manifest.attachments.length <= 100000, '附件清单无效。', 'INVALID_BACKUP');
      const ids = new Set();
      const descriptorValid = item => item && Number.isSafeInteger(item.size) && item.size >= 0 && typeof item.sha256 === 'string' && /^[a-f0-9]{64}$/.test(item.sha256);
      assert(descriptorValid(manifest.database), '数据库清单无效。', 'INVALID_BACKUP');
      for (const item of manifest.attachments) { assert(descriptorValid(item) && validAttachmentId(item.id) && !ids.has(item.id) && typeof item.name === 'string' && typeof item.mime === 'string', '附件清单包含无效或重复项目。', 'INVALID_BACKUP'); ids.add(item.id); }
      const totalBytes = manifest.database.size + manifest.attachments.reduce((sum, item) => sum + item.size, 0); let completedBytes = 0;
      assert(Number.isSafeInteger(totalBytes), '备份文件大小无效。', 'INVALID_BACKUP');
      const inputStat = await input.stat(); assert(inputStat.size === MAGIC.length + 4 + length + totalBytes, '备份长度不符，文件可能损坏或缺失附件。', 'INVALID_BACKUP');
      const extract = async (filename, descriptor, phase) => {
        const output = await fsp.open(filename, 'wx'); const hash = createHash('sha256'); let remaining = descriptor.size;
        try {
          while (remaining > 0) { const bytes = await readExact(input, Math.min(CHUNK, remaining)); await writeAll(output, bytes); hash.update(bytes); remaining -= bytes.length; completedBytes += bytes.length; progress({ phase, completedBytes, totalBytes }); }
          await output.sync();
        } finally { await output.close(); }
        assert(hash.digest('hex') === descriptor.sha256, '备份内容校验失败，当前工作空间未被修改。', 'INVALID_BACKUP', { filename: path.basename(filename) });
      };
      await extract(stagedDb, manifest.database, 'database');
      for (const item of manifest.attachments) await extract(path.join(stagedAttachments, item.id), item, 'attachments');
      await input.close(); input = null;
      candidate = new DatabaseSync(stagedDb, { readOnly: true });
      assert(candidate.prepare('PRAGMA integrity_check').get().integrity_check === 'ok', '备份数据库未通过完整性检查。', 'INVALID_BACKUP');
      assert(Number(candidate.prepare('PRAGMA user_version').get().user_version) === SCHEMA_VERSION, '备份数据库版本不兼容。', 'UNSUPPORTED_VERSION');
      assert(candidate.prepare("SELECT value FROM meta WHERE key='workspaceId'").get().value === manifest.workspaceId, '工作空间身份不匹配。', 'INVALID_BACKUP');
      assert(Number(candidate.prepare('SELECT COUNT(*) AS n FROM objects').get().n) === manifest.objects && Number(candidate.prepare('SELECT COUNT(*) AS n FROM revisions').get().n) === manifest.revisions && await objectDigest(candidate, count => progress({ phase: 'verify-revisions', completedObjects: count, completedBytes, totalBytes })) === manifest.revisionsDigest, '备份对象或版本不完整。', 'INVALID_BACKUP');
      assert(canonical(candidate.prepare('SELECT * FROM attachments ORDER BY id').all()) === canonical(manifest.attachments), '备份附件清单与数据库不一致。', 'INVALID_BACKUP');
      assert(candidate.prepare('PRAGMA foreign_key_check').all().length === 0, '备份引用不完整。', 'INVALID_BACKUP');
      let checked = 0;
      for (const row of candidate.prepare('SELECT json FROM objects').iterate()) {
        const object = parse(row.json); assert(OBJECT_TYPES.includes(object.objectType) && typeof object.id === 'string' && object.revision >= 1 && object.data && typeof object.data === 'object', '备份包含无效对象。', 'INVALID_BACKUP');
        const latest = candidate.prepare('SELECT json FROM revisions WHERE object_id=? AND revision=?').get(object.id, object.revision);
        assert(latest && canonical(parse(latest.json)) === canonical(object), '备份当前对象与历史版本不一致。', 'INVALID_BACKUP');
        for (const id of attachmentRefs(object.data)) assert(ids.has(id), '备份缺少已引用的附件。', 'INVALID_BACKUP', { id });
        if (++checked % 100 === 0) await new Promise(resolve => setImmediate(resolve));
      }
      candidate.close(); candidate = null;
      assert(empty(), '恢复期间工作空间发生变化，未覆盖现有内容。', 'WORKSPACE_NOT_EMPTY');
      this._fault('beforeImportSwap'); this._writeRestoreJournal(restoreId, 'pending'); this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); this.db.close(); oldClosed = true; this.statements.clear();
      fs.renameSync(this.databasePath, oldPath); fs.renameSync(this.attachmentsPath, oldAttachments);
      try { fs.renameSync(stagedDb, this.databasePath); fs.renameSync(stagedAttachments, this.attachmentsPath); this._fault('afterImportFilesSwapped'); this._open(); this._writeRestoreJournal(restoreId, 'complete'); switched = true; }
      catch (error) { try { this.db?.close(); } catch {} this._recoverRestore(); this._open(); oldClosed = false; throw error; }
      progress({ phase: 'complete', completedBytes, totalBytes });
      return { workspaceId: manifest.workspaceId, objects: manifest.objects, attachments: manifest.attachments.length, revisions: manifest.revisions, sequence: Number(this._meta('sequence')) };
    } catch (error) { if (oldClosed && !switched) { try { if (!fs.existsSync(this.databasePath) && fs.existsSync(oldPath)) fs.renameSync(oldPath, this.databasePath); if (!fs.existsSync(this.attachmentsPath) && fs.existsSync(oldAttachments)) fs.renameSync(oldAttachments, this.attachmentsPath); this._open(); } catch {} } throw storageError(error); }
    finally {
      this.importing = false; try { candidate?.close(); await input?.close(); } catch {}
      await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
      if (switched) { await fsp.rm(oldPath, { force: true }).catch(() => {}); await fsp.rm(oldAttachments, { recursive: true, force: true }).catch(() => {}); }
      // A completed rollback or completed swap no longer needs crash recovery on next launch.
      if (switched || (!fs.existsSync(oldPath) && !fs.existsSync(oldAttachments))) await fsp.rm(path.join(this.directory, '.restore-journal.json'), { force: true }).catch(() => {});
    }
  }

  close() { if (this.closed) return; assert(!this.exporting && !this.importing, '备份任务尚未完成。', 'STORAGE_BUSY'); this.db.close(); this.closed = true; this.listeners.clear(); }
}

export { SCHEMA_VERSION };
