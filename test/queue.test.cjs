const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { DownloadQueue, publishFile } = require('../src/downloads.cjs');
const mp4 = require('node:fs').readFileSync(path.join(__dirname, 'fixtures', 'clip.mp4'));

async function until(predicate) {
  for (let i = 0; i < 300; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('Timed out');
}
async function setup(t, fetcher, type = 'both') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mediacatch-test-'));
  const queue = new DownloadQueue({ fetcher, settings: { type, minImageKB: 0, downloadDir: root } });
  t.after(async () => { await queue.shutdown(); await fs.rm(root, { recursive: true, force: true }); });
  return { queue, root };
}
test('selection + dedup + complete bytes + same-name file preservation', async t => {
  let calls = 0;
  const { queue, root } = await setup(t, async url => {
    calls++; return { response: new Response(url.endsWith('.png') ? Buffer.from('complete-media-bytes') : mp4, { headers: { 'content-type': url.endsWith('.png') ? 'image/png' : 'video/mp4' } }), finalURL: url };
  }, 'image');
  const image = queue.discover({ url: 'https://site/a.png' });
  const video = queue.discover({ url: 'https://site/a.mp4' });
  queue.discover({ url: 'https://site/a.png#same' });
  queue.setEnabled(true);
  await until(() => image.status === 'complete');
  assert.equal(video.status, 'detected'); assert.equal(calls, 1);
  assert.equal((await fs.readFile(image.filePath)).toString(), 'complete-media-bytes');
  const temp = path.join(root, 'next.part'); await fs.writeFile(temp, 'second');
  const published = await publishFile(temp, image.filePath);
  assert.notEqual(published, image.filePath);
  assert.equal((await fs.readFile(image.filePath)).toString(), 'complete-media-bytes');
  queue.updateSettings({ ...queue.settings, type: 'video' });
  await until(() => video.status === 'complete'); assert.equal(calls, 2);
});
test('HTTP failures and partial video never leave successful files or partials', async t => {
  const { queue, root } = await setup(t, async url => ({ response: url.endsWith('bad.mp4') ? new Response('bad', { status: 403 }) : new Response('partial', { status: 206, headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 20-26/100' } }) }));
  queue.setEnabled(true);
  const one = queue.discover({ url: 'https://site/bad.mp4' });
  const two = queue.discover({ url: 'https://site/partial.mp4' });
  await until(() => one.status === 'failed' && two.status === 'failed');
  assert.deepEqual(await fs.readdir(root), []);
  assert.match(one.error, /403/); assert.match(two.error, /不完整/);
});
test('pause aborts active download, removes partial and resumes from beginning', async t => {
  let first = true;
  const { queue, root } = await setup(t, async (_url, { signal }) => {
    if (!first) return { response: new Response(mp4, { headers: { 'content-type': 'video/mp4' } }) };
    first = false;
    const stream = new ReadableStream({ start(controller) { controller.enqueue(Buffer.from('part')); signal.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true }); } });
    return { response: new Response(stream, { headers: { 'content-type': 'video/mp4' } }) };
  });
  queue.setEnabled(true);
  const item = queue.discover({ url: 'https://site/a.mp4' });
  await until(() => item.received > 0);
  queue.setEnabled(false);
  await until(() => item.status === 'paused' && queue.active.size === 0);
  const files = await fs.readdir(root, { recursive: true }); assert(!files.some(f => f.endsWith('.part')));
  queue.setEnabled(true);
  await until(() => item.status === 'complete');
  assert.deepEqual(await fs.readFile(item.filePath), mp4);
});
test('HLS preserves segment order and does not save master and child twice', async t => {
  const { queue } = await setup(t, async url => {
    let body = 'SEGMENT'; let type = 'video/mp2t';
    if (url.endsWith('master.m3u8')) { body = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\nchild.m3u8'; type = 'application/vnd.apple.mpegurl'; }
    if (url.endsWith('child.m3u8')) { body = '#EXTM3U\n#EXTINF:1,\na.ts\n#EXTINF:1,\nb.ts\n#EXT-X-ENDLIST'; type = 'application/vnd.apple.mpegurl'; }
    if (url.endsWith('a.ts')) body = 'FIRST'; if (url.endsWith('b.ts')) body = 'SECOND';
    return { response: new Response(body, { headers: { 'content-type': type } }), finalURL: url };
  });
  queue.setEnabled(true);
  const master = queue.discover({ url: 'https://site/master.m3u8' });
  const child = queue.discover({ url: 'https://site/child.m3u8' });
  await until(() => [master, child].some(i => i.status === 'complete') && [master, child].some(i => i.status === 'duplicate'));
  const result = [master, child].find(i => i.status === 'complete');
  assert.equal((await fs.readFile(result.filePath)).toString(), 'FIRSTSECOND');
});

test('cleared records stay cleared during page scans and manual download overrides image filter', async t => {
  const { queue } = await setup(t, async () => ({ response: new Response('tiny', { headers: { 'content-type': 'image/png' } }) }));
  queue.updateSettings({ ...queue.settings, minImageKB: 100 });
  const item = queue.discover({ url: 'https://site/tiny.png', size: 4 });
  queue.setEnabled(true);
  assert.equal(item.status, 'detected');
  queue.retry(item.id);
  await until(() => item.status === 'complete');
  await until(() => queue.active.size === 0);
  queue.clear();
  queue.discover({ url: 'https://site/tiny.png' });
  assert.equal(queue.items.size, 0);
});

test('immediate pause and resume does not strand the interrupted task', async t => {
  let attempts = 0;
  const { queue } = await setup(t, async (_url, { signal }) => {
    attempts++;
    const body = attempts > 1 ? mp4 : new ReadableStream({ start(controller) {
      controller.enqueue(Buffer.from('start'));
      signal.addEventListener('abort', () => controller.error(new Error('cancelled')), { once: true });
    } });
    return { response: new Response(body, { headers: { 'content-type': 'video/mp4' } }) };
  });
  queue.setEnabled(true);
  const item = queue.discover({ url: 'https://site/race.mp4' });
  await until(() => item.received > 0);
  queue.setEnabled(false); queue.setEnabled(true);
  await until(() => item.status === 'complete');
  assert.equal(attempts, 2);
  assert.deepEqual(await fs.readFile(item.filePath), mp4);
});

test('DOM scans cannot overwrite captured network headers, including no-referrer', async t => {
  const { queue } = await setup(t, async () => { throw new Error('should not download'); });
  const url = 'https://cdn.example/video.mp4';
  const item = queue.discover({ url, headers: { referer: 'https://page.example/', authorization: 'Bearer test' } });
  queue.discover({ url, source: 'dom', headers: { referer: 'https://page.example/watch?private=1' } });
  assert.deepEqual(item.headers, { referer: 'https://page.example/', authorization: 'Bearer test' });
  queue.discover({ url, headers: { accept: '*/*' } });
  queue.discover({ url, source: 'dom', headers: { referer: 'https://page.example/watch?private=1' } });
  assert.deepEqual(item.headers, { accept: '*/*' });
  const other = queue.discover({ url: 'https://cdn.example/photo.png', source: 'dom', headers: { referer: 'https://page.example/watch' } });
  queue.discover({ url: other.url, headers: {} });
  assert.deepEqual(other.headers, {});
});

test('page refresh resets discovered resources and dismissals while preserving independent history', async t => {
  const { queue } = await setup(t, async () => ({ response: new Response(mp4, { headers: { 'content-type': 'video/mp4' } }) }));
  const generation = queue.beginPage();
  const video = queue.discover({ url: 'https://site/a.mp4', pageURL: 'https://site/page-a', generation });
  queue.retry(video.id); await until(() => video.status === 'complete' && queue.active.size === 0);
  queue.discover({ url: 'https://site/unused.png', generation });
  queue.clear();
  assert.equal(queue.snapshot().length, 0); assert.equal(queue.historySnapshot().length, 1);
  assert.equal(queue.discover({ url: video.url, generation }), undefined);
  const current = queue.beginPage();
  assert.equal(queue.discover({ url: 'https://site/late.png', generation }), undefined, 'old responses cannot repopulate a refreshed page');
  assert.equal(queue.discover({ url: video.url, generation: current }).status, 'complete');
  assert.deepEqual(queue.snapshot().map(i => i.id), [video.id]);
  queue.beginPage();
  assert.equal(queue.snapshot().length, 0);
  assert.equal(queue.resource(`history:${video.id}`).filePath, video.filePath);
  assert.equal(queue.historySnapshot()[0].host, 'site');
  assert.deepEqual(await fs.readFile(video.filePath), mp4);
  const restarted = new DownloadQueue({ fetcher: queue.fetcher, settings: queue.settings, history: [...queue.history.values()] });
  assert.equal(restarted.snapshot().length, 0); assert.equal(restarted.historySnapshot().length, 1);
  assert.equal(restarted.resource(`history:${video.id}`).type, 'video');
  await restarted.shutdown();
});

test('downloads started on the previous page continue in history without leaking into new page resources', async t => {
  let finish;
  const { queue } = await setup(t, async () => ({ response: new Response(new ReadableStream({ start(controller) {
    controller.enqueue(mp4.subarray(0, 28)); finish = () => { controller.enqueue(mp4.subarray(28)); controller.close(); };
  } }), { headers: { 'content-type': 'video/mp4' } }) }));
  queue.beginPage();
  const item = queue.discover({ url: 'https://site/a.mp4' }); queue.retry(item.id);
  await until(() => item.received > 0);
  queue.beginPage();
  const other = queue.discover({ url: 'https://other/new.png' });
  assert.deepEqual(queue.snapshot().map(i => i.id), [other.id]);
  assert.equal(queue.historySnapshot()[0].status, 'downloading');
  finish(); await until(() => item.status === 'complete' && queue.active.size === 0);
  assert.deepEqual(queue.snapshot().map(i => i.id), [other.id]);
  assert.equal(queue.historySnapshot()[0].status, 'complete');
});

test('highest HLS rendition is selected before automatic downloads, even when children arrive first', async t => {
  const requested = [];
  const { queue } = await setup(t, async url => {
    requested.push(url);
    let body = 'BEST';
    if (url.endsWith('master.m3u8')) {
      await new Promise(resolve => setTimeout(resolve, 450));
      body = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=900,RESOLUTION=640x360\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=200,RESOLUTION=1920x1080\nhigh.m3u8';
    } else if (url.endsWith('.m3u8')) body = `#EXTM3U\n#EXTINF:1,\n${url.endsWith('low.m3u8') ? 'low' : 'high'}.ts\n#EXT-X-ENDLIST`;
    return { response: new Response(body), finalURL: url };
  });
  queue.setEnabled(true);
  const low = queue.discover({ url: 'https://site/low.m3u8' });
  const high = queue.discover({ url: 'https://site/high.m3u8' });
  const master = queue.discover({ url: 'https://site/master.m3u8' });
  await until(() => master.status === 'complete');
  assert.deepEqual(queue.snapshot().map(i => i.id), [master.id]);
  assert.equal(low.status, 'duplicate'); assert.equal(high.status, 'duplicate');
  assert(!requested.includes('https://site/low.ts'));
  assert.equal(requested.filter(url => url === 'https://site/high.ts').length, 1);
  assert.equal(queue.historySnapshot().length, 1);
  assert.equal(queue.historySnapshot()[0].quality.height, 1080);
  assert(!JSON.stringify(queue.snapshot()).includes('variants'), 'signed variant URLs stay in the main process');
});

test('X video-only renditions without an audio manifest fail clearly instead of saving a silent result', async t => {
  const { queue, root } = await setup(t, async url => ({ response: new Response(url.endsWith('.m3u8') ? '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2,\npart.m4s\n#EXT-X-ENDLIST' : url.endsWith('init.mp4') ? mp4.subarray(0, 28) : mp4.subarray(28)), finalURL: url }));
  const base = 'https://video.twimg.com/amplify_video/123/pl/avc1/';
  queue.setEnabled(true);
  const low = queue.discover({ url: base + '1280x720/low.m3u8' });
  const high = queue.discover({ url: base + '1920x1080/high.m3u8' });
  await until(() => high.status === 'failed' && queue.active.size === 0);
  assert.deepEqual(queue.snapshot().map(i => i.id), [high.id]);
  assert.equal(low.status, 'duplicate');
  assert.match(high.error, /音轨/);
  assert.equal(queue.history.size, 0);
  assert(!(await fs.readdir(root, { recursive: true })).some(f => /\.(mp4|part)$/.test(f)));
});

test('refresh ignores delayed quality inspections and cancels their network reads', async t => {
  let release;
  const { queue } = await setup(t, async (_url, { signal }) => ({ response: new Response(new ReadableStream({ start(controller) {
    release = () => { if (!signal.aborted) { controller.enqueue(Buffer.from('#EXTM3U\n#EXTINF:1,\na.ts\n#EXT-X-ENDLIST')); controller.close(); } };
    signal.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true });
  } })) }));
  queue.discover({ url: 'https://site/old.m3u8' });
  await until(() => release);
  queue.beginPage(); release();
  await until(() => queue.probes.size === 0);
  assert.equal(queue.snapshot().length, 0);
  assert.equal(queue.hlsMetadata.size, 0);
  assert.equal(queue.historySnapshot().length, 0);
});

test('master selection falls back when highest playlist is unavailable, and reports actual saved quality', async t => {
  const { queue } = await setup(t, async url => {
    if (url.endsWith('high.m3u8')) return { response: new Response('gone', { status: 404 }) };
    const body = url.endsWith('master.m3u8') ? '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=200,RESOLUTION=1920x1080\nhigh.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=100,RESOLUTION=1280x720\nlow.m3u8' : url.endsWith('low.m3u8') ? '#EXTM3U\n#EXTINF:1,\npart.ts\n#EXT-X-ENDLIST' : 'LOW';
    return { response: new Response(body), finalURL: url };
  });
  const item = queue.discover({ url: 'https://site/master.m3u8' });
  queue.retry(item.id);
  await until(() => item.status === 'complete');
  assert.equal(item.quality.height, 720);
  assert.match(item.qualityNote, /自动选择可用版本/);
  assert.equal(queue.historySnapshot()[0].quality.height, 720);
  const restarted = new DownloadQueue({ fetcher: queue.fetcher, settings: queue.settings, history: [...queue.history.values()] });
  assert.equal(restarted.historySnapshot()[0].quality.height, 720);
  await restarted.shutdown();
});
