const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { Peer, createIdentity, createInvite } = require('./legacy/peer.cjs');
const { startRelay } = require('./relay.cjs');
const root = path.resolve(__dirname, '..');
const pause = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, timeout = 15000) { const end = Date.now() + timeout; while (!fn()) { if (Date.now() > end) throw Error('Timed out'); await pause(20); } }
function rust(mode, relay, profile, invite) {
  const child = spawn(path.join(root, 'src-tauri/target/debug/examples/peer-cli'), [mode, relay, profile, ...(invite ? [invite] : [])]);
  const events = []; let buffer = '', stderr = '';
  child.stdout.on('data', data => { buffer += data; let n; while ((n = buffer.indexOf('\n')) !== -1) { events.push(JSON.parse(buffer.slice(0, n))); buffer = buffer.slice(n + 1); } });
  child.stderr.on('data', data => { stderr += data; });
  let exited = false; child.on('exit', () => { exited = true; });
  const current = () => events.findLast(e => e.status)?.status;
  return { events, current, child, check: () => { if (exited) throw Error(stderr || 'Rust exited'); }, send: (v, rpc) => child.stdin.write(JSON.stringify({ message: v, rpc }) + '\n'), stop: async () => { if (!exited) child.stdin.write('{"stop":true}\n'); await until(() => exited, 3000).catch(() => child.kill()); } };
}
(async () => {
  execFileSync('cargo', ['build', '--manifest-path', 'src-tauri/Cargo.toml', '--example', 'peer-cli'], { cwd: root, stdio: 'inherit' });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'petlink-rust-interop-'));
  const relay = await startRelay(); const resources = []; const checks = [];
  try {
    const r = rust('host', relay.url, path.join(directory, 'rust-host')); resources.push(r);
    await until(() => { r.check(); return r.events.some(e => e.invite); });
    const invite = r.events.find(e => e.invite).invite;
    const js = new Peer({ identity: createIdentity(), invite, name: '旧版', relays: [relay.url] }); resources.push(js); const incoming = [];
    js.on('message', m => incoming.push(m)); js.start();
    await until(() => { r.check(); return r.current()?.peerOnline && js.status.peerOnline; }); checks.push('Rust host pairs with legacy JS');
    const text = 'Rust → JS 你好 🐾 <script> & https://example.com'; r.send({ text }, 1);
    await until(() => r.events.some(e => e.rpc === 1)); assert.equal(r.events.find(e => e.rpc === 1).sent?.text, text); assert.equal(incoming[0].text, text);
    await js.send({ text: 'JS → Rust 双向' }); await until(() => r.events.some(e => e.received?.text === 'JS → Rust 双向'));
    const history = JSON.parse(fs.readFileSync(path.join(directory, 'rust-host/history.json'))); assert(history.some(m => m.text === 'JS → Rust 双向')); checks.push('Unicode, signatures, encryption, ACK after disk commit');
    await js.send({ text: 'Toss', placement: { display: 2, x: .99, y: .01 } }); await until(() => r.events.some(e => e.received?.placement));
    const request = r.events.find(e => e.received?.placement).received; r.send({ text: '接住', throwDecision: { requestId: request.id, accepted: true } }, 2);
    await until(() => r.events.some(e => e.rpc === 2)); assert.equal(incoming.at(-1).throwDecision.accepted, true);
    r.send({ quickAction: 'heart' }, 3); await until(() => r.events.some(e => e.rpc === 3)); assert.equal(incoming.at(-1).quickAction, 'heart'); checks.push('Toss coordinates, decisions and quick actions');
    const data = randomBytes(5 * 1024 * 1024).toString('base64'); r.send({ attachment: { name: 'five-mib.bin', mime: 'application/octet-stream', data } }, 4);
    await until(() => r.events.some(e => e.rpc === 4), 60000); assert.equal(r.events.find(e => e.rpc === 4).error, undefined); assert.equal(incoming.at(-1).attachment.data, data); checks.push('5 MiB Rust → legacy fragmented attachment');
    await js.send({ attachment: { name: 'return.bin', mime: 'application/octet-stream', data: data.slice(0, 1024 * 128) } });
    await until(() => r.events.some(e => e.received?.attachment)); assert.equal(r.events.findLast(e => e.received?.attachment).received.attachment.data, data.slice(0, 1024 * 128));
    const before = r.events.filter(e => e.received).length; for (const event of relay.events.slice(-10)) relay.inject(event); await pause(300); assert.equal(r.events.filter(e => e.received).length, before); checks.push('Retransmitted events do not deliver twice');
    const intruder = new Peer({ identity: createIdentity(), invite, name: '第三人', relays: [relay.url] }); resources.push(intruder); intruder.start(); await pause(1000); assert.equal(intruder.status.peerOnline, false); checks.push('Pinned peer rejects third party'); intruder.stop();
    for (const ws of relay.server.clients) ws.terminate(); await until(() => r.current()?.relayConnected === 0); await until(() => r.current()?.peerOnline && js.status.peerOnline, 15000); checks.push('WebSocket reconnect and fresh presence challenge');
    await r.stop(); js.stop();
    // The invitation must belong to its host identity.
    const hostId = createIdentity(), hostInvite = createInvite(hostId);
    const legacyHost = new Peer({ identity: hostId, name: 'JS host', invite: hostInvite, relays: [relay.url] }); resources.push(legacyHost); legacyHost.start();
    const join = rust('join', relay.url, path.join(directory, 'rust-join'), hostInvite); resources.push(join);
    await until(() => join.current()?.peerOnline && legacyHost.status.peerOnline); join.send({ text: 'Rust guest' }, 5); await until(() => join.events.some(e => e.rpc === 5)); assert.equal(join.events.find(e => e.rpc === 5).error, undefined); checks.push('Rust guest pairs with legacy host');
    fs.mkdirSync(path.join(root, 'test-output'), { recursive: true }); fs.writeFileSync(path.join(root, 'test-output/rust-interop.json'), JSON.stringify({ checks }, null, 2)); console.log(checks.join('\n'));
  } finally { for (const resource of resources) await resource.stop(); await relay.close(); fs.rmSync(directory, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
