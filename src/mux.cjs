const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

function ffmpegPath() {
  const name = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const bundled = process.resourcesPath && path.join(process.resourcesPath, 'ffmpeg', name);
  if (bundled && fs.existsSync(bundled)) return bundled;
  const development = path.join(__dirname, '..', 'vendor', 'ffmpeg', `${process.platform}-${process.arch}`, name);
  if (fs.existsSync(development)) return development;
  throw new Error('缺少内置音视频合并组件，请重新安装客户端；开发环境请先运行 npm run prepare:media');
}

function execute(args, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '', timer;
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
    const abort = () => { child.kill('SIGTERM'); timer = setTimeout(() => child.kill('SIGKILL'), 2000); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    child.once('error', () => { cleanup(); reject(new Error('无法启动内置音视频合并组件')); });
    child.once('close', code => {
      cleanup();
      if (signal?.aborted) reject(new Error('音视频合并已取消'));
      else if (code !== 0) { const error = new Error('音视频合并失败，音轨可能损坏或编码不受支持'); error.diagnostic = stderr; reject(error); }
      else resolve();
    });
  });
}

async function muxTracks(video, audio, output, signal) {
  // Only local, already-downloaded media is passed to FFmpeg. Session credentials
  // and remote URLs never enter its arguments; network protocols are disabled.
  const input = file => ['-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,mp4,m4a,3gp,3g2,mj2,mpegts,aac', '-i', path.resolve(file)];
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...input(video), ...(audio ? input(audio) : []), '-map', '0:v:0', '-map', audio ? '1:a:0' : '0:a:0'];
  try {
    await execute([...args, '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', path.resolve(output)], signal);
  } catch (error) {
    signal?.throwIfAborted();
    // Video remains untouched; AAC provides a compatible fallback for audio codecs
    // that cannot be copied into MP4. Required audio mapping never uses '?'.
    await execute([...args, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-f', 'mp4', path.resolve(output)], signal);
  }
}

module.exports = { ffmpegPath, muxTracks };
