const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { promisify } = require('node:util');
const { execFile, spawn } = require('node:child_process');
const { Updater, newer, releaseAsset, download, unpack, verifyBundle, bundlePath, cleanupInstalledUpdate } = require('../src/updater.cjs');
const run = promisify(execFile);
const url = 'https://github.com/Zy-zz/petlink-mac/releases/download/v0.4.1/PetLink-0.4.1-mac-arm64.zip';
const bytes = Buffer.from('test update');
const asset = { name: 'PetLink-0.4.1-mac-arm64.zip', browser_download_url: url,
  digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
const release = { tag_name: 'v0.4.1', assets: [asset] };
function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'petlink-update-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function mockFetch(t, fn) { const original = global.fetch; global.fetch = fn; t.after(() => { global.fetch = original; }); }

test('update versions compare numerically and never offer downgrades or prereleases', () => {
  assert.equal(newer('0.10.0', '0.9.9'), true);
  assert.equal(newer('0.4.0', '0.4.1'), false);
  assert.equal(releaseAsset(release, '0.4.1'), null);
  assert.equal(releaseAsset(release, '0.5.0'), null);
  for (const tag_name of ['v../0.4.1', 'v0.4.1-beta', '0.4.1', 'v99999999999999999999999.0.0'])
    assert.throws(() => releaseAsset({ ...release, tag_name }, '0.4.0'));
  assert.throws(() => releaseAsset({ ...release, prerelease: true }, '0.4.0'));
});
test('release packages need the exact official ZIP URL, bounded size, and SHA-256', () => {
  assert.equal(releaseAsset(release, '0.4.0').url, url);
  for (const change of [{ browser_download_url: 'https://evil.invalid/app.zip' }, { digest: null }, { size: -1 },
    { size: 1024 ** 3 }, { name: 'PetLink-0.4.1-source.zip' }])
    assert.throws(() => releaseAsset({ ...release, assets: [{ ...asset, ...change }] }, '0.4.0'));
});
test('streamed downloads reject altered, truncated, oversized data and off-site redirects', async t => {
  const root = temporary(t), selected = releaseAsset(release, '0.4.0');
  mockFetch(t, async () => new Response(bytes));
  const file = path.join(root, 'good.zip');
  await download(selected, file, () => {});
  assert.deepEqual(fs.readFileSync(file), bytes);
  for (const [index, response] of [Buffer.from('bad update!'), bytes.subarray(1), Buffer.concat([bytes, bytes])].entries()) {
    global.fetch = async () => new Response(response);
    await assert.rejects(download(selected, path.join(root, `${index}.zip`), () => {}), /校验|大小/);
  }
  global.fetch = async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } });
  await assert.rejects(download(selected, path.join(root, 'redirect.zip'), () => {}), /GitHub/);
});
test('update checks serialize, recover after errors, and reject uninstalled development apps', async t => {
  const root = temporary(t), updater = new Updater({ version: '0.4.0', bundle: root, profile: root, enabled: true });
  let resolve;
  mockFetch(t, () => new Promise(r => { resolve = r; }));
  const pending = updater.check();
  await assert.rejects(updater.check(), /正在进行/);
  resolve(new Response(JSON.stringify(release)));
  assert.equal((await pending).phase, 'available');
  global.fetch = async () => new Response('', { status: 503 });
  await assert.rejects(updater.check(), /503/);
  assert.equal(updater.state.phase, 'error');
  global.fetch = async () => new Response(JSON.stringify(release));
  assert.equal((await updater.check()).phase, 'available');
  await assert.rejects(new Updater({ version: '0.4.0', enabled: false }).check(), /已安装/);
});
test('bundle validation prevents wrong identity, changed developer, unsigned downgrade and invalid tickets', async () => {
  const candidate = '/tmp/new/PetLink.app', installed = '/tmp/old/PetLink.app';
  function execute({ before = 'Signature=adhoc', after = 'Signature=adhoc', badId = false, rejectTicket = false } = {}) {
    const calls = [];
    const fn = async (command, args) => {
      calls.push([command, args]);
      if (command.endsWith('plutil')) return { stdout: JSON.stringify({ CFBundleIdentifier: badId ? 'wrong' : 'app.petlink.mac',
        CFBundleShortVersionString: '0.4.1', CFBundleVersion: '0.4.1', CFBundleExecutable: 'Electron' }) };
      if (args[0] === '-dv') return { stderr: args.at(-1) === installed ? before : after };
      if (rejectTicket && command.endsWith('xcrun')) throw new Error('missing ticket');
      return { stdout: '', stderr: '' };
    };
    return { fn, calls };
  }
  const signed = 'Authority=Developer ID Application: Test\nTeamIdentifier=TEAM';
  for (const options of [{ badId: true }, { before: signed }, { before: signed, after: signed.replace('TEAM', 'OTHER') },
    { after: 'Signature=invalid' }, { before: signed, after: signed, rejectTicket: true }])
    await assert.rejects(verifyBundle(candidate, '0.4.1', installed, execute(options).fn));
  const trusted = execute({ before: signed, after: signed });
  assert.equal(await verifyBundle(candidate, '0.4.1', installed, trusted.fn), true);
  assert.ok(trusted.calls.some(([cmd]) => cmd.endsWith('spctl')));
  const local = execute();
  assert.equal(await verifyBundle(candidate, '0.4.1', installed, local.fn), false);
  assert.ok(local.calls.some(([cmd, args]) => cmd.endsWith('xattr') && args.includes('com.apple.quarantine')));
  assert.ok(!local.calls.some(([cmd]) => cmd.endsWith('spctl')));
});
test('extractor rejects path traversal and escaping symlinks before writing outside its directory', async t => {
  const root = temporary(t);
  for (const name of ['traversal', 'symlink']) {
    await assert.rejects(unpack(path.join(__dirname, `fixtures/update-${name}.zip`), path.join(root, name)));
    assert.equal(fs.existsSync(path.join(root, 'escaped.txt')), false);
  }
});
test('installer swaps only the app, preserves profile files and rolls back a failed launch', async t => {
  const root = temporary(t), profile = path.join(root, 'profile.json'); fs.writeFileSync(profile, 'keep pairing and history');
  const script = fs.readFileSync(path.join(__dirname, '../src/install-update.sh'), 'utf8');
  for (const fails of [false, true]) {
    const dir = path.join(root, `case ${fails}`); fs.mkdirSync(dir);
    const stage = path.join(dir, '.petlink-update-123'); fs.mkdirSync(stage);
    const target = path.join(dir, 'PetLink.app'), candidate = path.join(stage, 'candidate.app');
    fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'version'), 'old');
    fs.mkdirSync(candidate); fs.writeFileSync(path.join(candidate, 'version'), 'new');
    const launcher = path.join(root, 'open-stub'); fs.writeFileSync(launcher, `#!/bin/sh\nexit ${fails ? 1 : 0}\n`, { mode: 0o700 });
    const helper = path.join(dir, 'install.sh');
    fs.writeFileSync(helper, script.replaceAll('/usr/bin/open', `"${launcher}"`));
    const operation = run('/bin/sh', [helper, '99999999', target, candidate, stage]);
    if (fails) await assert.rejects(operation); else await operation;
    assert.equal(fs.readFileSync(path.join(target, 'version'), 'utf8'), fails ? 'old' : 'new');
    assert.equal(fs.readFileSync(profile, 'utf8'), 'keep pairing and history');
  }
});
test('backup cleanup requires successful startup of the exact installed version and directory', t => {
  const root = temporary(t), profile = path.join(root, 'profile'); fs.mkdirSync(profile);
  const bundle = path.join(root, 'PetLink.app'), stage = path.join(root, '.petlink-update-123'); fs.mkdirSync(stage);
  const marker = path.join(profile, 'pending-update.json');
  fs.writeFileSync(marker, JSON.stringify({ bundle, stage, version: '0.4.1' }));
  cleanupInstalledUpdate(bundle, '0.4.0', profile); assert.ok(fs.existsSync(stage));
  cleanupInstalledUpdate(bundle, '0.4.1', profile); assert.ok(!fs.existsSync(stage));
  fs.writeFileSync(marker, JSON.stringify({ bundle, stage: profile, version: '0.4.1' }));
  cleanupInstalledUpdate(bundle, '0.4.1', profile); assert.ok(fs.existsSync(profile));
  assert.equal(bundlePath('/Applications/PetLink.app/Contents/MacOS/Electron'), '/Applications/PetLink.app');
});
test('installer waits for the old process to exit before moving the running app', async t => {
  const root = temporary(t), stage = path.join(root, 'stage'); fs.mkdirSync(stage);
  const target = path.join(root, 'PetLink.app'), candidate = path.join(stage, 'candidate.app');
  fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'version'), 'old');
  fs.mkdirSync(candidate); fs.writeFileSync(path.join(candidate, 'version'), 'new');
  const launcher = path.join(root, 'open-stub'); fs.writeFileSync(launcher, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const script = fs.readFileSync(path.join(__dirname, '../src/install-update.sh'), 'utf8').replaceAll('/usr/bin/open', `"${launcher}"`);
  const helper = path.join(root, 'install.sh'); fs.writeFileSync(helper, script);
  const oldProcess = spawn('/bin/sleep', ['10']); t.after(() => oldProcess.kill());
  const operation = run('/bin/sh', [helper, String(oldProcess.pid), target, candidate, stage]);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(fs.readFileSync(path.join(target, 'version'), 'utf8'), 'old');
  assert.ok(fs.existsSync(candidate));
  oldProcess.kill();
  await operation;
  assert.equal(fs.readFileSync(path.join(target, 'version'), 'utf8'), 'new');
});
test('failed temporary cleanup cannot hide corruption or leave the updater stuck downloading', async t => {
  const root = temporary(t), bundle = path.join(root, 'PetLink.app'); fs.mkdirSync(bundle);
  const updater = new Updater({ version: '0.4.0', bundle, profile: root, enabled: true });
  mockFetch(t, async address => new Response(address.includes('/releases/latest') ? JSON.stringify(release) : 'bad update!'));
  await updater.check();
  const originalRm = fs.promises.rm;
  fs.promises.rm = async () => { throw new Error('cleanup refused'); };
  t.after(() => { fs.promises.rm = originalRm; });
  await assert.rejects(updater.prepare(), /SHA-256/);
  assert.equal(updater.state.phase, 'error');
  assert.match(updater.state.error, /SHA-256/);
  assert.ok(fs.existsSync(bundle));
});
