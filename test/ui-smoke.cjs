const { _electron: electron } = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startRelay } = require('./relay.cjs');
const { placedBounds } = require('../src/desktop.cjs');

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
async function windowPage(app, filename, previous = new Set()) {
  for (let i = 0; i < 100; i++) {
    const page = app.windows().find(p => !p.isClosed() && !previous.has(p) && p.url().endsWith('/' + filename));
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
async function selectTarget(client) {
  assert.equal(await client.page.locator('#pick-target').textContent(), 'Toss');
  const previous = new Set(client.app.windows());
  await client.page.locator('#pick-target').click();
  const target = await windowPage(client.app, 'target.html', previous);
  const size = await target.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  await target.mouse.click(Math.round(size.width * .3), Math.round(size.height * .28));
  await client.page.locator('#target-label').getByText(/屏幕 \d+/).waitFor();
  assert.equal(await client.page.locator('#send').textContent(), 'Toss');
}
(async () => {
  relay = await startRelay();
  const alice = await launch('alice');
  let bob = await launch('bob');
  const smallPet = await windowPage(bob.app, 'pet.html');
  const petWindow = await bob.app.browserWindow(smallPet);
  assert.deepEqual(await petWindow.evaluate(w => w.getSize()), [96, 108]);
  await bob.page.locator('#pet-choice').selectOption('bunny');
  await smallPet.waitForFunction(() => document.querySelector('#pet img').getAttribute('src') === 'bunny.svg');
  assert.equal(await smallPet.locator('#pet img').evaluate(el => getComputedStyle(el).imageRendering), 'pixelated');
  const customPetFile = path.join(profiles, 'custom-pet.png'); fs.writeFileSync(customPetFile, pixel);
  await bob.app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, customPetFile);
  await bob.page.locator('#pet-choice').selectOption('custom');
  await smallPet.waitForFunction(() => document.querySelector('#pet img').getAttribute('src')?.startsWith('data:image/png'));
  assert.equal((await bob.page.evaluate(() => window.petlink.call('get-state'))).pet.src, `data:image/png;base64,${pixel.toString('base64')}`);
  const badPetFile = path.join(profiles, 'broken-pet.png'); fs.writeFileSync(badPetFile, 'not an image');
  await bob.app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, badPetFile);
  await bob.page.locator('#pet-choice').selectOption('custom');
  await bob.page.locator('#notice').getByText('无法读取图片或图片尺寸过大。').waitFor();
  assert.equal((await bob.page.evaluate(() => window.petlink.call('get-state'))).pet.src, `data:image/png;base64,${pixel.toString('base64')}`);
  fs.writeFileSync(badPetFile, Buffer.alloc(2 * 1024 * 1024 + 1));
  await bob.page.locator('#pet-choice').selectOption('custom');
  await bob.page.locator('#notice').getByText('桌宠支持 PNG/JPEG，最大 2 MiB。').waitFor();
  await bob.app.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); });
  await bob.page.locator('#pet-choice').selectOption('custom');
  assert.equal((await bob.page.evaluate(() => window.petlink.call('get-state'))).pet.kind, 'custom');
  const invalidPet = await bob.page.evaluate(async () => {
    try { await window.petlink.call('set-pet', 'constructor'); return false; } catch { return true; }
  });
  assert.equal(invalidPet, true);
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
  const alicePet = await windowPage(alice.app, 'pet.html');
  const alicePetWindow = await alice.app.browserWindow(alicePet);
  await smallPet.evaluate(() => window.petlink.call('quick-action', 'heart'));
  await alicePet.locator('#effect').getByText('💗').waitFor();
  assert.equal((await alice.page.evaluate(() => window.petlink.call('get-state'))).history.length, 0, 'quick actions stay out of chat history');
  const originalPetBounds = await alicePetWindow.evaluate(win => win.getBounds());
  await smallPet.evaluate(() => window.petlink.call('quick-action', 'walk'));
  await alicePet.locator('#pet.walking').waitFor();
  assert.match(await alicePet.locator('#pet img').evaluate(el => getComputedStyle(el).animationName), /walk-cycle/);
  assert.notEqual((await alicePetWindow.evaluate(win => win.getBounds())).x, originalPetBounds.x);
  await alicePet.waitForTimeout(2800);
  assert.equal(await alicePet.locator('#pet').evaluate(el => el.classList.contains('walking')), true, 'stroll remains active at the old finish time');
  await alicePet.waitForFunction(() => !document.getElementById('pet').classList.contains('walking'), null, { timeout: 8000 });
  assert.deepEqual(await alicePetWindow.evaluate(win => win.getBounds()), originalPetBounds, 'walk returns the pet to its saved position');
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
  await bubble.locator('#quick-reply').fill('不用打开主界面也能回你啦。');
  await bubble.locator('#quick-send').click();
  await alice.page.locator('#history').getByText('不用打开主界面也能回你啦。').waitFor();
  await bubble.waitForTimeout(100);
  assert.equal(await bubbleWindow.evaluate(win => win.isVisible()), false);
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
  assert.equal((await bob.page.evaluate(() => window.petlink.call('get-state'))).pet.src, `data:image/png;base64,${pixel.toString('base64')}`);
  await bob.page.locator('#pet-choice').selectOption('cat');
  await Promise.all([online(alice.page), online(bob.page)]);
  const restored = await bob.page.evaluate(() => window.petlink.call('get-state'));
  assert.equal(restored.name, '阿月');
  assert.equal(restored.history.length, 5);
  for (const event of oldEvents) relay.inject(event);
  await bob.page.waitForTimeout(250);
  assert.equal((await bob.page.evaluate(() => window.petlink.call('get-state'))).history.length, 5,
    'persisted message IDs must prevent redisplay after receiver restart');
  await send(alice.page, '欢迎回来！配对还在，不需要重新输入邀请码。');
  bubble = await windowPage(bob.app, 'bubble.html');
  await bubble.locator('#content').getByText('欢迎回来！配对还在，不需要重新输入邀请码。').waitFor();
  await send(bob.page, '桌面上见 ♡');
  await alice.page.locator('#history').getByText('桌面上见 ♡').waitFor();
  await selectTarget(alice);
  await send(alice.page, '先问你：要接住这句话吗？');
  await bubble.locator('#content .throw-actions').waitFor();
  assert.equal(bob.app.windows().filter(p => p.url().endsWith('/object.html')).length, 0, 'nothing is placed before consent');
  const request = (await bob.page.evaluate(() => window.petlink.call('get-state'))).history.findLast(m => m.placement);
  const bobPet = await windowPage(bob.app, 'pet.html');
  const blockedConsent = await bobPet.evaluate(async (requestId) => {
    try { await window.petlink.call('respond-throw', { requestId, accepted: true }); return false; } catch { return true; }
  }, request.id);
  assert.equal(blockedConsent, true, 'pet renderer cannot bypass the consent UI');
  await bubble.locator('.throw-actions').getByRole('button', { name: '拒绝', exact: true }).click();
  await alice.page.locator(`[data-message-id="${request.id}"] .throw-status`).getByText('已拒绝').waitFor();
  assert.equal(bob.app.windows().filter(p => p.url().endsWith('/object.html')).length, 0, 'rejection never places an object');
  const originalImage = Buffer.from(await (await windowPage(alice.app, 'pet.html')).evaluate(async () => {
    const image = document.querySelector('img'); await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = 1440; canvas.height = 1530;
    const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png').split(',')[1];
  }), 'base64');
  await selectTarget(alice);
  await alice.page.locator('#file-input').setInputFiles({ name: '透明小猫.png', mimeType: 'image/png', buffer: originalImage });
  await alice.page.locator('#attachment-preview').waitFor({ state: 'visible' });
  await send(alice.page, '接住一只小猫 ♡');
  await bubble.locator('#content .throw-actions').waitFor();
  const imageRequest = (await bob.page.evaluate(() => window.petlink.call('get-state'))).history.findLast(m => m.placement);
  assert.equal(imageRequest.attachment.mime, 'image/png');
  assert.deepEqual(Buffer.from(imageRequest.attachment.data, 'base64'), originalImage, 'image bytes stay unchanged, including alpha');
  assert.equal(bob.app.windows().filter(p => p.url().endsWith('/object.html')).length, 0);
  await bubble.screenshot({ path: path.join(output, 'throw-request.png'), omitBackground: true });
  await bubble.locator('.throw-actions').getByRole('button', { name: '确认接住 ↗', exact: true }).click();
  const object = await windowPage(bob.app, 'object.html');
  await object.waitForFunction(() => document.querySelector('#object-content img')?.naturalWidth > 0);
  assert.equal(await object.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d'); ctx.drawImage(document.querySelector('#object-content img'), 0, 0);
    return ctx.getImageData(0, 0, 1, 1).data[3];
  }), 0, 'transparent PNG corner remains transparent');
  const appearance = await object.evaluate(() => {
    const style = getComputedStyle(document.querySelector('.desktop-object'));
    const image = getComputedStyle(document.querySelector('#object-content img'));
    return { background: style.backgroundColor, border: style.borderWidth, shadow: style.boxShadow,
      radius: image.borderRadius, text: document.querySelector('#object-content').textContent,
      metadata: document.querySelectorAll('.object-header, .file-card, .throw-location, .throw-actions').length };
  });
  assert.deepEqual(appearance, { background: 'rgba(0, 0, 0, 0)', border: '0px', shadow: 'none',
    radius: '0px', text: imageRequest.text, metadata: 0 });
  await object.mouse.move(0, 0);
  assert.equal(await object.locator('#close-object').evaluate(el => getComputedStyle(el).opacity), '0');
  await alice.page.locator(`[data-message-id="${imageRequest.id}"] .throw-status`).getByText('已确认接住 ✓').waitFor();
  const objectWindow = await bob.app.browserWindow(object);
  const bounds = await objectWindow.evaluate(win => win.getBounds());
  const nativeDisplays = await bob.app.evaluate(({ screen }) => {
    const primary = screen.getPrimaryDisplay().id;
    return screen.getAllDisplays().sort((a, b) => (b.id === primary) - (a.id === primary) || a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y);
  });
  assert.deepEqual(bounds, placedBounds(imageRequest.placement, nativeDisplays, { width: bounds.width, height: bounds.height }));
  assert.equal(await objectWindow.evaluate(win => win.isVisible()), true);
  await object.screenshot({ path: path.join(output, 'desktop-throw.png'), omitBackground: true });
  await object.locator('.desktop-object').hover();
  assert.equal(await object.locator('#close-object').evaluate(el => getComputedStyle(el).opacity), '1');
  await object.locator('#close-object').click();
  await bob.page.waitForTimeout(100);
  assert.equal(bob.app.windows().filter(p => p.url().endsWith('/object.html')).length, 0);
  await selectTarget(alice);
  const originalText = '再单独接住一句文字\n<img src=x onerror="window.injection=true"> https://example.com';
  await send(alice.page, originalText);
  await bubble.locator('#content .throw-actions').waitFor();
  const textRequest = (await bob.page.evaluate(() => window.petlink.call('get-state'))).history.findLast(m => m.placement);
  await bubble.locator('.throw-actions').getByRole('button', { name: '确认接住 ↗', exact: true }).click();
  const textObject = await windowPage(bob.app, 'object.html');
  await textObject.locator('#object-content').getByText('再单独接住一句文字', { exact: false }).waitFor();
  assert.equal(await textObject.locator('#object-content').textContent(), originalText);
  assert.equal(await textObject.locator('#object-content img, #object-content a').count(), 0);
  assert.equal(await textObject.evaluate(() => window.injection === true), false);
  await textObject.mouse.move(0, 0);
  await textObject.waitForFunction(() => document.querySelector('.desktop-object').getAnimations().every(a => a.playState === 'finished'));
  await textObject.screenshot({ path: path.join(output, 'desktop-text.png'), omitBackground: true });
  const repeat = await bob.page.evaluate(async requestId => {
    try { await window.petlink.call('respond-throw', { requestId, accepted: true }); return false; } catch { return true; }
  }, textRequest.id);
  assert.equal(repeat, true, 'one request may only be accepted once');
  assert.equal(bob.app.windows().filter(p => p.url().endsWith('/object.html')).length, 1);
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
    checks: ['small pixel pet', 'built-in pet switching', 'custom pet image', 'pet selection persists on restart', 'invalid and oversized pet image rejected',
      'UI pair and clipboard invite', 'real two-process relay delivery', 'pet bubble always on top', 'bubble quick reply', 'clickable link', 'blocked unsafe URL',
      'encrypted pet quick actions', 'walk restores saved pet position',
      'image display', 'attachment save/readback', 'literal HTML message', 'dismiss', 'mute', 'restart retains pair/history', 'restart replay dedup', 'bidirectional reply',
      'Toss button labels', 'desktop target picker', 'no placement before consent', 'reject request', 'consent IPC restricted',
      'original image bytes preserved', 'frameless transparent content', 'close button hidden until hover',
      'accept image at mapped coordinates', 'close desktop object', 'literal original text', 'accept text once'] }, null, 2));
  console.log('PASS: two Mac clients, pairing, chat, restart, desktop target selection, confirmed image/text placement and rejection.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  for (const app of apps) await app.close().catch(() => {});
  if (relay) await relay.close();
  fs.rmSync(profiles, { recursive: true, force: true });
});
