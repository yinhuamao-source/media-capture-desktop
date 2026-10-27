const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { DownloadQueue } = require('../src/downloads.cjs');
const { PreviewManager } = require('../src/preview.cjs');
const { inspectMp4 } = require('../src/video-validation.cjs');
const { ffmpegPath } = require('../src/mux.cjs');
const { parseHls } = require('../src/media.cjs');
const video = require('node:fs').readFileSync(path.join(__dirname, 'fixtures/clip.mp4'));
const audio = require('node:fs').readFileSync(path.join(__dirname, 'fixtures/tone.m4a'));
const base = 'https://video.twimg.com/amplify_video/123/pl/';
const master = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Other",URI="other-audio.m3u8"\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Default",DEFAULT=YES,URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=160x90,AUDIO="a"\navc1/160x90/low.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=100000,RESOLUTION=320x180,AUDIO="a"\navc1/320x180/high.m3u8';
async function until(predicate) { for (let i = 0; i < 500; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('Timed out'); }
async function setup(t, audioFailure = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mediacatch-audio-'));
  const requests = [];
  const fetcher = async url => {
    requests.push(url);
    let body;
    if (url.endsWith('master.m3u8')) body = master;
    else if (url.endsWith('audio.m3u8')) body = '#EXTM3U\n#EXTINF:2,\ntone.m4a\n#EXT-X-ENDLIST';
    else if (url.endsWith('.m3u8')) body = '#EXTM3U\n#EXTINF:2,\nmovie.mp4\n#EXT-X-ENDLIST';
    else if (url.endsWith('tone.m4a')) {
      if (audioFailure) return { response: new Response('audio expired', { status: 403 }) };
      body = audio;
    } else body = video;
    return { response: new Response(body), finalURL: url };
  };
  const queue = new DownloadQueue({ fetcher, settings: { type: 'video', minImageKB: 0, downloadDir: path.join(root, 'saved') } });
  t.after(async () => { await queue.shutdown(); await fs.rm(root, { recursive: true, force: true }); });
  return { queue, root, requests, fetcher };
}
function assertSound(file) {
  const pcm = execFileSync(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-i', file, '-map', '0:a:0', '-t', '0.25', '-f', 'f32le', '-acodec', 'pcm_f32le', '-']);
  let energy = 0;
  for (let i = 0; i + 4 <= pcm.length; i += 4) energy += pcm.readFloatLE(i) ** 2;
  assert(pcm.length > 1000 && Math.sqrt(energy / (pcm.length / 4)) > 0.01, 'decoded audio contains a real audible tone');
}
test('HLS highest-quality video and default separate audio become one playable MP4 with audible samples', async t => {
  const { queue, requests } = await setup(t);
  const plan = parseHls(master, base + 'master.m3u8');
  assert.equal(plan.variants.find(v => v.url === plan.variant).audioURL, base + 'audio.m3u8');
  queue.setEnabled(true);
  queue.discover({ url: base + 'avc1/160x90/low.m3u8' });
  const item = queue.discover({ url: base + 'master.m3u8' });
  queue.discover({ url: base + 'avc1/320x180/high.m3u8' });
  await until(() => ['complete', 'failed'].includes(item.status) && !queue.active.size);
  assert.equal(item.status, 'complete', item.error);
  assert.equal(item.ext, 'mp4'); assert.equal(item.hasAudio, true);
  assert.equal(item.quality.height, 180);
  assert.equal(queue.snapshot().length, 1);
  assert(!requests.some(url => url.includes('160x90/movie.mp4')));
  assert(!requests.some(url => url.endsWith('other-audio.m3u8')));
  const inspected = await inspectMp4(item.filePath); assert(inspected.hasVideo && inspected.hasAudio);
  assertSound(item.filePath);
  assert.equal(queue.historySnapshot()[0].hasAudio, true);
});
test('missing audio fails the download and removes video/audio/mux temporary files', async t => {
  const { queue, root } = await setup(t, true);
  queue.setEnabled(true);
  const item = queue.discover({ url: base + 'master.m3u8' });
  await until(() => item.status === 'failed' && !queue.active.size);
  assert.equal(queue.history.size, 0);
  assert.match(item.error, /403/);
  assert(!(await fs.readdir(root, { recursive: true })).some(f => /\.(part|mp4|m4a)$/.test(f)));
});
test('unsaved preview merges audio and saving preserves the exact preview bytes and selected quality', async t => {
  const { queue, root, fetcher } = await setup(t);
  const previews = new PreviewManager({ fetcher, root: path.join(root, 'previews') });
  t.after(() => previews.close());
  const item = queue.discover({ url: base + 'master.m3u8' });
  await until(() => item.status === 'detected');
  const result = await previews.prepare(item);
  assert.equal(result.hasAudio, true); assert.equal(result.ext, 'mp4');
  assertSound(previews.current.filePath);
  const before = await fs.readFile(previews.current.filePath);
  await previews.save(item.id, queue);
  assert.deepEqual(await fs.readFile(item.filePath), before);
  assert.equal(queue.historySnapshot()[0].quality.height, 180);
  await previews.close();
});
