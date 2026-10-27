const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { build: config } = require('../package.json');

function run(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function signature(file) {
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', file]);
  // codesign writes its successful signature description to stderr.
  const { spawnSync } = require('node:child_process');
  const result = spawnSync('/usr/bin/codesign', ['--display', '--verbose=2', file], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || '无法读取签名');
  return result.stderr;
}

function verifyApp(appPath, release = false) {
  if (process.platform !== 'darwin') throw new Error('Mac 签名验证需要在 macOS 上运行');
  const info = signature(appPath);
  if (!info.includes(`Identifier=${config.appId}\n`) || !/Sealed Resources version=2/.test(info)) {
    throw new Error('应用标识或资源封印不正确，禁止发布');
  }
  const helper = signature(path.join(appPath, 'Contents', 'Resources', 'ffmpeg', 'ffmpeg'));
  const team = /^TeamIdentifier=(.+)$/m.exec(info)?.[1];
  if (release) {
    for (const description of [info, helper]) {
      if (!/^Authority=Developer ID Application:/m.test(description) ||
          !description.includes(`TeamIdentifier=${team}\n`) || !team || team === 'not set' ||
          !/flags=.*\bruntime\b/.test(description) || !/^Timestamp=/m.test(description)) {
        throw new Error('正式包必须使用同一团队的 Developer ID Application 签名、Hardened Runtime 和安全时间戳');
      }
    }
    run('/usr/bin/xcrun', ['stapler', 'validate', appPath]);
    run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', appPath]);
  }
  return { signature: 'valid', helperSignature: 'valid', team, notarized: release, gatekeeper: release ? 'accepted' : 'not-assessed' };
}

function verifyZip(zipPath, release = false) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mediacatch-verify-'));
  try {
    run('/usr/bin/ditto', ['-x', '-k', zipPath, temporary]);
    return verifyApp(path.join(temporary, `${config.productName}.app`), release);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

// electron-builder calls this after signing/notarization, before creating the ZIP.
module.exports = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  verifyApp(appPath, context.packager.platformSpecificBuildOptions.notarize === true);
  console.log(`Mac 签名验证通过：${appPath}`);
};
module.exports.verifyApp = verifyApp;
module.exports.verifyZip = verifyZip;

if (require.main === module) {
  const release = process.argv.includes('--release');
  const target = process.argv.slice(2).find(arg => arg !== '--release');
  try {
    if (!target || !/\.(app|zip)$/.test(target)) throw new Error('用法：npm run verify:mac -- [--release] /path/MediaCatch.app 或 .zip');
    console.log(JSON.stringify(target.endsWith('.zip') ? verifyZip(path.resolve(target), release) : verifyApp(path.resolve(target), release), null, 2));
  } catch (error) {
    console.error(error.stderr?.toString() || error.message);
    process.exitCode = 1;
  }
}
