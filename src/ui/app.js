const $ = selector => document.querySelector(selector);
let state, listFilter = 'all', toastTimer;
let collectionView = 'page';
const collectionFilters = { page: 'all', history: 'all' };
const collectionPages = { page: 0, history: 0 };
const pageSize = 250;
let previewId = null, previewGeneration = 0;
const statusText = { checking: '正在识别清晰度…', detected: '待下载', queued: '排队中', paused: '已暂停', downloading: '下载中', complete: '已保存', failed: '下载失败', unsupported: '暂不支持', cancelled: '已取消', filtered: '小于筛选大小', duplicate: '重复视频，已跳过' };
statusText.missing = '文件已丢失';
const bytes = n => n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n || 0} B`;
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 5000); }
async function command(name, value) {
  try { const result = await window.mediaCatch.command(name, value); if (result) render(result); return result; }
  catch (error) { toast(error.message.replace(/^Error invoking remote method '[^']+': Error: /, '')); }
}
function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
function action(label, name, id) { const button = el('button', '', label); button.addEventListener('click', () => command(name, id)); return button; }
function selectedTypeItems() { return (collectionView === 'history' ? state.history || [] : state.items).filter(item => state.settings.type === 'both' || item.type === state.settings.type); }
function resourceReference(item) { return item.history ? `history:${item.id}` : item.id; }
function renderList(resetScroll = false) {
  if (resetScroll) collectionPages[collectionView] = 0;
  const list = $(collectionView === 'history' ? '#history-list' : '#resource-list');
  const scroll = resetScroll ? 0 : list.scrollTop;
  const typeItems = selectedTypeItems();
  let items = typeItems.filter(item => listFilter === 'all' ||
    listFilter === 'pending' && ['checking', 'detected', 'queued', 'paused', 'downloading'].includes(item.status) ||
    listFilter === 'complete' && item.status === 'complete' ||
    listFilter === 'failed' && ['failed', 'unsupported', 'missing'].includes(item.status));
  items = items.sort((a, b) => (b.completedAt || b.startedAt || b.createdAt) - (a.completedAt || a.startedAt || a.createdAt));
  const fragment = document.createDocumentFragment();
  if (!items.length) {
    const kind = { both: '媒体', image: '图片', video: '视频' }[state.settings.type];
    const empty = el('div', 'list-empty'); empty.append(el('span', 'empty-icon', '▤'), el('span', '', typeItems.length ? '此状态下还没有记录' : collectionView === 'history' ? `还没有${kind}下载记录` : state.page.loading ? '正在重新收集本页资源…' : `本页还没有发现${kind}资源`), el('br'), el('span', '', typeItems.length ? '切换状态筛选，可查看其他记录。' : collectionView === 'history' ? '下载后的文件会保留在这里。' : '浏览、滚动或播放视频后，资源会自动显示。')); fragment.append(empty);
  }
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const page = collectionPages[collectionView] = Math.min(collectionPages[collectionView], pageCount - 1);
  $('#list-pagination').hidden = pageCount <= 1;
  $('#page-number').textContent = `${page + 1} / ${pageCount} 页 · ${items.length} 条`;
  $('#previous-page').disabled = page === 0;
  $('#next-page').disabled = page + 1 >= pageCount;
  for (const item of items.slice(page * pageSize, (page + 1) * pageSize)) {
    const card = el('article', 'resource'); card.dataset.id = item.id;
    const canPreview = !['unsupported', 'duplicate', 'missing'].includes(item.status);
    const icon = el('button', `resource-icon ${item.type}`, item.type === 'image' ? '▧' : '▷');
    icon.setAttribute('aria-label', `预览 ${item.name}`); icon.title = '点击预览'; icon.disabled = !canPreview;
    icon.addEventListener('click', () => openPreview(item)); card.append(icon);
    const info = el('div', 'resource-info');
    const title = el('button', 'resource-title', item.name); title.title = `点击预览 · ${item.source || item.host || item.name}`; title.disabled = !canPreview;
    title.addEventListener('click', () => openPreview(item));
    card.addEventListener('click', event => { if (canPreview && !event.target.closest('button')) openPreview(item); });
    const format = item.mode === 'hls' ? 'HLS · 合并点播' : item.ext.toUpperCase();
    const meta = el('div', 'resource-meta'); meta.append(el('span', '', format + (item.hasAudio === false ? ' · 无音轨' : item.hasAudio === true ? ' · 含声音' : item.mergesAudio ? ' · 自动合并音轨' : '')), el('span', '', item.size ? bytes(item.size) : '大小待确认'));
    info.append(title, meta);
    if (item.mode === 'hls') {
      const quality = item.quality;
      const label = quality?.width && quality?.height ? `${Math.min(quality.width, quality.height)}p · ${quality.width} × ${quality.height}` : '分辨率未提供';
      info.append(el('div', 'quality-detail', `${item.status === 'complete' ? '已保存清晰度' : '自动选择'} · ${label}${item.qualityCount > 1 ? ` · ${item.qualityCount} 个版本` : ''}`));
      if (item.qualityNote) info.append(el('div', 'resource-error', item.qualityNote));
    }
    if (item.history) info.append(el('div', 'history-detail', [item.host, item.completedAt ? new Date(item.completedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '本次下载任务'].filter(Boolean).join(' · ')));
    if (item.status === 'downloading') {
      const progress = el('progress', 'progress'); progress.max = 1;
      if (item.segmentCount) progress.value = item.segmentsDone / item.segmentCount;
      else if (item.size) progress.value = Math.min(1, item.received / item.size);
      progress.setAttribute('aria-label', '下载进度'); info.append(progress);
    }
    const row = el('div', `resource-status ${item.status}`);
    const label = item.status === 'downloading' ? item.muxing ? '正在合并音视频…' : item.segmentCount ? `下载分段 ${item.segmentsDone}/${item.segmentCount}` : `已下载 ${bytes(item.received)}` : statusText[item.status];
    row.append(el('span', '', label));
    if (item.status === 'complete') row.append(action('查看文件 ↗', 'reveal', resourceReference(item)));
    else if (['downloading', 'queued'].includes(item.status)) row.append(action('取消', 'cancel', resourceReference(item)));
    else if (!['unsupported', 'checking'].includes(item.status) && item.canRetry !== false) row.append(action(item.status === 'missing' ? '重新下载' : item.status === 'failed' ? '重试' : '下载', 'retry', resourceReference(item)));
    if (['failed', 'cancelled'].includes(item.status)) row.append(action('移除', 'remove', resourceReference(item)));
    info.append(row);
    if (item.error) info.append(el('p', 'resource-error', item.error));
    card.append(info); fragment.append(card);
  }
  list.replaceChildren(fragment); list.scrollTop = scroll;
}
function render(next) {
  const typeChanged = state?.settings.type !== next.settings.type;
  const pageChanged = state?.page.generation !== next.page.generation;
  if (typeChanged) { collectionPages.page = 0; collectionPages.history = 0; }
  if (pageChanged) collectionPages.page = 0;
  state = next;
  $('#resource-list').hidden = collectionView !== 'page';
  $('#history-list').hidden = collectionView !== 'history';
  $('#collection-title').textContent = collectionView === 'history' ? '下载历史' : '当前页面资源';
  $('#size-label').textContent = collectionView === 'history' ? '已保存大小' : '本页已下载';
  $('#clear').hidden = collectionView === 'history';
  $('#clear-failed').hidden = collectionView !== 'history';
  $('#clear-failed').disabled = !(state.history || []).some(i => ['failed', 'cancelled'].includes(i.status));
  document.querySelectorAll('[data-collection]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.collection === collectionView)));
  document.querySelectorAll('[data-filter]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.filter === listFilter)));
  $('[data-filter=pending]').textContent = collectionView === 'history' ? '进行中' : '待下载';
  $('#capture-status').textContent = state.enabled ? '自动下载中' : '未开启';
  $('#capture-status').classList.toggle('active', state.enabled);
  $('#toggle-capture').classList.toggle('active', state.enabled);
  $('#toggle-label').textContent = state.enabled ? '暂停自动下载' : '开始自动下载';
  $('#toggle-capture>span').textContent = state.enabled ? 'Ⅱ' : '↓';
  $('#capture-hint').textContent = state.enabled ? '浏览、滚动或播放视频，新资源会自动保存。' : '开启后，当前已发现和新加载的资源都会下载。';
  document.querySelectorAll('[data-type]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.type === state.settings.type)));
  $('#min-size').value = state.settings.minImageKB;
  $('#video-quality').hidden = state.settings.type === 'image';
  $('#open-folder').textContent = state.settings.downloadDir.replace(/.*[/\\](?=[^/\\]+[/\\][^/\\]+$)/, '…/');
  $('#open-folder').title = state.settings.downloadDir;
  const typeItems = selectedTypeItems();
  $('#total-count').textContent = typeItems.length;
  $('#complete-count').textContent = typeItems.filter(i => i.status === 'complete').length;
  $('#active-count').textContent = typeItems.filter(i => ['queued', 'downloading'].includes(i.status)).length;
  $('#total-size').textContent = bytes(typeItems.reduce((sum, i) => sum + (collectionView === 'history' ? i.status === 'complete' ? i.size || 0 : 0 : i.received), 0));
  $('#fragment-note').hidden = collectionView === 'history' || !state.ignoredFragments || state.settings.type === 'image';
  $('#fragment-note').textContent = `已忽略 ${state.ignoredFragments || 0} 个播放片段，仅保留可独立下载的候选资源。`;
  const isPage = /^https?:/.test(state.page.url);
  if (document.activeElement !== $('#address')) $('#address').value = isPage ? state.page.url : '';
  $('#page-title').textContent = state.page.loading ? '正在加载网页…' : isPage ? state.page.title || state.page.url : '浏览器已就绪';
  $('#page-dot').classList.toggle('loading', state.page.loading);
  $('#back').disabled = !state.page.canBack; $('#forward').disabled = !state.page.canForward;
  $('#page-error').hidden = !state.page.error; $('#page-error').textContent = state.page.error;
  $('#footer-message').textContent = state.error || (state.capacityReached ? '已达到本次 2,000 条资源上限，请暂停后清理列表再继续。' : '支持图片、直链视频和未加密 HLS 点播；自动选择清晰度并合并分离音轨。');
  $('#version').textContent = state.version;
  renderList(typeChanged || (pageChanged && collectionView === 'page'));
}
$('#address-form').addEventListener('submit', event => { event.preventDefault(); const input = $('#address'); const value = input.value; input.blur(); command('navigate', value); });
for (const [id, cmd] of [['back', 'back'], ['forward', 'forward'], ['reload', 'reload'], ['toggle-capture', 'toggle'], ['choose-folder', 'chooseDirectory'], ['open-folder', 'openDirectory'], ['clear', 'clear'], ['clear-failed', 'clearFailed']]) $(`#${id}`).addEventListener('click', () => command(cmd));
for (const [id, delta] of [['previous-page', -1], ['next-page', 1]]) $(`#${id}`).addEventListener('click', () => {
  collectionPages[collectionView] = Math.max(0, collectionPages[collectionView] + delta);
  renderList();
  $(collectionView === 'history' ? '#history-list' : '#resource-list').scrollTop = 0;
});
document.querySelectorAll('[data-type]').forEach(button => button.addEventListener('click', () => command('type', button.dataset.type)));
document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => {
  listFilter = button.dataset.filter;
  collectionFilters[collectionView] = listFilter;
  document.querySelectorAll('[data-filter]').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
  renderList(true);
}));
document.querySelectorAll('[data-collection]').forEach(button => button.addEventListener('click', () => {
  collectionView = button.dataset.collection;
  listFilter = collectionFilters[collectionView];
  render(state);
  if (collectionView === 'history') command('checkHistory');
}));
$('#min-size').addEventListener('change', event => command('minImageKB', Number(event.target.value)));
const observer = new ResizeObserver(() => {
  const rect = $('#browser-host').getBoundingClientRect();
  window.mediaCatch.bounds({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
});
observer.observe($('#browser-host'));
window.mediaCatch.onState(render);
command('state');

async function openPreview(item) {
  const generation = ++previewGeneration;
  previewId = resourceReference(item);
  $('#preview-title').textContent = item.name;
  $('#preview-stage').replaceChildren();
  $('#preview-message').textContent = '正在准备预览…';
  $('#preview-detail').textContent = item.status === 'complete' ? '正在读取已保存文件。' : '预览使用临时缓存，确认内容后可保存文件。';
  $('#save-preview').disabled = true; $('#save-preview').textContent = '保存文件';
  if (!$('#preview-dialog').open) $('#preview-dialog').showModal();
  try {
    const result = await window.mediaCatch.preview(resourceReference(item));
    if (generation !== previewGeneration) return;
    const media = document.createElement(result.type === 'image' ? 'img' : 'video');
    media.id = 'preview-media';
    if (result.type === 'image') media.alt = item.name;
    else { media.controls = true; media.preload = 'auto'; media.playsInline = true; }
    let ready = false;
    const onReady = () => {
      if (generation !== previewGeneration) return;
      ready = true;
      const dimensions = result.type === 'image' ? `${media.naturalWidth} × ${media.naturalHeight}` : `${media.videoWidth} × ${media.videoHeight}`;
      $('#preview-message').textContent = result.type === 'image' ? `图片已加载 · ${dimensions}` : `视频可预览 · ${dimensions} · ${Number.isFinite(media.duration) ? Math.round(media.duration) + ' 秒' : ''}${result.hasAudio === false ? ' · 此文件没有音轨' : ''}`;
      $('#preview-detail').textContent = result.saved ? '正在预览已保存文件。' : '保存将使用这份预览文件，无需重新下载。';
      $('#save-preview').textContent = result.saved ? '查看文件 ↗' : '保存文件';
      $('#save-preview').disabled = false;
    };
    media.addEventListener(result.type === 'image' ? 'load' : 'loadeddata', onReady, { once: true });
    media.addEventListener('error', () => {
      if (generation !== previewGeneration) return;
      $('#preview-message').textContent = '预览失败：当前播放器无法解码此资源，或文件不完整。请检查原网页。';
      $('#preview-detail').textContent = ready ? '已停止预览，请勿仅凭先前画面判断文件完整。' : '尚未确认内容；此处不会将它标为预览成功。';
      $('#save-preview').disabled = true;
    });
    $('#preview-stage').replaceChildren(media);
    $('#preview-message').textContent = '正在读取媒体画面…';
    media.src = result.url;
  } catch (error) {
    if (generation !== previewGeneration) return;
    $('#preview-message').textContent = error.message.replace(/^Error invoking remote method '[^']+': Error: /, '');
    $('#preview-detail').textContent = '预览未成功，不会保存到下载目录。';
  }
}
function closePreview() {
  ++previewGeneration;
  const id = previewId; previewId = null;
  const media = $('#preview-media');
  if (media?.tagName === 'VIDEO') media.pause();
  if (media) { media.removeAttribute('src'); if (media.tagName === 'VIDEO') media.load(); }
  $('#preview-stage').replaceChildren();
  $('#preview-dialog').close();
  command('closePreview');
  (document.querySelector(`${collectionView === 'history' ? '#history-list' : '#resource-list'} [data-id="${id?.replace(/^history:/, '')}"] .resource-title`) || $('#address')).focus();
}
$('#close-preview').addEventListener('click', closePreview);
$('#preview-dialog').addEventListener('cancel', event => { event.preventDefault(); closePreview(); });
$('#save-preview').addEventListener('click', async () => {
  const id = previewId, generation = previewGeneration;
  const item = (id?.startsWith('history:') ? state.history || [] : state.items).find(i => i.id === id?.replace(/^history:/, ''));
  if (item?.status === 'complete') { command('reveal', id); return; }
  $('#save-preview').disabled = true;
  const saved = await command('savePreview', id);
  if (generation !== previewGeneration) return;
  $('#save-preview').disabled = false;
  if (saved?.history.some(i => i.id === id?.replace(/^history:/, '') && i.status === 'complete')) {
    $('#save-preview').textContent = '查看文件 ↗'; $('#preview-detail').textContent = '已将这份预览文件保存到下载目录。';
  }
});
window.mediaCatch.onPreviewProgress(progress => {
  if (progress.id !== previewId?.replace(/^history:/, '')) return;
  $('#preview-message').textContent = progress.segmentCount ? `正在合并预览 ${progress.segmentsDone}/${progress.segmentCount} · ${bytes(progress.received)}` : `正在加载预览 ${bytes(progress.received)}${progress.size ? ' / ' + bytes(progress.size) : ''}`;
});
