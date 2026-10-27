const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { remoteURL, mediaKind, safeName, outputRelative, replayHeaders, requestHeadersForURL, parseHls, urlKey } = require('../src/media.cjs');

test('only HTTP(S) media; signed query parameters remain part of identity', () => {
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'https://user:pass@host/x']) assert.equal(remoteURL(url), null);
  assert.equal(remoteURL('https://example.com/p.png?a=1#x'), 'https://example.com/p.png?a=1');
  assert.notEqual(urlKey('https://example.com/a?t=1'), urlKey('https://example.com/a?t=2'));
});
test('media detection rejects login HTML and standalone stream fragments', () => {
  assert.equal(mediaKind('https://site/a.mp4', 'text/html'), null);
  assert.equal(mediaKind('https://site/chunk-0001.mp4', 'video/mp4'), null);
  assert.equal(mediaKind('https://site/a.ts', 'video/mp2t'), null);
  assert.equal(mediaKind('https://site/a.m4s', 'application/octet-stream'), null);
  assert.equal(mediaKind('https://site/image?id=1', 'image/avif').type, 'image');
  assert.equal(mediaKind('https://site/play', 'application/vnd.apple.mpegurl').mode, 'hls');
  assert.equal(mediaKind('https://site/a.mpd').mode, 'dash');
  for (const resource of ['vid/avc1/0/0/1280x720/random.mp4', 'aud/mp4a/0/0/128000/random.mp4', 'pl/mp4a/128000/random.m3u8']) {
    assert.equal(mediaKind(`https://video.twimg.com/amplify_video/123/${resource}`, resource.endsWith('m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4'), null);
  }
  assert.equal(mediaKind('https://video.twimg.com/amplify_video/123/pl/avc1/1280x720/movie.m3u8').mode, 'hls');
});
test('output paths remain inside the destination and work with Windows names', () => {
  for (const value of ['../../CON', 'NUL.jpg', 'CON', 'LPT1.txt', '..', 'hi:\\there/']) {
    const name = safeName(value);
    assert(!/[<>:"/\\|?*]/.test(name));
    assert(!/^(CON|NUL|LPT1)(\.|$)/i.test(name));
  }
  const item = { url: 'https://example.com/%2e%2e%2f%2e%2e%2fCON.exe?token=x', pageURL: 'https://page.com', id: 'a'.repeat(64), type: 'image', ext: 'png' };
  const relative = outputRelative(item);
  assert(!relative.split(path.sep).includes('..'));
  assert(relative.endsWith('.png'));
  assert(!relative.includes('token'));
});
test('replaying headers does not copy Range, cookies or arbitrary headers', () => {
  assert.deepEqual(replayHeaders({ Range: 'bytes=1-2', Cookie: 'secret=x', Referer: 'https://site/', Authorization: 'Bearer x', 'X-Custom': 'secret' }), { referer: 'https://site/', authorization: 'Bearer x' });
});
test('referrer replay respects same-origin, cross-origin and HTTPS downgrade policy', () => {
  const headers = { Referer: 'https://page.example/watch?token=private#fragment' };
  assert.equal(requestHeadersForURL(headers, 'https://page.example/video.mp4').referer, 'https://page.example/watch?token=private');
  assert.equal(requestHeadersForURL(headers, 'https://cdn.example/video.mp4').referer, 'https://page.example/');
  assert.equal(requestHeadersForURL(headers, 'http://cdn.example/video.mp4').referer, undefined);
  assert.equal(requestHeadersForURL({ referer: 'file:///private/location' }, 'https://cdn.example/video.mp4').referer, undefined);
  assert.equal(requestHeadersForURL({}, 'https://cdn.example/video.mp4').referer, undefined);
  const redirected = requestHeadersForURL(requestHeadersForURL(headers, 'https://cdn.example/v'), 'https://page.example/returned');
  assert.equal(redirected.referer, 'https://page.example/', 'redirects do not restore previously stripped paths');
});
test('HLS resolves relative URLs, selects highest supported rendition and supports fMP4 init', () => {
  const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\na.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=200\nb.m3u8';
  assert.equal(parseHls(master, 'https://site/path/master.m3u8').variant, 'https://site/path/b.m3u8');
  const plan = parseHls('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1,\nx.m4s\n#EXT-X-ENDLIST', 'https://site/a.m3u8');
  assert.equal(plan.ext, 'mp4'); assert.deepEqual(plan.segments, ['https://site/init.mp4', 'https://site/x.m4s']);
});
test('HLS failures are explicit instead of producing a silent/incomplete video', () => {
  const invalid = [
    '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXTINF:1,\na.ts\n#EXT-X-ENDLIST',
    '#EXTM3U\n#EXTINF:1,\na.ts',
    '#EXTM3U\n#EXT-X-BYTERANGE:10@0\na.ts\n#EXT-X-ENDLIST',
    '#EXTM3U\n#EXT-X-DISCONTINUITY\na.ts\n#EXT-X-ENDLIST',
  ];
  for (const text of invalid) assert.throws(() => parseHls(text, 'https://site/index.m3u8'));
});

test('automatic HLS quality prefers resolution, then bitrate, includes separate audio and excludes audio-only variants', () => {
  const master = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",URI="audio.m3u8"\n' +
    '#EXT-X-STREAM-INF:BANDWIDTH=9000000,RESOLUTION=1280x720\n720.m3u8\n' +
    '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1920x1080\n1080-low.m3u8\n' +
    '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080\n1080-best.m3u8\n' +
    '#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=3840x2160,AUDIO="audio"\n4k-separated.m3u8\n' +
    '#EXT-X-STREAM-INF:BANDWIDTH=99999999,CODECS="mp4a.40.2"\naudio.m3u8';
  const plan = parseHls(master, 'https://site/master.m3u8');
  assert.equal(plan.variant, 'https://site/4k-separated.m3u8');
  assert.equal(plan.variants.find(v => v.url === plan.variant).audioURL, 'https://site/audio.m3u8');
  assert.deepEqual(plan.quality, { width: 3840, height: 2160, bandwidth: 8000000 });
  assert.equal(plan.variants.length, 5);
});
