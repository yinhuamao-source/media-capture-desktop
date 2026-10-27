const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { build, Platform, Arch } = require('electron-builder');
const { verifyApp, verifyZip } = require('./verify-mac.cjs');
const { version } = require('../package.json');

async function main() {
  if (process.platform !== 'darwin') throw new Error('Mac 构建需要在 macOS 上运行');
  const args = process.argv.slice(2);
  const release = args.includes('--release');
  const test = args.includes('--test');
  if (release === test || args.some(arg => !['--release', '--test', '--dir', '--arm64', '--x64'].includes(arg))) {
    throw new Error('用法：node scripts/build-mac.cjs --release 或 --test [--arm64] [--x64] [--dir]');
  }
  const root = path.resolve(__dirname, '..');
  let identity = '-';
  if (release) {
    const output = execFileSync('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
    const candidates = [...output.matchAll(/\b([A-Fa-f0-9]{40}) "(Developer ID Application: [^"]+)"/g)];
    const selector = process.env.MEDIA_CATCH_SIGN_IDENTITY;
    const selected = selector ? candidates.filter(match => match[1] === selector || match[2].includes(selector)) : candidates;
    if (selected.length !== 1) {
      throw new Error(selected.length ? '检测到多个发布证书，请用 MEDIA_CATCH_SIGN_IDENTITY 指定一个证书名称或 SHA-1。' :
        '未找到有效的 Developer ID Application 证书及私钥。请先导入这台 Mac 的钥匙串，或用 Xcode 创建。正式构建不会降级成临时签名包。');
    }
    identity = selected[0][1];
    if (!process.env.APPLE_KEYCHAIN_PROFILE) {
      throw new Error('请先用 xcrun notarytool store-credentials 保存公证凭据，再设置 APPLE_KEYCHAIN_PROFILE；密码不要写进项目。');
    }
    // Keep the release path on the explicitly chosen Keychain profile.
    if (['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'].some(key => process.env[key])) {
      throw new Error('当前环境还设置了其他 Apple 公证认证方式，请移除这些环境变量，只保留 APPLE_KEYCHAIN_PROFILE。');
    }
  }
  const architectures = args.filter(arg => arg === '--arm64' || arg === '--x64').map(arg => arg.slice(2));
  if (!architectures.length) architectures.push('arm64');
  execFileSync(process.execPath, ['scripts/prepare-ffmpeg.cjs', ...architectures.map(arch => `darwin-${arch}`)], { cwd: root, stdio: 'inherit' });
  const output = path.join(root, 'release', `${version}${test ? '-test' : ''}`);
  const config = {
    forceCodeSigning: true,
    directories: { output },
    artifactName: `MediaCatch-\${version}-\${os}-\${arch}${test ? '-test' : ''}.\${ext}`,
    mac: { identity, notarize: release },
  };
  if (release) {
    config.mac.entitlements = 'build/entitlements.mac.release.plist';
    config.mac.entitlementsInherit = 'build/entitlements.mac.release.plist';
  }
  if (process.env.MEDIA_CATCH_ELECTRON_DIST) config.electronDist = process.env.MEDIA_CATCH_ELECTRON_DIST;
  const artifacts = await build({
    projectDir: root,
    targets: Platform.MAC.createTarget(args.includes('--dir') ? 'dir' : 'zip', ...architectures.map(arch => Arch[arch])),
    publish: 'never',
    config,
  });
  const checks = [];
  for (const artifact of artifacts.filter(file => file.endsWith('.zip'))) {
    const verification = verifyZip(artifact, release);
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(artifact)).digest('hex');
    checks.push({ file: path.basename(artifact), sha256, ...verification });
  }
  if (args.includes('--dir')) {
    for (const arch of architectures) {
      const app = path.join(output, arch === 'arm64' ? 'mac-arm64' : 'mac', 'MediaCatch.app');
      checks.push({ file: path.relative(output, app), ...verifyApp(app, release) });
    }
  } else if (!checks.length) throw new Error('构建没有生成可验证的 Mac ZIP');
  fs.writeFileSync(path.join(output, 'mac-validation.json'), JSON.stringify({ version, mode: release ? 'release' : 'test', checks }, null, 2) + '\n');
  if (checks.some(check => check.sha256)) {
    fs.writeFileSync(path.join(output, 'SHA256SUMS.txt'), checks.filter(check => check.sha256).map(check => `${check.sha256}  ${check.file}\n`).join(''));
  }
  console.log(release ? '正式包签名、公证、Gatekeeper 和解压后验证全部通过。' : '测试包签名和解压后验证通过。此包未公证，不作为正式分发包。');
}

main().catch(error => {
  console.error(error.stderr?.toString() || error.message);
  process.exitCode = 1;
});
