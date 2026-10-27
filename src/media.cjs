const path = require('node:path');
const { createHash } = require('node:crypto');

const imageExt = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'bmp', 'svg', 'ico', 'tif', 'tiff']);
const videoExt = new Set(['mp4', 'webm', 'mov', 'm4v', 'ogv', 'mkv']);
const mimeExt = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'image/avif': 'avif', 'image/bmp': 'bmp', 'image/svg+xml': 'svg', 'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico', 'image/tiff': 'tiff', 'video/mp4': 'mp4',
  'video/webm': 'webm', 'video/quicktime': 'mov', 'video/ogg': 'ogv', 'video/x-matroska': 'mkv',
};

function remoteURL(value) {
  try {
    const u = new URL(value);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) return null;
    u.hash = '';
    return u.href;
  } catch { return null; }
}

function mediaKind(url, contentType = '', resourceType = '') {
  if (!remoteURL(url)) return null;
  const parsed = new URL(url);
  const pathname = parsed.pathname;
  const ext = path.posix.extname(pathname).slice(1).toLowerCase();
  const mime = contentType.split(';')[0].trim().toLowerCase();
  // X's player gives initialization and audio-only resources opaque .mp4 names.
  // These observed paths are stream components, not standalone video downloads.
  if (parsed.hostname === 'video.twimg.com' && /^\/amplify_video\/\d+\/(?:aud\/|pl\/mp4a\/|vid\/[^/]+\/0\/0\/)/.test(pathname)) return null;
  if (mime === 'application/vnd.apple.mpegurl' || mime === 'application/x-mpegurl' || ext === 'm3u8') {
    return { type: 'video', mode: 'hls', ext: 'ts' };
  }
  if (mime === 'application/dash+xml' || ext === 'mpd') return { type: 'video', mode: 'dash', ext: 'mpd' };
  if (/\.(?:m4s|ts|aac|cmfv|cmfa)$/i.test(pathname) || mime === 'video/mp2t') return null;
  if (/(?:^|\/)(?:init|segment|chunk|fragment|frag)[-_\d.]/i.test(pathname) && !mime.startsWith('image/')) return null;
  if (mime.startsWith('image/')) return { type: 'image', mode: 'file', ext: mimeExt[mime] || (imageExt.has(ext) ? ext : 'img') };
  if (mime.startsWith('video/')) return { type: 'video', mode: 'file', ext: mimeExt[mime] || (videoExt.has(ext) ? ext : 'video') };
  // A URL suffix must never turn an HTML login/error page into a successful media download.
  if (mime && !['application/octet-stream', 'binary/octet-stream'].includes(mime)) return null;
  if (imageExt.has(ext) || resourceType === 'image') return { type: 'image', mode: 'file', ext: imageExt.has(ext) ? ext : 'img' };
  if (videoExt.has(ext)) return { type: 'video', mode: 'file', ext };
  return null;
}

function urlKey(url) { return createHash('sha256').update(remoteURL(url) || url).digest('hex'); }

function safeName(value, fallback = 'media') {
  const name = String(value).normalize('NFKC').replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '_')
    .replace(/^[. ]+|[. ]+$/g, '').slice(0, 72).replace(/[. ]+$/g, '') || fallback;
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ? `_${name}` : name;
}

function outputRelative(item, extension = item.ext, now = new Date()) {
  const url = new URL(item.url);
  let basename;
  try { basename = decodeURIComponent(path.posix.basename(url.pathname)); } catch { basename = 'media'; }
  basename = basename.replace(/\.[a-z0-9]{1,8}$/i, '');
  let site;
  try { site = new URL(item.pageURL).hostname; } catch { site = url.hostname; }
  const day = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
  return path.join(safeName(site), day, item.type === 'image' ? '图片' : '视频', `${safeName(basename)}-${item.id.slice(0, 12)}.${extension}`);
}

function headerValue(headers, key) {
  const entry = Object.entries(headers || {}).find(([k]) => k.toLowerCase() === key.toLowerCase());
  return entry ? (Array.isArray(entry[1]) ? entry[1].join(', ') : String(entry[1])) : '';
}

function replayHeaders(headers = {}) {
  const result = {};
  // Cookies come from Chromium's cookie jar. Range is deliberately omitted for complete files.
  for (const name of ['accept', 'accept-language', 'user-agent', 'referer', 'origin', 'authorization']) {
    const value = headerValue(headers, name);
    if (value && !/[\r\n]/.test(value)) result[name] = value;
  }
  return result;
}

function requestHeadersForURL(headers, targetURL) {
  const result = replayHeaders(headers);
  const referrer = remoteURL(result.referer);
  const target = remoteURL(targetURL);
  if (!referrer || !target) { delete result.referer; return result; }
  const from = new URL(referrer), to = new URL(target);
  // Match Chromium's strict-origin-when-cross-origin policy BEFORE handing it a
  // Referer header. A cross-origin full path is rejected as ERR_BLOCKED_BY_CLIENT.
  if (from.protocol === 'https:' && to.protocol !== 'https:') delete result.referer;
  else result.referer = from.origin === to.origin ? from.href : `${from.origin}/`;
  return result;
}

