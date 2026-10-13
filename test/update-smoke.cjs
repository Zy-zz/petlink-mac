const { _electron: electron } = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { createIdentity } = require('../src/peer.cjs');
const { Updater } = require('../src/updater.cjs');

const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'petlink-update-smoke-'));
const version = require('../package.json').version;
const nextVersion = version.replace(/\d+$/, part => String(Number(part) + 1));
const target = path.join(temporary, 'installed/PetLink.app');
const candidate = path.join(temporary, 'release/PetLink.app');
const profile = path.join(temporary, 'profile');
let client;
(async () => {
  for (const bundle of [target, candidate]) {
    fs.mkdirSync(path.dirname(bundle), { recursive: true });
    execFileSync('/usr/bin/ditto', [path.join(root, 'dist/PetLink.app'), bundle]);
  }
  const info = path.join(candidate, 'Contents/Info.plist');
  for (const key of ['CFBundleVersion', 'CFBundleShortVersionString'])
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${nextVersion}`, info]);
  const packageFile = path.join(candidate, 'Contents/Resources/app/package.json');
  const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8')); pkg.version = nextVersion;
  fs.writeFileSync(packageFile, JSON.stringify(pkg));
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', candidate]);
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', candidate]);
  const archive = path.join(temporary, 'release.zip');
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', candidate, archive]);
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(archive)) hash.update(chunk);
  const metadata = { tag_name: `v${nextVersion}`, assets: [{ name: `PetLink-${nextVersion}-mac-arm64.zip`,
    browser_download_url: `https://github.com/Zy-zz/petlink-mac/releases/download/v${nextVersion}/PetLink-${nextVersion}-mac-arm64.zip`,
    digest: `sha256:${hash.digest('hex')}`, size: fs.statSync(archive).size }] };
  fs.mkdirSync(profile);
  const config = { identity: createIdentity(), name: '更新测试', invite: null, peerPubkey: null,
    peerName: '', pet: { kind: 'cat', src: 'pet.svg', name: '像素小猫', pixel: true } };
  const history = [{ id: 'preserved-message', text: '更新后仍然保留', sentAt: Date.now(), direction: 'incoming', fromName: '测试' }];
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(profile, 'history.json'), JSON.stringify(history));
  client = await electron.launch({ executablePath: path.join(target, 'Contents/MacOS/Electron'), args: [],
    env: { ...process.env, PETLINK_PROFILE: profile, PETLINK_HIDDEN: '1' } });
  await client.firstWindow();
  let page;
  for (let i = 0; i < 100; i++) {
    page = client.windows().find(p => p.url().endsWith('/index.html'));
    if (page) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(page, 'main update window must load');
  page.on('pageerror', error => console.error('Update renderer:', error.message));
  await page.waitForFunction(() => Boolean(window.petlink));
  await page.evaluate(() => window.petlink.onState(state => { window.updateTestPhase = state.update.phase; }));
  await client.evaluate(({ dialog }, { archive, metadata }) => {
    const { Readable } = process.getBuiltinModule('node:stream');
    const fs = process.getBuiltinModule('node:fs');
    globalThis.fetch = async url => url.includes('/releases/latest') ? new Response(JSON.stringify(metadata))
      : new Response(Readable.toWeb(fs.createReadStream(archive)));
    dialog.showMessageBox = async (_window, options) => { globalThis.updateConfirmation = options; return { response: 0 }; };
  }, { archive, metadata });
  await page.locator('#update').click();
  await page.locator('#update-status').getByText(`可更新到 v${nextVersion}`).waitFor();
  await page.locator('#update').click();
  await page.waitForFunction(() => ['ready', 'error'].includes(window.updateTestPhase), null, { timeout: 120_000, polling: 200 });
  const downloaded = (await page.evaluate(() => window.petlink.call('get-state'))).update;
  assert.equal(downloaded.phase, 'ready', downloaded.error || await page.locator('#notice').textContent());
  assert.equal(downloaded.signed, false);
  await page.locator('#update').click();
  await page.waitForTimeout(100);
  const confirmation = await client.evaluate(() => globalThis.updateConfirmation);
  assert.match(confirmation.detail, /未经过 Apple 公证/);
  assert.equal((await page.evaluate(() => window.petlink.call('get-state'))).update.phase, 'ready');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(profile, 'config.json'))), config);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(profile, 'history.json'))), history);
  assert.equal(execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', path.join(target, 'Contents/Info.plist')],
    { encoding: 'utf8' }).trim(), version);
  console.log('PASS: packaged UI checks, downloads, extracts and verifies a real newer app ZIP; cancel preserves the app, pairing, pet and history.');
  // Also exercise the real GitHub metadata endpoint without installing anything.
  const latest = await new Updater({ version: '0.0.0', enabled: true }).check();
  assert.equal(latest.phase, 'available');
  console.log(`PASS: real GitHub latest release and asset digest read (${latest.available}).`);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (client) await client.close();
  fs.rmSync(temporary, { recursive: true, force: true });
});
