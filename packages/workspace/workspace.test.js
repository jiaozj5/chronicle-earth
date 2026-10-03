import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { Workspace } from './index.js';

function fixture(t, options = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'chronicle-a1-'));
  let workspace = new Workspace(path.join(root, 'work'), options);
  const additional = [];
  t.after(() => { for (const item of additional) item.close(); try { workspace.close(); } catch {} rmSync(root, { recursive: true, force: true }); });
  return { root, get workspace() { return workspace; }, open(directory) { const item = new Workspace(directory); additional.push(item); return item; }, reopen() { workspace.close(); workspace = new Workspace(path.join(root, 'work'), options); return workspace; } };
}
const data = body => ({ body, title: '', kind: 'note', status: 'adopted', occurrenceTime: null, placeRefs: [], citations: [] });
const change = (id, body, objectType = 'entry', expectedRevision = 0) => ({ id, objectType, expectedRevision, data: data(body) });
const save = (w, id, body, requestId = id) => w.commit({ requestId, changes: [change(id, body)] });
const code = expected => error => error.code === expected;

test('C06 durable idempotent commit, request collision and revisions survive reopen', t => {
  const f = fixture(t), w = f.workspace;
  const request = { requestId: 'create', changes: [change('one', '我记录江南河流与城市')] };
  const result = w.commit(request);
  assert.equal(result.sequence, 1); assert.equal(w.commit(request).commitId, result.commitId);
  assert.equal(f.reopen().commit(request).commitId, result.commitId);
  assert.throws(() => f.workspace.commit({ ...request, changes: [change('one', '不同内容')] }), code('IDEMPOTENCY_CONFLICT'));
  assert.equal(f.workspace.history('one').length, 1);
  assert.equal(f.workspace.stats().sequence, 1);
});

test('C07 every domain type rejects stale writes across connections; multi-object transaction rolls back', t => {
  const f = fixture(t), w = f.workspace, other = f.open(path.join(f.root, 'work'));
  for (const type of ['entry', 'document', 'knowledge', 'source', 'persona', 'place']) {
    w.commit({ requestId: `create-${type}`, changes: [change(type, '第一版', type)] });
    other.commit({ requestId: `update-${type}`, changes: [change(type, '第二版', type, 1)] });
    assert.throws(() => w.commit({ requestId: `conflict-${type}`, changes: [change(`orphan-${type}`, '不能留下'), change(type, '冲突正文', type, 1)] }), code('VERSION_CONFLICT'));
    assert.equal(w.get(type).data.body, '第二版');
    assert.throws(() => w.get(`orphan-${type}`), code('NOT_FOUND'));
  }
});

test('soft delete / restore preserves object ID, fixed revisions, searchable deleted content and committed events', t => {
  const { workspace: w } = fixture(t), seen = [];
  const unsubscribe = w.subscribe(event => seen.push(event));
  save(w, 'entry', '未来城市');
  w.commit({ requestId: 'delete', changes: [{ ...change('entry', '未来城市', 'entry', 1), deleted: true }] });
  assert.throws(() => w.get('entry'), code('DELETED'));
  assert.equal(w.get('entry', { revision: 1 }).data.body, '未来城市');
  assert.equal(w.list({ q: '城市' }).total, 0);
  assert.equal(w.list({ q: '城市', onlyDeleted: true }).total, 1);
  w.commit({ requestId: 'restore', changes: [{ ...change('entry', '未来城市', 'entry', 2), deleted: false }] });
  assert.equal(w.get('entry').id, 'entry'); assert.equal(w.history('entry').length, 3);
  assert.deepEqual(seen.map(event => event.type), ['ObjectCommitted', 'ObjectDeleted', 'ObjectRestored']);
  assert.equal(w.changesSince(1).items.length, 2); unsubscribe();
});

test('Chinese substring search, literal special characters and draft/status/place/predicate filters precede pagination', t => {
  const { workspace: w } = fixture(t);
  w.commit({ requestId: 'records', changes: [
    { ...change('a', '南京的历史记录，百分比 100% 与 A_B'), data: { ...data('南京的历史记录，百分比 100% 与 A_B'), placeRefs: [{ placeId: 'nanjing' }], status: 'adopted' } },
    { ...change('b', '南京的历史记录二'), data: { ...data('南京的历史记录二'), status: 'inbox' } },
    change('d', '南京的历史记录草稿', 'draft'),
    change('c', '南京的历史记录三')
  ] });
  assert.equal(w.list({ q: '南京' }).total, 3);
  assert.equal(w.list({ q: '历史记录' }).total, 3);
  assert.equal(w.list({ q: '100%' }).total, 1); assert.equal(w.list({ q: 'a_b' }).total, 1);
  assert.equal(w.list({ q: '南京', objectType: 'draft' }).total, 1);
  assert.equal(w.list({ q: '南京', status: 'inbox' }).total, 1);
  assert.equal(w.list({ placeIds: ['nanjing'] }).total, 1);
  const page = w.list({ q: '南京', predicate: object => object.id !== 'a', limit: 1, offset: 1, summary: true });
  assert.equal(page.total, 2); assert.equal(page.items[0].id, 'c'); assert.equal(page.items[0].data.body, undefined);
  assert.equal(w.list({ ids: [] }).total, 0);
});

