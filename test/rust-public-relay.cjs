// Opt-in internet smoke: random isolated test identities; no user profile or real messages.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const pause = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, timeout = 30000) { const end = Date.now() + timeout; while (!fn()) { if (Date.now() > end) throw Error('Public relay timed out'); await pause(100); } }
(async () => {
  execFileSync('cargo', ['build', '--manifest-path', 'src-tauri/Cargo.toml', '--example', 'peer-cli'], { cwd: root, stdio: 'inherit' });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'petlink-rust-public-')), clients = [];
  function start(mode, invite) {
    const profile = path.join(directory, String(clients.length));
    const child = spawn(path.join(root, 'src-tauri/target/debug/examples/peer-cli'), [mode, 'wss://nos.lol,wss://nostr.mom,wss://relay.snort.social', profile, ...(invite ? [invite] : [])]);
    const events = []; let buffer = '', stderr = '', exited = false;
    child.stdout.on('data', d => { buffer += d; let n; while ((n = buffer.indexOf('\n')) !== -1) { events.push(JSON.parse(buffer.slice(0, n))); buffer = buffer.slice(n + 1); } });
    child.stderr.on('data', d => { stderr += d; }); child.on('exit', () => exited = true);
    const client = { events, profile, child, status: () => events.findLast(e => e.status)?.status, check: () => { if (exited) throw Error(stderr); }, stop: async () => { if (!exited) child.stdin.write('{"stop":true}\n'); await until(() => exited, 3000).catch(() => child.kill()); } }; clients.push(client); return client;
  }
  try {
    const a = start('host'); await until(() => { a.check(); return a.events.some(e => e.invite); }); const b = start('join', a.events.find(e => e.invite).invite);
    await until(() => { a.check(); b.check(); return a.status()?.peerOnline && b.status()?.peerOnline; });
    const text = 'PetLink isolated Rust smoke ' + randomBytes(8).toString('hex'); a.child.stdin.write(JSON.stringify({ rpc: 1, message: { text } }) + '\n');
    await until(() => a.events.some(e => e.rpc === 1), 55000); assert.equal(a.events.find(e => e.rpc === 1).error, undefined); assert.equal(b.events.find(e => e.received)?.received.text, text);
    b.child.stdin.write(JSON.stringify({ rpc: 2, message: { attachment: { name: 'random.bin', mime: 'application/octet-stream', data: randomBytes(1024).toString('base64') } } }) + '\n');
    await until(() => b.events.some(e => e.rpc === 2), 55000); assert.equal(b.events.find(e => e.rpc === 2).error, undefined);
    assert(JSON.parse(fs.readFileSync(path.join(a.profile, 'history.json'))).some(m => m.attachment));
    const result = { pass: true, relayConnected: [a.status().relayConnected, b.status().relayConnected], checks: ['Public WSS TLS', 'Signed/encrypted pairing', 'Text plus recipient ACK', 'Binary attachment plus persistence'] };
    fs.mkdirSync(path.join(root, 'test-output'), { recursive: true }); fs.writeFileSync(path.join(root, 'test-output/rust-public-relay.json'), JSON.stringify(result, null, 2)); console.log(result);
  } finally { for (const c of clients) await c.stop(); fs.rmSync(directory, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
