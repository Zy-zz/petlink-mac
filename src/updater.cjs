const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { promisify } = require('node:util');
const { execFile, spawn } = require('node:child_process');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { extract } = require('@electron-internal/extract-zip');
const executeFile = promisify(execFile);
const run = (command, args) => executeFile(command, args, { timeout: 60_000 });
const REPOSITORY = 'Zy-zz/petlink-mac';
const API = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
const MAX_ZIP = 512 * 1024 * 1024;

function versionParts(value) {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+$/.test(value)) throw new Error('更新版本号无效。');
  const parts = value.split('.').map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new Error('更新版本号无效。');
  return parts;
}
function newer(a, b) {
  const left = versionParts(a), right = versionParts(b);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i];
  return false;
}
function releaseAsset(release, current) {
  if (release?.draft || release?.prerelease || typeof release?.tag_name !== 'string' || !release.tag_name.startsWith('v'))
    throw new Error('只支持正式发布的更新。');
  const version = release.tag_name.slice(1);
  if (!newer(version, current)) return null;
  const name = `PetLink-${version}-mac-arm64.zip`;
  const asset = release.assets?.find(a => a.name === name);
  if (!asset || asset.browser_download_url !== `https://github.com/${REPOSITORY}/releases/download/v${version}/${name}` ||
    !/^sha256:[a-f0-9]{64}$/.test(asset.digest) || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_ZIP)
    throw new Error('更新包缺少有效的 GitHub SHA-256 校验或下载信息。');
  return { version, url: asset.browser_download_url, sha256: asset.digest.slice(7), size: asset.size };
}
async function request(url, timeout = 60_000) {
  for (let redirects = 0; redirects < 6; redirects++) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !['api.github.com', 'github.com', 'release-assets.githubusercontent.com',
      'objects.githubusercontent.com'].includes(parsed.hostname) || parsed.username || parsed.password)
      throw new Error('更新地址不属于 GitHub。');
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeout),
      headers: { 'User-Agent': 'PetLink', Accept: url === API ? 'application/vnd.github+json' : 'application/octet-stream' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      url = new URL(response.headers.get('location'), url).href;
      continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`GitHub 更新请求失败（${response.status}），请稍后重试。`); }
    return response;
  }
  throw new Error('更新地址重定向次数过多。');
}
async function download(asset, file, progress) {
  const response = await request(asset.url, 15 * 60_000);
  const hash = createHash('sha256');
  let bytes = 0, lastProgress = 0;
  await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, _encoding, callback) {
    bytes += chunk.length;
    if (bytes > asset.size || bytes > MAX_ZIP) return callback(new Error('更新包大小与 GitHub 发布信息不符。'));
    hash.update(chunk);
    if (Date.now() - lastProgress > 400) { progress(Math.floor(bytes / asset.size * 100)); lastProgress = Date.now(); }
    callback(null, chunk);
  } }), fs.createWriteStream(file, { flags: 'wx', mode: 0o600 }));
  if (bytes !== asset.size || hash.digest('hex') !== asset.sha256) throw new Error('更新包 SHA-256 校验失败，已取消安装。');
}
async function unpack(archive, directory) {
  const { stdout } = await run('/usr/bin/zipinfo', ['-t', archive]);
  const totals = stdout.match(/(\d+) files?, (\d+) bytes uncompressed/);
  if (!totals || Number(totals[1]) > 20_000 || Number(totals[2]) > 2 * 1024 * 1024 * 1024)
    throw new Error('更新 ZIP 内容过大或无效。');
  // Reuse Electron's extractor: files are contained first and symlinks are applied last.
  await extract(archive, { dir: directory });
  if ((await fs.promises.readdir(directory)).some(name => !['PetLink.app', '__MACOSX'].includes(name)))
    throw new Error('更新 ZIP 内容无效。');
  const bundle = path.join(directory, 'PetLink.app');
  const root = await fs.promises.realpath(bundle);
  if ((await fs.promises.lstat(bundle)).isSymbolicLink()) throw new Error('更新应用不能是符号链接。');
  async function checkLinks(dir) {
    for (const item of await fs.promises.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      if (item.isSymbolicLink()) {
        const target = await fs.promises.realpath(file);
        if (!target.startsWith(root + path.sep)) throw new Error('更新应用包含越界符号链接。');
      } else if (item.isDirectory()) await checkLinks(file);
    }
  }
  await checkLinks(bundle);
  return bundle;
}
async function signature(bundle, execute = run) {
  const result = await execute('/usr/bin/codesign', ['-dv', '--verbose=4', bundle]);
  return { team: result.stderr.match(/^TeamIdentifier=(.+)$/m)?.[1],
    developer: /^Authority=Developer ID Application:/m.test(result.stderr),
    adhoc: /^Signature=adhoc$/m.test(result.stderr) };
}
async function verifyBundle(bundle, version, installed, execute = run) {
  const { stdout } = await execute('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(bundle, 'Contents/Info.plist')]);
  const info = JSON.parse(stdout);
  if (info.CFBundleIdentifier !== 'app.petlink.mac' || info.CFBundleShortVersionString !== version ||
    info.CFBundleVersion !== version || info.CFBundleExecutable !== 'Electron') throw new Error('更新包身份或版本与发布信息不符。');
  await execute('/usr/bin/lipo', [path.join(bundle, 'Contents/MacOS/Electron'), '-verify_arch', 'arm64']);
  await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  const before = await signature(installed, execute), after = await signature(bundle, execute);
  if (before.developer && (!after.developer || after.team !== before.team)) throw new Error('更新签名与已安装应用的开发者不一致。');
  if (after.developer) {
    await execute('/usr/bin/xcrun', ['stapler', 'validate', bundle]);
    await execute('/usr/sbin/spctl', ['--assess', '--type', 'execute', bundle]);
  } else if (!after.adhoc) throw new Error('更新包没有有效的 Developer ID 或临时签名。');
  // Downloads through Node do not acquire quarantine automatically. Keep macOS's first-open checks.
  await execute('/usr/bin/xattr', ['-w', 'com.apple.quarantine', `0001;${Math.floor(Date.now() / 1000).toString(16)};PetLink;`, bundle]);
  return after.developer;
}
function bundlePath(executable) { return path.resolve(path.dirname(executable), '../..'); }
function cleanupInstalledUpdate(bundle, version, profile) {
  const marker = path.join(profile, 'pending-update.json');
  if (!fs.existsSync(marker)) return;
  try {
    const pending = JSON.parse(fs.readFileSync(marker, 'utf8'));
    if (pending.bundle !== bundle || pending.version !== version || path.dirname(pending.stage) !== path.dirname(bundle) ||
      !/^\.petlink-update-[A-Za-z0-9]+$/.test(path.basename(pending.stage))) return;
    if (fs.existsSync(pending.stage) && !fs.lstatSync(pending.stage).isSymbolicLink()) fs.rmSync(pending.stage, { recursive: true });
    fs.unlinkSync(marker);
  } catch { /* Keep the backup if cleanup cannot be verified or completed. */ }
}
class Updater {
  constructor({ version, bundle, profile, enabled, onState }) {
    this.version = version; this.bundle = bundle; this.profile = profile; this.enabled = enabled; this.onState = onState;
    this.state = { phase: 'idle', current: version };
  }
  set(value) { this.state = { ...this.state, ...value }; this.onState?.(this.state); return this.state; }
  assertIdle() {
    if (!this.enabled) throw new Error('请从已安装的 Apple Silicon Mac 应用中更新。');
    if (['checking', 'downloading', 'installing'].includes(this.state.phase)) throw new Error('更新正在进行，请稍候。');
  }
  async check() {
    this.assertIdle();
    this.set({ phase: 'checking', error: '', available: null, progress: 0 });
    try {
      if (this.stage) { await fs.promises.rm(this.stage, { recursive: true, force: true }); this.stage = null; }
      this.asset = null;
      const response = await request(API);
      const chunks = []; let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) throw new Error('GitHub 更新信息过大。');
        chunks.push(Buffer.from(chunk));
      }
      this.asset = releaseAsset(JSON.parse(Buffer.concat(chunks).toString('utf8')), this.version);
      return this.set({ phase: this.asset ? 'available' : 'current', available: this.asset?.version });
    } catch (error) { this.set({ phase: 'error', error: error.message }); throw error; }
  }
  async prepare() {
    this.assertIdle();
    if (!this.asset || this.state.phase !== 'available') throw new Error('请先检查可用更新。');
    this.set({ phase: 'downloading', error: '', progress: 0 });
    try {
      if (path.basename(this.bundle) !== 'PetLink.app' || fs.lstatSync(this.bundle).isSymbolicLink()) throw new Error('请把 PetLink 安装到应用程序目录后再更新。');
      await fs.promises.access(path.dirname(this.bundle), fs.constants.W_OK);
      this.stage = await fs.promises.mkdtemp(path.join(path.dirname(this.bundle), '.petlink-update-'));
      await fs.promises.chmod(this.stage, 0o700);
      const archive = path.join(this.stage, 'update.zip'), directory = path.join(this.stage, 'unpacked');
      await download(this.asset, archive, progress => this.set({ progress }));
      const candidate = await unpack(archive, directory);
      const signed = await verifyBundle(candidate, this.asset.version, this.bundle);
      fs.copyFileSync(path.join(__dirname, 'install-update.sh'), path.join(this.stage, 'install.sh'));
      this.candidate = candidate;
      return this.set({ phase: 'ready', progress: 100, signed });
    } catch (error) {
      try { if (this.stage) await fs.promises.rm(this.stage, { recursive: true, force: true }); }
      catch { /* Temporary cleanup must not hide the download or verification failure. */ }
      this.stage = null;
      const message = ['EACCES', 'EROFS'].includes(error.code) ? '应用目录不可写，请先把 PetLink 移到你自己的 ~/Applications 目录。' : error.message;
      this.set({ phase: 'error', error: message }); throw new Error(message);
    }
  }
  async install() {
    this.assertIdle();
    if (this.state.phase !== 'ready' || !this.stage) throw new Error('更新尚未准备好。');
    this.set({ phase: 'installing' });
    try {
      // Recheck the staged code just before handing it to the detached installer.
      await verifyBundle(this.candidate, this.asset.version, this.bundle);
      const log = fs.openSync(path.join(this.stage, 'install.log'), 'a', 0o600);
      try {
        fs.writeFileSync(path.join(this.profile, 'pending-update.json'), JSON.stringify({ bundle: this.bundle,
          stage: this.stage, version: this.asset.version }), { mode: 0o600 });
        const child = spawn('/bin/sh', [path.join(this.stage, 'install.sh'), String(process.pid), this.bundle,
          this.candidate, this.stage], { detached: true, stdio: ['ignore', log, log], env: { ...process.env } });
        await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
        child.unref();
      } finally { fs.closeSync(log); }
    } catch (error) { this.set({ phase: 'ready', error: error.message }); throw error; }
  }
}
module.exports = { Updater, bundlePath, cleanupInstalledUpdate, releaseAsset, newer, download, unpack, verifyBundle };
