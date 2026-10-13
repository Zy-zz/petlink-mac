const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, clipboard, shell, dialog, screen, powerMonitor } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { Peer, createIdentity, createInvite, parseInvite, validatePlacement, DEFAULT_RELAYS } = require('./peer.cjs');
const { clampBounds, placedBounds } = require('./desktop.cjs');
const PET_SIZE = { width: 96, height: 108 };
const PETS = {
  cat: { kind: 'cat', src: 'pet.svg', name: '像素小猫', pixel: true },
  bunny: { kind: 'bunny', src: 'bunny.svg', name: '像素小兔', pixel: true }
};

if (process.env.PETLINK_PROFILE) app.setPath('userData', path.resolve(process.env.PETLINK_PROFILE));
app.setName('PetLink');
const profile = app.getPath('userData');
const configFile = path.join(profile, 'config.json');
const historyFile = path.join(profile, 'history.json');
fs.mkdirSync(profile, { recursive: true, mode: 0o700 });

function readJSON(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error(`${path.basename(file)} 无法读取，已保留原文件，请先备份再重试。`); }
}
let config, history;
try {
  config = readJSON(configFile, { identity: createIdentity(), name: '', invite: null, peerPubkey: null, peerName: '' });
  history = readJSON(historyFile, []);
  if (!config.identity || !Array.isArray(history)) throw new Error('本机配置格式无效，已保留原文件。');
  if (config.invite) parseInvite(config.invite);
} catch (error) {
  config = null;
  app.whenReady().then(() => { dialog.showErrorBox('PetLink', error.message); app.quit(); });
}
function writeJSON(file, value) {
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(temporary, file);
}
let peer = null, composer, pet, bubble, tray, quitting = false, unread = 0, latest = null, muted = false;
let historyVersion = 0;
const sentHistory = new WeakMap();
const objects = new Map();
const pickerDisplays = new Map();
let choice = null, dragOrigin = null;
function displays() {
  const primary = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().sort((a, b) => (b.id === primary) - (a.id === primary) || a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y);
}
const emptyStatus = { relayConnected: 0, peerOnline: false, paired: false, peerName: '', peerPubkey: null };
function state() {
  return { name: config.name, invite: config.peerPubkey ? null : config.invite, configured: !!config.invite,
    status: peer?.status ?? emptyStatus, history, unread, latest, muted, version: app.getVersion(), pet: config.pet || PETS.cat };
}
function broadcast() {
  for (const win of [composer, pet, bubble]) if (win && !win.isDestroyed()) {
    const value = state();
    if (win !== composer || sentHistory.get(win) === historyVersion) delete value.history;
    else sentHistory.set(win, historyVersion);
    if (win !== composer) delete value.invite;
    win.webContents.send('state', value);
  }
}
function remember(message, direction) {
  history.push({ ...message, direction, ...(message.placement ? { throwState: 'pending' } : {}) });
  let bytes = history.reduce((sum, m) => sum + (m.attachment?.data.length ?? 0), 0);
  while (history.length > 40 || bytes > 24 * 1024 * 1024) bytes -= history.shift().attachment?.data.length ?? 0;
  writeJSON(historyFile, history);
  historyVersion += 1;
}
function persistHistory() { writeJSON(historyFile, history); historyVersion += 1; broadcast(); }
function startPeer() {
  peer?.stop();
  peer = null;
  if (!config.invite) { broadcast(); return; }
  peer = new Peer({ identity: config.identity, invite: config.invite, peerPubkey: config.peerPubkey,
    name: config.name, relays: process.env.PETLINK_RELAYS ? process.env.PETLINK_RELAYS.split(',') : DEFAULT_RELAYS,
    onPair: ({ pubkey, name }) => {
      config.peerPubkey = pubkey; config.peerName = name;
      writeJSON(configFile, config);
    } });
  peer.on('status', broadcast);
  peer.on('error', (error) => {
    for (const win of [composer]) win?.webContents.send('notice', error.message);
  });
  peer.on('message', (message) => {
    if (history.some((m) => m.id === message.id)) return;
    // Persist before acknowledging so a delivered message survives an app restart.
    remember(message, 'incoming');
    if (message.throwDecision) {
      const request = history.find((m) => m.id === message.throwDecision.requestId && m.direction === 'outgoing' && m.placement);
      if (request?.throwState === 'pending') { request.throwState = message.throwDecision.accepted ? 'accepted' : 'rejected'; persistHistory(); }
    }
    latest = history[history.length - 1]; unread += 1;
    broadcast();
    if (!muted) { positionBubble(); bubble.showInactive(); pet.showInactive(); }
  });
  peer.start();
  broadcast();
}
function positionBubble() {
  if (!pet || !bubble) return;
  const p = pet.getBounds();
  const height = bubble.getBounds().height;
  const area = screen.getDisplayMatching(p).workArea;
  const x = Math.max(area.x + 8, Math.min(p.x + p.width - 360, area.x + area.width - 368));
  const y = Math.max(area.y + 8, Math.min(p.y - height + 16, area.y + area.height - height - 8));
  bubble.setPosition(Math.round(x), Math.round(y));
}
function markRead() { unread = 0; bubble?.hide(); broadcast(); }
function showComposer() { composer.show(); composer.focus(); markRead(); }
function makeWindow(page, options) {
  const win = new BrowserWindow({ show: false, ...options, webPreferences: {
    preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true
  } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
  win.webContents.on('did-finish-load', broadcast);
  win.loadFile(path.join(__dirname, '../ui', page));
  return win;
}
function handle(channel, fn, allowed) {
  ipcMain.handle(channel, async (event, ...args) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (![composer, pet, bubble, ...objects.keys(), ...pickerDisplays.keys()].includes(win) || (allowed && !allowed(win))) throw new Error('未知客户端');
    try { return { ok: true, value: await fn(...args, win) }; }
    catch (error) { return { ok: false, error: error.message }; }
  });
}
function finishChoice(placement) {
  if (!choice) return;
  const resolve = choice; choice = null;
  const windows = [...pickerDisplays.keys()]; pickerDisplays.clear();
  for (const win of windows) win.close();
  showComposer(); resolve(placement);
}
async function placeObject(message) {
  if (objects.size >= 8) throw new Error('桌面上已有 8 个物件，请先关闭一个。');
  const bounds = placedBounds(message.placement, displays(), { width: 300, height: 340 });
  const win = makeWindow('object.html', { ...bounds, title: 'PetLink 桌面物件', frame: false, transparent: true,
    hasShadow: false, resizable: false, alwaysOnTop: true, skipTaskbar: true, fullscreenable: false });
  objects.set(win, message);
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  win.on('closed', () => objects.delete(win));
  try {
    await new Promise((resolve, reject) => {
      win.webContents.once('did-finish-load', resolve);
      win.webContents.once('did-fail-load', (_event, _code, description) => reject(new Error(description)));
      win.once('closed', () => reject(new Error('桌面物件窗口已关闭。')));
    });
  } catch (error) { if (!win.isDestroyed()) win.close(); throw error; }
  win.showInactive(); return win;
}

app.whenReady().then(() => {
  if (!config) return;
  writeJSON(configFile, config);
  composer = makeWindow('index.html', { width: 520, height: 760, minWidth: 460, minHeight: 600,
    title: 'PetLink · 把话交给小伙伴', titleBarStyle: 'hiddenInset', backgroundColor: '#f6f3ed' });
  const area = screen.getPrimaryDisplay().workArea;
  const overlay = { frame: false, transparent: true, hasShadow: false, resizable: false,
    alwaysOnTop: true, skipTaskbar: true, fullscreenable: false };
  pet = makeWindow('pet.html', { ...overlay, ...PET_SIZE,
    x: area.x + area.width - PET_SIZE.width - 24, y: area.y + area.height - PET_SIZE.height - 20, title: 'PetLink 小伙伴' });
  bubble = makeWindow('bubble.html', { ...overlay, width: 360, height: 360, title: 'PetLink 新消息', focusable: true });
  for (const win of [pet, bubble]) {
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  }
  pet.on('move', positionBubble);
  if (config.position) {
    const { x, y } = config.position;
    if (Number.isFinite(x) && Number.isFinite(y)) {
      pet.setBounds(clampBounds({ x, y, ...PET_SIZE }, screen.getDisplayMatching({ x, y, ...PET_SIZE }).workArea));
    }
  }
  pet.once('ready-to-show', () => pet.showInactive());
  composer.once('ready-to-show', () => { if (!process.env.PETLINK_HIDDEN) composer.show(); });
  composer.on('close', (event) => { if (!quitting) { event.preventDefault(); composer.hide(); } });
  tray = new Tray(nativeImage.createEmpty());
  tray.setTitle('🐾'); tray.setToolTip('PetLink · 桌面小伙伴');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 PetLink', click: showComposer },
    { label: '显示小伙伴', click: () => pet.showInactive() },
    { label: '暂时隐藏小伙伴', click: () => { pet.hide(); bubble.hide(); } },
    { type: 'separator' }, { label: '退出', click: () => app.quit() }
  ]));
  tray.on('click', showComposer);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'PetLink', submenu: [{ role: 'about' }, { role: 'hide' }, { role: 'quit' }] },
    { role: 'editMenu' }, { role: 'windowMenu' }
  ]));
  handle('get-state', state);
  handle('set-pet', async (kind) => {
    if (typeof kind === 'string' && Object.hasOwn(PETS, kind)) config.pet = PETS[kind];
    else if (kind === 'custom') {
      const result = await dialog.showOpenDialog(composer, { title: '选择桌宠图片', properties: ['openFile'],
        filters: [{ name: '桌宠图片', extensions: ['png', 'jpg', 'jpeg'] }] });
      if (result.canceled) return state();
      const file = result.filePaths[0];
      const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' }[path.extname(file).toLowerCase()];
      if (!mime || fs.statSync(file).size > 2 * 1024 * 1024) throw new Error('桌宠支持 PNG/JPEG，最大 2 MiB。');
      const data = fs.readFileSync(file);
      if (data.length > 2 * 1024 * 1024) throw new Error('桌宠图片最大 2 MiB。');
      const image = nativeImage.createFromBuffer(data), size = image.getSize();
      if (image.isEmpty() || size.width * size.height > 64_000_000) throw new Error('无法读取图片或图片尺寸过大。');
      config.pet = { kind: 'custom', src: `data:${mime};base64,${data.toString('base64')}`, name: '自定义桌宠', pixel: false };
    } else throw new Error('请选择有效的桌宠。');
    writeJSON(configFile, config); broadcast(); return state();
  }, (w) => w === composer);
  handle('drag-start', () => { dragOrigin = { bounds: pet.getBounds(), cursor: screen.getCursorScreenPoint() }; }, (w) => w === pet);
  handle('drag-move', () => {
    if (!dragOrigin) return;
    const cursor = screen.getCursorScreenPoint();
    pet.setPosition(Math.round(dragOrigin.bounds.x + cursor.x - dragOrigin.cursor.x),
      Math.round(dragOrigin.bounds.y + cursor.y - dragOrigin.cursor.y));
  }, (w) => w === pet);
  handle('drag-end', () => {
    if (!dragOrigin) return;
    dragOrigin = null;
    pet.setBounds(clampBounds(pet.getBounds(), screen.getDisplayMatching(pet.getBounds()).workArea));
    config.position = pet.getBounds(); writeJSON(configFile, config);
  }, (w) => w === pet);
  handle('pick-target', () => {
    if (choice) throw new Error('正在选择落点。');
    composer.hide(); bubble.hide();
    return new Promise((resolve) => {
      choice = resolve;
      for (const [index, display] of displays().entries()) {
        const win = makeWindow('target.html', { ...display.workArea, title: 'PetLink 选择落点', frame: false, transparent: true,
          resizable: false, hasShadow: false, alwaysOnTop: true, skipTaskbar: true, fullscreenable: false });
        pickerDisplays.set(win, index + 1);
        win.setAlwaysOnTop(true, 'screen-saver');
        win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
        win.once('ready-to-show', () => { if (pickerDisplays.has(win)) { win.show(); win.focus(); } });
        win.on('closed', () => { if (pickerDisplays.has(win)) finishChoice(null); });
      }
    });
  }, (w) => w === composer);
  handle('choose-target', (point, win) => finishChoice(validatePlacement({ ...point, display: pickerDisplays.get(win) })), (w) => pickerDisplays.has(w));
  handle('cancel-target', () => finishChoice(null), (w) => pickerDisplays.has(w));
  handle('get-object', (_value, win) => objects.get(win), (w) => objects.has(w));
  handle('close-object', (_value, win) => win.close(), (w) => objects.has(w));
  handle('object-height', (height, win) => {
    if (!Number.isFinite(height)) return;
    win.setBounds(placedBounds(objects.get(win).placement, displays(), { width: 300, height: Math.max(30, Math.min(420, Math.ceil(height))) }));
  }, (w) => objects.has(w));
  handle('respond-throw', async ({ requestId, accepted }) => {
    if (typeof accepted !== 'boolean') throw new Error('请选择确认或拒绝。');
    const request = history.find((m) => m.id === requestId && m.direction === 'incoming' && m.placement);
    if (!request || request.throwState !== 'pending') throw new Error('这个请求已处理或不存在。');
    if (Date.now() - request.sentAt > 5 * 60 * 1000) throw new Error('请求已过期，请让 TA 重新发送。');
    request.throwState = 'processing';
    const session = peer;
    let win;
    try {
      if (accepted) win = await placeObject(request);
      if (peer !== session || !history.includes(request)) throw new Error('配对已变化，这个请求已取消。');
      request.throwState = accepted ? 'accepted' : 'rejected'; persistHistory();
    } catch (error) { win?.close(); request.throwState = 'pending'; throw error; }
    try {
      const response = await session.send({ text: accepted ? `${config.name}接住了你甩来的东西 ♡` : `${config.name}拒绝了甩东西请求`,
        throwDecision: { requestId, accepted } });
      if (peer === session && history.includes(request)) { remember(response, 'outgoing'); broadcast(); }
    } catch { return { accepted, notice: '本机已处理请求，但暂未通知到对方。' }; }
    return { accepted };
  }, (w) => w === composer || w === bubble);
  handle('configure', ({ name, invite, create }) => {
    if (config.peerPubkey) throw new Error('请先断开当前配对。');
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 30) throw new Error('请输入 1–30 字的昵称。');
    const next = create === true ? createInvite(config.identity) : invite?.trim();
    parseInvite(next);
    config.name = name.trim(); config.invite = next;
    writeJSON(configFile, config); startPeer(); return state();
  });
  handle('copy-invite', () => {
    if (!config.invite || config.peerPubkey) throw new Error('当前没有可用的邀请码。');
    clipboard.writeText(config.invite); return true;
  });
  handle('send', async (message) => {
    if (!peer) throw new Error('请先配对。');
    if (message?.throwDecision) throw new Error('请通过收到的请求按钮确认。');
    if (message?.placement && !peer.status.canThrow) throw new Error('对方版本还不支持甩东西，请双方更新到 0.2.0。');
    const session = peer;
    const sent = await session.send(message);
    if (peer === session) { remember(sent, 'outgoing'); broadcast(); }
    return sent;
  });
  handle('open', showComposer);
  handle('dismiss', markRead);
  handle('bubble-height', (height) => {
    if (!Number.isFinite(height)) return;
    bubble.setSize(360, Math.max(120, Math.min(360, Math.ceil(height)))); positionBubble();
  });
  handle('mute', () => { muted = !muted; if (muted) bubble.hide(); broadcast(); return muted; });
  handle('link', async (value) => {
    if (typeof value !== 'string' || value.length > 4096) throw new Error('链接无效。');
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('只支持 http / https 链接。');
    await shell.openExternal(url.href);
  });
  handle('save-attachment', async (id) => {
    const attachment = history.find((m) => m.id === id)?.attachment;
    if (!attachment) throw new Error('附件已不在本机历史中。');
    const result = await dialog.showSaveDialog(composer, { defaultPath: path.basename(attachment.name) });
    if (result.canceled || !result.filePath) return false;
    fs.writeFileSync(result.filePath, Buffer.from(attachment.data, 'base64')); return true;
  });
  handle('reset', async () => {
    const result = await dialog.showMessageBox(composer, { type: 'question', buttons: ['保留配对', '断开配对'],
      defaultId: 0, cancelId: 0, message: '断开与小伙伴的配对？', detail: '本机聊天记录会被清空，之后可以和其他人重新配对。' });
    if (result.response !== 1) return false;
    peer?.stop(); peer = null;
    config.invite = null; config.peerPubkey = null; config.peerName = '';
    history = []; historyVersion += 1; latest = null; unread = 0; bubble.hide();
    finishChoice(null); for (const win of objects.keys()) win.close();
    writeJSON(configFile, config); writeJSON(historyFile, history); broadcast(); return true;
  });
  powerMonitor.on('resume', startPeer);
  screen.on('display-removed', () => {
    finishChoice(null);
    const a = screen.getPrimaryDisplay().workArea; pet.setPosition(a.x + a.width - PET_SIZE.width - 24, a.y + a.height - PET_SIZE.height - 20);
    for (const [win, message] of objects) win.setBounds(placedBounds(message.placement, displays(), win.getBounds()));
  });
  startPeer();
});
app.on('activate', () => composer && showComposer());
app.on('window-all-closed', () => {});
app.on('before-quit', () => { quitting = true; peer?.stop(); });
