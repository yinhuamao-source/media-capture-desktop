const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { remoteURL, mediaKind, urlKey, outputRelative, replayHeaders, parseHls, compareQuality, knownHlsRendition } = require('./media.cjs');
const { validateVideoFile } = require('./video-validation.cjs');
const { muxTracks } = require('./mux.cjs');

async function readChunk(reader, signal) {
  let timer, onAbort;
  try {
    signal?.throwIfAborted();
    return await Promise.race([
      reader.read(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('45 秒内未收到数据，请重试')), 45000); }),
      ...(signal ? [new Promise((_, reject) => { onAbort = () => reject(new Error('下载已中断')); signal.addEventListener('abort', onAbort, { once: true }); })] : []),
    ]);
  } finally { clearTimeout(timer); if (onAbort) signal.removeEventListener('abort', onAbort); }
}

async function writeResponse(response, handle, item, notify, signal, limit = Infinity) {
  if (!response.body) throw new Error('服务器返回了空文件');
  const reader = response.body.getReader();
  let written = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await readChunk(reader, signal);
      if (done) break;
      written += value.byteLength;
      if (written > limit) throw new Error('资源超过大小上限');
      let offset = 0;
      while (offset < value.byteLength) {
        const { bytesWritten } = await handle.write(value, offset, value.byteLength - offset);
        if (!bytesWritten) throw new Error('无法写入下载目录');
        offset += bytesWritten;
      }
      item.received += value.byteLength;
      notify();
    }
    const expected = Number(response.headers.get('content-length'));
    if (expected > 0 && !response.headers.get('content-encoding') && written !== expected) throw new Error('服务器返回的文件长度不完整，请重试');
    return written;
  } finally { reader.cancel().catch(() => {}); }
}

