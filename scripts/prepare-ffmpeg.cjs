const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
async function download(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`Download failed: ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  } catch {
    return execFileSync('curl', ['--fail', '--location', '--retry', '2', '--connect-timeout', '30', '--max-time', '180', url], { maxBuffer: 200 * 1024 * 1024 });
  }
}
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error || result.status) throw result.error || new Error(`${command} failed: ${result.status}`);
}
async function prepare(target) {
  if (!['darwin-arm64', 'darwin-x64', 'win32-x64'].includes(target)) throw new Error(`Unsupported target: ${target}`);
  const name = target.startsWith('win32') ? 'ffmpeg.exe' : 'ffmpeg';
  const directory = path.join(root, 'vendor', 'ffmpeg', target);
  await fs.mkdir(directory, { recursive: true });
  const executable = path.join(directory, name);
  try {
    const previous = JSON.parse(await fs.readFile(path.join(directory, 'BUILD.json'), 'utf8'));
    await fs.access(path.join(directory, 'LICENSE.txt'));
    const checksum = createHash('sha256').update(await fs.readFile(executable)).digest('hex');
    if (checksum === previous.binarySHA256 && (target.startsWith('win32') || previous.buildRecipe === 2)) { console.log(`Using verified ${target}`); return; }
  } catch {}
  let provenance;
  if (target.startsWith('darwin')) {
    if (process.platform !== 'darwin') throw new Error('Build macOS helper on macOS');
    const version = '8.1.3';
    const sourceURL = `https://ffmpeg.org/releases/ffmpeg-${version}.tar.xz`;
    const runtime = path.join(root, '.runtime'); await fs.mkdir(runtime, { recursive: true });
    const archive = path.join(runtime, `ffmpeg-${version}.tar.xz`);
    try { await fs.access(archive); } catch { await fs.writeFile(archive, await download(sourceURL)); }
    const source = path.join(runtime, `ffmpeg-${version}`);
    try { await fs.access(path.join(source, 'configure')); } catch { run('tar', ['-xf', archive, '-C', runtime]); }
    const build = path.join(runtime, `ffmpeg-build-${target}`); await fs.mkdir(build, { recursive: true });
    const arch = target.endsWith('arm64') ? 'arm64' : 'x86_64';
    const args = ['--extra-cflags=-mmacosx-version-min=12.0', '--extra-ldflags=-mmacosx-version-min=12.0', ...(target !== `${process.platform}-${process.arch}` ? ['--enable-cross-compile', '--target-os=darwin'] : []), '--disable-everything', '--disable-autodetect', '--disable-network', '--disable-doc', '--disable-debug', '--disable-ffplay', '--disable-ffprobe', '--enable-ffmpeg', '--disable-x86asm', `--arch=${arch}`, `--cc=clang -arch ${arch}`, '--enable-protocol=file,pipe', '--enable-demuxer=mov,mpegts,aac', '--enable-muxer=mp4,null,pcm_f32le', '--enable-parser=h264,hevc,aac,mpegaudio,ac3,opus,flac', '--enable-decoder=aac,mp3,ac3,eac3,opus,flac,pcm_s16le', '--enable-encoder=aac,pcm_f32le', '--enable-bsf=aac_adtstoasc,extract_extradata,h264_mp4toannexb,hevc_mp4toannexb', '--enable-filter=aresample,anull', '--enable-swresample'];
    run(path.join(source, 'configure'), args, build);
    run('make', ['clean'], build);
    run('make', ['-j4'], build);
    await fs.copyFile(path.join(build, 'ffmpeg'), executable);
    await fs.copyFile(path.join(source, 'COPYING.LGPLv2.1'), path.join(directory, 'LICENSE.txt'));
    // The unchanged upstream source is included alongside the helper for reproducible local builds.
    await fs.copyFile(archive, path.join(directory, path.basename(archive)));
    provenance = { buildRecipe: 2, sourceURL, sourceSHA256: createHash('sha256').update(await fs.readFile(archive)).digest('hex'), configure: args, license: 'LGPL-2.1-or-later' };
  } else {
    const binaryURL = 'https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-8.1.2-essentials_build.zip';
    const checksum = 'db580001caa24ac104c8cb856cd113a87b0a443f7bdf47d8c12b1d740584a2ec';
    const runtime = path.join(root, '.runtime'); await fs.mkdir(runtime, { recursive: true });
    const archive = path.join(runtime, 'ffmpeg-8.1.2-essentials_build.zip');
    try { await fs.access(archive); } catch {
      const partial = `${archive}.part`;
      run('curl', ['--fail', '--location', '--retry', '2', '--connect-timeout', '30', '--max-time', '900', '--continue-at', '-', '--output', partial, binaryURL]);
      await fs.rename(partial, archive);
    }
    const data = await fs.readFile(archive);
    if (createHash('sha256').update(data).digest('hex') !== checksum) throw new Error('Windows FFmpeg checksum mismatch');
    await fs.writeFile(archive, data);
    run('tar', ['-xf', archive, '-C', runtime]);
    const extracted = path.join(runtime, 'ffmpeg-8.1.2-essentials_build');
    await fs.copyFile(path.join(extracted, 'bin', 'ffmpeg.exe'), executable);
    await fs.copyFile(path.join(extracted, 'LICENSE'), path.join(directory, 'LICENSE.txt'));
    await fs.copyFile(path.join(extracted, 'README.txt'), path.join(directory, 'README.txt'));
    provenance = { binaryURL, archiveSHA256: checksum, upstream: 'https://www.gyan.dev/ffmpeg/builds/', source: 'https://github.com/GyanD/codexffmpeg/releases/tag/8.1.2', license: 'GPL-3.0-or-later; see LICENSE.txt and README.txt' };
  }
  await fs.chmod(executable, 0o755);
  provenance.binarySHA256 = createHash('sha256').update(await fs.readFile(executable)).digest('hex');
  await fs.writeFile(path.join(directory, 'BUILD.json'), JSON.stringify(provenance, null, 2));
  console.log(`Prepared ${target}`);
}
(async () => { for (const target of process.argv.slice(2).length ? process.argv.slice(2) : [`${process.platform}-${process.arch}`]) await prepare(target); })().catch(error => { console.error(error.message); process.exitCode = 1; });
