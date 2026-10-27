const fs = require('node:fs/promises');

function fragment(message) { const error = new Error(message); error.code = 'MEDIA_FRAGMENT'; return error; }

function tracks(buffer, start = 0, end = buffer.length, depth = 0) {
  const result = new Set();
  if (depth > 6) throw new Error('MP4 轨道结构异常');
  for (let p = start; p < end;) {
    if (p + 8 > end) throw new Error('MP4 轨道信息不完整');
    let size = buffer.readUInt32BE(p), header = 8;
    const type = buffer.toString('ascii', p + 4, p + 8);
    if (size === 1) { if (p + 16 > end) throw new Error('MP4 轨道信息不完整'); size = Number(buffer.readBigUInt64BE(p + 8)); header = 16; }
    if (!size) size = end - p;
    if (!Number.isSafeInteger(size) || size < header || p + size > end) throw new Error('MP4 轨道信息不完整');
    if (type === 'hdlr' && size >= header + 12) result.add(buffer.toString('ascii', p + header + 8, p + header + 12));
    if (['moov', 'trak', 'mdia'].includes(type)) for (const track of tracks(buffer, p + header, p + size, depth + 1)) result.add(track);
    p += size;
  }
  return result;
}

async function inspectMp4(file) {
  const handle = await fs.open(file, 'r');
  try {
    const { size: length } = await handle.stat();
    let position = 0, count = 0, hasMovie = false, hasData = false;
    const handlers = new Set();
    while (position < length) {
      if (++count > 200000) throw new Error('MP4 结构过于复杂，暂不支持');
      const header = Buffer.alloc(16);
      const { bytesRead } = await handle.read(header, 0, 16, position);
      if (bytesRead < 8) throw new Error('MP4 文件不完整：数据块头被截断');
      let size = header.readUInt32BE(0), headerSize = 8;
      const type = header.toString('ascii', 4, 8);
      if (size === 1) { if (bytesRead < 16) throw new Error('MP4 文件不完整'); size = Number(header.readBigUInt64BE(8)); headerSize = 16; }
      if (!size) size = length - position;
      if (!Number.isSafeInteger(size) || size < headerSize || position + size > length) throw new Error('MP4 文件无效或不完整：数据块长度不匹配');
      if (type === 'mdat' && size > headerSize) hasData = true;
      if (type === 'moov') {
        hasMovie = true;
        if (size > 32 * 1024 * 1024) throw new Error('MP4 轨道信息过大，暂不支持检查');
        const movie = Buffer.alloc(size - headerSize);
        const read = await handle.read(movie, 0, movie.length, position + headerSize);
        if (read.bytesRead !== movie.length) throw new Error('MP4 轨道信息被截断');
        for (const handler of tracks(movie)) handlers.add(handler);
      }
      position += size;
    }
    return { hasMovie, hasData, hasVideo: handlers.has('vide'), hasAudio: handlers.has('soun'), size: length };
  } finally { await handle.close(); }
}

async function validateVideoFile(file, item) {
  if (item.type !== 'video' || !['mp4', 'm4v', 'mov'].includes(item.ext)) return;
  const result = await inspectMp4(file);
  if (!result.hasMovie) throw fragment('这是独立媒体片段，缺少初始化信息，已忽略；请使用完整视频或 HLS 合并结果');
  if (!result.hasData) throw fragment('这是播放器初始化片段，没有视频画面数据，已忽略');
  if (!result.hasVideo) throw fragment(result.hasAudio ? '这是单独的音轨，不能作为完整视频保存，已忽略' : '没有找到视频轨道，已忽略');
  return result;
}

module.exports = { inspectMp4, validateVideoFile };
