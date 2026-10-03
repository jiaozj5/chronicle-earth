import { id, titleOf, refOf, changeFor } from '../../packages/contracts/index.js';
import { renderMarkdown } from '../../packages/ui/index.js';
import { parseTime, formatTime, toRange } from '../atlas/time.js';
import { blankEntry, DraftSession, excerpt, groupEntries, prepareEntryChange, prepareReviewChange, REVIEW_LABELS } from './service.js';

function node(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith('on')) element.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'class') element.className = value;
    else if (key === 'text') element.textContent = value;
    else if (key in element) element[key] = value;
    else element.setAttribute(key, value);
  }
  element.append(...children.flat().filter(v => v !== null && v !== undefined)); return element;
}
const text = (value, cls = 'muted') => node('span', { class: cls, text: value });
const action = (label, handler, cls = '') => node('button', { type: 'button', class: `button ${cls}`, text: label, onClick: handler });
const inputField = (label, input) => node('label', { class: 'chronicle-field' }, text(label, 'chronicle-label'), input);
const localDate = value => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '';
const memory = { selectedId: null, listScroll: 0, readerScroll: 0, filter: 'all', q: '', offset: 0, draftId: null, selection: null };
const errorText = error => error?.code === 'VERSION_CONFLICT' ? '内容已在其他窗口修改。你的文字已保留；请对照最新版本，或另存为一条记录。' : error?.message || '操作没有完成，请重试。';
const LIMIT = 30;