async function publishFile(temp, desired) {
  const ext = path.extname(desired);
  for (let n = 0; n < 10000; n++) {
    const candidate = n ? `${desired.slice(0, -ext.length)} (${n})${ext}` : desired;
    try {
      try { await fs.link(temp, candidate); }
      catch (error) {
        if (!['EPERM', 'EOPNOTSUPP', 'ENOTSUP', 'EXDEV', 'ENOSYS'].includes(error.code)) throw error;
        await fs.copyFile(temp, candidate, constants.COPYFILE_EXCL);
      }
      await fs.unlink(temp);
      return candidate;
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  throw new Error('同名文件过多，请更换保存目录');
}

class DownloadQueue extends EventEmitter {
  constructor({ fetcher, settings, history = [], historyChanged = () => {} }) {
    super();
    this.fetcher = fetcher;
    this.settings = settings;
    this.history = new Map(history.map(h => [h.id, h]));
    this.historyChanged = historyChanged;
    this.items = new Map();
    this.currentIds = new Set();
    this.generation = 0;
    this.active = new Map();
    this.manual = new Set();
    this.hlsPlans = new Map();
    this.hlsMetadata = new Map();
    this.probePending = new Map();
    this.probes = new Map();
    this.fileChecks = new Map();
    this.qualityTimer = null;
    this.qualityReadyAt = 0;
    this.dismissed = new Set();
    this.fragments = new Set();
    this.enabled = false;
    this.capacityReached = false;
    this.closed = false;
  }
  notify() { this.emit('change'); }
  selected(item) { return this.settings.type === 'both' || this.settings.type === item.type; }
  eligible(item) { return this.selected(item) && (item.type !== 'image' || !item.size || item.size >= this.settings.minImageKB * 1024); }

  beginPage() {
    this.generation++;
    this.probePending.clear();
    for (const probe of this.probes.values()) probe.abort();
    this.hlsMetadata.clear();
    this.currentIds.clear(); this.dismissed.clear(); this.capacityReached = false;
    for (const [id, item] of this.items) {
      if (!this.active.has(id) && item.status !== 'queued' && (!item.startedAt || item.status === 'complete' || item.status === 'fragment')) this.items.delete(id);
    }
    this.notify();
    return this.generation;
  }

  discover(input) {
    if (input.generation !== undefined && input.generation !== this.generation) return;
    const url = remoteURL(input.url);
    const kind = input.kind || mediaKind(url, input.mime, input.resourceType);
    if (!url || !kind) return;
    const id = urlKey(url);
    if (this.dismissed.has(id) || this.fragments.has(id)) return;
    const existing = this.items.get(id);
    if (existing) {
      const newlyVisible = !this.currentIds.has(id);
      this.currentIds.add(id);
      if (input.headers && (input.source !== 'dom' || existing.headersSource !== 'network')) {
        existing.headers = replayHeaders(input.headers);
        existing.headersSource = input.source === 'dom' ? 'dom' : 'network';
      }
      if (input.size > 0 && existing.status !== 'complete') existing.size = input.size;
      if (newlyVisible) this.notify();
      if (newlyVisible && existing.mode === 'hls') this.probeHls(existing);
      if (newlyVisible && existing.status === 'complete') this.recheckDiscovered(existing);
      return existing;
    }
    // Retain old failures for retry until space is needed, without letting them
    // permanently prevent discovery on subsequent pages.
    if (this.items.size >= 2000) {
      for (const [oldID, old] of this.items) {
        if (!this.currentIds.has(oldID) && !this.active.has(oldID) && ['failed', 'cancelled', 'missing'].includes(old.status)) {
          this.remove(oldID);
          if (this.items.size < 2000) break;
        }
      }
    }
    if (this.items.size >= 2000) { this.capacityReached = true; this.notify(); return; }
    this.capacityReached = false;
    const previous = this.history.get(id);
    const item = {
      id, url, ...kind, mime: input.mime || '', pageURL: remoteURL(input.pageURL) || url,
      ext: previous?.filePath ? path.extname(previous.filePath).slice(1).toLowerCase() || kind.ext : kind.ext,
      headers: replayHeaders(input.headers), size: previous?.size || input.size || 0, received: 0, segmentsDone: 0,
      hasAudio: previous?.hasAudio,
      quality: previous?.quality || input.quality || (kind.mode === 'hls' ? knownHlsRendition(url)?.quality : undefined),
      headersSource: input.headers ? input.source === 'dom' ? 'dom' : 'network' : 'none',
      status: previous ? 'complete' : kind.mode === 'dash' ? 'unsupported' : 'detected',
      error: kind.mode === 'dash' ? '当前版本暂不支持 DASH 音视频轨道合并' : '',
      filePath: previous?.filePath || '', createdAt: Date.now(),
    };
    item.name = previous?.filePath ? path.basename(previous.filePath) : path.basename(outputRelative(item));
    this.items.set(id, item);
    this.currentIds.add(id);
    if (item.mode === 'hls') this.probeHls(item);
    else if (this.enabled && item.status === 'detected' && this.eligible(item)) item.status = 'queued';
    this.notify();
    this.pump();
    if (previous) this.recheckDiscovered(item);
    return item;
  }

  setEnabled(value) {
    this.enabled = Boolean(value);
    if (this.enabled) {
      for (const item of this.items.values()) if (!item.supersededBy && (this.currentIds.has(item.id) || item.startedAt) && ['detected', 'paused', 'missing'].includes(item.status) && this.eligible(item)) item.status = 'queued';
    } else {
      this.manual.clear();
      for (const item of this.items.values()) if (item.status === 'queued') item.status = 'paused';
      for (const controller of this.active.values()) controller.abort('paused');
    }
    this.notify();
    this.pump();
  }

  updateSettings(settings) {
    this.settings = settings;
    for (const item of this.items.values()) {
      if (item.status === 'filtered' && this.eligible(item)) item.status = 'detected';
      if (!this.eligible(item) && ['queued', 'paused'].includes(item.status)) item.status = 'detected';
      if (!this.eligible(item) && this.active.has(item.id) && !this.manual.has(item.id)) this.active.get(item.id).abort('filtered');
      if (this.enabled && !item.supersededBy && this.currentIds.has(item.id) && this.eligible(item) && ['detected', 'missing'].includes(item.status)) item.status = 'queued';
    }
    this.notify(); this.pump();
  }

  async retry(id) {
    let item = this.items.get(id);
    const visited = new Set();
    while (item?.supersededBy && !visited.has(item.id)) { visited.add(item.id); item = this.items.get(item.supersededBy); }
    if (item?.status === 'complete') await this.checkSaved(item.id);
    if (this.closed || !item || this.items.get(item.id) !== item || ['downloading', 'complete', 'unsupported', 'fragment'].includes(item.status)) return;
    if (item.status === 'checking') { this.manual.add(item.id); return; }
    item.status = 'queued'; item.error = '';
    this.manual.add(item.id);
    this.notify(); this.pump();
  }
  cancel(id) {
    const item = this.items.get(id);
    if (!item || item.status === 'complete') return;
    this.manual.delete(id);
    if (this.active.has(id)) this.active.get(id).abort('cancelled');
    else item.status = 'cancelled';
    this.notify();
  }
  clear() {
    for (const id of this.currentIds) {
      const item = this.items.get(id);
      if (item && !this.active.has(id) && item.status !== 'queued') {
        this.dismissed.add(id); this.currentIds.delete(id);
        this.probePending.delete(id); this.probes.get(id)?.abort(); this.hlsMetadata.delete(id);
        if (!item.startedAt || ['complete', 'failed', 'cancelled', 'missing'].includes(item.status)) this.items.delete(id);
      }
    }
    while (this.dismissed.size > 10000) this.dismissed.delete(this.dismissed.values().next().value);
    this.capacityReached = this.items.size >= 2000; this.notify();
  }
  remove(id) {
    const item = this.items.get(id);
    if (!item || this.active.has(id) || !['failed', 'cancelled', 'missing'].includes(item.status)) return;
    if (this.currentIds.has(id)) this.dismissed.add(id);
    this.currentIds.delete(id); this.items.delete(id); this.manual.delete(id);
    this.probePending.delete(id); this.probes.get(id)?.abort(); this.hlsMetadata.delete(id);
    this.capacityReached = this.items.size >= 2000; this.notify();
  }
  clearFailed() {
    for (const [id, item] of this.items) if (['failed', 'cancelled'].includes(item.status)) this.remove(id);
  }
  recheckDiscovered(item) {
    void this.checkSaved(item.id).then(exists => {
      if (!exists && !this.closed && this.items.get(item.id) === item && this.currentIds.has(item.id) && item.status === 'missing' && this.enabled && this.eligible(item)) {
        item.status = 'queued'; this.notify(); this.pump();
      }
    }).catch(() => {}); // Permission/IO errors must not be mistaken for a deleted file.
  }
  async checkSaved(reference, { persist = true } = {}) {
    const item = this.resource(reference);
    if (!item || !['complete', 'missing'].includes(item.status)) return false;
    const id = item.id;
    if (this.fileChecks.has(id)) return this.fileChecks.get(id);
    const record = this.history.get(id);
    const check = (async () => {
      let exists;
      try { exists = (await fs.stat(item.filePath)).isFile(); }
      catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; exists = false; }
      if (this.closed || this.history.get(id) !== record) return exists;
      const live = this.items.get(id);
      if (record && Boolean(record.missing) !== !exists) {
        record.missing = !exists;
        if (persist) this.historyChanged([...this.history.values()]);
      }
      if (live && ['complete', 'missing'].includes(live.status)) {
        live.status = exists ? 'complete' : 'missing';
        live.error = exists ? '' : '文件已被移动或删除，可以重新下载';
        if (!exists) live.received = 0;
      }
      this.notify();
      return exists;
    })();
    this.fileChecks.set(id, check);
    try { return await check; } finally { this.fileChecks.delete(id); }
  }
  async checkHistory() {
    const ids = [...this.history.keys()];
    const missingBefore = ids.filter(id => this.history.get(id)?.missing).join(',');
    for (let n = 0; n < ids.length && !this.closed; n += 16) {
      await Promise.all(ids.slice(n, n + 16).map(id => this.checkSaved(`history:${id}`, { persist: false }).catch(() => {})));
    }
    if (!this.closed && missingBefore !== ids.filter(id => this.history.get(id)?.missing).join(',')) this.historyChanged([...this.history.values()]);
  }
  snapshot() {
    return this.serialize([...this.items.values()].filter(item => this.currentIds.has(item.id) && item.status !== 'fragment' && !item.supersededBy));
  }
  serialize(items) {
    return items.map(({ headers, headersSource, url, pageURL, supersededBy, ...item }) => ({
      ...item, host: new URL(pageURL).hostname,
      // Do not pass authentication headers or signed query strings into the UI.
      source: new URL(url).origin + new URL(url).pathname,
    }));
  }
  historyItem(record) {
    const ext = path.extname(record.filePath).slice(1).toLowerCase();
    const type = record.type || (['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'svg', 'bmp', 'ico', 'tif', 'tiff', 'img'].includes(ext) ? 'image' : 'video');
    return { ...record, ext, type, mode: record.mode || 'file', name: path.basename(record.filePath), status: record.missing ? 'missing' : 'complete', received: 0,
      canRetry: Boolean(this.items.get(record.id)?.url), error: record.missing ? '文件已被移动或删除；可重新下载，或打开原网页重新采集' : '',
      host: record.host || path.basename(path.dirname(path.dirname(path.dirname(record.filePath)))),
      source: '', createdAt: record.completedAt || 0, history: true };
  }
  historySnapshot() {
    const records = new Map([...this.history].map(([id, record]) => [id, this.historyItem(record)]));
    const tasks = [...this.items.values()].filter(item => ['queued', 'downloading', 'paused', 'failed', 'cancelled', 'missing'].includes(item.status) && (item.startedAt || ['queued', 'missing'].includes(item.status)));
    for (const item of this.serialize(tasks)) records.set(item.id, { ...item, history: true });
    return [...records.values()].sort((a, b) => (b.completedAt || b.startedAt || b.createdAt) - (a.completedAt || a.startedAt || a.createdAt));
  }
  resource(reference) {
    if (typeof reference !== 'string') return undefined;
    if (!reference.startsWith('history:')) return this.items.get(reference);
    const id = reference.slice(8);
    const record = this.history.get(id);
    return record ? this.historyItem(record) : this.items.get(id);
  }
  remember(item) {
    this.history.set(item.id, { id: item.id, filePath: item.filePath, size: item.size, hasAudio: item.hasAudio, quality: item.quality, type: item.type, mode: item.mode,
      host: new URL(item.pageURL).hostname, completedAt: Date.now() });
    while (this.history.size > 5000) this.history.delete(this.history.keys().next().value);
    this.historyChanged([...this.history.values()]);
  }

  probeHls(item) {
    if (this.closed) return;
    if (item.status === 'detected') item.status = 'checking';
    this.probePending.set(item.id, { item, generation: this.generation });
    this.qualityReadyAt = Date.now() + 400;
    this.pumpProbes();
  }
  pumpProbes() {
    if (this.closed) return;
    for (const [id, entry] of this.probePending) {
      if (this.probes.size >= 3) break;
      if (this.probes.has(id)) continue;
      this.probePending.delete(id);
      const controller = new AbortController(); this.probes.set(id, controller);
      const { item, generation } = entry;
      const valid = () => !controller.signal.aborted && generation === this.generation && this.items.get(id) === item && this.currentIds.has(id);
      const inspect = async () => {
        try {
          const plan = await this.readHls(item.url, item, AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]));
          if (!valid()) return;
          this.hlsMetadata.set(id, plan);
          if (plan.quality && item.status !== 'complete' && !this.active.has(id)) item.quality = plan.quality;
          if (plan.variants) item.qualityCount = plan.variants.filter(v => !v.audioOnly).length;
          if (plan.variants && item.status !== 'complete') item.mergesAudio = Boolean(plan.variants.find(v => v.url === plan.variant)?.audioURL);
          else this.markSegments(plan, item);
          if (item.status === 'checking') item.status = 'detected';
        } catch (error) {
          if (!valid()) return;
          this.hlsMetadata.set(id, { error: error.message });
          if (item.status === 'checking') { item.status = 'failed'; item.error = error.message; }
        } finally {
          if (valid()) {
            this.reconcileQuality();
            for (const candidate of this.items.values()) {
              if (!candidate.supersededBy && this.currentIds.has(candidate.id) && candidate.status === 'detected' && (this.manual.has(candidate.id) || this.enabled && this.eligible(candidate))) candidate.status = 'queued';
            }
            this.notify();
          }
          this.probes.delete(id); this.pumpProbes(); this.pump();
        }
      };
      void inspect();
    }
  }
  reconcileQuality() {
    const items = [...this.items.values()].filter(i => this.currentIds.has(i.id) && i.mode === 'hls');
    const owners = new Map();
    for (const item of items) {
      const plan = this.hlsMetadata.get(item.id);
      if (!plan?.variants || plan.error) continue;
      for (const variant of plan.variants) {
        const id = urlKey(variant.url);
        if (id !== item.id && !owners.has(id)) owners.set(id, item.id);
        const child = this.items.get(id);
        if (child && child.status !== 'complete' && variant.width && !this.active.has(id)) child.quality = { width: variant.width, height: variant.height, bandwidth: variant.bandwidth };
      }
    }
    // On X, separately requested renditions also carry a stable video asset ID.
    // This only selects among observed playlists; it never invents a higher-quality URL.
    const groups = new Map();
    for (const item of items) {
      const known = knownHlsRendition(item.url);
      if (known) { if (!groups.has(known.group)) groups.set(known.group, []); groups.get(known.group).push(item); }
    }
    for (const group of groups.values()) {
      const usable = group.filter(i => this.hlsMetadata.has(i.id) && !this.hlsMetadata.get(i.id).error && !owners.has(i.id));
      usable.sort((a, b) => compareQuality(a.quality, b.quality) || Number(Boolean(this.hlsMetadata.get(b.id)?.variant)) - Number(Boolean(this.hlsMetadata.get(a.id)?.variant)));
      const best = usable[0];
      if (!best) continue;
      best.qualityCount = Math.max(best.qualityCount || 0, group.filter(i => i.quality?.width).length);
      for (const other of group) if (other.id !== best.id) owners.set(other.id, best.id);
    }
    for (const item of items) {
      let owner = owners.get(item.id);
      const seen = new Set([item.id]);
      while (owner && owners.has(owner) && !seen.has(owner)) { seen.add(owner); owner = owners.get(owner); }
      if (seen.has(owner)) owner = undefined;
      item.supersededBy = owner;
      if (owner) {
        if (this.active.has(item.id) && !this.manual.has(item.id)) this.active.get(item.id).abort('quality');
        else if (!this.active.has(item.id) && item.status !== 'complete') { item.status = 'duplicate'; item.error = ''; }
      } else if (item.status === 'duplicate') {
        const plan = this.hlsMetadata.get(item.id);
        item.status = plan?.error ? 'failed' : plan ? 'detected' : 'checking'; item.error = plan?.error || '';
      }
    }
  }
  markSegments(plan, item) {
    for (const segment of plan.segments || []) {
      const id = urlKey(segment); this.fragments.add(id);
      const part = this.items.get(id);
      if (part && part.id !== item.id) {
        this.active.get(id)?.abort('fragment');
        part.status = 'fragment'; part.error = '已识别为 HLS 播放片段，由完整视频统一合并';
      }
    }
  }
  pump() {
    if (this.closed) return;
    for (const item of this.items.values()) {
      if (this.active.size >= 3) break;
      if (item.status !== 'queued' || (!this.enabled && !this.manual.has(item.id))) continue;
      if (item.supersededBy && !this.manual.has(item.id)) continue;
      if (item.mode === 'hls' && (this.probes.size || this.probePending.size)) continue;
      if (item.mode === 'hls' && Date.now() < this.qualityReadyAt) {
        clearTimeout(this.qualityTimer);
        this.qualityTimer = setTimeout(() => this.pump(), this.qualityReadyAt - Date.now() + 1);
        continue;
      }
      const controller = new AbortController();
      this.active.set(item.id, controller);
      this.run(item, controller).finally(() => {
        this.active.delete(item.id); this.manual.delete(item.id);
        this.notify(); this.pump();
      });
    }
  }

  async request(url, item, signal) {
    signal.throwIfAborted();
    const result = await this.fetcher(url, { headers: item.headers, signal, credentialOrigin: new URL(item.url).origin });
    if (!result.response.ok) {
      await result.response.body?.cancel().catch(() => {});
      throw new Error(`下载失败：HTTP ${result.response.status}，请重新加载网页或登录后重试`);
    }
    return result;
  }

  async readHls(url, item, signal) {
    const { response, finalURL } = await this.request(url, item, signal);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('播放列表为空');
    const chunks = []; let size = 0;
    try {
      while (true) {
        const { value, done } = await readChunk(reader, signal);
        if (done) break;
        size += value.length;
        if (size > 4 * 1024 * 1024) throw new Error('HLS 播放列表过大');
        chunks.push(Buffer.from(value));
      }
    } finally { reader.cancel().catch(() => {}); }
    return parseHls(Buffer.concat(chunks).toString('utf8'), finalURL || url);
  }

  async hlsPlan(item, signal) {
    let requests = 0;
    const resolve = async (url, visited, quality, audioTrack = false) => {
      signal.throwIfAborted();
      if (++requests > 40) throw new Error('HLS 清晰度尝试过多，请重新加载网页');
      if (visited.size >= 5) throw new Error('HLS 播放列表嵌套过深');
      if (visited.has(url)) throw new Error('HLS 播放列表出现循环引用');
      const nextVisited = new Set(visited); nextVisited.add(url);
      const plan = await this.readHls(url, item, signal);
      if (!plan.variant) return { ...plan, quality };
      if (audioTrack) throw new Error('音轨播放列表结构不受支持，未保存缺声视频');
      const variants = plan.variants.filter(v => !v.audioOnly).sort(compareQuality);
      let failure;
      for (let index = 0; index < variants.length; index++) {
        const variant = variants[index];
        try {
          const selected = variant.width ? { width: variant.width, height: variant.height, bandwidth: variant.bandwidth } : quality;
          const result = await resolve(variant.url, nextVisited, selected);
          result.requiresAudio ||= variant.expectsAudio;
          if (variant.audioURL) {
            result.audio = await resolve(variant.audioURL, nextVisited, undefined, true);
            if (result.duration && result.audio.duration && Math.abs(result.duration - result.audio.duration) > Math.max(2, result.duration * 0.05)) throw new Error('音轨与视频时长不匹配，未保存不完整视频');
          }
          if (index) result.fallback = true;
          return result;
        } catch (error) { signal.throwIfAborted(); failure = error; }
      }
      throw failure;
    };
    const plan = await resolve(item.url, new Set(), item.quality);
    item.quality = plan.quality;
    item.requiresAudio = plan.requiresAudio || Boolean(knownHlsRendition(item.url)?.quality.width);
    item.mergesAudio = Boolean(plan.audio);
    if (plan.fallback) item.qualityNote = '较高清晰度的播放列表不可用，已自动选择可用版本';
    this.markSegments(plan, item); if (plan.audio) this.markSegments(plan.audio, item); this.notify();
    return plan;
  }

  async run(item, controller) {
    let handle, temp, hlsKey, response;
    const intermediates = new Set();
    const transfer = new AbortController();
    const signal = AbortSignal.any([controller.signal, transfer.signal, AbortSignal.timeout(30 * 60 * 1000)]);
    item.status = 'downloading'; item.startedAt ||= Date.now(); item.error = ''; item.received = 0; item.segmentsDone = 0;
    this.notify();
    try {
      const root = this.settings.downloadDir;
      const minBytes = item.type === 'image' && !this.manual.has(item.id) ? this.settings.minImageKB * 1024 : 0;
      let plan;
      if (item.mode === 'hls') {
        plan = await this.hlsPlan(item, signal);
        hlsKey = urlKey([...plan.segments, ...(plan.audio?.segments || [])].join('\n'));
        const priorID = this.hlsPlans.get(hlsKey);
        const prior = this.items.get(priorID);
        if (priorID && priorID !== item.id && prior && ['downloading', 'complete'].includes(prior.status)) {
          item.status = 'duplicate'; item.error = '同一视频已由另一条播放列表加入下载'; return;
        }
        this.hlsPlans.set(hlsKey, item.id);
        item.ext = plan.audio || plan.requiresAudio && plan.ext === 'ts' ? 'mp4' : plan.ext; item.segmentCount = plan.segments.length + (plan.audio?.segments.length || 0); item.size = 0;
      } else {
        ({ response } = await this.request(item.url, item, signal));
        const kind = mediaKind(item.url, response.headers.get('content-type') || '', item.type === 'image' ? 'image' : '');
        if (!kind || kind.type !== item.type || kind.mode !== 'file') {
          await response.body?.cancel();
          throw new Error('服务器返回的不是预期媒体，可能需要重新登录或资源已过期');
        }
        item.ext = kind.ext;
        const range = response.headers.get('content-range');
        if (response.status === 206) {
          const m = /^bytes 0-(\d+)\/(\d+)$/.exec(range || '');
          if (!m || Number(m[1]) + 1 !== Number(m[2])) {
            await response.body?.cancel(); throw new Error('服务器只返回了视频的一部分，已避免保存不完整视频');
          }
        }
        item.size = Number(response.headers.get('content-length')) || 0;
        if (item.size && item.size < minBytes) {
          await response.body?.cancel(); item.status = 'filtered'; return;
        }
      }
      signal.throwIfAborted();
      const desired = path.join(root, outputRelative(item));
      await fs.mkdir(path.dirname(desired), { recursive: true });
      temp = `${desired}.${randomUUID()}.part`;
      handle = await fs.open(temp, 'wx');
      if (plan) {
        for (const segmentURL of plan.segments) {
          const { response: segment } = await this.request(segmentURL, item, signal);
          const mime = segment.headers.get('content-type') || '';
          if (/text\/html|application\/(?:json|xml)/i.test(mime) || segment.status === 206) {
            await segment.body?.cancel(); throw new Error('视频分段无效或不完整');
          }
          const count = await writeResponse(segment, handle, item, () => this.notify(), signal);
          if (!count) throw new Error('视频分段为空');
          item.segmentsDone++; this.notify();
        }
      } else {
        await writeResponse(response, handle, item, () => this.notify(), signal);
      }
      await handle.close(); handle = null;
      if (plan?.audio || plan?.requiresAudio && plan.ext === 'ts') {
        const audioFile = plan.audio ? `${desired}.${randomUUID()}.audio.part` : null;
        const mergedFile = `${desired}.${randomUUID()}.merged.part`;
        if (audioFile) intermediates.add(audioFile);
        intermediates.add(temp); intermediates.add(mergedFile);
        if (audioFile) handle = await fs.open(audioFile, 'wx');
        for (const segmentURL of plan.audio?.segments || []) {
          const { response: segment } = await this.request(segmentURL, item, signal);
          if (/text\/html|application\/(?:json|xml)/i.test(segment.headers.get('content-type') || '') || segment.status === 206) { await segment.body?.cancel(); throw new Error('音频分段无效，未保存缺声视频'); }
          if (!await writeResponse(segment, handle, item, () => this.notify(), signal)) throw new Error('音频分段为空，未保存缺声视频');
          item.segmentsDone++; this.notify();
        }
        if (handle) await handle.close(); handle = null;
        item.muxing = true; this.notify();
        await muxTracks(temp, audioFile, mergedFile, signal);
        temp = mergedFile;
        item.muxing = false;
        item.received = (await fs.stat(temp)).size;
      }
      if (!item.received) throw new Error('下载内容为空');
      if (item.received < minBytes) { item.status = 'filtered'; return; }
      const inspection = await validateVideoFile(temp, item);
      if (inspection) item.hasAudio = inspection.hasAudio;
      if (item.requiresAudio && !inspection?.hasAudio) throw new Error('未找到完整音轨，未保存缺声视频；请在网页播放视频后重试');
      signal.throwIfAborted();
      item.filePath = await publishFile(temp, desired); temp = null;
      item.name = path.basename(item.filePath);
      item.status = 'complete'; item.size = item.received;
      this.remember(item);
    } catch (error) {
      if (controller.signal.aborted) {
        item.status = controller.signal.reason === 'quality' ? 'duplicate' : controller.signal.reason === 'fragment' ? 'fragment' : controller.signal.reason === 'paused' ? 'paused' : controller.signal.reason === 'filtered' ? 'detected' : 'cancelled';
      } else {
        item.status = error.code === 'MEDIA_FRAGMENT' ? 'fragment' : 'failed';
        if (item.status === 'fragment') this.fragments.add(item.id);
        item.error = error.message || '下载失败，请重试';
      }
    } finally {
      item.muxing = false;
      // Destroying Electron's response stream alone does not abort its native
      // request. End the transfer lifetime too, including mkdir/open failures.
      transfer.abort();
      await response?.body?.cancel().catch(() => {});
      if (handle) await handle.close().catch(() => {});
      if (temp) await fs.unlink(temp).catch(() => {});
      for (const file of intermediates) await fs.unlink(file).catch(() => {});
      if (hlsKey && item.status !== 'complete' && this.hlsPlans.get(hlsKey) === item.id) this.hlsPlans.delete(hlsKey);
      if (['paused', 'filtered'].includes(controller.signal.reason) && this.enabled && this.eligible(item) && ['paused', 'detected'].includes(item.status)) item.status = 'queued';
      this.notify();
    }
  }
  async shutdown() {
    this.closed = true; this.setEnabled(false);
    clearTimeout(this.qualityTimer); this.probePending.clear();
    for (const probe of this.probes.values()) probe.abort();
    while (this.active.size || this.probes.size || this.fileChecks.size) await new Promise(resolve => setTimeout(resolve, 20));
  }

  async importPreview(id, source, extension, quality) {
    if (this.closed) throw new Error('客户端正在关闭');
    const item = this.items.get(id);
    if (!item || item.status === 'fragment') throw new Error('资源已经移除，请重新选择');
    if (item.status === 'complete') return item;
    if (this.active.has(id) || item.status === 'queued') throw new Error('此资源正在下载，请稍候查看已保存文件');
    const controller = new AbortController();
    this.active.set(id, controller); item.status = 'downloading'; item.startedAt ||= Date.now(); item.error = ''; item.ext = extension; item.quality = quality || item.quality;
    this.notify();
    let temp;
    try {
      const desired = path.join(this.settings.downloadDir, outputRelative(item));
      await fs.mkdir(path.dirname(desired), { recursive: true });
      temp = `${desired}.${randomUUID()}.part`;
      await fs.copyFile(source, temp, constants.COPYFILE_EXCL);
      const inspection = await validateVideoFile(temp, item);
      if (inspection) item.hasAudio = inspection.hasAudio;
      controller.signal.throwIfAborted();
      item.received = (await fs.stat(temp)).size;
      item.filePath = await publishFile(temp, desired); temp = null;
      item.name = path.basename(item.filePath); item.size = item.received; item.status = 'complete';
      this.remember(item);
      return item;
    } catch (error) {
      item.status = controller.signal.aborted ? 'cancelled' : 'failed'; item.error = controller.signal.aborted ? '' : error.message;
      throw error;
    } finally {
      if (temp) await fs.unlink(temp).catch(() => {});
      this.active.delete(id); this.notify(); this.pump();
    }
  }
}

module.exports = { DownloadQueue, publishFile, writeResponse };