test('exact source snapshots never expand corpus or silently upgrade revision', t => {
  const { workspace: w } = fixture(t);
  const src = (id, body, rev = 0) => ({ ...change(id, body, 'source', rev), data: { title: id, body, parseStatus: 'ready', format: 'text' } });
  w.commit({ requestId: 'sources', changes: [src('s', '旧版本的河流知识'), src('private', '无关私人河流知识'), { ...src('unparsed', '未解析河流知识'), data: { body: '未解析河流知识', parseStatus: 'unparsed' } }] });
  w.commit({ requestId: 'revision', changes: [src('s', '新版本完全不同', 1)] });
  const result = w.searchSourceVersions([{ sourceId: 's', revision: 1 }, { sourceId: 'unparsed', revision: 1 }], '河流');
  assert.equal(result.items.length, 1); const item = result.items[0]; assert.equal(item.revision, 1); assert.equal(item.sourceId, 's');
  assert.equal(w.get('s', { revision: 1 }).data.body.slice(item.locator.start, item.locator.end), item.text);
  assert.equal(w.searchSourceVersions([{ sourceId: 's', revision: 2 }], '河流').items.length, 0);
  assert.throws(() => w.searchSourceVersions([{ sourceId: 's' }], '河流'), code('REFERENCE_UNAVAILABLE'));
  assert.throws(() => w.searchSourceVersions([{ sourceId: 's', revision: 99 }], '河流'), code('REFERENCE_UNAVAILABLE'));
});

test('C09 paused projection reports its watermark and resumes, failed rebuild preserves prior index', t => {
  let fail = false;
  const { workspace: w } = fixture(t, { fault(point) { if (fail && point === 'duringIndexRebuild') throw new Error('injected index error'); } });
  save(w, 'a', '原始文字'); w.setIndexingPaused(true); save(w, 'b', '新增文字');
  assert.equal(w.get('b').data.body, '新增文字');
  let query = w.list({ q: '新增' }); assert.equal(query.total, 0); assert.equal(query.sequence, 2); assert.equal(query.indexedThroughSequence, 1);
  fail = true; assert.throws(() => w.rebuildIndex(), code('STORAGE_FAILED')); assert.equal(w.list({ q: '原始' }).total, 1);
  fail = false; w.setIndexingPaused(false); query = w.list({ q: '新增' }); assert.equal(query.total, 1); assert.equal(query.indexedThroughSequence, 2);
});

test('D02 before / middle / flush failures leave no half commit; postcommit interruption is idempotently recoverable', t => {
  let stage = '';
  const f = fixture(t, { fault(point) { if (point === stage) { const e = new Error('injected storage failure'); e.code = stage === 'beforeCommit' ? 'ENOSPC' : 'EIO'; throw e; } } });
  for (const point of ['beforeCommit', 'afterObjectWrite', 'beforeCommitFlush']) {
    stage = point;
    assert.throws(() => f.workspace.commit({ requestId: point, changes: [change('a', '第一项'), change('b', '第二项')] }), code(point === 'beforeCommit' ? 'CAPACITY_EXCEEDED' : 'STORAGE_FAILED'));
    stage = ''; assert.equal(f.reopen().stats().sequence, 0); assert.equal(f.workspace.list().total, 0);
  }
  stage = 'afterCommit'; const request = { requestId: 'committed', changes: [change('a', '提交完成但回执中断')] };
  assert.throws(() => f.workspace.commit(request), error => error.code === 'STORAGE_FAILED' && error.details.committed === true);
  stage = ''; const result = f.reopen().commit(request); assert.equal(result.sequence, 1); assert.equal(f.workspace.history('a').length, 1);
});

test('D01 streamed backup restores all revisions, objects, actual attachments, workspace identity and idempotency', async t => {
  const f = fixture(t), w = f.workspace, buffer = Buffer.alloc(3 * 1024 * 1024, 153);
  const attachment = w.putAttachment(buffer, { name: '中文材料—一个很长的文件名.bin', mime: 'application/octet-stream' });
  w.commit({ requestId: 'all', changes: [
    { ...change('s', '材料', 'source'), data: { body: '材料', attachmentIds: [attachment.id], parseStatus: 'unparsed' } },
    change('draft', '未完成', 'draft'), change('prediction', '未来', 'entry'), change('discussion', '讨论', 'discussion'), change('message', '消息', 'message'), change('adoption', '采纳', 'adoption'), change('review', '评估', 'predictionReview')
  ] });
  w.commit({ requestId: 'revise', changes: [{ ...change('s', '材料修订', 'source', 1), data: { body: '材料修订', attachmentIds: [attachment.id], parseStatus: 'ready' }, deleted: true }] });
  const file = path.join(f.root, 'backup.chronicle'), progress = [];
  const exported = await w.exportBackup(file, { onProgress: item => progress.push(item) });
  assert.equal(exported.objects, 7); assert.equal(exported.revisions, 8); assert.equal(progress.at(-1).phase, 'complete'); assert(progress.length >= 5);
  const restored = f.open(path.join(f.root, 'restored'));
  await restored.importBackup(file);
  assert.deepEqual(restored.stats(), w.stats());
  for (const object of w.list({ includeDeleted: true, includeDrafts: true }).items) assert.deepEqual(restored.history(object.id), w.history(object.id));
  assert.deepEqual(restored.getAttachment(attachment.id).buffer, buffer);
  assert.deepEqual(restored.listAttachments(), w.listAttachments());
  assert.equal(restored.commit({ requestId: 'revise', changes: [{ ...change('s', '材料修订', 'source', 1), data: { body: '材料修订', attachmentIds: [attachment.id], parseStatus: 'ready' }, deleted: true }] }).sequence, 2);
  assert.throws(() => restored.get('s'), code('DELETED'));
  await assert.rejects(() => restored.importBackup(file), code('WORKSPACE_NOT_EMPTY'));
});