export async function mount(container, ctx) {
  if(ctx.params?.resumeState)Object.assign(memory,structuredClone(ctx.params.resumeState));
  let disposed = false, session = null, selected = null, selection = structuredClone(ctx.selection || {}), requestNo = 0, openNo = 0;
  let selectedRevision = null;
  let places = [], filter = ctx.params?.filter || memory.filter, q = ctx.params?.q ?? memory.q, offset = memory.offset;
  let kind = '', placeIds = (selection.placeRefs || []).map(p => p.placeId), timeSpec = selection.occurrenceTime || null;
  let composing = false, statusNode, activeEditor, unsavedReview = false;
  const rememberedListScroll = memory.listScroll, rememberedReaderScroll = memory.readerScroll, rememberedDraftId = memory.draftId, rememberedSelectedId = memory.selectedId;
  const root = node('section', { class: 'chronicle-root', 'aria-label': '岁月史书' });
  const listPanel = node('aside', { class: 'chronicle-directory panel' });
  const reader = node('section', { class: 'chronicle-reader panel', 'aria-label': '正文阅读与编辑', tabIndex: -1 });
  const searchInput = node('input', { class: 'input', type: 'search', placeholder: '搜索正文、标题或条件', value: q, 'aria-label': '搜索史书' });
  const results = node('div', { class: 'chronicle-results', 'aria-live': 'polite' });
  const pagination = node('div', { class: 'chronicle-pagination' });
  const scope = node('div', { class: 'chronicle-scope' });
  const totalNode = node('span', { class: 'muted' });
  const tabs = node('div', { class: 'chronicle-tabs', role: 'group', 'aria-label': '记录范围' });
  const labels = { all: '全部', unlocated: '待定位', inbox: '待整理', drafts: '草稿', trash: '回收站' };
  const kindSelect = node('select', { class: 'input', 'aria-label': '记录类型', onChange: event => { kind = event.target.value; offset = 0; loadList(); } }, node('option', { value: '', text: '全部类型' }), node('option', { value: 'note', text: '记录' }), node('option', { value: 'prediction', text: '预言' }));
  listPanel.append(node('div', { class: 'chronicle-directory-head' }, node('h2', { text: '岁月史书' }), action('记一笔', () => newEntry(), 'primary')), searchInput, tabs, node('div', { class: 'chronicle-list-controls' }, kindSelect, totalNode), scope, results, pagination);
  root.append(listPanel, reader); container.replaceChildren(root);
  const resizeObserver = new ResizeObserver(entries => root.classList.toggle('chronicle-compact', entries[0].contentRect.width < 760));
  resizeObserver.observe(root);

  function notice(message, tone = 'error') { ctx.notify?.(message, tone); }
  function showError(target, error, retry) {
    const block = node('div', { class: 'chronicle-error', role: 'alert' }, text(errorText(error), ''));
    if (retry) block.append(action('重试', retry)); target.append(block); return block;
  }
  function saveMemory() { memory.filter = filter; memory.q = q; memory.offset = offset; memory.selectedId = selected?.id || null; memory.listScroll = results.scrollTop; memory.readerScroll = reader.scrollTop; memory.draftId = session?.draftId || null; }
  async function leaveEditor() {
    if (unsavedReview) {
      if (!window.confirm('这段评估尚未保存，确定离开吗？')) throw new Error('请先保存这段评估。');
      unsavedReview = false;
    }
    if (!session) return;
    captureEditorSelection();
    try { await session.dispose(); } catch (error) { notice(`草稿尚未保存：${errorText(error)}`); throw error; }
    session = null; activeEditor = null;
  }
  function captureEditorSelection() {
    if (session && activeEditor) {
      const ui = { selectionStart: activeEditor.selectionStart, selectionEnd: activeEditor.selectionEnd, scrollTop: activeEditor.scrollTop };
      if (!session.submission && !session.submitting && JSON.stringify(ui) !== JSON.stringify(session.data.ui) && (session.draft || session.dirty)) session.update({ ui });
    }
  }
  function renderTabs() {
    tabs.replaceChildren(...Object.entries(labels).map(([key, label]) => action(label, () => { filter = key; offset = 0; memory.filter = key; renderTabs(); loadList(); }, filter === key ? 'active' : '')));
    tabs.querySelectorAll('button').forEach((button, i) => button.setAttribute('aria-pressed', Object.keys(labels)[i] === filter ? 'true' : 'false'));
  }
  function renderScope() {
    const names = placeIds.map(placeId => places.find(p => p.id === placeId)?.data.name || '已选地点');
    scope.replaceChildren();
    if (names.length) scope.append(text(names.join('、'), 'chronicle-chip'));
    if (timeSpec) scope.append(text(formatTime(timeSpec), 'chronicle-chip'));
    if (names.length || timeSpec) scope.append(action('查看所有时空', () => { placeIds = []; timeSpec = null; offset = 0; renderScope(); loadList(); }, 'small'));
  }
  async function loadPlaces() {
    try { places = (await ctx.api.list({ objectType: 'place', limit: 100000 })).items; renderScope(); return true; } catch (error) { notice(`地点暂不可用：${errorText(error)}`); return false; }
  }
  async function loadList() {
    const request = ++requestNo;
    totalNode.textContent = '读取中…';
    try {
      const query = { objectType: filter === 'drafts' ? 'draft' : 'entry', q, limit: LIMIT, offset };
      if (filter === 'trash') query.onlyDeleted = true;
      if (filter === 'inbox') query.status = 'inbox';
      if (filter === 'unlocated') query.unlocated = true;
      if (kind) query.kind = kind;
      if (placeIds.length) query.placeIds = placeIds;
      if (timeSpec) query.timeSpec = timeSpec;
      const response = await ctx.api.list(query);
      if (disposed || request !== requestNo) return;
      if (offset >= response.total && offset > 0) { offset = Math.max(0, Math.ceil(response.total / LIMIT) * LIMIT - LIMIT); return loadList(); }
      totalNode.textContent = `${response.total} 条${filter === 'drafts' ? '草稿' : '记录'}`;
      results.replaceChildren();
      if (response.indexedThroughSequence < response.sequence) results.append(node('p', { class: 'chronicle-status', text: '正文已保存，搜索结果仍在更新。' }));
      if (!response.items.length) results.append(node('div', { class: 'chronicle-empty' }, node('h3', { text: q ? '没有找到这段文字' : '这里还没有记录' }), node('p', { text: q ? '尝试换一个正文词，或取消时空筛选。' : '写一句话就可以开始，地点和时间可以以后补上。' }), action('记一笔', () => newEntry())));
      for (const group of groupEntries(response.items)) {
        results.append(node('h3', { class: 'chronicle-group-label', text: group.label }));
        for (const object of group.items) {
          const openButton = node('button', { type: 'button', 'data-object-id': object.id, class: `chronicle-record-row${selected?.id === object.id ? ' selected' : ''}`, onClick: () => object.objectType === 'draft' ? openDraft(object) : open(object.id) },
            node('span', { class: 'chronicle-record-title', text: titleOf(object) }),
            node('span', { class: 'chronicle-record-excerpt', text: excerpt(object.data.body) }),
            node('span', { class: 'chronicle-record-meta', text: `${object.data.kind === 'prediction' ? '预言 · ' : ''}${object.data.status === 'inbox' ? '待整理 · ' : ''}${object.data.placeRefs?.map(ref => ref.originalName || places.find(p => p.id === ref.placeId)?.data.name || '地点').join('、') || '地点待补充'}` }));
          if (selected?.id === object.id) openButton.setAttribute('aria-current', 'true');
          results.append(openButton);
        }
      }
      pagination.replaceChildren(action('上一页', () => { offset = Math.max(0, offset - LIMIT); loadList(); }), text(`${Math.floor(offset / LIMIT) + 1} / ${Math.max(1, Math.ceil(response.total / LIMIT))}`), action('下一页', () => { offset += LIMIT; loadList(); }));
      pagination.firstChild.disabled = offset === 0; pagination.lastChild.disabled = offset + LIMIT >= response.total;
      saveMemory();return true;
    } catch (error) { if (disposed || request !== requestNo) return false; totalNode.textContent = '读取失败'; results.replaceChildren(); showError(results, error, loadList);return false; }
  }

  function emptyReader() {
    reader.replaceChildren(node('div', { class: 'chronicle-welcome' }, text('每一笔，都属于你的史书', 'chronicle-eyebrow'), node('h1', { text: '从此刻关注的事情开始' }), node('p', { text: '记下一件往事、一段材料，或者对未来的判断。时间和地点可以慢慢补齐。' }), action('写下第一笔', () => newEntry(), 'primary')));
  }
  function renderSaveState(info) {
    if (!statusNode) return;
    const label = { idle: '写下之后，草稿会自动保存', dirty: '尚未保存', saving: '正在保存草稿…', saved: '草稿已保存到本机', submitting: '正在收入史书…', submitted: '已收入史书', error: '未保存，请重试' }[info.state];
    statusNode.replaceChildren(text(label, info.state === 'error' ? 'chronicle-error-text' : 'muted'));
    if (info.state === 'error') {
      statusNode.append(text(errorText(info.error), 'chronicle-error-text'), action('重试保存草稿', () => session?.flush().catch(error => notice(errorText(error))), 'small'));
      if (info.error?.code === 'VERSION_CONFLICT' && session?.pending) statusNode.append(action('保留为独立草稿', () => session.recoverAsNewDraft().catch(error => notice(errorText(error))), 'small'));
    }
  }
  async function newEntry(context = null) {
    try { await leaveEditor(); } catch { return; }
    selected = null;
    session = new DraftSession(ctx.api, { selection: context || selection, onState: renderSaveState });
    renderEditor(); saveMemory();
  }
  async function openDraft(draft) {
    try { await leaveEditor(); } catch { return; }
    selected = null;
    try {
      const current = await ctx.api.get(draft.id);
      session = new DraftSession(ctx.api, { draft: current, onState: renderSaveState });
      renderEditor(); saveMemory();
    } catch (error) { notice(errorText(error)); }
  }
  async function editEntry(object) {
    try { await leaveEditor(); } catch { return; }
    try {
      const current = await ctx.api.get(object.id);
      const drafts = await ctx.api.list({ objectType: 'draft', limit: 100000 });
      const prior = drafts.items.find(draft => draft.data.editingId === current.id);
      selected = current;
      session = new DraftSession(ctx.api, { draft: prior || null, entry: prior ? null : current, onState: renderSaveState });
      renderEditor(); saveMemory();
    } catch (error) { notice(errorText(error)); }
  }
  function renderEditor() {
    ctx.onViewChange?.('reader');
    const editing = session;
    reader.scrollTop = 0;
    statusNode = node('div', { class: 'chronicle-save-status', role: 'status', 'aria-live': 'polite' });
    const titleInput = node('input', { class: 'input chronicle-title-input', placeholder: '标题（可以不写）', value: editing.data.title || '', 'aria-label': '记录标题（可选）', onInput: event => editing.update({ title: event.target.value }) });
    const bodyInput = node('textarea', { class: 'input chronicle-body-input', placeholder: '此刻，你想记下什么？', value: editing.data.body || '', 'aria-label': '记录正文', spellcheck: false, onInput: event => editing.update({ body: event.target.value }), onCompositionstart: () => { composing = true; }, onCompositionend: () => { composing = false; } });
    activeEditor = bodyInput;
    const timeInput = node('input', { class: 'input', value: editing.data.occurrenceTime?.originalText || '', placeholder: '1850、1850—1860、约某朝时期…', 'aria-label': '发生时间' });
    const timeHelp = node('span', { class: 'muted' }); let timeError = null;
    function applyTime() {
      try {
        const spec = timeInput.value.trim() ? parseTime(timeInput.value.trim()) : null;
        const range = toRange(spec);
        if (spec && spec.kind !== 'unknown' && !range.indexed && /无效|晚于/.test(range.reason || '')) throw new Error(range.reason);
        editing.update({ occurrenceTime: spec }); timeError = null;
        timeInput.removeAttribute('aria-invalid'); timeHelp.className = 'muted';
        timeHelp.textContent = spec ? `${formatTime(spec)}${spec.kind === 'unknown' ? ' · 原文保留，尚未定位到可索引时期' : ''}` : '时间可以留空，之后补齐。';
      } catch (error) { timeError = error; timeHelp.textContent = errorText(error); timeHelp.className = 'chronicle-error-text'; timeInput.setAttribute('aria-invalid', 'true'); }
    }
    timeInput.addEventListener('change', applyTime);
    timeHelp.textContent = editing.data.occurrenceTime ? formatTime(editing.data.occurrenceTime) : '时间可以留空，之后补齐。';
    const placeChips = node('div', { class: 'chronicle-place-chips' });
    const placeSelect = node('select', { class: 'input', 'aria-label': '添加关联地点' });
    function renderPlaces() {
      placeChips.replaceChildren(...(editing.data.placeRefs || []).map(ref => node('span', { class: 'chronicle-chip' }, node('input', { class: 'chronicle-place-name', value: ref.originalName || places.find(p => p.id === ref.placeId)?.data.name || '已选地点', 'aria-label': '地点名称（可以保留历史名称）', title: '可以在这里保留当时的名称，地点身份不变', onInput: event => editing.update({ placeRefs: editing.data.placeRefs.map(placeRef => placeRef.placeId === ref.placeId ? { ...placeRef, originalName: event.target.value } : placeRef) }) }), action('×', () => { editing.update({ placeRefs: editing.data.placeRefs.filter(p => p.placeId !== ref.placeId) }); renderPlaces(); }, 'chronicle-remove'))));
      if (!editing.data.placeRefs?.length) placeChips.append(text('地点待补充'));
      placeSelect.replaceChildren(node('option', { value: '', text: '添加地点（可选择多个）' }), ...places.filter(p => !editing.data.placeRefs.some(ref => ref.placeId === p.id)).map(place => node('option', { value: place.id, text: `${place.data.name}${place.data.kind !== 'city' ? ' · ' + ({ settlement: '聚落', region: '地区', naturalFeature: '自然地理', route: '路线', custom: '自定义' }[place.data.kind] || '') : ''}${place.data.aliases?.length ? `（${place.data.aliases.map(a => typeof a === 'string' ? a : a.name).join('、')}）` : ''}` })));
    }
    placeSelect.addEventListener('change', () => { const place = places.find(p => p.id === placeSelect.value); if (place) { editing.update({ placeRefs: [...editing.data.placeRefs, { placeId: place.id, originalName: place.data.name, confirmed: true }] }); renderPlaces(); } });
    renderPlaces();
    const addPlace = action('管理地点', async () => { try { await editing.flush(); if (ctx.onLocate) ctx.onLocate(); else notice('请在地球面板中添加地点，再点击“刷新地点”。草稿归属会保持不变。', 'info'); } catch (error) { notice(errorText(error)); } }, 'small');
    const refreshPlaces = action('刷新地点', async () => { await loadPlaces(); renderPlaces(); }, 'small');
    const kindInput = node('select', { class: 'input', 'aria-label': '记录身份' }, node('option', { value: 'note', text: '记录' }), node('option', { value: 'prediction', text: '预言' }));
    kindInput.value = editing.data.kind;
    if (editing.data.initialPredictionRevision) kindInput.disabled = true;
    const conditionInput = node('textarea', { class: 'input', rows: 3, value: editing.data.conditions || '', placeholder: '哪些前提成立时，你预计会发生什么？', 'aria-label': '预言条件与依据', onInput: event => editing.update({ conditions: event.target.value }) });
    const conditions = inputField('条件与依据（可选）', conditionInput); conditions.hidden = editing.data.kind !== 'prediction';
    kindInput.addEventListener('change', () => { editing.update({ kind: kindInput.value }); conditions.hidden = kindInput.value !== 'prediction'; });
    const statusInput = node('select', { class: 'input', 'aria-label': '收录状态' }, node('option', { value: 'adopted', text: '收入史书' }), node('option', { value: 'inbox', text: '放入待整理' }));
    statusInput.value = editing.data.status; statusInput.addEventListener('change', () => editing.update({ status: statusInput.value }));
    const errorBox = node('div');
    const saveButton = action(editing.data.editingId ? '保存修订' : '记下', submit, 'primary');
    const copyButton = action('另存为新记录', async () => {
      saveButton.disabled = copyButton.disabled = true; errorBox.replaceChildren();
      try { if (timeError) throw timeError; const saved = await editing.fork(); session = null; activeEditor = null; await open(saved.id); await loadList(); ctx.refresh?.(); }
      catch (error) { showError(errorBox, error); }
      finally { saveButton.disabled = copyButton.disabled = false; }
    }); copyButton.hidden = !editing.data.editingId;
    async function submit() {
      if (composing || editing.submitting) return;
      if (timeInput.value.trim() !== (editing.data.occurrenceTime?.originalText || '')) applyTime();
      if (timeError) { timeInput.focus(); return; }
      saveButton.disabled = true; errorBox.replaceChildren(); bodyInput.readOnly = titleInput.readOnly = true;
      try {
        const saved = await editing.submit(); session = null; activeEditor = null; memory.draftId = null;
        notice('已收入史书', 'success'); await open(saved.id); await loadList(); ctx.refresh?.();
      } catch (error) { showError(errorBox, error, submit); copyButton.hidden = !editing.data.editingId; }
      finally {
        saveButton.disabled = false;
        const uncertain = !!editing.submission;
        bodyInput.readOnly = titleInput.readOnly = uncertain;
        for (const control of [timeInput, placeSelect, kindInput, statusInput, conditionInput]) control.disabled = uncertain || (control === kindInput && !!editing.data.initialPredictionRevision);
        copyButton.disabled = uncertain;
      }
    }
    bodyInput.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.isComposing && !composing) { event.preventDefault(); submit(); } });
    const citationBox = node('div', { class: 'chronicle-citation-editor' });
    renderCitationEditor(citationBox, editing);
    const details = node('details', { class: 'chronicle-editor-details', open: true }, node('summary', { text: '这笔记录的时间与地点' }), node('div', { class: 'chronicle-context-grid' }, inputField('发生时间', node('div', {}, timeInput, timeHelp)), inputField('关联地点', node('div', {}, placeChips, placeSelect, node('div', { class: 'row' }, addPlace, refreshPlaces)))));
    reader.replaceChildren(node('div', { class: 'chronicle-editor' }, node('div', { class: 'chronicle-toolbar' }, text(editing.data.editingId ? '修订记录 · 保留历史版本' : '新的一笔', 'chronicle-eyebrow'), kindInput, statusInput), titleInput, bodyInput, details, conditions, citationBox, errorBox, node('div', { class: 'chronicle-editor-footer' }, statusNode, node('div', { class: 'row' }, copyButton, saveButton)), text('Ctrl / ⌘ + Enter 记下 · 切换地点不会改变正在书写的归属', 'chronicle-hint')));
    renderSaveState({ state: editing.state, error: editing.error });
    queueMicrotask(() => { if (disposed || session !== editing) return; bodyInput.focus(); const ui = editing.data.ui; if (ui) { bodyInput.setSelectionRange(ui.selectionStart || 0, ui.selectionEnd || 0); bodyInput.scrollTop = ui.scrollTop || 0; } });
  }

  function renderCitationEditor(container, editing) {
    const chosen = node('div'), choices = node('div', { class: 'chronicle-source-options' });
    const sourceQuery = node('input', { class: 'input', placeholder: '查找已保存的材料、记录或知识', 'aria-label': '查找引用材料' });
    const picker = node('details', {}, node('summary', { text: '添加来源或依据（可选）' }), sourceQuery, choices);
    function renderChosen() {
      chosen.replaceChildren(...(editing.data.citations || []).map((ref, index) => {
        const openRef = action(`固定版本 ${ref.revision} · 读取引用名称…`, () => ctx.openObject?.(ref.targetId, ref.revision), 'small');
        ctx.api.get(ref.targetId, { revision: ref.revision, includeDeleted: true }).then(object => { openRef.textContent = `固定版本 ${ref.revision} · ${titleOf(object)}`; }).catch(() => { openRef.textContent = `固定版本 ${ref.revision} · 暂时无法读取的引用`; });
        return node('div', { class: 'chronicle-citation-chip' }, openRef, action('移除', () => { editing.update({ citations: editing.data.citations.filter((_, i) => i !== index) }); renderChosen(); }, 'small'));
      }));
    }
    async function findSources() {
      choices.replaceChildren(text('查找中…'));
      try {
        const result = await ctx.api.list({ objectTypes: ['source', 'entry', 'knowledge', 'document'], q: sourceQuery.value, limit: 12 });
        choices.replaceChildren();
        for (const object of result.items) choices.append(action(`${titleOf(object)} · v${object.revision}`, () => {
          if (!editing.data.citations.some(ref => ref.targetId === object.id && ref.revision === object.revision)) editing.update({ citations: [...editing.data.citations, refOf(object)] });
          renderChosen(); picker.open = false;
        }, 'chronicle-source-choice'));
        if (!result.items.length) choices.append(text('没有匹配的内容，可在“材料”中添加来源。'));
      } catch (error) { choices.replaceChildren(); showError(choices, error, findSources); }
    }
    let timer; sourceQuery.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(findSources, 180); });
    picker.addEventListener('toggle', () => { if (picker.open) findSources(); });
    renderChosen(); container.replaceChildren(chosen, picker);
  }

  async function open(objectId, revision) {
    try { await leaveEditor(); } catch { return; }
    const opening = ++openNo;
    reader.replaceChildren(node('p', { class: 'muted', text: '正在打开记录…' }));
    try {
      const object = await ctx.api.get(objectId, { revision, includeDeleted: true });
      if (disposed || opening !== openNo) return;
      if (object.objectType === 'draft') return openDraft(object);
      if (object.objectType === 'predictionReview') return open(object.data.predictionRef.targetId, object.data.predictionRef.revision);
      selected = object; memory.selectedId = object.id; memory.draftId = null;
      results.querySelectorAll('.chronicle-record-row').forEach(row => { const active = row.dataset.objectId === object.id; row.classList.toggle('selected', active); if (active) row.setAttribute('aria-current', 'true'); else row.removeAttribute('aria-current'); });
      await renderReader(object, !!revision); saveMemory();
    } catch (error) { if (disposed || opening !== openNo) return; reader.replaceChildren(); showError(reader, error, () => open(objectId, revision)); }
  }
  async function renderReader(object, pinned = false) {
    ctx.onViewChange?.('reader');
    selectedRevision=pinned?object.revision:null;
    const data = object.data;
    const headline = node('div', { class: 'chronicle-reading-header' }, text(`${data.kind === 'prediction' ? '预言' : '记录'} · 版本 ${object.revision}${pinned ? ' · 固定历史版本' : ''}`, 'chronicle-eyebrow'), node('h1', { text: titleOf(object) }));
    const locationNames = (data.placeRefs || []).map(ref => ref.originalName || places.find(p => p.id === ref.placeId)?.data.name || '地点');
    const meta = node('div', { class: 'chronicle-reading-meta' }, text(formatTime(data.occurrenceTime) || '时间待补充'), text(locationNames.join('、') || '地点待补充'), text(`写下于 ${localDate(object.createdAt)}`));
    const toolbar = node('div', { class: 'chronicle-toolbar' });
    if (object.deletedAt) toolbar.append(text('这条记录在回收站中。引用及历史版本仍被保留。', 'chronicle-error-text'), action('恢复记录', async () => { try { const current = await ctx.api.get(object.id, { includeDeleted: true }); await ctx.api.restore(current); await open(object.id); await loadList(); ctx.refresh?.(); } catch (error) { notice(errorText(error)); } }, 'primary'));
    else {
      toolbar.append(action('编辑', () => editEntry(object)), action('修订历史', () => showHistory(object)), action('形成观点', () => ctx.onDevelop ? ctx.onDevelop(refOf(object)) : ctx.navigate('knowledge', { seedRefs: [refOf(object)] })), action('与人物讨论', () => ctx.onDiscuss ? ctx.onDiscuss(refOf(object)) : ctx.navigate('personas', { contextRefs: [refOf(object)] })));
      if (pinned) toolbar.append(action('查看当前版本', () => open(object.id)));
      else toolbar.append(action('移入回收站', async () => { try { await ctx.api.remove(object); await open(object.id); await loadList(); ctx.refresh?.(); } catch (error) { notice(errorText(error)); } }, 'quiet'));
    }
    const prose = node('article', { class: 'chronicle-prose' }); appendMarkdown(prose, data.body || '');
    const related = node('div', { class: 'chronicle-related' });
    const reading = node('div', { class: 'chronicle-reading' }, toolbar, headline, meta, prose);
    if (data.conditions) { const conditionBlock = node('section', { class: 'chronicle-conditions' }, node('h2', { text: '条件与依据' })); appendMarkdown(conditionBlock, data.conditions); reading.append(conditionBlock); }
    if (data.citations?.length) { const citations = node('section', { class: 'chronicle-citations' }, node('h2', { text: data.kind === 'prediction' ? '固定版本依据' : '来源与引用' })); reading.append(citations); renderReferences(citations, data.citations); }
    if (data.kind === 'prediction') {
      const predictions = node('section', { class: 'chronicle-reviews' }, node('h2', { text: '预言复盘' }), text('结果由你评估，预言不会自动变成史实。'));
      if (data.initialPredictionRevision) predictions.append(action(`查看首次预言 · v${data.initialPredictionRevision}`, () => open(object.id, data.initialPredictionRevision), 'small'));
      if (!object.deletedAt) predictions.append(action('写下评估', () => editReview(object), 'small'));
      const reviewList = node('div'); predictions.append(reviewList); reading.append(predictions); loadReviews(object, reviewList);
    }
    reading.append(related); reader.replaceChildren(reading); reader.scrollTop = 0;
    loadBacklinks(object, related);
  }
  function appendMarkdown(target, body) {
    const content = renderMarkdown(body);
    if (content instanceof Node) target.append(content);
    else target.append(node('div', { class: 'chronicle-plain', text: body }));
  }
  async function renderReferences(target, citations) {
    for (const ref of citations) {
      const row = node('div', { class: 'chronicle-reference' }, text('读取引用…')); target.append(row);
      try {
        const object = await ctx.api.get(ref.targetId, { revision: ref.versionMode === 'pinned' ? ref.revision : undefined, includeDeleted: true });
        const latest = await ctx.api.get(ref.targetId, { includeDeleted: true });
        row.replaceChildren(action(`${titleOf(object)} · ${ref.versionMode === 'pinned' ? '固定 v' + ref.revision : '跟随最新版本'}`, () => ctx.openObject?.(ref.targetId, ref.versionMode === 'pinned' ? ref.revision : undefined), 'chronicle-reference-link'));
        if (ref.quote) row.append(node('blockquote', { text: ref.quote }));
        if (latest.deletedAt) row.append(text('原内容已移入回收站，引用版本仍保留。', 'chronicle-warning'));
        else if (ref.versionMode === 'pinned' && latest.revision > ref.revision) row.append(text(`原内容已有 v${latest.revision}，此处仍使用 v${ref.revision}。`, 'chronicle-warning'));
      } catch (error) { row.replaceChildren(text(`引用暂无法打开：${errorText(error)}`, 'chronicle-error-text')); }
    }
  }
  async function loadBacklinks(object, target) {
    try {
      const response = await ctx.api.list({ objectType: 'relation', limit: 100000 });
      const relations = response.items.filter(relation => relation.data.from?.targetId === object.id || relation.data.to?.targetId === object.id);
      if (!relations.length) return;
      target.append(node('h2', { text: '这条记录参与的思考' }));
      for (const relation of relations) {
        const outgoing = relation.data.from.targetId === object.id, other = outgoing ? relation.data.to : relation.data.from;
        const otherObject = await ctx.api.get(other.targetId, { includeDeleted: true });
        const label = { supports: outgoing ? '支持' : '受到支持', refutes: outgoing ? '质疑' : '受到质疑', defines: outgoing ? '定义' : '定义来自', premiseOf: outgoing ? '作为前提' : '前提包含', exampleOf: outgoing ? '作为实例' : '例子包含', relatedTo: '相关' }[relation.data.kind] || '相关';
        target.append(action(`${label} · ${titleOf(otherObject)}`, () => ctx.openObject?.(other.targetId, other.versionMode === 'pinned' ? other.revision : undefined), 'chronicle-reference-link'));
      }
    } catch (error) { target.append(text(`关联暂未加载：${errorText(error)}`, 'muted')); }
  }
  async function loadReviews(object, target) {
    try {
      const response = await ctx.api.list({ objectType: 'predictionReview', limit: 100000 });
      const reviews = response.items.filter(review => review.data.predictionRef.targetId === object.id);
      if (!reviews.length) target.append(node('p', { class: 'muted', text: '尚未写下评估。' }));
      for (const review of reviews) {
        const block = node('article', { class: 'chronicle-review' }, node('h3', { text: REVIEW_LABELS[review.data.status] || review.data.status }), text(`评估预言 v${review.data.predictionRef.revision} · ${localDate(review.createdAt)}`));
        appendMarkdown(block, review.data.body);
        if (review.data.citations?.length) renderReferences(block, review.data.citations);
        block.append(action(`查看被评估的预言 v${review.data.predictionRef.revision}`, () => open(object.id, review.data.predictionRef.revision), 'small'));
        block.append(action('修改评估', () => editReview(object, review), 'small')); target.append(block);
      }
    } catch (error) { showError(target, error, () => { target.replaceChildren(); loadReviews(object, target); }); }
  }
  async function editReview(prediction, review = null) {
    let versions;
    try { versions = (await ctx.api.history(prediction.id)).filter(v => v.data.kind === 'prediction'); }
    catch (error) { notice(errorText(error)); return; }
    const versionSelect = node('select', { class: 'input', 'aria-label': '被评估的预言版本', onChange: () => { unsavedReview = true; } }, ...versions.map(v => node('option', { value: v.revision, text: `v${v.revision} · ${localDate(v.updatedAt)} · ${excerpt(v.data.body, 30)}` })));
    versionSelect.value = review?.data.predictionRef.revision || prediction.revision;
    const statusSelect = node('select', { class: 'input', 'aria-label': '评估结论', onChange: () => { unsavedReview = true; } }, ...Object.entries(REVIEW_LABELS).map(([value, label]) => node('option', { value, text: label })));
    statusSelect.value = review?.data.status || 'pending';
    const bodyInput = node('textarea', { class: 'input chronicle-body-input', value: review?.data.body || '', placeholder: '你后来了解到什么？哪些符合，哪些需要修正？', 'aria-label': '评估依据', onInput: () => { unsavedReview = true; } });
    let submission = null;
    const errors = node('div'), save = action('保存评估', async () => {
      save.disabled = true; errors.replaceChildren();
      try {
        if (!submission) {
          const data = { predictionRef: { ...refOf(prediction), revision: Number(versionSelect.value) }, status: statusSelect.value, body: bodyInput.value };
          submission = { change: prepareReviewChange(data, review), requestId: id('review') };
        }
        await ctx.api.commit([submission.change], submission.requestId);
        unsavedReview = false; await open(prediction.id); notice('评估已保存', 'success');
      } catch (error) {
        if (error.code && !['SERVICE_UNAVAILABLE', 'INVALID_RESPONSE'].includes(error.code)) submission = null;
        unsavedReview = true; showError(errors, error);
        if (submission) errors.append(text('结果尚未确认，请再次点击“保存评估”重试同一笔提交。', ''));
      } finally { save.disabled = false; bodyInput.readOnly = !!submission; versionSelect.disabled = statusSelect.disabled = !!submission; }
    }, 'primary');
    reader.replaceChildren(node('div', { class: 'chronicle-editor' }, node('h1', { text: '复盘这条预言' }), node('p', { text: titleOf(prediction), class: 'muted' }), inputField('评估哪个版本', versionSelect), inputField('你的判断', statusSelect), bodyInput, errors, node('div', { class: 'row' }, save, action('返回预言', () => { if (!unsavedReview || window.confirm('这段评估尚未保存，确定返回吗？')) { unsavedReview = false; open(prediction.id); } }))));
  }
  async function showHistory(object) {
    let versions;
    try { versions = await ctx.api.history(object.id); } catch (error) { notice(errorText(error)); return; }
    const historyPanel = node('section', { class: 'chronicle-history' }, node('h1', { text: '修订历史' }), action('返回正文', () => open(object.id)));
    const comparison = node('div');
    function versionContent(version, label) {
      const data = version.data;
      const card = node('section', { class: 'chronicle-version-card' }, node('h3', { text: label }), node('h4', { text: data.title || '未单独填写标题' }),
        node('dl', { class: 'chronicle-version-metadata' }, node('dt', { text: '时间' }), node('dd', { text: formatTime(data.occurrenceTime) }), node('dt', { text: '地点' }), node('dd', { text: (data.placeRefs || []).map(ref => ref.originalName || places.find(place => place.id === ref.placeId)?.data.name || '未命名地点').join('、') || '尚未补充' }), node('dt', { text: '身份' }), node('dd', { text: data.kind === 'prediction' ? '预言' : '记录' })), node('h4', { text: '正文' }), node('div', { class: 'chronicle-version-body', text: data.body }));
      if (data.conditions) card.append(node('h4', { text: '条件与依据' }), node('div', { class: 'chronicle-version-body', text: data.conditions }));
      if (data.citations?.length) card.append(text(`保留 ${data.citations.length} 条来源引用`, 'muted'));
      return card;
    }
    for (const version of versions) historyPanel.append(action(`v${version.revision} · ${localDate(version.updatedAt)}${version.deletedAt ? ' · 已删除' : ''}`, () => {
      const latest = versions[0];
      const restore = action('以此内容建立新修订', async () => {
        restore.disabled = true;
        try { const current = await ctx.api.get(object.id, { includeDeleted: true }); if (current.deletedAt) throw new Error('请先从回收站恢复记录。'); const change = prepareEntryChange(version.data, current); const result = await ctx.api.commit([change], id('restore_revision')); await open(result.objects[0].id); await loadList(); ctx.refresh?.(); }
        catch (error) { notice(errorText(error)); } finally { restore.disabled = false; }
      });
      comparison.replaceChildren(node('h2', { text: `v${version.revision} 与当前 v${latest.revision}` }), node('div', { class: 'chronicle-version-compare' }, versionContent(version, `选中版本 v${version.revision}`), versionContent(latest, `当前版本 v${latest.revision}`)), action('阅读这个版本', () => open(object.id, version.revision)), restore);
    }, 'chronicle-version-row'));
    historyPanel.append(comparison); reader.replaceChildren(historyPanel);
  }
  let searchTimer;
  searchInput.addEventListener('input', () => { q = searchInput.value; offset = 0; clearTimeout(searchTimer); searchTimer = setTimeout(loadList, 180); });
  const keyHandler = event => {
    if (event.isComposing || composing) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); searchInput.focus(); searchInput.select(); }
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'n') { event.preventDefault(); newEntry(); }
    if (event.key === 'Escape' && !session && document.activeElement?.tagName !== 'TEXTAREA') { results.querySelector('.selected')?.focus(); }
  };
  const visibilityHandler = () => { if (document.hidden && session) session.flush().catch(() => {}); };
  const unloadHandler = event => { if (session?.dirty || session?.submitting || unsavedReview) { event.preventDefault(); event.returnValue = ''; } };
  document.addEventListener('keydown', keyHandler); document.addEventListener('visibilitychange', visibilityHandler); window.addEventListener('beforeunload', unloadHandler);
  renderTabs(); renderScope(); emptyReader();
  await Promise.all([loadPlaces(), loadList()]);
  results.scrollTop = rememberedListScroll;
  if (ctx.params?.objectId) await open(ctx.params.objectId, ctx.params.revision);
  else if (ctx.params?.newEntry) await newEntry();
  else if (rememberedDraftId) { try { await openDraft(await ctx.api.get(rememberedDraftId)); } catch { emptyReader(); } }
  else if (rememberedSelectedId) { await open(rememberedSelectedId); reader.scrollTop = rememberedReaderScroll; }
  else {
    try {
      const drafts = await ctx.api.list({ objectType: 'draft', limit: 1 });
      if (drafts.items.length) reader.prepend(node('div', { class: 'chronicle-resume' }, text('你有一笔尚未收入史书的草稿。', ''), action('继续书写', () => openDraft(drafts.items[0]))));
    } catch (error) { showError(reader, error, () => ctx.refresh?.()); }
  }
  return {
    open, newEntry,
    getNavigationState(){return{resumeState:structuredClone(memory),...(selectedRevision&&selected?{objectId:selected.id,revision:selectedRevision}:{})};},
    async search(value) { q = String(value || ''); searchInput.value = q; offset = 0; await loadList(); searchInput.focus(); },
    async refresh({external=false}={}) { const placesReady=await loadPlaces(),listReady=await loadList();if(!placesReady||!listReady)return false; if(external&&selected&&!selectedRevision&&!session&&!unsavedReview){const latest=await ctx.api.get(selected.id,{includeDeleted:true});if(latest.revision!==selected.revision)await open(selected.id);} return true; },
    setContext(next) { selection = structuredClone(next || {}); placeIds = (selection.placeRefs || []).map(p => p.placeId); timeSpec = selection.occurrenceTime || null; offset = 0; renderScope(); loadList(); },
    async dispose() { saveMemory(); await leaveEditor(); disposed = true; resizeObserver.disconnect(); clearTimeout(searchTimer); document.removeEventListener('keydown', keyHandler); document.removeEventListener('visibilitychange', visibilityHandler); window.removeEventListener('beforeunload', unloadHandler); },
  };
}
