import { assert, id, changeFor } from '../../packages/contracts/index.js';

const clone = value => structuredClone(value);
export const REVIEW_LABELS = { pending: '待观察', supported: '符合预期', partlySupported: '部分符合', notSupported: '不符合', indeterminate: '无法判断' };

export function blankEntry(selection = {}) {
  return { title: '', body: '', kind: 'note', status: 'adopted', occurrenceTime: clone(selection.occurrenceTime || null), placeRefs: clone(selection.placeRefs || []), citations: [], conditions: '' };
}

export function validateEntry(data) {
  assert(typeof data?.body === 'string' && data.body.trim().length > 0, '先写下一句话，再收入史书。');
  assert(['note', 'prediction'].includes(data.kind), '记录类型无效');
  assert(['adopted', 'inbox'].includes(data.status), '收录状态无效');
  assert(Array.isArray(data.placeRefs) && Array.isArray(data.citations), '地点或引用格式无效');
  for (const place of data.placeRefs) assert(typeof place.placeId === 'string' && place.confirmed === true, '地点尚未确认');
  for (const ref of data.citations) {
    assert(typeof ref.targetId === 'string', '引用缺少对象身份');
    assert(['pinned', 'live'].includes(ref.versionMode), '引用版本模式无效');
    if (ref.versionMode === 'pinned') assert(Number.isInteger(ref.revision) && ref.revision > 0, '固定引用缺少版本');
  }
  return data;
}

export function prepareEntryChange(data, existing = null, entryId = id('entry')) {
  validateEntry(data);
  const clean = clone(data);
  delete clean.editingId; delete clean.editingRevision; delete clean.ui;
  clean.placeRefs = [...new Map(clean.placeRefs.map(ref => [ref.placeId, ref])).values()];
  if (existing) assert(existing.objectType === 'entry' && !existing.deletedAt, '只能修改现有记录');
  if (existing?.data.initialPredictionRevision) clean.initialPredictionRevision = existing.data.initialPredictionRevision;
  else if (clean.kind === 'prediction') clean.initialPredictionRevision = (existing?.revision || 0) + 1;
  if (existing?.data.kind === 'prediction') assert(clean.kind === 'prediction', '预言保留原有身份；可另写一条普通记录。');
  return { id: existing?.id || entryId, objectType: 'entry', expectedRevision: existing?.revision || 0, data: clean };
}

export function prepareReviewChange(data, existing = null, reviewId = id('predictionReview')) {
  assert(data?.predictionRef?.targetId && data.predictionRef.versionMode === 'pinned' && Number.isInteger(data.predictionRef.revision) && data.predictionRef.revision > 0, '复盘必须指定预言版本');
  if (existing) assert(existing.objectType === 'predictionReview' && !existing.deletedAt, '只能修改现有评估');
  assert(Object.hasOwn(REVIEW_LABELS, data.status), '复盘状态无效');
  assert(typeof data.body === 'string', '复盘依据必须为文字');
  return { id: existing?.id || reviewId, objectType: 'predictionReview', expectedRevision: existing?.revision || 0, data: clone(data) };
}

/** Business preparation only. The shell adds the adoption receipt and commits atomically. */
export function prepareAdoptionChange({ target = null, objectType = 'entry', data, messageRef, newId }) {
  assert(['entry', 'predictionReview'].includes(objectType), '史书只能接收记录或预言评估');
  assert(messageRef?.targetId && messageRef.versionMode === 'pinned' && Number.isInteger(messageRef.revision), '采纳缺少固定消息来源');
  const combined = clone(data);
  combined.citations = [...(combined.citations || []), clone(messageRef)];
  return objectType === 'predictionReview' ? prepareReviewChange(combined, target, newId) : prepareEntryChange(combined, target, newId);
}

export function prepareUndoChange(current, before, expectedRevision) {
  assert(current.revision === expectedRevision, '目标在采纳后已被编辑，不能覆盖后续内容。', 'VERSION_CONFLICT');
  return before ? changeFor(current, clone(before.data), { deleted: !!before.deletedAt }) : changeFor(current, current.data, { deleted: true });
}

