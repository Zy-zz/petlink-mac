const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../scripts/build-mac.cjs'), 'utf8');
const credentials = { MAC_SIGNING_IDENTITY: 'Developer ID Application: Test (TEAMID)', MAC_NOTARY_PROFILE: 'test-notary',
  MAC_SIGNING_KEYCHAIN: '/tmp/test.keychain-db' };

function fixture({ release = true, env = credentials, arch = 'arm64', status = 'Accepted', fail } = {}) {
  const events = [];
  const fakeFs = { existsSync: file => !file.endsWith('ui/icon.png') };
  for (const name of ['mkdirSync', 'rmSync', 'cpSync', 'writeFileSync', 'copyFileSync', 'symlinkSync'])
    fakeFs[name] = (...args) => events.push({ file: name, args });
  const execFileSync = (command, args) => {
    events.push({ command, args });
    if (fail?.(command, args)) throw new Error('verification failed');
    if (command === 'xcrun' && args[0] === 'notarytool') return JSON.stringify({ status, id: 'test-submission' });
    return '';
  };
  const module = { exports: {} };
  const context = { module, __dirname: path.join(__dirname, '../scripts'),
    process: { platform: 'darwin', arch, argv: release ? ['node', 'build-mac.cjs', '--release'] : [], env },
    console: { log: value => events.push({ log: value }), warn: value => events.push({ warn: value }) },
    require: name => {
      if (name === 'node:fs') return fakeFs;
      if (name === 'node:child_process') return { execFileSync };
      if (name === '@electron/osx-sign') return { sign: async options => {
        events.push({ sign: options });
        if (fail?.('sign', [])) throw new Error('signing failed');
      } };
      if (name === '../package.json') return require('../package.json');
      return require(name);
    } };
  vm.runInNewContext(source, context);
  return { build: module.exports, events };
}

test('local builds stay ad-hoc and warn that downloads will be blocked', async () => {
  const { build, events } = fixture({ release: false, env: {} });
  await build();
  assert.ok(events.some(e => e.command === 'codesign' && e.args.includes('-')));
  assert.ok(events.some(e => e.warn?.includes('ad-hoc')));
  assert.ok(!events.some(e => e.sign || e.command === 'xcrun' || e.command === 'spctl'));
});

test('release preflight rejects absent credentials and ad-hoc identities before changing files', async () => {
  for (const env of [{}, { ...credentials, MAC_NOTARY_PROFILE: '' }, { ...credentials, MAC_SIGNING_IDENTITY: '-' },
    { ...credentials, MAC_SIGNING_IDENTITY: 'Apple Development: Test' }]) {
    const { build, events } = fixture({ env });
    await assert.rejects(build(), /Developer ID Application/);
    assert.equal(events.length, 0);
  }
});

test('arm64 artifact names cannot be used for an Intel build', async () => {
  const { build, events } = fixture({ arch: 'x64' });
  await assert.rejects(build(), /Apple Silicon/);
  assert.equal(events.length, 0);
});

test('release archives contain the stapled app and DMG passes all checks before success', async () => {
  const { build, events } = fixture();
  await build();
  const index = predicate => events.findIndex(predicate);
  const appStaple = index(e => e.command === 'xcrun' && e.args[0] === 'stapler' && e.args[1] === 'staple' && e.args[2].endsWith('.app'));
  const appAssess = index(e => e.command === 'spctl' && e.args.includes('execute'));
  const finalZip = index(e => e.command === 'ditto' && e.args.at(-1).endsWith('-mac-arm64.zip'));
  const stageApp = index(e => e.command === 'ditto' && e.args.at(-1).endsWith('dmg-stage/PetLink.app'));
  assert.ok(appStaple > index(e => e.command === 'xcrun' && e.args[0] === 'notarytool'));
  assert.ok(appAssess > appStaple && finalZip > appAssess && stageApp > appAssess);
  assert.equal(events.filter(e => e.command === 'xcrun' && e.args[0] === 'notarytool').length, 2);
  for (const e of events.filter(e => e.command === 'xcrun' && e.args[0] === 'notarytool')) {
    assert.ok(e.args.includes('--wait') && e.args.includes('--keychain-profile') && e.args.includes(credentials.MAC_SIGNING_KEYCHAIN));
  }
  const dmgSign = index(e => e.command === 'codesign' && e.args.at(-1).endsWith('.dmg'));
  const dmgStaple = index(e => e.command === 'xcrun' && e.args[1] === 'staple' && e.args[2].endsWith('.dmg'));
  const dmgAssess = index(e => e.command === 'spctl' && e.args.includes('open'));
  assert.ok(dmgSign > stageApp && dmgStaple > dmgSign && dmgAssess > dmgStaple);
  assert.ok(index(e => e.log) > dmgAssess);
  assert.ok(events[dmgSign].args.includes('--timestamp') && events[dmgSign].args.includes('--keychain'));
  assert.equal(events.find(e => e.sign).sign.platform, 'darwin');
  assert.ok(!events.some(e => e.command === 'codesign' && e.args.includes('-')));
});

test('Apple rejection stops before final archives and removes the submission ZIP', async () => {
  const { build, events } = fixture({ status: 'Invalid' });
  await assert.rejects(build(), /Apple 公证失败/);
  assert.ok(!events.some(e => e.command === 'hdiutil' || e.command === 'spctl' || e.log));
  assert.ok(events.some(e => e.file === 'rmSync' && e.args[0].endsWith('PetLink-notarization.zip')));
});

test('signing, ticket, and Gatekeeper failures never fall back to ad-hoc or report success', async () => {
  for (const failedCommand of ['sign', 'spctl', 'xcrun']) {
    const { build, events } = fixture({ fail: command => command === failedCommand });
    await assert.rejects(build(), /failed/);
    assert.ok(!events.some(e => e.command === 'hdiutil' || e.log));
    assert.ok(!events.some(e => e.command === 'codesign' && e.args.includes('-')));
  }
});

test('DMG ticket or Gatekeeper failure cannot report a successful release', async () => {
  for (const failedCommand of ['xcrun', 'spctl']) {
    const { build, events } = fixture({ fail: (command, args) => command === failedCommand && args.some(a => a.endsWith('.dmg')) });
    await assert.rejects(build(), /failed/);
    assert.ok(events.some(e => e.command === 'hdiutil'));
    assert.ok(!events.some(e => e.log));
  }
});
