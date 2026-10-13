// Real macOS WKWebView windows, real Rust IPC, two app processes and a real WebSocket relay.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { startRelay } = require('./relay.cjs');
const root = path.resolve(__dirname, '..');
const pause = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, timeout = 15000) { const end = Date.now() + timeout; while (!(await fn())) { if (Date.now() > end) throw Error('Timed out in native UI'); await pause(100); } }
let sequence = 0;
function client(profile, relay) {
  const child = spawn(path.join(root, 'src-tauri/target/debug/petlink'), [], { env: { ...process.env, PETLINK_PROFILE: profile, PETLINK_RELAYS: relay, PETLINK_HIDDEN: '1', PETLINK_UI_TEST: '1' } });
  let exited = false, stderr = ''; child.stderr.on('data', d => { stderr = (stderr + d).slice(-20000); }); child.on('exit', () => exited = true);
  async function evaluate(script, label = 'composer') {
    if (exited) throw Error('Native app exited: ' + stderr);
    const id = ++sequence, command = path.join(profile, 'test-command.json'), result = path.join(profile, `test-result-${id}.json`);
    await until(() => { if (exited) throw Error(stderr); return fs.existsSync(path.join(profile, `test-ready-${label}`)); }); fs.writeFileSync(command + '.tmp', JSON.stringify({ id, label, script })); fs.renameSync(command + '.tmp', command);
    await until(() => { if (exited) throw Error('Native app exited: ' + stderr); return fs.existsSync(result); });
    const value = JSON.parse(fs.readFileSync(result)); fs.unlinkSync(result); if (value.error) throw Error(value.error); return value.result;
  }
  return { evaluate, state: () => evaluate("return await window.petlink.call('get-state')"), stop: async () => { if (!exited) child.kill('SIGTERM'); await until(() => exited, 3000).catch(() => child.kill('SIGKILL')); }, stderr: () => stderr };
}
(async () => {
  if (process.platform !== 'darwin') throw Error('Native UI test requires macOS');
  execFileSync('cargo', ['build', '--manifest-path', 'src-tauri/Cargo.toml'], { cwd: root, stdio: 'inherit' });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'petlink-native-ui-')); const relay = await startRelay(); const clients = [], checks = [];
  try {
    const pa = path.join(directory, 'a'), pb = path.join(directory, 'b'); fs.mkdirSync(pa); fs.mkdirSync(pb);
    const a = client(pa, relay.url), b = client(pb, relay.url); clients.push(a, b);
    assert.equal((await a.state()).version, '0.5.0'); assert.equal((await b.state()).configured, false); checks.push('Real WKWebView pages and restricted IPC load');
    await a.evaluate("document.getElementById('name').value='甲';document.getElementById('create').click()");
    await until(async () => (await a.state()).configured); const invite = (await a.state()).invite;
    await b.evaluate(`document.getElementById('name').value='乙';document.getElementById('invite-input').value=${JSON.stringify(invite)};document.getElementById('join-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))`);
    await until(async () => (await a.state()).status.peerOnline && (await b.state()).status.peerOnline); checks.push('Pairing through actual inputs and buttons');
    async function send(c, text) { await c.evaluate(`document.getElementById('message').value=${JSON.stringify(text)};document.getElementById('compose-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))`); }
    await send(a, '你好 <img src=x onerror="window.injected=true"> https://example.com');
    await until(async () => (await b.state()).history.length === 1);
    assert.equal(await b.evaluate("return !!window.injected"), false); assert.equal(await b.evaluate("return document.querySelectorAll('#history a').length"), 1);
    assert.match(await b.evaluate("return document.getElementById('content').textContent", 'bubble'), /你好/); checks.push('Messages persist, bubble renders, HTML is escaped and links stay clickable');
    await b.evaluate("document.getElementById('quick-reply').value='气泡回复';document.getElementById('quick-reply-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))", 'bubble');
    await until(async () => (await a.state()).history.some(m => m.text === '气泡回复')); checks.push('Bubble quick reply uses production send and ACK');
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf2cAAAAASUVORK5CYII=';
    await a.evaluate(`const bytes=Uint8Array.from(atob('${png}'),c=>c.charCodeAt(0));const dt=new DataTransfer();dt.items.add(new File([bytes],'transparent.png',{type:'image/png'}));const input=document.getElementById('file-input');input.files=dt.files;input.dispatchEvent(new Event('change'))`);
    await until(async () => await a.evaluate("return !document.getElementById('attachment-preview').hidden"));
    await send(a, '图片'); await until(async () => (await b.state()).history.some(m => m.attachment)); assert.equal((await b.state()).history.find(m => m.attachment).attachment.data, png); checks.push('FileReader, original image bytes and attachment preview');
    await a.evaluate("document.getElementById('pick-target').click()");
    let targets; await until(async () => { targets = await a.evaluate("return await window.__TAURI__.core.invoke('call',{channel:'test-windows'})"); return targets.some(s => s.startsWith('target-')); });
    const target = targets.find(s => s === 'target-1');
    await a.evaluate("setTimeout(()=>document.body.dispatchEvent(new MouseEvent('click',{clientX:innerWidth*.9,clientY:innerHeight*.9,bubbles:true})),200)", target);
    await until(async () => await a.evaluate("return document.getElementById('send').textContent==='Toss'")); await send(a, '接住这个');
    await until(async () => (await b.state()).history.some(m => m.placement));
    let windows = await b.evaluate("return await window.__TAURI__.core.invoke('call',{channel:'test-windows'})"); assert(!windows.some(s => s.startsWith('object-')));
    await b.evaluate("document.querySelector('#history .throw-actions button').click()"); await until(async () => (await b.state()).history.find(m => m.placement).throwState === 'accepted');
    windows = await b.evaluate("return await window.__TAURI__.core.invoke('call',{channel:'test-windows'})"); const object = windows.find(s => s.startsWith('object-')); assert(object);
    assert.equal(await b.evaluate("return document.getElementById('object-content').textContent", object), '接住这个');
    const requestId = (await b.state()).history.find(m => m.placement).id;
    await assert.rejects(() => b.evaluate("return await window.petlink.call('respond-throw',{requestId:" + JSON.stringify(requestId) + ",accepted:true})"));
    await b.evaluate("setTimeout(()=>document.getElementById('close-object').click(),200)", object); checks.push('Multi-screen picker, consent before object creation, object content and duplicate-consent rejection');
    await b.evaluate("document.getElementById('pet-choice').value='bunny';document.getElementById('pet-choice').dispatchEvent(new Event('change'))"); await until(async () => (await b.state()).pet.kind === 'bunny');
    const before = (await b.state()).history.length; await b.stop(); const restarted = client(pb, relay.url); clients.push(restarted);
    assert.equal((await restarted.state()).pet.kind, 'bunny'); assert.equal((await restarted.state()).history.length, before); assert.equal((await restarted.state()).status.paired, true); checks.push('Restart retains legacy-format identity, pairing, history and pet choice');
    await assert.rejects(() => restarted.evaluate("return await window.petlink.call('configure',{name:'unauthorized',create:true})", 'pet'), /未知操作/); checks.push('Pet window cannot mutate pairing');
    const updates = await restarted.evaluate("return await window.petlink.call('check-update')").catch(e => String(e)); assert.match(String(updates), /已安装/); checks.push('Unpackaged debug app cannot install updates');
    fs.mkdirSync(path.join(root, 'test-output'), { recursive: true }); fs.writeFileSync(path.join(root, 'test-output/native-ui.json'), JSON.stringify({ checks }, null, 2)); console.log(checks.join('\n'));
  } catch (e) { console.error(clients.map(c => c.stderr()).join('\n')); throw e; }
  finally { for (const c of clients) await c.stop(); await relay.close(); fs.rmSync(directory, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