export function excerpt(body, length = 120) { return String(body || '').replace(/\s+/g, ' ').slice(0, length); }
export function groupEntries(items) {
  const groups = [];
  for (const item of items) {
    const label = item.data.occurrenceTime?.originalText || '时间待补充';
    const previous = groups.at(-1);
    if (previous?.label === label) previous.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}

/** One editor owns one draft. API commit is the sole persistence boundary. */
export class DraftSession {
  constructor(api, { draft = null, entry = null, selection = {}, onState = () => {}, delay = 350 } = {}) {
    this.api = api; this.onState = onState; this.delay = delay;
    this.draft = draft; this.entry = entry;
    this.data = clone(draft?.data || entry?.data || blankEntry(selection));
    if (entry) { this.data.editingId = entry.id; this.data.editingRevision = entry.revision; }
    this.draftId = draft?.id || id('draft'); this.entryId = entry?.id || draft?.data.editingId || id('entry');
    this.generation = 0; this.persisted = 0; this.pending = null; this.running = null; this.submission = null;
    this.state = draft ? 'saved' : 'idle'; this.error = null; this.disposed = false;
  }
  get dirty() { return this.generation > this.persisted || !!this.pending; }
  update(patch) {
    assert(!this.submitting, '正在提交，请稍候。');
    assert(!this.submission, '上次提交的结果尚未确认，请先重试提交。');
    Object.assign(this.data, clone(patch)); this.generation++; this.error = null;
    this.report('dirty'); clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush().catch(() => {}), this.delay);
  }
  report(state) { this.state = state; this.onState({ state, error: this.error, dirty: this.dirty }); }
  async flush() {
    clearTimeout(this.timer);
    if (this.running) { await this.running; if (this.dirty) return this.flush(); return; }
    if (!this.dirty) return;
    this.running = this.persistLoop();
    try { await this.running; } finally { this.running = null; }
  }
  async persistLoop() {
    while (this.dirty) {
      if (!this.pending) this.pending = { generation: this.generation, requestId: id('save_draft'), change: { id: this.draftId, objectType: 'draft', expectedRevision: this.draft?.revision || 0, data: clone(this.data) } };
      this.report('saving');
      try {
        const response = await this.api.commit([this.pending.change], this.pending.requestId);
        this.draft = response.objects.find(o => o.id === this.draftId);
        assert(this.draft, '保存回执缺少草稿', 'INVALID_RESPONSE');
        this.persisted = this.pending.generation; this.pending = null; this.error = null;
      } catch (error) { this.error = error; this.report('error'); throw error; }
    }
    this.report('saved');
  }
  async submit() {
    if (this.submitting) return this.submitPromise;
    this.submitting = true;
    this.submitPromise = this.finishSubmit();
    try { return await this.submitPromise; } finally { this.submitting = false; }
  }
  async finishSubmit() {
    await this.flush();
    if (!this.submission) {
      let entry = this.entry;
      if (!entry && this.data.editingId) entry = { id: this.data.editingId, objectType: 'entry', revision: this.data.editingRevision, data: this.data };
      const entryChange = prepareEntryChange(this.data, entry, this.entryId);
      const changes = [entryChange];
      if (this.draft) changes.push(changeFor(this.draft, this.draft.data, { deleted: true }));
      this.submission = { changes, requestId: id('submit_entry') };
    }
    this.report('submitting');
    try {
      const result = await this.api.commit(this.submission.changes, this.submission.requestId);
      const saved = result.objects.find(o => o.id === this.entryId);
      assert(saved, '保存回执缺少记录', 'INVALID_RESPONSE');
      this.report('submitted'); return saved;
    } catch (error) {
      // A structured rejection confirms that nothing was committed. A dropped
      // connection does not: retain that exact request until its receipt returns.
      if (error.code && !['SERVICE_UNAVAILABLE', 'INVALID_RESPONSE'].includes(error.code)) this.submission = null;
      this.error = error; this.report('error'); throw error;
    }
  }
  async fork() {
    assert(!this.submission, '请先重试，确认上次提交的结果。');
    if (this.pending && this.error?.code === 'VERSION_CONFLICT') {
      this.draft = null; this.draftId = id('draft'); this.pending = null; this.persisted = -1;
    }
    await this.flush();
    this.entry = null; this.entryId = id('entry'); this.submission = null;
    delete this.data.editingId; delete this.data.editingRevision;
    delete this.data.initialPredictionRevision;
    this.update({ body: this.data.body });
    return this.submit();
  }
  async recoverAsNewDraft() {
    assert(!this.submission, '请先重试，确认上次提交的结果。');
    this.draft = null; this.draftId = id('draft'); this.pending = null; this.persisted = -1;
    await this.flush();
  }
  async dispose() { clearTimeout(this.timer); await this.flush(); this.disposed = true; }
}
