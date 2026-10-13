const { _electron: electron } = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startRelay } = require('./relay.cjs');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'test-output');
fs.mkdirSync(output, { recursive: true });
const profiles = fs.mkdtempSync(path.join(os.tmpdir(), 'petlink-ui-'));
const apps = [];
let relay;
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
async function launch(name) {
  const app = await electron.launch({ executablePath: process.env.PETLINK_EXECUTABLE || require('electron'),
    args: process.env.PETLINK_EXECUTABLE ? [] : [root],
    env: { ...process.env, PETLINK_PROFILE: path.join(profiles, name), PETLINK_RELAYS: relay.url, PETLINK_HIDDEN: '1' } });
  apps.push(app);
  await app.firstWindow();
  const page = await windowPage(app, 'index.html');
  page.on('pageerror', error => console.error('Renderer:', error.message));
  await page.waitForLoadState();
  await page.waitForFunction(() => !!window.petlink);
  return { app, page };
}
async function windowPage(app, filename) {
  for (let i = 0; i < 100; i++) {
    const page = app.windows().find(p => p.url().endsWith('/' + filename));
    if (page) { await page.waitForLoadState(); return page; }
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`Missing ${filename}`);
}
async function online(page) {
  await page.waitForFunction(() => document.getElementById('status-dot').classList.contains('online'), null, { timeout: 20000, polling: 100 });
  assert.equal(await page.evaluate(async () => (await window.petlink.call('get-state')).status.peerOnline), true);
}
async function send(page, text) {
  await online(page);
  await page.locator('#message').fill(text);
  await page.locator('#send').click();
  await page.waitForFunction(() => !document.getElementById('send').disabled, null, { timeout: 15000 });
  if (await page.locator('#notice').isVisible()) {
    const debug = await page.evaluate(async () => { const s = await window.petlink.call('get-state'); return { name: s.name,
      online: s.status.peerOnline, relayCount: s.status.relayConnected, lastMessages: s.history.slice(-3).map(m => ({ text: m.text, direction: m.direction })) }; });
    console.error('Send debug', debug);
    await page.screenshot({ path: path.join(output, 'send-error.png') });
  }
  assert.equal(await page.locator('#notice').isVisible(), false, await page.locator('#notice').textContent());
}
(async () => {
  relay = await startRelay();
  const alice = await launch('alice');
  let bob = await launch('bob');
  await alice.page.locator('#name').fill('小林');
  await alice.page.locator('#create').click();
  try { await alice.page.locator('#invite-code').waitFor({ state: 'visible', timeout: 10000 }); }
  catch (error) { console.error('Configure notice:', await alice.page.locator('#notice').textContent()); await alice.page.screenshot({ path: path.join(output, 'setup-error.png') }); throw error; }
  const invite = await alice.page.locator('#invite-code').inputValue();
  assert.match(invite, /^PL1\./);
  await alice.page.locator('#copy').click();
  assert.equal(await alice.app.evaluate(({ clipboard }) => clipboard.readText()), invite);
  await bob.page.locator('#name').fill('阿月');
  await bob.page.locator('#join-toggle').click();
  await bob.page.locator('#invite-input').fill(invite);
  await bob.page.locator('#join-form button').click();
  await Promise.all([online(alice.page), online(bob.page)]);
  await send(alice.page, '嘿，今晚一起吃饭吧 🍜\n这个地方：https://example.com/dinner');
  let bubble = await windowPage(bob.app, 'bubble.html');
  await bubble.locator('#content').getByText('嘿，今晚一起吃饭吧 🍜', { exact: false }).waitFor();
  const bubbleWindow = await bob.app.browserWindow(bubble);
  assert.equal(await bubbleWindow.evaluate(win => win.isVisible()), true);
  assert.equal(await bubbleWindow.evaluate(win => win.isAlwaysOnTop()), true);
  await bob.app.evaluate(({ shell }) => { shell.openExternal = async url => { globalThis.openedURL = url; }; });
  await bubble.locator('a').click();
  assert.equal(await bob.app.evaluate(() => globalThis.openedURL), 'https://example.com/dinner');
  const blocked = await bubble.evaluate(async () => {
    try { await window.petlink.call('link', 'javascript:alert(1)'); return false; } catch { return true; }
  });
  assert.equal(blocked, true);
  await bob.page.locator('#file-input').setInputFiles({ name: '小纸条.png', mimeType: 'image/png', buffer: pixel });
  await bob.page.locator('#attachment-preview').waitFor({ state: 'visible' });
  await send(bob.page, '好呀，这是给你的小图片。');
  const aliceBubble = await windowPage(alice.app, 'bubble.html');
  await aliceBubble.waitForFunction(() => document.querySelector('#content img')?.naturalWidth > 0);
  const savedFile = path.join(profiles, 'received.png');
  await alice.app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, savedFile);
  await aliceBubble.locator('.file-card button').click();
  await aliceBubble.waitForTimeout(200);
  assert.deepEqual(fs.readFileSync(savedFile), pixel);
  await send(alice.page, '<img src=x onerror="window.injection=true"> 这应该是一段普通文字');
  await bubble.locator('#content').getByText('这应该是一段普通文字', { exact: false }).waitFor();
  assert.equal(await bubble.locator('#content img').count(), 0);
  assert.equal(await bubble.evaluate(() => window.injection === true), false);
  await bubble.locator('#dismiss').click();
  await bubble.waitForTimeout(100);
  assert.equal(await bubbleWindow.evaluate(win => win.isVisible()), false);
  await bob.page.locator('#mute').click();
  await send(alice.page, '暂停弹出时，小纸条仍然会留在聊天记录。');
  await bob.page.locator('#history').getByText('暂停弹出时，小纸条仍然会留在聊天记录。').waitFor();
  assert.equal(await bubbleWindow.evaluate(win => win.isVisible()), false);
  await bob.page.locator('#mute').click();
  const alicePubkey = (await bob.page.evaluate(() => window.petlink.call('get-state'))).status.peerPubkey;
  const oldEvents = relay.events.filter(event => event.pubkey === alicePubkey);
  await bob.app.close();
  bob = await launch('bob');
  await Promise.all([online(alice.page), online(bob.page)]);
  const restored = await bob.page.evaluate(() => window.petlink.call('get-state'));
  assert.equal(restored.name, '阿月');
  assert.equal(restored.history.length, 4);
  for (const event of oldEvents) relay.inject(event);
  await bob.page.waitForTimeout(250);
  assert.equal((await bob.page.evaluate(() => window.petlink.call('get-state'))).history.length, 4,
    'persisted message IDs must prevent redisplay after receiver restart');
  await send(alice.page, '欢迎回来！配对还在，不需要重新输入邀请码。');
  bubble = await windowPage(bob.app, 'bubble.html');
  await bubble.locator('#content').getByText('欢迎回来！配对还在，不需要重新输入邀请码。').waitFor();
  await send(bob.page, '桌面上见 ♡');
  await alice.page.locator('#history').getByText('桌面上见 ♡').waitFor();
  await alice.page.screenshot({ path: path.join(output, 'conversation.png') });
  await bubble.screenshot({ path: path.join(output, 'message-bubble.png'), omitBackground: true });
  const petPage = await windowPage(bob.app, 'pet.html');
  await petPage.screenshot({ path: path.join(output, 'desktop-pet.png'), omitBackground: true });
  const icon = await petPage.evaluate(async () => {
    const image = document.querySelector('img'); await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 1024;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#f6f3ed'; ctx.beginPath(); ctx.roundRect(0, 0, 1024, 1024, 220); ctx.fill();
    ctx.drawImage(image, 50, -5, 924, 982); return canvas.toDataURL('image/png').split(',')[1];
  });
  fs.writeFileSync(path.join(root, 'ui/icon.png'), Buffer.from(icon, 'base64'));
  fs.writeFileSync(path.join(output, 'ui-result.json'), JSON.stringify({ passed: true,
    checks: ['UI pair and clipboard invite', 'real two-process relay delivery', 'pet bubble always on top', 'clickable link', 'blocked unsafe URL',
      'image display', 'attachment save/readback', 'literal HTML message', 'dismiss', 'mute', 'restart retains pair/history', 'restart replay dedup', 'bidirectional reply'] }, null, 2));
  console.log('PASS: two Mac Electron clients, pairing, text/link/image, bubble, file save, literal HTML, mute and restart.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  for (const app of apps) await app.close().catch(() => {});
  if (relay) await relay.close();
  fs.rmSync(profiles, { recursive: true, force: true });
});