test('D03 broken/truncated/missing attachment backup never changes empty workspace; recovery can retry', async t => {
  const f = fixture(t), w = f.workspace; save(w, 'a', '可靠内容');
  const att = w.putAttachment(Buffer.from('重要附件'), { name: '附件.txt', mime: 'text/plain' });
  const backupFile = path.join(f.root, 'valid.chronicle'); await w.exportBackup(backupFile);
  const target = f.open(path.join(f.root, 'target'));
  const before = target.stats(); const raw = readFileSync(backupFile);
  for (const [name, bad] of [['truncated', raw.subarray(0, raw.length - 3)], ['tampered', Buffer.from(raw)]]) {
    if (name === 'tampered') bad[bad.length - 1] ^= 1;
    const file = path.join(f.root, name); writeFileSync(file, bad);
    await assert.rejects(() => target.importBackup(file), code('INVALID_BACKUP')); assert.deepEqual(target.stats(), before);
  }
  await target.importBackup(backupFile); assert.equal(target.get('a').data.body, '可靠内容'); assert.equal(target.getAttachment(att.id).buffer.toString(), '重要附件');
});

test('attachments validate actual bytes and failed attachment writes leave no claimed success', t => {
  let fail = false;
  const f = fixture(t, { fault(point) { if (fail && point === 'beforeAttachmentCommit') throw new Error('injected'); } }), w = f.workspace;
  fail = true; assert.throws(() => w.putAttachment(Buffer.from('a'), { name: 'a' }), code('STORAGE_FAILED')); assert.equal(w.listAttachments().length, 0);
  fail = false; const att = w.putAttachment(Buffer.from('test'), { name: 'test' });
  writeFileSync(path.join(f.root, 'work', 'attachments', att.id), 'bad');
  assert.throws(() => w.getAttachment(att.id), code('ATTACHMENT_CORRUPTED'));
  assert.throws(() => w.getAttachment('../workspace.sqlite'), code('INVALID_INPUT'));
});

test('D04 schema initialization failure rolls back; future versions remain untouched', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'chronicle-schema-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(() => new Workspace(root, { fault(point) { if (point === 'duringMigration') throw new Error('migration interrupted'); } }), code('STORAGE_FAILED'));
  const w = new Workspace(root); save(w, 'a', '仍可使用'); w.close();
  const db = new DatabaseSync(path.join(root, 'workspace.sqlite')); db.exec('PRAGMA user_version=99'); db.close();
  assert.throws(() => new Workspace(root), code('UNSUPPORTED_VERSION'));
  const inspect = new DatabaseSync(path.join(root, 'workspace.sqlite')); assert.equal(inspect.prepare('SELECT COUNT(*) AS n FROM objects').get().n, 1); assert.equal(inspect.prepare('PRAGMA user_version').get().user_version, 99); inspect.close();
});

test('restore process exit during file swap rolls back on next launch and preserves original workspace identity', async t => {
  const f = fixture(t); save(f.workspace, 'saved', '备份数据');
  const backupFile = path.join(f.root, 'recovery.chronicle'); await f.workspace.exportBackup(backupFile);
  const targetPath = path.join(f.root, 'crash-target');
  const empty = new Workspace(targetPath); const oldIdentity = empty.stats().workspaceId; empty.close();
  const childSource = `import {Workspace} from ${JSON.stringify(new URL('./index.js', import.meta.url).href)};
    const target = new Workspace(${JSON.stringify(targetPath)}, {fault(point) {if(point==='afterImportFilesSwapped') process.exit(73)}});
    await target.importBackup(${JSON.stringify(backupFile)});`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', childSource], { encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 73, child.stderr);
  const recovered = f.open(targetPath);
  assert.equal(recovered.stats().workspaceId, oldIdentity); assert.equal(recovered.stats().sequence, 0);
  assert.equal(recovered.list().total, 0);
  await recovered.importBackup(backupFile); assert.equal(recovered.get('saved').data.body, '备份数据');
});
