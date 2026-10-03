import test from 'node:test';
import assert from 'node:assert/strict';
import { DomainError, refOf } from '../../packages/contracts/index.js';
import { blankEntry, DraftSession, prepareEntryChange, prepareReviewChange, prepareAdoptionChange, prepareUndoChange } from './service.js';

// Explicit API fixture: tests business sequencing and retention, not disk durability.
function fixture(initial = []) {
  const objects = new Map(initial.map(object => [object.id, structuredClone(object)]));
  const requests = new Map(), calls = [];
  let beforeFailure = null, afterFailure = null, gate = null;
  const api = {
    objects, calls,
    failBefore(error) { beforeFailure = error; },
    failAfter(error) { afterFailure = error; },
    delayWith(promise) { gate = promise; },
    async commit(changes, requestId) {
      calls.push({ changes: structuredClone(changes), requestId });
      if (gate) { const wait = gate; gate = null; await wait; }
      if (beforeFailure) { const failure = beforeFailure; beforeFailure = null; throw failure; }
      const existingRequest = requests.get(requestId);
      if (existingRequest) {
        assert.deepEqual(existingRequest.changes, changes, 'A retry must reuse the same payload');
        return structuredClone(existingRequest.response);
      }
      for (const change of changes) {
        const current = objects.get(change.id);
        if ((current?.revision || 0) !== change.expectedRevision) throw new DomainError('VERSION_CONFLICT', '版本冲突');
      }
      const saved = changes.map(change => ({ id: change.id, objectType: change.objectType, revision: change.expectedRevision + 1, createdAt: objects.get(change.id)?.createdAt || '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', deletedAt: change.deleted ? '2026-10-01T00:00:00.000Z' : null, data: structuredClone(change.data) }));
      saved.forEach(object => objects.set(object.id, object));
      const response = { commitId: requestId, sequence: calls.length, objects: saved };
      requests.set(requestId, { changes: structuredClone(changes), response: structuredClone(response) });
      if (afterFailure) { const failure = afterFailure; afterFailure = null; throw failure; }
      return response;
    },
  };
  return api;
}
function object(body = '原文', kind = 'note') { return { id: 'entry_fixed', objectType: 'entry', revision: 1, deletedAt: null, data: { ...blankEntry(), body, kind, ...(kind === 'prediction' ? { initialPredictionRevision: 1 } : {}) } }; }

test('one sentence can be committed without title, place, time, or source', async () => {
  const api = fixture(), session = new DraftSession(api);
  session.update({ body: '这是我的理解，即使暂时没有材料。' });
  const saved = await session.submit();
  assert.equal(saved.objectType, 'entry'); assert.equal(saved.data.body, '这是我的理解，即使暂时没有材料。');
  assert.equal(saved.data.occurrenceTime, null); assert.deepEqual(saved.data.placeRefs, []);
  assert.equal(api.calls.at(-1).changes.length, 2, 'entry + draft deletion in one commit');
  assert.ok(api.objects.get(session.draftId).deletedAt);
});

test('draft context is captured independently of subsequent map selection', async () => {
  const selection = { placeRefs: [{ placeId: 'place_old', originalName: '旧城', confirmed: true }], occurrenceTime: { originalText: '1850', kind: 'instant' } };
  const api = fixture(), session = new DraftSession(api, { selection });
  selection.placeRefs[0].placeId = 'place_new'; selection.occurrenceTime.originalText = '未来';
  session.update({ body: '归属不能漂移' }); await session.flush();
  assert.equal(api.objects.get(session.draftId).data.placeRefs[0].placeId, 'place_old');
  assert.equal(session.data.occurrenceTime.originalText, '1850');
});

test('autosave persists the settled draft in less than the one-second target', async () => {
  const api = fixture(); let complete;
  const saved = new Promise(resolve => { complete = resolve; });
  const session = new DraftSession(api, { onState: state => { if (state.state === 'saved') complete(); } });
  const start = performance.now(); session.update({ body: '中文输入后的草稿' });
  await saved; assert.ok(performance.now() - start < 1000); assert.equal(api.objects.get(session.draftId).data.body, '中文输入后的草稿');
});

test('input arriving during an in-flight draft save is persisted as a later version', async () => {
  const api = fixture(); let release;
  api.delayWith(new Promise(resolve => { release = resolve; }));
  const session = new DraftSession(api); session.update({ body: '第一段' });
  const flushing = session.flush(); session.update({ body: '第一段\n第二段' }); release(); await flushing;
  assert.equal(api.objects.get(session.draftId).data.body, '第一段\n第二段');
  assert.equal(api.objects.get(session.draftId).revision, 2); assert.equal(session.dirty, false);
});

test('draft network failure retains text and retries exactly the original request', async () => {
  const api = fixture(), session = new DraftSession(api);
  api.failAfter(new DomainError('SERVICE_UNAVAILABLE', 'response lost'));
  session.update({ body: '第一版' }); await assert.rejects(session.flush());
  assert.equal(session.state, 'error'); assert.equal(session.data.body, '第一版');
  session.update({ body: '失败后继续写' }); await session.flush();
  assert.equal(api.calls[0].requestId, api.calls[1].requestId);
  assert.equal(api.objects.get(session.draftId).data.body, '失败后继续写');
  assert.equal(api.objects.get(session.draftId).revision, 2);
});

