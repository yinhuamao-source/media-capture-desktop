const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { createHash } = require('node:crypto');
const digest = data => createHash('sha256').update(data).digest('hex');
async function waitFor(predicate, label, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await predicate()) return; await new Promise(r => setTimeout(r, 75)); }
  throw new Error(`Timeout: ${label}`);
}

async function run({ win, browser, queue, settings, navigate, fetchMedia, previews }) {
  const output = path.join(__dirname, '..', 'test-output');
  await fs.mkdir(output, { recursive: true });
  await fs.rm(settings.downloadDir, { recursive: true, force: true });
  const png = await fs.readFile(path.join(__dirname, 'fixtures', 'image.png'));
  const mp4 = await fs.readFile(path.join(__dirname, 'fixtures', 'clip.mp4'));
  const tone = await fs.readFile(path.join(__dirname, 'fixtures', 'tone.m4a'));
  let seenDownloadCookie = false, seenDownloadReferer = false;
  let crossAuth, crossReferer, slowRequests = 0, slowClosed = false;
  let lateResponse, lowQualitySegments = 0;
  const cross = http.createServer((req, res) => {
    crossAuth = req.headers.authorization;
    crossReferer = req.headers.referer;
    res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(png);
  });
  await new Promise(resolve => cross.listen(0, '127.0.0.1', resolve));
  const crossURL = `http://127.0.0.1:${cross.address().port}/target.png`;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'test_login=valid; Path=/; HttpOnly; SameSite=Lax' });
      res.end(`<!doctype html><meta charset="utf-8"><title>MediaCatch 本地验证页</title><style>body{font:16px system-ui;background:#f3f7f4;color:#284537;padding:45px}h1{font-size:28px}section{display:flex;gap:24px;margin:35px 0}img,video{width:320px;border-radius:12px;box-shadow:0 4px 20px #0001}button{padding:12px;border-radius:8px;border:1px solid #ccdcd2;background:white}</style><h1>下载链路验证</h1><p>以下图片与视频是本地生成的测试媒体。</p><section><img src="/image.png"><video id="video" muted controls preload="auto" src="/clip.mp4"></video></section><img src="/image.png" style="width:40px"><button id="lazy" onclick="const i=new Image();i.src='/lazy.png';document.body.append(i)">加载新图片</button><button id="hls" onclick="fetch('/index.m3u8')">加载 HLS</button>`);
      return;
    }
    if (url.pathname === '/redirect.png') { res.writeHead(302, { Location: crossURL }); res.end(); return; }
    if (url.pathname === '/other') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>第二个页面</title><img src="/only-b.png">'); return; }
    if (url.pathname === '/late.png') { lateResponse = res; return; }
    if (url.pathname === '/index.m3u8') { res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }); res.end('#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\n/first.ts\n#EXTINF:1,\n/second.ts\n#EXT-X-ENDLIST'); return; }
    if (url.pathname === '/quality-master.m3u8') { res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }); res.end('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",DEFAULT=YES,NAME="Default",URI="/quality-audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=160x90,AUDIO="a"\n/quality-low.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=100000,RESOLUTION=320x180,AUDIO="a"\n/quality-high.m3u8'); return; }
    if (url.pathname === '/quality-audio.m3u8') { res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }); res.end('#EXTM3U\n#EXTINF:2,\n/tone.m4a\n#EXT-X-ENDLIST'); return; }
    if (url.pathname === '/tone.m4a') { res.writeHead(200, { 'Content-Type': 'audio/mp4' }); res.end(tone); return; }
    if (url.pathname === '/quality-low.m3u8' || url.pathname === '/quality-high.m3u8') { res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }); res.end('#EXTM3U\n#EXT-X-MAP:URI="/quality-init.mp4"\n#EXTINF:2,\n' + (url.pathname.includes('low') ? '/quality-low.m4s' : '/quality-high.m4s') + '\n#EXT-X-ENDLIST'); return; }
    if (['/quality-init.mp4', '/quality-high.m4s', '/quality-low.m4s'].includes(url.pathname)) { if (url.pathname.includes('low')) lowQualitySegments++; res.writeHead(200, { 'Content-Type': 'video/mp4' }); res.end(url.pathname.endsWith('init.mp4') ? mp4.subarray(0, 28) : mp4.subarray(28)); return; }
    if (url.pathname === '/mp4.m3u8') { res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }); res.end('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MAP:URI="/init.mp4"\n#EXTINF:2,\n/clip.m4s\n#EXT-X-ENDLIST'); return; }
    if (url.pathname === '/init.mp4' || url.pathname === '/clip.m4s') { res.writeHead(200, { 'Content-Type': 'video/mp4' }); res.end(url.pathname === '/init.mp4' ? mp4.subarray(0, 28) : mp4.subarray(28)); return; }
    if (url.pathname === '/first.ts' || url.pathname === '/second.ts') { res.writeHead(200, { 'Content-Type': 'video/mp2t' }); res.end(url.pathname === '/first.ts' ? 'FIRST-TEST-SEGMENT' : 'SECOND-TEST-SEGMENT'); return; }
    if (!req.headers.cookie?.includes('test_login=valid')) { res.writeHead(403); res.end('Login required'); return; }
    if (url.pathname === '/slow.mp4') {
      res.once('close', () => { slowClosed = true; });
      slowRequests++; res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': mp4.length });
      if (slowRequests === 1) { res.write(mp4.subarray(0, 30)); }
      else res.end(mp4);
      return;
    }
    if (['/image.png', '/lazy.png', '/preview-only.png', '/only-b.png', '/clip.mp4'].includes(url.pathname)) {
      const data = url.pathname.endsWith('.png') ? png : mp4;
      const type = url.pathname.endsWith('.png') ? 'image/png' : 'video/mp4';
      const range = req.headers.range && /bytes=(\d+)-(\d*)/.exec(req.headers.range);
      if (!range) {
        seenDownloadCookie = true;
        if (req.headers.referer === base + '/') seenDownloadReferer = true;
      }
      if (range) {
        const from = Number(range[1]), to = Math.min(data.length - 1, range[2] ? Number(range[2]) : data.length - 1);
        res.writeHead(206, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${from}-${to}/${data.length}`, 'Content-Length': to - from + 1 }); res.end(data.subarray(from, to + 1));
      } else { res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length, 'Accept-Ranges': 'bytes' }); res.end(data); }
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const ui = code => win.webContents.executeJavaScript(code);
  const remote = code => browser.webContents.executeJavaScript(code);
  const assertList = async (type, filter = 'all') => {
    const typed = queue.snapshot().filter(i => type === 'both' || i.type === type);
    const expected = typed.filter(i => filter === 'all' || filter === 'complete' && i.status === 'complete' || filter === 'pending' && ['detected', 'queued', 'paused', 'downloading'].includes(i.status));
    await waitFor(async () => {
      const visible = await ui(`({ ids: [...document.querySelectorAll('#resource-list .resource')].map(n => n.dataset.id).sort(), type: document.querySelector('[data-type][aria-pressed="true"]').dataset.type, filter: document.querySelector('[data-filter][aria-pressed="true"]').dataset.filter, total: Number(document.querySelector('#total-count').textContent), complete: Number(document.querySelector('#complete-count').textContent) })`);
      return visible.type === type && visible.filter === filter && visible.total === typed.length && visible.complete === typed.filter(i => i.status === 'complete').length && JSON.stringify(visible.ids) === JSON.stringify(expected.map(i => i.id).sort());
    }, `resource list and counts: ${type}/${filter}`);
  };
  try {
    await waitFor(() => ui('Boolean(document.querySelector("#toggle-capture"))'), 'UI loaded');
    await new Promise(r => setTimeout(r, 350));
    await fs.writeFile(path.join(output, 'welcome.png'), (await win.webContents.capturePage()).toPNG());
    assert.equal(await remote('typeof require'), 'undefined');
    assert.equal(await remote('typeof window.mediaCatch'), 'undefined');
    await ui(`document.querySelector('#address').value=${JSON.stringify(base)};document.querySelector('#address-form').requestSubmit()`);
    await waitFor(() => [...queue.items.values()].some(i => i.type === 'image') && [...queue.items.values()].some(i => i.type === 'video'), 'network media discovery');
    assert.equal(queue.enabled, false);
    assert([...queue.items.values()].every(i => i.status === 'detected'));
    const previewImage = [...queue.items.values()].find(i => i.url.endsWith('/image.png'));
    await ui('document.querySelector("[data-type=image]").click()');
    await assertList('image');
    await ui(`document.querySelector('[data-id="${previewImage.id}"] .resource-title').click()`);
    await waitFor(() => ui('Boolean(document.querySelector("#preview-media")?.naturalWidth)'), 'image preview loaded');
    assert.equal(previewImage.status, 'detected', 'preview does not save or change the download queue');
    assert.equal(await ui('document.querySelector("#save-preview").disabled'), false);
    assert.equal(browser.getVisible(), false, 'native webpage is hidden behind preview');
    await ui('document.querySelector("#close-preview").click()');
    await waitFor(() => !previews.current, 'preview closed');
    assert.equal(browser.getVisible(), true, 'webpage restored after closing preview');
    const previewVideo = [...queue.items.values()].find(i => i.url.endsWith('/clip.mp4'));
    await ui('document.querySelector("[data-type=video]").click()');
    await assertList('video');
    await ui(`document.querySelector('[data-id="${previewVideo.id}"] .resource-icon').click()`);
    await waitFor(() => ui('Boolean(document.querySelector("#preview-media")?.readyState >= 2)'), 'unsaved MP4 preview decodes');
    await ui('document.querySelector("#preview-media").muted=true; document.querySelector("#preview-media").play()');
    await waitFor(() => ui('document.querySelector("#preview-media").currentTime > 0.1'), 'preview video playback advances');
    await ui('document.querySelector("#preview-media").currentTime=1');
    await waitFor(() => ui('document.querySelector("#preview-media").currentTime >= 1'), 'preview seeking');
    await fs.writeFile(path.join(output, 'preview.png'), (await win.webContents.capturePage()).toPNG());
    await ui('document.querySelector("#close-preview").click()');
    await waitFor(() => !previews.current, 'video preview cache released');
    assert.equal(previewVideo.status, 'detected');
    await ui('document.querySelector("[data-type=both]").click()');
    await assertList('both');
    await ui('document.querySelector("[data-filter=pending]").click()');
    await ui('document.querySelector("[data-type=image]").click()');
    await assertList('image', 'pending');
    await ui('document.querySelector("[data-type=video]").click()');
    await assertList('video', 'pending');
    await ui('document.querySelector("[data-type=both]").click()');
    await assertList('both', 'pending');
    await ui('document.querySelector("[data-type=image]").click(); document.querySelector("[data-filter=all]").click()');
    await assertList('image');
    await ui('document.querySelector("#toggle-capture").click()');
    await waitFor(() => [...queue.items.values()].some(i => i.type === 'image' && i.status === 'complete'), 'image download');
    const image = [...queue.items.values()].find(i => i.url === `${base}/image.png`);
    assert.equal(digest(await fs.readFile(image.filePath)), digest(png));
    assert.equal([...queue.items.values()].filter(i => i.url.endsWith('/image.png')).length, 1);
    assert([...queue.items.values()].filter(i => i.type === 'video').every(i => i.status === 'detected'));
    await remote('document.querySelector("#lazy").click()');
    await waitFor(() => [...queue.items.values()].some(i => i.url.endsWith('/lazy.png') && i.status === 'complete'), 'dynamic image download');
    await ui('window.mediaCatch.command("type", "video")');
    await waitFor(() => [...queue.items.values()].some(i => i.url.endsWith('/clip.mp4') && i.status === 'complete'), 'complete video download');
    const video = [...queue.items.values()].find(i => i.url.endsWith('/clip.mp4'));
    assert.equal(digest(await fs.readFile(video.filePath)), digest(mp4));
    assert(await remote('document.querySelector("#video").readyState >= 1'), 'original MP4 metadata is playable');
    assert(seenDownloadCookie, 'session cookies retained'); assert(seenDownloadReferer, 'referer retained');
    await remote('document.querySelector("#hls").click()');
    await waitFor(() => [...queue.items.values()].some(i => i.mode === 'hls' && ['complete', 'failed'].includes(i.status)), 'HLS join');
    const hls = [...queue.items.values()].find(i => i.mode === 'hls');
    assert.equal(hls.status, 'complete', hls.error);
    assert.equal((await fs.readFile(hls.filePath)).toString(), 'FIRST-TEST-SEGMENTSECOND-TEST-SEGMENT');
    await remote('fetch("/mp4.m3u8")');
    await waitFor(() => [...queue.items.values()].some(i => i.url.endsWith('/mp4.m3u8') && ['complete', 'failed'].includes(i.status)), 'MP4 HLS init + media concatenation');
    const mp4Hls = [...queue.items.values()].find(i => i.url.endsWith('/mp4.m3u8'));
    assert.equal(mp4Hls.status, 'complete', mp4Hls.error);
    assert.equal(digest(await fs.readFile(mp4Hls.filePath)), digest(mp4));
    await ui('document.querySelector("[data-filter=all]").click()');
    await waitFor(() => ui(`Boolean(document.querySelector('[data-id="${mp4Hls.id}"] .resource-title'))`), 'HLS resource visible');
    await ui(`document.querySelector('[data-id="${mp4Hls.id}"] .resource-title').click()`);
    await waitFor(() => ui('Boolean(document.querySelector("#preview-media")?.readyState >= 2)'), 'saved HLS MP4 preview decodes');
    await ui('document.querySelector("#close-preview").click()');
    await waitFor(() => !previews.current, 'saved preview closed');
    await remote('void Promise.all([fetch("/quality-low.m3u8"), fetch("/quality-master.m3u8"), fetch("/quality-high.m3u8")])');
    await waitFor(() => [...queue.items.values()].some(i => i.url.endsWith('/quality-master.m3u8') && i.status === 'complete'), 'automatic highest resolution download');
    const qualityVideo = [...queue.items.values()].find(i => i.url.endsWith('/quality-master.m3u8'));
    assert.equal(qualityVideo.quality.height, 180);
    assert.equal(lowQualitySegments, 0, 'lower rendition media was never downloaded');
    assert.equal(queue.snapshot().filter(i => i.source.includes('/quality-')).length, 1, 'renditions collapse into a single resource');
    assert.equal(qualityVideo.hasAudio, true, 'merged MP4 contains the separate audio track');
    await waitFor(() => ui(`document.querySelector('[data-id="${qualityVideo.id}"] .quality-detail')?.textContent.includes('180p')`), 'selected quality shown in resource UI');
    assert.match(await ui('document.querySelector("#video-quality").textContent'), /最高可用/);
    await fs.writeFile(path.join(output, 'quality.png'), (await win.webContents.capturePage()).toPNG());
    await ui(`document.querySelector('[data-id="${qualityVideo.id}"] .resource-title').click()`);
    await waitFor(() => ui('Boolean(document.querySelector("#preview-media")?.readyState >= 2)'), 'merged audio/video preview loads');
    await ui('document.querySelector("#preview-media").muted=true; document.querySelector("#preview-media").play()');
    await waitFor(() => ui('document.querySelector("#preview-media").webkitAudioDecodedByteCount > 0 && document.querySelector("#preview-media").currentTime > 0.1'), 'Chromium decodes actual audio samples during preview playback');
    await ui('document.querySelector("#close-preview").click()');
    await waitFor(() => !previews.current, 'merged preview closes');
    const redirect = await fetchMedia(`${base}/redirect.png`, { headers: { authorization: 'Bearer test-only' }, credentialOrigin: base, signal: new AbortController().signal });
    assert.equal(digest(Buffer.from(await redirect.response.arrayBuffer())), digest(png));
    assert.equal(crossAuth, undefined, 'credentials stripped on cross-origin redirect');
    const crossMedia = await fetchMedia(crossURL, {
      headers: { referer: `${base}/watch?private_query=example` },
      credentialOrigin: base, signal: new AbortController().signal,
    });
    assert.equal(digest(Buffer.from(await crossMedia.response.arrayBuffer())), digest(png));
    assert.equal(crossReferer, `${base}/`, 'cross-origin referrer respects Chromium policy');
    const slow = queue.discover({ url: `${base}/slow.mp4`, pageURL: base, mime: 'video/mp4' });
    await waitFor(() => slow.received > 0, 'streaming download begun');
    await ui('document.querySelector("#toggle-capture").click()');
    await waitFor(() => !queue.enabled && queue.active.size === 0 && slow.status === 'paused', 'pause aborts Chromium stream', 5000).catch(error => {
      throw new Error(`${error.message}: ${JSON.stringify({ enabled: queue.enabled, active: queue.active.size, status: slow.status, received: slow.received, error: slow.error })}`);
    });
    await waitFor(() => slowClosed, 'paused HTTP stream socket closed', 5000);
    await ui(`window.mediaCatch.command('retry', ${JSON.stringify(slow.id)})`);
    await waitFor(() => slow.status === 'complete', 'manual restart after pause');
    assert.equal(digest(await fs.readFile(slow.filePath)), digest(mp4));
    await ui('document.querySelector("[data-filter=complete]").click()');
    await assertList('video', 'complete');
    await ui('document.querySelector("[data-type=image]").click()');
    await assertList('image', 'complete');
    await ui('document.querySelector("[data-type=both]").click()');
    await assertList('both', 'complete');
    await ui('document.querySelector("[data-filter=pending]").click()');
    await assertList('both', 'pending');
    await ui('document.querySelector("[data-type=video]").click()');
    await assertList('video', 'pending');
    await ui('document.querySelector("[data-filter=all]").click()');
    await assertList('video');
    const previewOnly = queue.discover({ url: `${base}/preview-only.png`, pageURL: base, headers: { referer: base + '/' } });
    await ui('document.querySelector("[data-type=image]").click()');
    await assertList('image');
    await ui(`document.querySelector('[data-id="${previewOnly.id}"] .resource-title').click()`);
    await waitFor(() => ui('Boolean(document.querySelector("#preview-media")?.naturalWidth)'), 'preview-only image loaded');
    assert.equal(previewOnly.status, 'detected');
    await ui('document.querySelector("#save-preview").click()');
    await waitFor(() => previewOnly.status === 'complete', 'save preview through UI');
    assert.equal(digest(await fs.readFile(previewOnly.filePath)), digest(png));
    await ui('document.querySelector("#close-preview").click()');
    await waitFor(() => !previews.current, 'saved preview cache cleanup');
    await ui('document.querySelector("[data-type=video]").click()');
    await assertList('video');
    await new Promise(r => setTimeout(r, 250));
    await fs.writeFile(path.join(output, 'downloads.png'), (await win.webContents.capturePage()).toPNG());
    const files = await fs.readdir(settings.downloadDir, { recursive: true });
    assert(!files.some(f => f.endsWith('.part')));
    const historyIds = queue.historySnapshot().filter(i => i.status === 'complete').map(i => i.id).sort();
    const generation = queue.generation;
    await ui('document.querySelector("#reload").click()');
    await waitFor(() => queue.generation > generation && queue.snapshot().length === 2 && !browser.webContents.isLoading(), 'refresh rebuilds only resources on the current page');
    assert(!queue.snapshot().some(i => i.id === previewOnly.id), 'previous discoveries disappear on refresh');
    assert.deepEqual(queue.historySnapshot().filter(i => i.status === 'complete').map(i => i.id).sort(), historyIds);
    await ui('document.querySelector("[data-type=both]").click()');
    await assertList('both');
    await ui('document.querySelector("#clear").click()');
    await waitFor(() => queue.snapshot().length === 0, 'clear current resources only');
    assert.deepEqual(queue.historySnapshot().filter(i => i.status === 'complete').map(i => i.id).sort(), historyIds);
    await ui('document.querySelector("#reload").click()');
    await waitFor(() => queue.snapshot().length === 2 && !browser.webContents.isLoading(), 'refresh recollects previously cleared resources');
    await remote('void fetch("/late.png").catch(() => {})');
    await waitFor(() => lateResponse, 'old page request started');
    await remote('history.pushState({}, "", "/other"); document.body.innerHTML = \'<img src="/only-b.png">\'');
    await waitFor(() => queue.snapshot().some(i => i.source.endsWith('/only-b.png')), 'SPA route resource collection');
    lateResponse.writeHead(200, { 'Content-Type': 'image/png' }); lateResponse.end(png);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.deepEqual(queue.snapshot().map(i => i.source), [base + '/only-b.png'], 'late old responses do not contaminate the new route');
    await assertList('both');
    await ui('document.querySelector("[data-collection=history]").click()');
    await waitFor(async () => JSON.stringify(await ui('[...document.querySelectorAll("#history-list .resource")].map(n => n.dataset.id).sort()')) === JSON.stringify(historyIds), 'separate history UI retains all downloads');
    assert.equal(await ui('document.querySelector("#resource-list").hidden'), true);
    await fs.writeFile(path.join(output, 'history.png'), (await win.webContents.capturePage()).toPNG());
    await ui(`document.querySelector('#history-list [data-id="${mp4Hls.id}"] .resource-title').click()`);
    await waitFor(() => ui('Boolean(document.querySelector("#preview-media")?.readyState >= 2)'), 'history preview without original page resources');
    await ui('document.querySelector("#close-preview").click()');
    await waitFor(() => !previews.current, 'history preview closed');
    await ui('document.querySelector("[data-collection=page]").click()');
    await assertList('both');
    await ui('document.querySelector("#reload").click()');
    await waitFor(() => !browser.webContents.isLoading() && queue.snapshot().length === 1 && queue.snapshot()[0].source.endsWith('/only-b.png'), 'full navigation and reload preserve page isolation');
    await assertList('both');
    const report = { passed: true, checks: ['separate audio automatically muxed + Chromium audio decode verified', 'highest resolution before bitrate + one resource per HLS video + visible quality', 'separate page resources and persistent download history', 'reload recollects cached resources and resets clear-list exclusions', 'SPA navigation + stale response isolation', 'history preview independently of current page', 'image + unsaved MP4 + saved HLS previews', 'preview playback and seek', 'preview save exact bytes + temporary cache cleanup', 'native webpage restored on close', 'real UI navigation and start/pause', 'network detection', 'image/video selection', 'resource list + counts follow type while preserving status filter', 'switching back restores collected records', 'dynamic images', 'URL deduplication', 'cookie + referer replay', 'PNG byte equality', 'playable H.264 MP4 byte equality', 'HLS segment ordering (synthetic transport fixture)', 'HLS init + MP4 bytes reconstruction', 'cross-origin auth stripping', 'cross-origin Referer policy (ERR_BLOCKED_BY_CLIENT regression)', 'pause aborts real Chromium stream + manual restart', 'remote page isolation'], items: queue.snapshot(), history: queue.historySnapshot() };
    await fs.writeFile(path.join(output, 'smoke-result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ passed: true, saved: report.history.filter(i => i.status === 'complete').length, checks: report.checks }));
  } finally { server.closeAllConnections(); cross.closeAllConnections(); server.close(); cross.close(); }
}
module.exports = { run };
