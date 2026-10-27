const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const { Readable } = require('node:stream');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DownloadQueue } = require('./downloads.cjs');
const { validateVideoFile } = require('./video-validation.cjs');

const mimeTypes = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', ogv: 'video/ogg', ts: 'video/mp2t', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp' };

class PreviewManager {
  constructor({ fetcher, root, progress = () => {} }) { this.fetcher = fetcher; this.root = root; this.progress = progress; this.current = null; }
  async dispose(entry) {
    if (!entry) return;
    entry.closed = true;
    if (entry.worker) await entry.worker.shutdown();
    await entry.saving?.catch(() => {});
    if (entry.directory) await fs.rm(entry.directory, { recursive: true, force: true }).catch(() => {});
  }
  async close() { const old = this.current; this.current = null; await this.dispose(old); }
  async prepare(item) {
    const old = this.current;
    const entry = { token: randomUUID(), id: item.id, closed: false, ready: false };
    this.current = entry;
    await this.dispose(old);
    try {
      if (entry.closed) throw new Error('预览已关闭');
      let ready = item;
      if (item.status !== 'complete') {
        entry.directory = path.join(this.root, entry.token);
        entry.worker = new DownloadQueue({ fetcher: this.fetcher, settings: { type: 'both', minImageKB: 0, downloadDir: entry.directory } });
        ready = entry.worker.discover({ ...item, kind: { type: item.type, mode: item.mode, ext: item.ext } });
        if (!ready || ready.status === 'unsupported') throw new Error(item.error || '暂不支持预览此格式');
        await new Promise((resolve, reject) => {
          const update = () => {
            if (this.current === entry && !entry.closed) this.progress({ id: item.id, received: ready.received, size: ready.size, segmentsDone: ready.segmentsDone, segmentCount: ready.segmentCount });
            if (ready.status === 'complete') { entry.worker.off('change', update); resolve(); }
            else if (entry.closed || ['failed', 'unsupported', 'fragment', 'cancelled', 'paused'].includes(ready.status)) {
              entry.worker.off('change', update);
              const error = new Error(ready.error || '预览已取消');
              if (ready.status === 'fragment') error.code = 'MEDIA_FRAGMENT';
              reject(error);
            }
          };
          entry.worker.on('change', update);
          entry.worker.retry(ready.id);
          update();
        });
      }
      if (entry.closed || this.current !== entry) throw new Error('预览已关闭');
      await fs.access(ready.filePath);
      const inspection = await validateVideoFile(ready.filePath, ready);
      if (entry.closed || this.current !== entry) throw new Error('预览已关闭');
      entry.filePath = ready.filePath; entry.ext = ready.ext; entry.quality = ready.quality;
      entry.mime = mimeTypes[ready.ext] || ready.mime?.split(';')[0] || 'application/octet-stream';
      entry.ready = true;
      return { id: item.id, url: `capture://app/preview/${entry.token}`, type: item.type, name: ready.name, saved: item.status === 'complete', ext: ready.ext, hasAudio: inspection?.hasAudio };
    } catch (error) {
      await this.dispose(entry);
      if (this.current === entry) this.current = null;
      throw error;
    }
  }
  async save(id, queue) {
    const entry = this.current;
    if (!entry?.ready || entry.closed || entry.id !== id) throw new Error('请先完成预览');
    entry.saving ||= queue.importPreview(id, entry.filePath, entry.ext, entry.quality).finally(() => { entry.saving = null; });
    return entry.saving;
  }
  async response(request) {
    const entry = this.current;
    const url = new URL(request.url);
    if (!entry?.ready || entry.closed || url.pathname !== `/preview/${entry.token}` || url.search || !['GET', 'HEAD'].includes(request.method)) return new Response('Not found', { status: 404 });
    if (request.initiatorOrigin && request.initiatorOrigin !== 'capture://app') return new Response('Forbidden', { status: 403 });
    try {
      const { size } = await fs.stat(entry.filePath);
      let start = 0, end = size - 1, status = 200;
      const range = request.headers.get('range');
      const headers = { 'content-type': entry.mime, 'accept-ranges': 'bytes', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; sandbox", 'x-content-type-options': 'nosniff' };
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
        start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
        end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
        status = 206; headers['content-range'] = `bytes ${start}-${end}/${size}`;
      }
      headers['content-length'] = String(end - start + 1);
      const body = request.method === 'HEAD' ? null : Readable.toWeb(createReadStream(entry.filePath, { start, end }));
      return new Response(body, { status, headers });
    } catch { return new Response('Preview unavailable', { status: 404 }); }
  }
}

module.exports = { PreviewManager };