test('lost formal commit receipt retries idempotently and blocks ambiguous edits', async () => {
  const api = fixture(), session = new DraftSession(api);
  session.update({ body: '只能收录一次' }); await session.flush();
  api.failAfter(new DomainError('SERVICE_UNAVAILABLE', 'response lost'));
  await assert.rejects(session.submit());
  assert.equal(session.data.body, '只能收录一次');
  assert.throws(() => session.update({ body: '结果未确认前不能改请求' }));
  const saved = await session.submit();
  assert.equal(saved.revision, 1); assert.equal([...api.objects.values()].filter(o => o.objectType === 'entry').length, 1);
  assert.equal(api.calls.at(-1).requestId, api.calls.at(-2).requestId);
});

test('conflicting formal edit retains recoverable draft and permits a separate entry', async () => {
  const original = object(), api = fixture([original]), session = new DraftSession(api, { entry: original });
  session.update({ body: '我的修订不能丢' }); await session.flush();
  api.objects.set(original.id, { ...original, revision: 2, data: { ...original.data, body: '另一窗口的内容' } });
  await assert.rejects(session.submit(), error => error.code === 'VERSION_CONFLICT');
  assert.equal(api.objects.get(original.id).data.body, '另一窗口的内容');
  assert.equal(api.objects.get(session.draftId).deletedAt, null);
  const copy = await session.fork(); assert.notEqual(copy.id, original.id); assert.equal(copy.data.body, '我的修订不能丢');
});

test('a reopened editing draft keeps its original expected revision', async () => {
  const entry = object(), api = fixture([entry]), first = new DraftSession(api, { entry });
  first.update({ body: '退出前的草稿' }); await first.flush();
  const reopened = new DraftSession(api, { draft: api.objects.get(first.draftId) });
  const saved = await reopened.submit(); assert.equal(saved.id, entry.id); assert.equal(saved.revision, 2);
  assert.equal(saved.data.body, '退出前的草稿'); assert.equal(saved.data.editingId, undefined);
});

test('conflicting draft can be preserved independently without overwriting another editor', async () => {
  const api = fixture(), first = new DraftSession(api); first.update({ body: '共同起点' }); await first.flush();
  const stale = new DraftSession(api, { draft: structuredClone(first.draft) });
  first.update({ body: '窗口甲' }); await first.flush(); stale.update({ body: '窗口乙' });
  await assert.rejects(stale.flush(), error => error.code === 'VERSION_CONFLICT');
  await stale.recoverAsNewDraft(); assert.notEqual(stale.draftId, first.draftId);
  assert.equal(api.objects.get(first.draftId).data.body, '窗口甲'); assert.equal(api.objects.get(stale.draftId).data.body, '窗口乙');
});

test('predictions preserve their first revision and identity through later changes', () => {
  const existing = object('我的预测', 'prediction');
  const changed = prepareEntryChange({ ...existing.data, body: '修订后的预测', initialPredictionRevision: 99 }, existing);
  assert.equal(changed.data.initialPredictionRevision, 1);
  assert.throws(() => prepareEntryChange({ ...existing.data, kind: 'note' }, existing));
  assert.equal(prepareEntryChange({ ...blankEntry(), body: '新预测', kind: 'prediction' }).data.initialPredictionRevision, 1);
});

test('reviews pin the assessed prediction revision and store the user judgment', () => {
  const predictionRef = refOf(object('预测', 'prediction'));
  const review = prepareReviewChange({ predictionRef, status: 'partlySupported', body: '条件只部分满足' });
  assert.equal(review.data.predictionRef.revision, 1); assert.equal(review.objectType, 'predictionReview');
  assert.throws(() => prepareReviewChange({ predictionRef: { ...predictionRef, versionMode: 'live' }, status: 'supported', body: '' }));
});

test('adoption preserves message provenance and protected undo rejects later edits', () => {
  const messageRef = { targetId: 'message_1', revision: 2, versionMode: 'pinned', locator: null, quote: null };
  const change = prepareAdoptionChange({ data: { ...blankEntry(), body: '讨论中形成的新判断' }, messageRef });
  assert.deepEqual(change.data.citations[0], messageRef);
  const current = { ...object(), revision: 3 };
  assert.throws(() => prepareUndoChange(current, object(), 2), error => error.code === 'VERSION_CONFLICT');
  assert.equal(prepareUndoChange(current, null, 3).deleted, true);
});

test('same place is counted once per entry while preserving explicit multi-place association', () => {
  const ref = placeId => ({ placeId, confirmed: true });
  const change = prepareEntryChange({ ...blankEntry(), body: '多地记录', placeRefs: [ref('a'), ref('a'), ref('b')] });
  assert.deepEqual(change.data.placeRefs.map(p => p.placeId), ['a', 'b']);
});
