const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { PreviewManager } = require('../src/preview.cjs');
const { DownloadQueue } = require('../src/downloads.cjs');
const { validateVideoFile } = require('../src/video-validation.cjs');
const mp4 = require('node:fs').readFileSync(path.join(__dirname, 'fixtures', 'clip.mp4'));

async function setup(t, fetcher) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mediacatch-preview-test-'));
  const manager = new PreviewManager({ fetcher, root: path.join(root, 'preview') });
  const queue = new DownloadQueue({ fetcher, settings: { type: 'video', minImageKB: 0, downloadDir: path.join(root, 'saved') } });
  t.after(async () => { await manager.close(); await queue.shutdown(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, manager, queue };
}

test('preview uses temporary cache, serves ranges, saves identical bytes and revokes access on close', async t => {
  let requests = 0;
  const { manager, queue, root } = await setup(t, async url => { requests++; return { finalURL: url, response: new Response(mp4, { headers: { 'content-type': 'video/mp4' } }) }; });
  const item = queue.discover({ url: 'https://site/movie.mp4' });
  const preview = await manager.prepare(item);
  assert.equal(item.status, 'detected');
  await assert.rejects(fs.stat(path.join(root, 'saved')), { code: 'ENOENT' });
  const response = await manager.response(new Request(preview.url, { headers: { range: 'bytes=0-27' } }));
  assert.equal(response.status, 206); assert.deepEqual(Buffer.from(await response.arrayBuffer()), mp4.subarray(0, 28));
  assert.equal((await manager.response(new Request(preview.url, { headers: { range: 'bytes=999999999-' } }))).status, 416);
  assert.equal((await manager.response(new Request('capture://app/preview/not-a-token'))).status, 404);
  const denied = new Request(preview.url); denied.initiatorOrigin = 'https://evil.example';
  assert.equal((await manager.response(denied)).status, 403);
  await manager.save(item.id, queue);
  assert.equal(item.status, 'complete'); assert.equal(requests, 1, 'saving the preview does not fetch a different copy');
  assert.deepEqual(await fs.readFile(item.filePath), mp4);
  const directory = manager.current.directory;
  await manager.close();
  assert.equal((await manager.response(new Request(preview.url))).status, 404);
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(item.filePath), mp4, 'closing never removes the saved file');
});

test('closing a loading preview aborts its stream and removes temporary files', async t => {
  let started;
  const startedPromise = new Promise(resolve => { started = resolve; });
  const { manager, queue, root } = await setup(t, async (_url, { signal }) => ({ response: new Response(new ReadableStream({ start(controller) {
    controller.enqueue(mp4.subarray(0, 28)); started();
    signal.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true });
  } }), { headers: { 'content-type': 'video/mp4' } }) }));
  const item = queue.discover({ url: 'https://site/slow.mp4' });
  const pending = assert.rejects(manager.prepare(item), /取消|关闭/);
  await startedPromise;
  await manager.close(); await pending;
  assert.equal(item.status, 'detected');
  const files = await fs.readdir(root, { recursive: true });
  assert(!files.some(f => f.endsWith('.part') || f.endsWith('.mp4')));
});

test('restarted HLS history previews the actual MP4 and retains saved filename and size', async t => {
  const { manager, queue, root } = await setup(t, async () => { throw new Error('Saved preview must not fetch'); });
  const file = path.join(root, 'previous.mp4'); await fs.writeFile(file, mp4);
  const url = 'https://site/playlist.m3u8';
  const id = require('../src/media.cjs').urlKey(url);
  queue.history.set(id, { id, filePath: file, size: mp4.length });
  const item = queue.discover({ url, size: 700 });
  queue.discover({ url, size: 700 });
  assert.equal(item.ext, 'mp4'); assert.equal(item.name, 'previous.mp4'); assert.equal(item.size, mp4.length);
  const preview = await manager.prepare(item);
  assert.equal(preview.saved, true); assert.equal(preview.ext, 'mp4'); assert.equal(preview.hasAudio, false);
  const response = await manager.response(new Request(preview.url));
  assert.equal(response.headers.get('content-type'), 'video/mp4');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), mp4);
  queue.beginPage();
  assert.equal(queue.snapshot().length, 0);
  const fromHistory = await manager.prepare(queue.resource(`history:${id}`));
  assert.equal(fromHistory.saved, true);
  assert.deepEqual(Buffer.from(await (await manager.response(new Request(fromHistory.url))).arrayBuffer()), mp4);
});

test('MP4 inspection accepts complete movie and rejects initialization-only, media-only, audio-only and truncated files', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mediacatch-mp4-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const boxes = [];
  for (let p = 0; p < mp4.length;) {
    let size = mp4.readUInt32BE(p);
    if (size === 1) size = Number(mp4.readBigUInt64BE(p + 8));
    if (!size) size = mp4.length - p;
    boxes.push({ type: mp4.toString('ascii', p + 4, p + 8), data: mp4.subarray(p, p + size) }); p += size;
  }
  const cases = [
    ['complete', mp4, null],
    ['init', Buffer.concat(boxes.filter(b => b.type !== 'mdat').map(b => b.data)), /初始化片段/],
    ['media', Buffer.concat(boxes.filter(b => b.type === 'mdat').map(b => b.data)), /独立媒体片段/],
    ['audio', Buffer.from(mp4), /单独的音轨/],
    ['truncated', mp4.subarray(0, mp4.length - 7), /不完整/],
  ];
  cases[3][1].write('soun', cases[3][1].lastIndexOf(Buffer.from('vide')), 'ascii');
  for (const [name, bytes, error] of cases) {
    const file = path.join(root, `${name}.mp4`); await fs.writeFile(file, bytes);
    if (error) await assert.rejects(validateVideoFile(file, { type: 'video', ext: 'mp4' }), error, name);
    else assert.equal((await validateVideoFile(file, { type: 'video', ext: 'mp4' })).hasVideo, true);
  }
});

test('initialization segments with arbitrary names are never published as successful videos', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mediacatch-init-test-'));
  const init = Buffer.from('000000186674797069736f6d0000000069736f6d69736f32000000086d6f6f76', 'hex');
  const queue = new DownloadQueue({ fetcher: async () => ({ response: new Response(init, { headers: { 'content-type': 'video/mp4' } }) }), settings: { type: 'video', minImageKB: 0, downloadDir: root } });
  t.after(async () => { await queue.shutdown(); await fs.rm(root, { recursive: true, force: true }); });
  const item = queue.discover({ url: 'https://cdn.example/random-hash.mp4' });
  await queue.run(item, new AbortController());
  assert.equal(item.status, 'fragment'); assert.equal(queue.history.size, 0); assert.equal(queue.snapshot().length, 0);
  assert.equal(queue.discover({ url: item.url }), undefined);
  assert(!(await fs.readdir(root, { recursive: true })).some(f => f.endsWith('.mp4') || f.endsWith('.part')));
});