function attributes(line) {
  const result = {};
  for (const m of line.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) result[m[1]] = m[2].replace(/^"|"$/g, '');
  return result;
}

function videoQuality(width, height, bandwidth = 0) {
  width = Number(width); height = Number(height);
  return { width: Number.isSafeInteger(width) && width > 0 && width <= 32768 ? width : 0,
    height: Number.isSafeInteger(height) && height > 0 && height <= 32768 ? height : 0,
    bandwidth: Number.isFinite(Number(bandwidth)) && Number(bandwidth) > 0 ? Number(bandwidth) : 0 };
}
function compareQuality(a = {}, b = {}) {
  return (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0) || (b.bandwidth || 0) - (a.bandwidth || 0);
}
function knownHlsRendition(value) {
  const url = new URL(value);
  // Only group the observed X video asset namespace, never similar filenames on arbitrary sites.
  const match = url.hostname === 'video.twimg.com' && /^\/(amplify_video|ext_tw_video)\/(\d+)\/pl\/(?:[^/]+\/(\d+)x(\d+)\/)?[^/]+\.m3u8$/.exec(url.pathname);
  return match ? { group: `${url.origin}/${match[1]}/${match[2]}`, quality: videoQuality(match[3], match[4]) } : null;
}

function parseHls(text, baseURL) {
  if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('服务器没有返回有效的 HLS 播放列表');
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const resolve = value => {
    const result = remoteURL(new URL(value, baseURL).href);
    if (!result) throw new Error('播放列表包含不支持的资源地址');
    return result;
  };
  if (lines.some(l => /^#EXT-X-(?:SESSION-)?KEY:/.test(l) && attributes(l).METHOD !== 'NONE')) throw new Error('暂不支持加密 HLS 视频');
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF:')) {
      const attr = attributes(lines[i]);
      const next = lines[i + 1];
      if (!next || next.startsWith('#')) throw new Error('HLS 清晰度地址缺失');
      const audioTracks = lines.filter(l => l.startsWith('#EXT-X-MEDIA:')).map(attributes).filter(a => a.TYPE === 'AUDIO' && a['GROUP-ID'] === attr.AUDIO);
      audioTracks.sort((a, b) => Number(b.DEFAULT === 'YES') - Number(a.DEFAULT === 'YES') || Number(b.AUTOSELECT === 'YES') - Number(a.AUTOSELECT === 'YES'));
      const audio = audioTracks[0];
      if (attr.AUDIO && !audio) throw new Error('HLS 音轨组缺失，无法保证下载包含声音');
      const audioURL = audio?.URI ? resolve(audio.URI) : undefined;
      const dimensions = /^(\d+)x(\d+)$/.exec(attr.RESOLUTION || '');
      const quality = videoQuality(dimensions?.[1], dimensions?.[2], attr['AVERAGE-BANDWIDTH'] || attr.BANDWIDTH);
      const audioOnly = Boolean(attr.CODECS) && !quality.width && attr.CODECS.split(',').every(codec => /^(mp4a|ac-3|ec-3|opus|flac)(\.|$)/i.test(codec.trim()));
      variants.push({ url: resolve(next), ...quality, separateAudio: Boolean(audioURL), audioURL, audioOnly, expectsAudio: Boolean(attr.AUDIO) || /(?:mp4a|ac-3|ec-3|opus)/i.test(attr.CODECS || '') });
    }
  }
  if (variants.length) {
    const supported = variants.filter(v => !v.audioOnly).sort(compareQuality);
    if (!supported.length) throw new Error('播放列表只包含音频，没有视频轨道');
    return { variant: supported[0].url, quality: videoQuality(supported[0].width, supported[0].height, supported[0].bandwidth), variants };
  }
  if (!lines.includes('#EXT-X-ENDLIST')) throw new Error('检测到直播或未结束的 HLS，当前版本只下载点播视频');
  if (lines.some(l => /^#EXT-X-(BYTERANGE|DISCONTINUITY)(:|$)/.test(l))) throw new Error('暂不支持含字节区间或不连续时间轴的 HLS');
  const maps = lines.filter(l => l.startsWith('#EXT-X-MAP:'));
  if (new Set(maps).size > 1 || maps.some(l => attributes(l).BYTERANGE)) throw new Error('暂不支持动态初始化片段或字节区间 HLS');
  const segments = lines.filter(l => !l.startsWith('#')).map(resolve);
  if (!segments.length) throw new Error('HLS 播放列表中没有视频片段');
  if (segments.length > 20000) throw new Error('视频超过 20,000 个分段，已停止下载');
  const init = maps[0] && attributes(maps[0]).URI;
  if (maps.length && !init) throw new Error('HLS 初始化片段地址缺失');
  const duration = lines.filter(l => l.startsWith('#EXTINF:')).reduce((sum, line) => sum + (Number(line.slice(8).split(',')[0]) || 0), 0);
  return { segments: init ? [resolve(init), ...segments] : segments, ext: init ? 'mp4' : 'ts', duration };
}

module.exports = { remoteURL, mediaKind, urlKey, safeName, outputRelative, headerValue, replayHeaders, requestHeadersForURL, parseHls, videoQuality, compareQuality, knownHlsRendition };
