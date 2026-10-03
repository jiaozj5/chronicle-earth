import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Workspace } from '../../packages/workspace/index.js';
import { DraftSession, prepareReviewChange } from './service.js';
import { parseTime } from '../atlas/time.js';
import { refOf } from '../../packages/contracts/index.js';

function createWorkspace() {
  const directory = mkdtempSync(join(tmpdir(), 'chronicle-a2-'));
  const workspace = new Workspace(directory);
  const api = { commit: (changes, requestId) => workspace.commit({ changes, requestId }) };
  return { workspace, api, directory, close() {
    workspace.close();
    const target = resolve(directory), parent = resolve(tmpdir());
    assert.ok(target.startsWith(parent + sep) && target.slice(parent.length + 1).startsWith('chronicle-a2-'));
    rmSync(target, { recursive: true, force: true });
  } };
}

test('real SQLite: autosaved draft survives reopening; formal commit deletes draft atomically', async () => {
  const context = createWorkspace();
  try {
    let draftSession = new DraftSession(context.api, { selection: { occurrenceTime: parseTime('1850—1860') } });
    draftSession.update({ body: '河运改变城市的空间组织。\n这是我的个人解释。' });
    await draftSession.flush();
    const draftId = draftSession.draftId;
    context.workspace.close();
    context.workspace = new Workspace(context.directory);
    context.api.commit = (changes, requestId) => context.workspace.commit({ changes, requestId });
    draftSession = new DraftSession(context.api, { draft: context.workspace.get(draftId) });
    const entry = await draftSession.submit();
    assert.equal(context.workspace.get(entry.id).data.body, '河运改变城市的空间组织。\n这是我的个人解释。');
    assert.ok(context.workspace.get(draftId, { includeDeleted: true }).deletedAt);
    assert.equal(context.workspace.list({ objectType: 'entry', q: '空间组织' }).items[0].id, entry.id);
    assert.equal(context.workspace.list({ objectType: 'draft' }).total, 0);
    assert.equal(context.workspace.list({ objectType: 'entry', unlocated: true }).total, 1);
  } finally { context.workspace.close(); context.close(); }
});

test('real SQLite: stale edit is rejected and every prediction version remains assessable', async () => {
  const context = createWorkspace();
  try {
    const first = new DraftSession(context.api); first.update({ body: '未来的预言', kind: 'prediction', occurrenceTime: parseTime('2040—2050') });
    const prediction = await first.submit();
    const editorA = new DraftSession(context.api, { entry: prediction }), editorB = new DraftSession(context.api, { entry: prediction });
    editorA.update({ body: '加上条件的预测', conditions: '只有甲条件成立' }); await editorA.submit();
    editorB.update({ body: '并发编辑不能覆盖' });
    await assert.rejects(editorB.submit(), error => error.code === 'VERSION_CONFLICT');
    assert.equal(context.workspace.get(editorB.draftId).data.body, '并发编辑不能覆盖');
    const versions = context.workspace.history(prediction.id);
    assert.equal(versions.length, 2); assert.equal(versions[0].data.initialPredictionRevision, 1);
    assert.equal(versions[1].data.body, '未来的预言');
    context.workspace.commit({ requestId: 'review_prediction', changes: [prepareReviewChange({ predictionRef: refOf(prediction), status: 'indeterminate', body: '条件尚未成立' })] });
    assert.equal(context.workspace.list({ objectType: 'predictionReview' }).items[0].data.predictionRef.revision, 1);
  } finally { context.close(); }
});
